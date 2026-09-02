// Levora — the whole signal chain, on the audio thread.
//
// This file loads two ways. In an AudioWorkletGlobalScope it registers the
// processor; under `node --test` it is imported for `LevoraCore` alone, which
// is why the base class and `registerProcessor` are both guarded. The DSP is
// plain arithmetic over one number per block, so it is testable without any
// Web Audio at all — see test/core.test.js.
//
// Why an AudioWorklet rather than native nodes driven from a timer:
//
//   * A timer sees ~46 ms out of every 200 ms through an AnalyserNode, and
//     stops entirely when the tab goes to the background. Here every block is
//     seen, at 128 samples.
//   * Gain used to be scheduled with setTargetAtTime, whose interaction between
//     two nodes produced a +27 dB blast. Gain is now interpolated per sample
//     inside one process() call. There is nothing to schedule and nothing to
//     race.
//   * The old loop measured its own output and stepped toward a target, which
//     is a feedback loop: it needed step fractions, it converged rather than
//     arrived, and it could ring. Here the output level is *known* —
//     `out = in + reduction + level` — so the required gain is solved directly.
//
// Two timescales. The compressor works in milliseconds; the leveller works in
// tens of seconds and is what makes a whole programme sit at one level.
//
// Both of the user's level controls are stated *relative to the programme's own
// loudness*, which this file already tracks. That is not a cosmetic choice. An
// absolute threshold is a fine control in a DAW, where the material is known
// and fixed; a browser sees YouTube at roughly -14 LUFS, a disc rip at -27, a
// podcast at -16, and one absolute number does three different things to them.
// Relative, a single setting behaves the same everywhere. The popup shows the
// resolved dBFS alongside, so the number is still concrete.

const FLOOR = 1e-9;
const dbFromAmp = (amp) => 20 * Math.log10(Math.max(amp, FLOOR));
const ampFromDb = (db) => 10 ** (db / 20);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// Digital silence, or close enough. Distinct from the user's floor: this is
// "there is nothing here", not "this is too quiet to be worth lifting".
const SILENCE_DB = -70;

// Levelling timescales.
const REF_TAU = 60; // "how loud is this programme?"
const SHORT_ATTACK_TAU = 0.3; // "how loud is this moment?" — rises quickly...
const SHORT_RELEASE_TAU = 1.5; // ...and falls slowly, so a pause between lines
// is not mistaken for a quiet scene
const LEVEL_DOWN_TAU = 0.5; // coming down is a safety action
const LEVEL_UP_TAU = 3; // going up drags the noise floor with it
const GR_AVG_TAU = 2; // the *average* reduction, which is what needs restoring
const LEVEL_MIN_DB = -24;
const LEVEL_MAX_DB = 30; // this gain carries the compressor's own reduction too

// After a change the gain is stale by however much the compressor's behaviour
// moved. Rather than predict the new value, the leveller is allowed to move
// quickly for a moment and measure it. A quarter of a second, and quiet on the
// way rather than loud.
const SEED_TAU = 0.08;
const SEED_SECONDS = 0.6;

// Program-dependent release. A second, lazier reduction envelope runs alongside
// the first, and the more conservative of the two wins. A short transient only
// moves the fast one, so recovery is quick; a sustained loud passage moves both,
// and the lazy one then holds the reduction in place instead of pumping back up
// between syllables. This is the difference between "dense" and "even", and it
// is the thing a bare DynamicsCompressorNode cannot be told to do.
const SLOW_ATTACK_SCALE = 4;
const SLOW_RELEASE_SCALE = 8;

/**
 * Static compression curve with a soft knee. Returns the output level, in dB,
 * for an input level in dB.
 */
export function staticCurveDb(levelDb, thresholdDb, ratio, kneeDb) {
  const over = levelDb - thresholdDb;
  if (2 * over < -kneeDb) return levelDb;
  if (kneeDb > 0 && 2 * Math.abs(over) <= kneeDb) {
    return levelDb + ((1 / ratio - 1) * (over + kneeDb / 2) ** 2) / (2 * kneeDb);
  }
  return thresholdDb + over / ratio;
}

export class LevoraCore {
  /**
   * @param {number} sampleRate
   * @param {number} blockSize frames per process() call; 128 in a worklet
   */
  constructor(sampleRate = 48000, blockSize = 128) {
    this.dt = blockSize / sampleRate;
    this.params = {
      holdAboveDb: 4, // compress what is this far above the programme
      reachBelowDb: -28, // lift what is no further below it than this
      ratio: 5,
      knee: 8,
      attack: 0.005,
      release: 0.25,
    };
    this.reset();
  }

  reset() {
    this.envDb = null;
    this.grFastDb = 0;
    this.grSlowDb = 0;
    this.grAvgDb = 0;
    this.shortDb = null;
    this.refDb = null;
    this.levelDb = 0;
    this.seedLeft = SEED_SECONDS;
  }

  setParams(params) {
    this.params = { ...this.params, ...params };
    this.seedLeft = SEED_SECONDS;
  }

  /** One-pole smoother toward `next`, seeding on the first sample. */
  smooth(previous, next, tau) {
    if (previous === null || !Number.isFinite(previous)) return next;
    if (tau <= 0) return next;
    const coefficient = Math.exp(-this.dt / tau);
    return next + (previous - next) * coefficient;
  }

  /**
   * @param {number} inDb block loudness entering the chain
   * @returns {{gainDb:number, reductionDb:number, levelDb:number}}
   */
  processBlock(inDb) {
    const p = this.params;

    // Nothing here. Freeze rather than gate: every envelope keeps its value, so
    // when audio returns it resumes instead of re-learning the material.
    if (inDb < SILENCE_DB) {
      const held = Math.min(this.grFastDb, this.grSlowDb);
      return { gainDb: held + this.levelDb, reductionDb: held, levelDb: this.levelDb };
    }

    // The programme reference comes first: both user controls are stated
    // against it, so it has to exist before either can be resolved.
    this.refDb = this.smooth(this.refDb, inDb, REF_TAU);
    const thresholdDb = this.refDb + p.holdAboveDb;

    const rising = this.envDb === null || inDb > this.envDb;
    this.envDb = this.smooth(this.envDb, inDb, rising ? p.attack : p.release);
    const envDb = this.envDb;

    const targetGr = staticCurveDb(envDb, thresholdDb, p.ratio, p.knee) - envDb;
    this.grFastDb = this.smooth(
      this.grFastDb,
      targetGr,
      targetGr < this.grFastDb ? p.attack : p.release,
    );
    this.grSlowDb = this.smooth(
      this.grSlowDb,
      targetGr,
      targetGr < this.grSlowDb
        ? p.attack * SLOW_ATTACK_SCALE
        : p.release * SLOW_RELEASE_SCALE,
    );
    const reductionDb = Math.min(this.grFastDb, this.grSlowDb);

    // Seeding has to cover the *whole* estimate, not just the gain. The average
    // reduction is what the gain is solved against, so leaving it on its slow
    // constant means the gain chases a target that is itself still moving, and
    // what should take a quarter of a second takes four.
    const seeding = this.seedLeft > 0;
    this.grAvgDb = this.smooth(this.grAvgDb, reductionDb, seeding ? SEED_TAU : GR_AVG_TAU);

    const shortRising = this.shortDb === null || inDb > this.shortDb;
    this.shortDb = this.smooth(
      this.shortDb,
      inDb,
      shortRising ? SHORT_ATTACK_TAU : SHORT_RELEASE_TAU,
    );

    // The two controls describe a window around the programme's own level, and
    // the leveller only acts on material outside it.
    //
    //   above the threshold -> held down to the threshold
    //   inside the window   -> left alone
    //   below the floor     -> left alone
    //   between             -> lifted toward the programme, tapering to nothing
    //                          at the floor
    //
    // The threshold is the same line the compressor uses. It has to be: a
    // threshold that governed milliseconds but not tens of seconds would say
    // "only touch what is 12 dB above average" while the leveller quietly
    // pulled every loud scene down to average anyway, and the control would be
    // lying about what it does.
    //
    // Lowering the floor is what reaches further into quiet material — and
    // brings up whatever noise is under it, which is why it is a decision and
    // not a constant.
    const deviationDb = this.shortDb - this.refDb;
    let liftDb;
    if (deviationDb < 0) {
      const span = Math.max(1, -p.reachBelowDb);
      const depth = clamp((deviationDb - p.reachBelowDb) / span, 0, 1);
      liftDb = -deviationDb * depth;
    } else {
      liftDb = -Math.max(0, deviationDb - p.holdAboveDb);
    }

    // Solved, not converged upon: this is the gain that puts the output where
    // it belongs. Only the *average* reduction is restored — the fast part is
    // the compression, and restoring that would undo the work.
    const desiredDb = clamp(liftDb - this.grAvgDb, LEVEL_MIN_DB, LEVEL_MAX_DB);

    let tau = desiredDb < this.levelDb ? LEVEL_DOWN_TAU : LEVEL_UP_TAU;
    if (seeding) {
      tau = SEED_TAU;
      this.seedLeft -= this.dt;
    }
    this.levelDb = this.smooth(this.levelDb, desiredDb, tau);

    return {
      gainDb: reductionDb + this.levelDb,
      reductionDb,
      levelDb: this.levelDb,
      thresholdDb,
    };
  }
}

// --- worklet shell --------------------------------------------------------

const Base =
  globalThis.AudioWorkletProcessor ??
  class {
    constructor() {
      this.port = { postMessage() {}, onmessage: null };
    }
  };

class LevoraProcessor extends Base {
  constructor() {
    super();
    this.rate = globalThis.sampleRate ?? 48000;
    this.core = new LevoraCore(this.rate, 128);
    this.gain = 1;
    this.sinceReport = 0;
    this.port.onmessage = (event) => {
      const data = event.data;
      if (data?.type === "params") this.core.setParams(data.params);
      if (data?.type === "reset") this.core.reset();
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    // No input connected yet, or the source ended. Stay alive: the node is
    // wired for the life of the element, not the life of one buffer.
    if (!input || input.length === 0 || !input[0]) return true;

    const frames = input[0].length;
    let sum = 0;
    for (const channel of input) {
      for (let i = 0; i < frames; i += 1) sum += channel[i] * channel[i];
    }
    const result = this.core.processBlock(
      dbFromAmp(Math.sqrt(sum / (frames * input.length))),
    );
    const gainDb = result.gainDb;

    // Interpolated across the block rather than applied as a step. At 128
    // frames this is ~3 ms of ramp, which is short enough to be exact and long
    // enough to be silent.
    const from = this.gain;
    const to = ampFromDb(gainDb);
    const stepPerSample = (to - from) / frames;
    for (let c = 0; c < output.length; c += 1) {
      const source = input[Math.min(c, input.length - 1)];
      const destination = output[c];
      let gain = from;
      for (let i = 0; i < frames; i += 1) {
        destination[i] = source[i] * gain;
        gain += stepPerSample;
      }
    }
    this.gain = to;

    this.sinceReport += frames;
    if (this.sinceReport >= this.rate / 10) {
      this.sinceReport = 0;
      // The programme level goes up with the meter so the popup can show what
      // the relative controls resolve to in dBFS. Without it they are two
      // numbers floating against nothing.
      this.port.postMessage({
        reduction: result.reductionDb,
        gainDb,
        programmeDb: this.core.refDb,
        thresholdDb: result.thresholdDb ?? null,
      });
    }
    return true;
  }
}

if (typeof registerProcessor === "function") {
  registerProcessor("levora", LevoraProcessor);
}
