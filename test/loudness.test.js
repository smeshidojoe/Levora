// K-weighting and the lookahead limiter.
//
// Both are standards-shaped rather than taste-shaped, so both can be pinned
// against published numbers instead of against how they sound.

import test from "node:test";
import assert from "node:assert/strict";

import {
  kWeightingCoefficients,
  LoudnessMeter,
  LookaheadLimiter,
  LOOKAHEAD_BLOCKS,
} from "../src/worklet/levora-processor.js";

const RATE = 48000;
const BLOCK = 128;

const close = (actual, expected, tolerance, label) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual} not within ${tolerance} of ${expected}`,
  );

/** One block of a sine at a given frequency and amplitude, in both channels. */
function sine(frequency, amplitude, frames, phase = 0) {
  const channel = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    channel[i] = amplitude * Math.sin((2 * Math.PI * frequency * (phase + i)) / RATE);
  }
  return channel;
}

/**
 * Steady-state loudness of a tone.
 *
 * Averaged in the power domain over many blocks, not read off the last one. A
 * 128-frame block is a tenth of a cycle at 40 Hz, so a single reading says more
 * about where the phase happened to land than about the filter — an earlier
 * version of this file measured one block and produced a response curve that
 * was not even monotonic. The engine never sees a raw block either: it smooths
 * over 0.4 s before anything acts on the number.
 */
function measureTone(frequency, amplitude, blocks = 600, settle = 200) {
  const meter = new LoudnessMeter(RATE, 2);
  let power = 0;
  let counted = 0;
  for (let b = 0; b < blocks; b += 1) {
    const channel = sine(frequency, amplitude, BLOCK, b * BLOCK);
    const reading = meter.measure([channel, channel], BLOCK);
    if (b < settle) continue; // let the filter state settle first
    power += 10 ** ((reading + 0.691) / 10);
    counted += 1;
  }
  return -0.691 + 10 * Math.log10(power / counted);
}

test("the derived coefficients match BS.1770's published 48 kHz values", () => {
  // Deriving from the analog prototype rather than hard-coding these is what
  // makes 44.1 kHz correct too, so the derivation is what needs pinning.
  const [shelf, highpass] = kWeightingCoefficients(48000);
  close(shelf.b0, 1.53512485958697, 1e-6, "shelf b0");
  close(shelf.b1, -2.69169618940638, 1e-6, "shelf b1");
  close(shelf.b2, 1.19839281085285, 1e-6, "shelf b2");
  close(shelf.a1, -1.69065929318241, 1e-6, "shelf a1");
  close(shelf.a2, 0.73248077421585, 1e-6, "shelf a2");
  close(highpass.a1, -1.99004745483398, 1e-6, "highpass a1");
  close(highpass.a2, 0.99007225036621, 1e-6, "highpass a2");
});

test("coefficients are stable across the sample rates a browser hands out", () => {
  for (const rate of [44100, 48000, 96000]) {
    for (const stage of kWeightingCoefficients(rate)) {
      for (const value of Object.values(stage)) {
        assert.ok(Number.isFinite(value), `${rate} Hz produced ${value}`);
      }
      // Poles inside the unit circle, or the filter rings away to infinity.
      assert.ok(Math.abs(stage.a2) < 1, `${rate} Hz stage is unstable`);
    }
  }
});

test("a 1 kHz tone reads near its unweighted level", () => {
  // K-weighting is close to flat through the midrange, so 1 kHz is the anchor
  // the other readings are relative to.
  //
  // A sine of amplitude 0.5 has mean square 0.125 per channel. Two channels
  // sum, per BS.1770, and the standard's offset comes off the top:
  //   -0.691 + 10*log10(2 * 0.125) = -6.71
  const amplitude = 0.5;
  const unweighted = -0.691 + 10 * Math.log10(2 * (amplitude ** 2 / 2));
  close(measureTone(1000, amplitude), unweighted, 1, "1 kHz against its unweighted level");
});

test("the weighting curve is monotonic and shaped like the standard's", () => {
  const middle = measureTone(1000, 0.5);
  const at = (frequency) => measureTone(frequency, 0.5) - middle;

  // Rising across the audible band: the high-pass discounts the very low end,
  // and the shelf adds about 4 dB up top, where speech lives.
  let previous = -Infinity;
  for (const frequency of [30, 40, 60, 100, 250, 1000, 2000, 4000, 8000]) {
    const response = at(frequency);
    assert.ok(
      response > previous - 0.05,
      `curve dips at ${frequency} Hz: ${response.toFixed(2)} after ${previous.toFixed(2)}`,
    );
    previous = response;
  }

  // A second-order high-pass is down by exactly Q at its corner, and the RLB
  // stage has Q ~= 0.5, so the bottom of the band falls away faster than a
  // -3 dB corner would suggest: about -6 dB at 38 Hz, not -3.
  close(at(38), 20 * Math.log10(0.5003270373238773) - 0.7, 0.4, "at the RLB corner");
  close(at(20), -14, 0.6, "20 Hz");
  close(at(40), -6.3, 0.4, "40 Hz");
  close(at(1000), 0, 0.01, "1 kHz");
  close(at(6000), 3.3, 0.3, "6 kHz, on the shelf");

  // The span between a rumble and a line of dialogue is the systematic error a
  // flat RMS was making.
  assert.ok(at(3000) - at(40) > 8, `only ${(at(3000) - at(40)).toFixed(1)} dB of span`);
});

test("two channels read louder than one, as the standard requires", () => {
  const meter = new LoudnessMeter(RATE, 2);
  const mono = new LoudnessMeter(RATE, 2);
  const silent = new Float32Array(BLOCK);
  let stereo = 0;
  let single = 0;
  for (let b = 0; b < 400; b += 1) {
    const channel = sine(1000, 0.5, BLOCK, b * BLOCK);
    stereo = meter.measure([channel, channel], BLOCK);
    single = mono.measure([channel, silent], BLOCK);
  }
  // 1 kHz is high enough that a block is many cycles, so a single reading is
  // stable here — unlike at the bottom of the band.
  close(stereo - single, 3, 0.2, "stereo versus one channel");
});

test("silence reads at the floor, not at negative infinity", () => {
  const meter = new LoudnessMeter(RATE, 2);
  const silent = new Float32Array(BLOCK);
  const reading = meter.measure([silent, silent], BLOCK);
  assert.ok(Number.isFinite(reading), "silence produced a non-finite reading");
  assert.ok(reading < -100, `silence read ${reading}`);
});

// --- limiter ---------------------------------------------------------------

test("the limiter is already down when the peak arrives", () => {
  // The whole point of lookahead. The gain returned for the block leaving the
  // delay line accounts for peaks still inside it, so a transient cannot get
  // through at full level while the detector catches up.
  const limiter = new LookaheadLimiter(RATE, BLOCK, -1.5);
  for (let i = 0; i < 10; i += 1) limiter.process(-20); // quiet, no reduction
  assert.equal(limiter.gainDb, 0);

  // A +6 dBFS peak enters the line. It will not be heard for LOOKAHEAD_BLOCKS
  // blocks, but the gain must be down now.
  const gain = limiter.process(6);
  assert.ok(gain <= -7.5, `only ${gain.toFixed(1)} dB of limiting when the peak entered`);
});

test("the ceiling actually holds", () => {
  const ceiling = -1.5;
  const limiter = new LookaheadLimiter(RATE, BLOCK, ceiling);
  let worst = -Infinity;
  for (const peakDb of [-30, -10, 6, 6, 6, -10, -30, 0, -40]) {
    const gain = limiter.process(peakDb);
    // What is heard is the block that entered LOOKAHEAD_BLOCKS ago, and its
    // required gain is still inside the window, so this is a fair bound.
    worst = Math.max(worst, peakDb + gain);
  }
  assert.ok(worst <= ceiling + 0.01, `peaked at ${worst.toFixed(2)} dBFS over ${ceiling}`);
});

test("the limiter releases gradually and never boosts", () => {
  const limiter = new LookaheadLimiter(RATE, BLOCK, -1.5);
  for (let i = 0; i < 5; i += 1) limiter.process(6);
  const clamped = limiter.gainDb;
  assert.ok(clamped < -7, "no reduction was applied to a loud passage");

  // Release cannot begin while the loud blocks are still inside the lookahead
  // window — they have not been heard yet, and letting go early is exactly the
  // overshoot the window exists to prevent.
  const trail = [];
  for (let i = 0; i < 400; i += 1) trail.push(limiter.process(-40));
  for (let i = 0; i < LOOKAHEAD_BLOCKS; i += 1) {
    close(trail[i], clamped, 1e-9, `held while block ${i} was still in the window`);
  }
  assert.ok(trail[LOOKAHEAD_BLOCKS] > clamped, "release did not begin once the window cleared");
  assert.ok(trail.every((value) => value <= 0.0001), "the limiter applied gain above unity");
  assert.ok(trail[trail.length - 1] > -0.5, "the limiter never let go");
  // Gradual, not a step: it should take tens of milliseconds, not one block.
  assert.ok(
    trail[LOOKAHEAD_BLOCKS + 1] - trail[LOOKAHEAD_BLOCKS] < 1,
    "release was a jump rather than a ramp",
  );
});

test("the lookahead window covers the attack without becoming audible delay", () => {
  const delaySeconds = (LOOKAHEAD_BLOCKS * BLOCK) / RATE;
  // It has to be longer than the compressor's attack, or the gain is still
  // moving when the transient arrives and the lookahead bought nothing.
  assert.ok(delaySeconds > 0.005, `${(delaySeconds * 1000).toFixed(1)} ms is under the attack`);
  // And short enough that it is neither heard as a breath before each hit nor
  // seen as lip-sync drift; detectability for audio lagging video is ~45 ms.
  assert.ok(delaySeconds < 0.015, `${(delaySeconds * 1000).toFixed(1)} ms of delay`);
});
