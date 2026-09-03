// Levora — the whole signal chain, on the audio thread.
//
// This file loads two ways. In an AudioWorkletGlobalScope it registers the
// processor; under `node --test` it is imported for its classes alone, which is
// why the base class and `registerProcessor` are both guarded. Everything that
// decides anything is plain arithmetic, so it is testable without any Web Audio
// at all — see test/core.test.js.
//
// The chain, in order:
//
//   K-weighted loudness  ->  compressor  ->  leveller  ->  lookahead limiter
//         (measure)              (ms)        (tens of s)      (peaks)
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
//     is a feedback loop: it needed step fractions, converged rather than
//     arrived, and could ring. Here the output level is *known* —
//     `out = in + reduction + level` — so the required gain is solved directly.

const FLOOR = 1e-12;
const dbFromPower = (power) => 10 * Math.log10(Math.max(power, FLOOR));
const ampFromDb = (db) => 10 ** (db / 20);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// --- loudness --------------------------------------------------------------

/**
 * K-weighting, per ITU-R BS.1770.
 *
 * A flat RMS counts a 40 Hz rumble the same as a line of dialogue, which is not
 * how anyone hears. The consequence is not academic: the measurement drives
 * every decision here, so a bass-heavy passage reads louder than it sounds and
 * gets ducked for it, while speech reads quieter than it sounds and is lifted
 * less than it should be — exactly backwards for what this extension is for.
 *
 * The filter is two biquads: a high shelf that adds about 4 dB above ~2 kHz for
 * the head-related boost, and a high-pass near 38 Hz that discounts the very low
 * end. Derived from the analog prototype rather than hard-coding the published
 * 48 kHz coefficients, because a browser hands you 44.1 kHz as readily as 48.
 * A test pins the derivation against the published values at 48 kHz.
 */
const SHELF = { f0: 1681.974450955533, gainDb: 3.999843853973347, q: 0.7071752369554196 };
const HIGHPASS = { f0: 38.13547087602444, q: 0.5003270373238773 };

export function kWeightingCoefficients(sampleRate) {
  const shelfK = Math.tan((Math.PI * SHELF.f0) / sampleRate);
  const vh = 10 ** (SHELF.gainDb / 20);
  const vb = vh ** 0.4996667741545416;
  const shelfDenominator = 1 + shelfK / SHELF.q + shelfK * shelfK;
  const shelf = {
    b0: (vh + (vb * shelfK) / SHELF.q + shelfK * shelfK) / shelfDenominator,
    b1: (2 * (shelfK * shelfK - vh)) / shelfDenominator,
    b2: (vh - (vb * shelfK) / SHELF.q + shelfK * shelfK) / shelfDenominator,
    a1: (2 * (shelfK * shelfK - 1)) / shelfDenominator,
    a2: (1 - shelfK / SHELF.q + shelfK * shelfK) / shelfDenominator,
  };

  const highK = Math.tan((Math.PI * HIGHPASS.f0) / sampleRate);
  const highDenominator = 1 + highK / HIGHPASS.q + highK * highK;
  const highpass = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (highK * highK - 1)) / highDenominator,
    a2: (1 - highK / HIGHPASS.q + highK * highK) / highDenominator,
  };

  return [shelf, highpass];
}

/** Direct form I biquad, one instance per channel per stage. */
class Biquad {
  constructor(coefficients) {
    Object.assign(this, coefficients);
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;
  }

  process(x) {
    const y =
      this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/**
 * Block loudness on the LUFS scale.
 *
 * Channels are summed as mean squares rather than pooled into one average, per
 * BS.1770, so the same material in two channels reads 3 dB louder than in one —
 * which is what it sounds like. The −0.691 dB offset is the standard's, so the
 * number the popup shows is a real LUFS value and not a private unit.
 */
export class LoudnessMeter {
  constructor(sampleRate, channels = 2) {
    const coefficients = kWeightingCoefficients(sampleRate);
    this.stages = Array.from({ length: channels }, () =>
      coefficients.map((set) => new Biquad(set)),
    );
  }

  /** @param {Float32Array[]} input @param {number} frames */
  measure(input, frames) {
    let sum = 0;
    for (let c = 0; c < input.length && c < this.stages.length; c += 1) {
      const [shelf, highpass] = this.stages[c];
      const channel = input[c];
      let power = 0;
      for (let i = 0; i < frames; i += 1) {
        const weighted = highpass.process(shelf.process(channel[i]));
        power += weighted * weighted;
      }
      sum += power / frames;
    }
    return -0.691 + dbFromPower(sum);
  }
}

// --- levelling -------------------------------------------------------------

const SILENCE_LUFS = -70; // the standard's absolute gate; also just "nothing here"
const RELATIVE_GATE_LU = -10; // BS.1770's relative gate, below the ungated mean

const MOMENTARY_TAU = 0.4; // the standard's momentary window
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
 * Two-sided transfer curve: the gain to apply, in dB, for material sitting
 * `deviationDb` away from the programme's own loudness.
 *
 * This is the *static* response. Gain is a function of the current level and
 * nothing else — no memory of what came before — so the same input level always
 * produces the same output level. A quiet line after an explosion comes out
 * exactly as it would in silence.
 *
 * That is the whole difference from the adaptive leveller, which chases a
 * target over seconds: when a loud passage ends its gain rises and the quiet
 * material that follows drifts up toward the level the loud material had, then
 * drops again when the loud material returns. Smooth, but a swing — and audible
 * as one.
 *
 * Three regions:
 *
 *   above the threshold      compressed downward at `ratio`
 *   inside the window        untouched
 *   below zero, to the floor lifted at `ratio`, tapering to nothing at the
 *                            floor so that noise is left where it is
 *
 * The taper is what keeps upward compression from being a noise amplifier. A
 * plain upward compressor lifts anything quiet, hiss included; here the lift
 * grows away from the programme level and then falls back to zero as the floor
 * approaches.
 *
 * The corners are hard rather than soft-kneed on purpose. A knee centred on the
 * threshold reaches below it, into the region this curve holds at unity, and the
 * two disagree: the first version of this went *down* as the input went up just
 * past the threshold. Every boundary here is continuous and the whole curve is
 * provably monotonic, which is worth more than a rounded corner — and the
 * program-dependent ballistics smooth the gain anyway.
 */
export function transferDb(deviationDb, holdAboveDb, reachBelowDb, ratio) {
  const slope = 1 - 1 / Math.max(1, ratio);
  if (deviationDb > holdAboveDb) return -(deviationDb - holdAboveDb) * slope;

  // Where lifting starts. Normally the programme level; if the threshold has
  // been pulled below it, the threshold, so the two regions meet instead of
  // overlapping and fighting over the same material.
  const lowerDb = Math.min(0, holdAboveDb);
  if (deviationDb >= lowerDb) return 0;

  const span = Math.max(1, lowerDb - reachBelowDb);
  const depth = clamp((deviationDb - reachBelowDb) / span, 0, 1);
  return (lowerDb - deviationDb) * slope * depth;
}

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
      // Only the adaptive response uses this. The static curve has hard corners
      // by construction — a knee centred on the threshold reaches below it and
      // disagrees with the unity region there — so on the default path this is
      // carried and ignored.
      knee: 8,
      attack: 0.005,
      release: 0.25,
      response: "static",
    };
    this.reset();
  }

  reset() {
    this.envDb = null;
    this.grFastDb = 0;
    this.grSlowDb = 0;
    this.grAvgDb = 0;
    this.momentaryDb = null;
    this.ungatedDb = null;
    this.refDb = null;
    this.shortDb = null;
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
    return next + (previous - next) * Math.exp(-this.dt / tau);
  }

  /**
   * The programme reference, gated.
   *
   * A plain average over everything is dragged down by quiet stretches, and the
   * reference is the anchor both user controls are stated against — so a
   * reference that wanders makes both of them wander with it. BS.1770 answers
   * this with two gates: an absolute one at −70 LUFS, and a relative one 10 LU
   * below the ungated mean, which excludes the quiet material from the average
   * that defines the programme.
   *
   * Gating on the momentary value rather than the raw block matters: gating on
   * 2.7 ms blocks would throw away the gaps between words and read speech as
   * louder than it is.
   */
  updateReference() {
    this.ungatedDb = this.smooth(this.ungatedDb, this.momentaryDb, REF_TAU);
    if (this.refDb === null) {
      this.refDb = this.momentaryDb;
      return;
    }
    if (this.momentaryDb > this.ungatedDb + RELATIVE_GATE_LU) {
      this.refDb = this.smooth(this.refDb, this.momentaryDb, REF_TAU);
    }
  }

  /**
   * @param {number} inDb block loudness, LUFS
   * @returns {{gainDb:number, reductionDb:number, levelDb:number, thresholdDb:number}}
   */
  processBlock(inDb) {
    const p = this.params;

    // Nothing here. Freeze rather than gate: every envelope keeps its value, so
    // when audio returns it resumes instead of re-learning the material.
    if (inDb < SILENCE_LUFS) {
      const held = Math.min(this.grFastDb, this.grSlowDb);
      return {
        gainDb: held + this.levelDb,
        reductionDb: held,
        levelDb: this.levelDb,
        thresholdDb: this.refDb === null ? null : this.refDb + p.holdAboveDb,
      };
    }

    // The programme reference comes first: both user controls are stated
    // against it, so it has to exist before either can be resolved.
    this.momentaryDb = this.smooth(this.momentaryDb, inDb, MOMENTARY_TAU);
    this.updateReference();
    const thresholdDb = this.refDb + p.holdAboveDb;

    const rising = this.envDb === null || inDb > this.envDb;
    this.envDb = this.smooth(this.envDb, inDb, rising ? p.attack : p.release);
    const envDb = this.envDb;

    // Static response: one memoryless curve, and the compressor's own ballistics
    // are the only smoothing. Adaptive response: the downward curve here, and
    // the slow leveller below does the lifting.
    const staticResponse = p.response !== "adaptive";
    const targetGr = staticResponse
      ? transferDb(envDb - this.refDb, p.holdAboveDb, p.reachBelowDb, p.ratio)
      : staticCurveDb(envDb, thresholdDb, p.ratio, p.knee) - envDb;

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
    // The lazier envelope only wins where it is holding *more* reduction. On the
    // lifting side of a static curve it would otherwise drag gain down.
    const reductionDb =
      targetGr < 0 ? Math.min(this.grFastDb, this.grSlowDb) : this.grFastDb;

    if (staticResponse) {
      // No slow loop at all. Everything the response does is in the curve, and
      // overall loudness is the output control's business.
      this.levelDb = 0;
      this.grAvgDb = 0;
      // Nothing here reads shortDb; it is kept turning so that switching to the
      // adaptive response starts from a warm envelope instead of a null one.
      this.shortDb = this.smooth(
        this.shortDb,
        inDb,
        this.shortDb === null || inDb > this.shortDb ? SHORT_ATTACK_TAU : SHORT_RELEASE_TAU,
      );
      return {
        gainDb: reductionDb,
        reductionDb,
        levelDb: 0,
        thresholdDb,
      };
    }

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
    // The threshold is the same line the compressor uses. It has to be: a
    // threshold that governed milliseconds but not tens of seconds would say
    // "only touch what is 12 LU above average" while the leveller quietly
    // pulled every loud scene down to average anyway.
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

// --- limiting --------------------------------------------------------------

// 512 frames, ~10.7 ms at 48 kHz.
//
// Longer is not monotonically better, which is the trap here. The window has to
// cover the compressor's attack so the gain has finished moving before the
// transient arrives — but push it much past that and the gain drops audibly
// *ahead* of the event, which is heard as a breath or a suck before every hit.
// Ten milliseconds is the usual ceiling for a limiter meant to be transparent,
// and it is far under the ~45 ms where audio lagging video starts to show.
export const LOOKAHEAD_BLOCKS = 4;

/**
 * Lookahead peak limiter.
 *
 * Without lookahead a limiter is always late: the transient has already passed
 * by the time the detector has seen it, so the first milliseconds of a door
 * slam go through at full level and the only way to catch them is an attack so
 * fast it distorts. Delaying the audio and computing the gain from the
 * undelayed copy means the gain is already down when the peak arrives, and the
 * ramp can be gentle. This is the whole character of a good brickwall.
 *
 * The gain applied to the block leaving the delay line is the minimum required
 * across the blocks still inside it, so nothing in flight can exceed the
 * ceiling. Recovery is a one-pole release, because coming back up is the part
 * that is allowed to be gradual.
 *
 * This is a sample-peak ceiling, not true-peak: inter-sample peaks can still
 * sit a little above it. That is a clipping concern on the way out of a DAC
 * rather than something audible here, and the ceiling leaves headroom for it.
 */
export class LookaheadLimiter {
  constructor(sampleRate, blockSize, ceilingDb = -1.5, releaseTau = 0.06) {
    this.dt = blockSize / sampleRate;
    this.ceilingDb = ceilingDb;
    this.releaseTau = releaseTau;
    this.window = [];
    this.gainDb = 0;
  }

  /**
   * @param {number} peakDb peak of the block just entering the delay line
   * @returns {number} gain for the block now leaving it
   */
  process(peakDb) {
    this.window.push(Math.min(0, this.ceilingDb - peakDb));
    if (this.window.length > LOOKAHEAD_BLOCKS + 1) this.window.shift();

    const required = Math.min(...this.window);
    if (required < this.gainDb) {
      // Attack is instant because it is not late: the peak this answers to is
      // still inside the delay line.
      this.gainDb = required;
    } else {
      this.gainDb = required + (this.gainDb - required) * Math.exp(-this.dt / this.releaseTau);
    }
    return this.gainDb;
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

const BLOCK = 128;

class LevoraProcessor extends Base {
  constructor() {
    super();
    this.rate = globalThis.sampleRate ?? 48000;
    this.core = new LevoraCore(this.rate, BLOCK);
    this.meter = new LoudnessMeter(this.rate, 2);
    this.limiter = new LookaheadLimiter(this.rate, BLOCK);

    // Block-granular delay: process() always gets exactly 128 frames, so the
    // ring can hold whole blocks and the read is a swap rather than a copy.
    this.delay = Array.from({ length: LOOKAHEAD_BLOCKS }, () => [
      new Float32Array(BLOCK),
      new Float32Array(BLOCK),
    ]);
    this.delayIndex = 0;

    this.gain = 1;
    // Output make-up. Not part of the core: it changes loudness on purpose,
    // which is exactly what the dynamics controls must never do. It sits before
    // the limiter so that pushing it up drives limiting rather than clipping.
    this.outputDb = 0;
    // Bypass lives here rather than as a parallel dry path in the graph.
    //
    // A dry path is the obvious way to guarantee transparency when off, and it
    // was wrong: the wet side is delayed by the lookahead, so while the two
    // crossfade — and setTargetAtTime is exponential, so "while" means a good
    // fraction of a second — the same audio reaches the output twice, about
    // 10 ms apart. That is a slapback, and it is heard as the sound doubling
    // and getting louder. There can only ever be one path.
    this.bypass = true;
    this.sinceReport = 0;
    this.port.onmessage = (event) => {
      const data = event.data;
      if (data?.type === "params") {
        const { outputDb, bypass, ...core } = data.params;
        if (Number.isFinite(outputDb)) this.outputDb = outputDb;
        if (typeof bypass === "boolean") this.bypass = bypass;
        this.core.setParams(core);
      }
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
    const result = this.core.processBlock(this.meter.measure(input, frames));

    // Everything is decided from the block just arrived and applied to the
    // block leaving the delay line, which is what gives the whole chain
    // lookahead rather than only the limiter: the gain has already finished
    // moving by the time the transient that caused it is heard.
    let peak = 0;
    for (const channel of input) {
      for (let i = 0; i < frames; i += 1) {
        const magnitude = channel[i] < 0 ? -channel[i] : channel[i];
        if (magnitude > peak) peak = magnitude;
      }
    }

    // The limiter has to judge the peak that will actually be heard, so the
    // gains ahead of it are added in dB rather than measured after the fact.
    const beforeLimiterDb = result.gainDb + this.outputDb;
    const predictedPeakDb = 20 * Math.log10(Math.max(peak, FLOOR)) + beforeLimiterDb;
    const limited = beforeLimiterDb + this.limiter.process(predictedPeakDb);

    // Bypassed, this is a plain delay line. The core kept running above, so its
    // idea of the programme is still warm when the user switches back on — and
    // the per-sample ramp below makes the switch itself click-free.
    const totalDb = this.bypass ? 0 : limited;

    // Read before write: the slot about to be overwritten holds the block from
    // LOOKAHEAD_BLOCKS calls ago, which is the one that should be heard now.
    const emerging = this.delay[this.delayIndex];
    const from = this.gain;
    const to = ampFromDb(totalDb);
    const step = (to - from) / frames;
    for (let c = 0; c < output.length; c += 1) {
      const source = emerging[Math.min(c, emerging.length - 1)];
      const destination = output[c];
      let gain = from;
      for (let i = 0; i < frames; i += 1) {
        destination[i] = source[i] * gain;
        gain += step;
      }
    }
    this.gain = to;

    for (let c = 0; c < emerging.length; c += 1) {
      emerging[c].set(input[Math.min(c, input.length - 1)].subarray(0, frames));
    }
    this.delayIndex = (this.delayIndex + 1) % LOOKAHEAD_BLOCKS;

    this.sinceReport += frames;
    if (this.sinceReport >= this.rate / 10) {
      this.sinceReport = 0;
      // The programme level goes up with the meter so the popup can show what
      // the relative controls resolve to. It is a real LUFS value, which is the
      // number a person actually means by "how loud is this".
      this.port.postMessage({
        reduction: result.reductionDb,
        gainDb: totalDb,
        programmeDb: this.core.refDb,
        thresholdDb: result.thresholdDb,
        limiting: this.limiter.gainDb,
      });
    }
    return true;
  }
}

if (typeof registerProcessor === "function") {
  registerProcessor("levora", LevoraProcessor);
}
