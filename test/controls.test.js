import test from "node:test";
import assert from "node:assert/strict";

import "../src/lib/controls.js";

const controls = globalThis.LevoraControls;
const { RANGES, DEFAULTS, FIXED, PRESETS, keys, normalise, resolve } = controls;

test("stored junk normalises into something the worklet can use", () => {
  // Settings come back from storage written by an older version, or by hand.
  const result = normalise({ on: 1, holdAboveDb: "999", ratio: null });
  assert.equal(result.on, true);
  assert.equal(result.holdAboveDb, RANGES.holdAboveDb.max);
  assert.equal(result.ratio, DEFAULTS.ratio);
  assert.equal(result.reachBelowDb, DEFAULTS.reachBelowDb);
});

test("normalising an empty object gives the defaults, off", () => {
  const result = normalise(undefined);
  assert.equal(result.on, false);
  for (const key of keys) assert.equal(result[key], DEFAULTS[key]);
});

test("values are quantised to their step", () => {
  assert.equal(normalise({ holdAboveDb: 4.3 }).holdAboveDb, 4.5);
  assert.equal(normalise({ reachBelowDb: -28.4 }).reachBelowDb, -28);
});

test("resolve hands the worklet the fixed parameters too", () => {
  const params = resolve(DEFAULTS);
  for (const [key, value] of Object.entries(FIXED)) assert.equal(params[key], value);
  for (const key of keys) assert.equal(params[key], DEFAULTS[key]);
});

test("no control is an output level", () => {
  // The one thing this surface must never grow: a volume slider. The strength
  // control was reworked precisely because a control that changes loudness gets
  // tuned by loudness, and louder always wins in the first few seconds.
  for (const key of keys) {
    assert.ok(!/output|volume|gain|level$/i.test(key), `${key} looks like a level control`);
  }
});

test("knob travel round-trips through the taper", () => {
  for (const key of keys) {
    for (const position of [0, 0.25, 0.5, 0.75, 1]) {
      const value = controls.valueAt(key, position);
      const back = controls.positionOf(key, value);
      assert.ok(
        Math.abs(back - position) < 0.05,
        `${key} at ${position} came back as ${back.toFixed(3)}`,
      );
    }
  }
});

test("the ratio taper spends its travel where the ear is", () => {
  // 2:1 to 4:1 is an enormous change; 16:1 to 18:1 is nothing. The low end
  // must get more of the sweep, or the useful range is a sliver of the knob.
  const lowerHalf = controls.valueAt("ratio", 0.5) - RANGES.ratio.min;
  const upperHalf = RANGES.ratio.max - controls.valueAt("ratio", 0.5);
  assert.ok(lowerHalf < upperHalf, "ratio travel is not tapered toward the low end");
});

test("knob travel stays inside the range at the extremes", () => {
  for (const key of keys) {
    assert.equal(controls.valueAt(key, -5), RANGES[key].min);
    assert.equal(controls.valueAt(key, 5), RANGES[key].max);
  }
});

test("presets are valid settings and are recognised back", () => {
  for (const preset of PRESETS) {
    const settings = normalise({ ...preset, on: true });
    for (const key of keys) {
      assert.equal(settings[key], preset[key], `preset ${preset.id} shifted on ${key}`);
    }
    assert.equal(controls.presetFor(settings), preset.id);
  }
  assert.equal(controls.presetFor(normalise({ holdAboveDb: 7.5 })), null);
});

test("presets get deeper in one direction", () => {
  // Light through Night should be a single axis: lower threshold, deeper floor,
  // higher ratio. A preset row that wanders is a preset row nobody trusts.
  for (let i = 1; i < PRESETS.length; i += 1) {
    const previous = PRESETS[i - 1];
    const current = PRESETS[i];
    assert.ok(current.holdAboveDb < previous.holdAboveDb, `${current.id} threshold`);
    assert.ok(current.reachBelowDb < previous.reachBelowDb, `${current.id} floor`);
    assert.ok(current.ratio > previous.ratio, `${current.id} ratio`);
  }
});

test("relative controls resolve against the measured programme level", () => {
  assert.equal(controls.absolute(4, -18), -14);
  assert.equal(controls.absolute(-28, -18), -46);
  // Nothing measured yet, or silence: there is no absolute value to show.
  assert.equal(controls.absolute(4, null), null);
  assert.equal(controls.absolute(4, -90), null);
});

test("formatting is signed for dB and never for ratio", () => {
  assert.equal(controls.format("holdAboveDb", 4), "+4 dB");
  assert.equal(controls.format("reachBelowDb", -28), "−28 dB");
  assert.equal(controls.format("holdAboveDb", 0), "0 dB");
  assert.equal(controls.format("ratio", 5), "5.0:1");
  assert.equal(controls.format("ratio", 12), "12:1");
});
