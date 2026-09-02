// The DSP, driven directly. `LevoraCore.processBlock` takes one number — the
// loudness of a block — and returns the gain to apply, so the whole chain is
// testable as arithmetic, with no audio graph and no browser.
//
// Two regressions these guard:
//
//   * An early version aimed the leveller at short-term *input* loudness, which
//     makes the output copy the very envelope it was asked to flatten. Gain
//     reduction looked healthy, the meter moved, and nothing was levelled. Only
//     a test that plays a programme and looks at what comes out catches that.
//
//   * Both user controls are relative to the programme's own loudness, which is
//     the reason one setting can work on YouTube and on a quiet disc rip. That
//     is a property worth asserting, not assuming.

import test from "node:test";
import assert from "node:assert/strict";

import { LevoraCore, staticCurveDb } from "../src/worklet/levora-processor.js";
import "../src/lib/controls.js";

const controls = globalThis.LevoraControls;

const RATE = 48000;
const BLOCK = 128;
const BLOCKS_PER_SECOND = RATE / BLOCK; // 375
const seconds = (n) => Math.round(n * BLOCKS_PER_SECOND);

function core(settings) {
  const instance = new LevoraCore(RATE, BLOCK);
  instance.setParams(controls.resolve({ ...controls.DEFAULTS, ...settings }));
  return instance;
}

/** Run a dB timeline through the core; returns output loudness per block. */
function run(instance, timeline) {
  return timeline.map((inDb) => inDb + instance.processBlock(inDb).gainDb);
}

function trace(instance, timeline) {
  return timeline.map((inDb) => instance.processBlock(inDb).reductionDb);
}

const level = (db, duration) => new Array(seconds(duration)).fill(db);

/** Quiet scene, loud scene, over and over. */
function programme(cycles, quietDb, loudDb, sceneSeconds = 20) {
  const ticks = [];
  for (let i = 0; i < cycles; i += 1) {
    ticks.push(...level(quietDb, sceneSeconds), ...level(loudDb, sceneSeconds));
  }
  return ticks;
}

/**
 * Loudness spread between scenes, sampled where each scene has settled.
 *
 * Measuring the raw tail would be measuring the wrong thing: at a quiet-to-loud
 * cut the gain is still the one the quiet scene earned, so a transition always
 * shows an excursion — and a *better* leveller shows a bigger one, because it
 * had further to come down. Levelling is a claim about how scenes compare once
 * the loop has caught up.
 */
function sceneSpread(output, sceneSeconds = 20) {
  const scene = seconds(sceneSeconds);
  const settled = [];
  for (let i = Math.floor(output.length / 2); i < output.length; i += 1) {
    if (i % scene >= scene - seconds(5)) settled.push(output[i]);
  }
  return Math.max(...settled) - Math.min(...settled);
}

test("static curve is transparent below the knee and compresses above it", () => {
  assert.equal(staticCurveDb(-40, -20, 4, 0), -40);
  // 10 dB over a threshold at 4:1 comes out 2.5 dB over.
  assert.equal(staticCurveDb(-10, -20, 4, 0), -17.5);
  // A soft knee has to stay monotonic across the transition, or the compressor
  // gets louder as the input gets louder somewhere in the middle.
  let previous = -Infinity;
  for (let x = -60; x <= 0; x += 0.25) {
    const y = staticCurveDb(x, -20, 6, 10);
    assert.ok(y >= previous, `knee is not monotonic at ${x} dB`);
    previous = y;
  }
});

test("one setting behaves the same on sources 12 dB apart", () => {
  // The whole reason the controls are relative. An absolute threshold would
  // make these two traces completely different, and the user would be
  // re-tuning for every site.
  const settings = { holdAboveDb: 2, reachBelowDb: -30, ratio: 8 };
  const loud = trace(core(settings), programme(4, -18, -6));
  const quiet = trace(core(settings), programme(4, -30, -18));
  const half = Math.floor(loud.length / 2);
  for (let i = half; i < loud.length; i += seconds(1)) {
    assert.ok(
      Math.abs(loud[i] - quiet[i]) < 0.5,
      `reduction diverged at block ${i}: ${loud[i].toFixed(1)} vs ${quiet[i].toFixed(1)}`,
    );
  }
});

test("gain starts at unity and never makes the source louder while settling", () => {
  // The failure this replaces: two cancelling gain nodes peaked +27 dB for a
  // third of a second on every change. Whatever else happens on startup, the
  // output may not exceed the source.
  for (const preset of controls.PRESETS) {
    const inDb = -20;
    const loudest = Math.max(...run(core(preset), level(inDb, 5)));
    assert.ok(
      loudest <= inDb + 1,
      `preset ${preset.id} reached ${loudest.toFixed(1)} dB from a ${inDb} dB source`,
    );
  }
});

test("gain settles quickly rather than crawling", () => {
  const inDb = -20;
  const output = run(core({ holdAboveDb: -2, reachBelowDb: -42, ratio: 14 }), level(inDb, 5));
  const settled = output[output.length - 1];
  const reached = output.findIndex((value) => Math.abs(value - settled) < 1);
  assert.ok(
    reached / BLOCKS_PER_SECOND < 0.6,
    `took ${(reached / BLOCKS_PER_SECOND).toFixed(2)}s to reach its level`,
  );
});

test("a deep floor flattens a 16 dB scene change", () => {
  const spread = sceneSpread(
    run(core({ holdAboveDb: 0, reachBelowDb: -40, ratio: 10 }), programme(6, -30, -14)),
  );
  assert.ok(spread < 5, `scenes still ${spread.toFixed(1)} dB apart`);
});

test("a wide window leaves the programme's dynamics alone", () => {
  // The scenes sit about 8 dB either side of the programme average. A floor at
  // −8 dB does not reach the quiet one and a threshold at +12 dB is above the
  // loud one, so neither should be touched.
  const spread = sceneSpread(
    run(core({ holdAboveDb: 12, reachBelowDb: -8, ratio: 2 }), programme(6, -30, -14)),
  );
  assert.ok(spread > 14, `dynamics were flattened by a wide window: ${spread.toFixed(1)} dB`);
});

test("the threshold holds loud scenes down, not just loud moments", () => {
  const timeline = programme(6, -30, -14);
  const wide = sceneSpread(run(core({ holdAboveDb: 12, reachBelowDb: -8, ratio: 4 }), timeline));
  const tight = sceneSpread(run(core({ holdAboveDb: 0, reachBelowDb: -8, ratio: 4 }), timeline));
  assert.ok(
    tight < wide - 4,
    `lowering the threshold did not bring the loud scene down: ${wide.toFixed(1)} then ${tight.toFixed(1)}`,
  );
});

test("levelling deepens as the floor is lowered", () => {
  const timeline = programme(6, -30, -14);
  let previous = Infinity;
  for (const reachBelowDb of [-8, -16, -24, -32, -40]) {
    const spread = sceneSpread(run(core({ holdAboveDb: 0, reachBelowDb, ratio: 10 }), timeline));
    assert.ok(
      spread <= previous + 0.5,
      `floor ${reachBelowDb} dB levelled less than the step above it`,
    );
    previous = spread;
  }
});

test("a quiet scene is lifted, not just a loud one cut", () => {
  const output = run(
    core({ holdAboveDb: 0, reachBelowDb: -40, ratio: 10 }),
    programme(6, -30, -14),
  );
  // Deep inside the last quiet scene, past any settling.
  const quiet = output[output.length - seconds(20) - seconds(2)];
  assert.ok(quiet > -30 + 5, `quiet scene came out at ${quiet.toFixed(1)} dB`);
});

test("a higher ratio compresses harder", () => {
  const timeline = [...level(-24, 3), ...level(-10, 3)];
  const deepest = (ratio) =>
    Math.min(...trace(core({ holdAboveDb: 0, reachBelowDb: -30, ratio }), timeline));
  const gentle = deepest(2);
  const hard = deepest(16);
  assert.ok(hard < gentle - 2, `2:1 reached ${gentle.toFixed(1)}, 16:1 ${hard.toFixed(1)}`);
});

test("the threshold decides how much material is touched", () => {
  const timeline = [...level(-24, 3), ...level(-14, 4)];
  const deepest = (holdAboveDb) =>
    Math.min(...trace(core({ holdAboveDb, reachBelowDb: -30, ratio: 8 }), timeline));
  assert.ok(
    deepest(-6) < deepest(12) - 2,
    "lowering the threshold did not put more material into compression",
  );
});

test("release is program-dependent: a stab recovers faster than a sustained passage", () => {
  const recovery = (loudSeconds) => {
    const instance = core({ holdAboveDb: 2, reachBelowDb: -30, ratio: 8 });
    run(instance, level(-30, 3)); // settle on the quiet material first
    run(instance, level(-8, loudSeconds));
    const after = trace(instance, level(-30, 4));
    const settled = after[after.length - 1];
    return after.findIndex((value) => Math.abs(value - settled) < 0.5) / BLOCKS_PER_SECOND;
  };
  const stab = recovery(0.05);
  const sustained = recovery(3);
  assert.ok(
    sustained > stab,
    `sustained recovered in ${sustained.toFixed(2)}s, stab in ${stab.toFixed(2)}s`,
  );
});

test("silence is frozen, not amplified", () => {
  const instance = core({ holdAboveDb: 0, reachBelowDb: -40, ratio: 10 });
  run(instance, level(-20, 3));
  const before = instance.levelDb;
  const output = run(instance, level(-90, 10)); // ten seconds of nothing
  assert.equal(instance.levelDb, before, "the leveller moved during silence");
  assert.ok(Math.max(...output) < -60, "silence was amplified toward the programme level");
});

test("changing the controls does not step the gain upward", () => {
  const instance = core({ holdAboveDb: 12, reachBelowDb: -10, ratio: 2 });
  run(instance, level(-20, 4));
  const settled = -20 + instance.processBlock(-20).gainDb;
  instance.setParams(
    controls.resolve({ holdAboveDb: -8, reachBelowDb: -44, ratio: 18 }),
  );
  const loudest = Math.max(...run(instance, level(-20, 3)));
  assert.ok(
    loudest <= Math.max(settled, -20) + 1,
    `the change pushed the output to ${loudest.toFixed(1)} dB`,
  );
});
