import test from "node:test";
import assert from "node:assert/strict";

import "../src/lib/controls.js";

const controls = globalThis.LevoraControls;
const {
  RANGES,
  DEFAULTS,
  FIXED,
  PRESETS,
  MODES,
  keys,
  ADVANCED_KEYS,
  OUTPUT_KEY,
  normalise,
  resolve,
  effective,
  fromStrength,
  withMode,
} = controls;

test("stored junk normalises into something the worklet can use", () => {
  // Settings come back from storage written by an older version, or by hand.
  const result = normalise({ on: 1, holdAboveDb: "999", ratio: null, mode: "sideways" });
  assert.equal(result.on, true);
  assert.equal(result.mode, DEFAULTS.mode);
  assert.equal(result.holdAboveDb, RANGES.holdAboveDb.max);
  assert.equal(result.ratio, DEFAULTS.ratio);
});

test("normalising an empty object gives the defaults, off", () => {
  const result = normalise(undefined);
  assert.equal(result.on, false);
  assert.ok(MODES.includes(result.mode));
  for (const key of keys) assert.equal(result[key], DEFAULTS[key]);
});

test("values are quantised to their step", () => {
  assert.equal(normalise({ holdAboveDb: 4.3 }).holdAboveDb, 4.5);
  assert.equal(normalise({ reachBelowDb: -28.4 }).reachBelowDb, -28);
  assert.equal(normalise({ outputDb: 3.2 }).outputDb, 3);
});

test("resolve hands the worklet the fixed parameters and the output gain", () => {
  const params = resolve(DEFAULTS);
  for (const [key, value] of Object.entries(FIXED)) assert.equal(params[key], value);
  assert.equal(params.outputDb, DEFAULTS.outputDb);
  for (const key of ADVANCED_KEYS) assert.ok(Number.isFinite(params[key]));
  // Strength is a control, not a parameter: it exists to drive the other three
  // and the engine never sees it.
  assert.equal(params.strength, undefined);
});

test("the response defaults to static and rejects anything else", () => {
  // Static is the default because gain that depends on what came before is
  // heard as a swing, and the measured levelling is no worse.
  assert.equal(DEFAULTS.response, "static");
  assert.equal(normalise({ response: "wobbly" }).response, "static");
  assert.equal(normalise({ response: "adaptive" }).response, "adaptive");
  assert.equal(resolve({ ...DEFAULTS, response: "adaptive" }).response, "adaptive");
});

test("the parameters are complete whether on or off", () => {
  // The page-world hook is handed `resolve()` output and nothing else, so every
  // value it needs has to be in there in both states. Publishing a bare "off"
  // left a page-world graph compressing after the user switched the extension
  // off, because it was never told.
  const off = resolve({ ...DEFAULTS, on: false });
  const on = resolve({ ...DEFAULTS, on: true });
  assert.deepEqual(Object.keys(off).sort(), Object.keys(on).sort());
  for (const key of Object.keys(on)) {
    assert.ok(off[key] !== undefined, `${key} is missing while off`);
  }
});

test("bypass is a parameter, not a second signal path", () => {
  // It has to be. The worklet delays the signal by the lookahead, so a parallel
  // dry path beside it puts the same audio out twice about 10 ms apart — heard
  // as the sound doubling and swelling on every toggle. Being off means the
  // worklet passes its delayed input through, and there is only ever one path
  // to the destination.
  assert.equal(resolve({ ...DEFAULTS, on: true }).bypass, false);
  assert.equal(resolve({ ...DEFAULTS, on: false }).bypass, true);
});

test("basic mode ignores the stored knob values, advanced mode uses them", () => {
  const stored = { holdAboveDb: -10, reachBelowDb: -46, ratio: 19, strength: 10 };
  const asBasic = resolve({ ...DEFAULTS, ...stored, mode: "basic" });
  const asAdvanced = resolve({ ...DEFAULTS, ...stored, mode: "advanced" });
  assert.deepEqual(
    { holdAboveDb: asBasic.holdAboveDb, ratio: asBasic.ratio },
    { holdAboveDb: fromStrength(10).holdAboveDb, ratio: fromStrength(10).ratio },
  );
  assert.equal(asAdvanced.holdAboveDb, -10);
  assert.equal(asAdvanced.ratio, 19);
});

test("exactly one control is an output level, and it is named as one", () => {
  // The rule this replaces was "no control is an output level", which was too
  // blunt. What must not happen is a *dynamics* control that also moves the
  // level: it then gets tuned by level, because louder wins in the first few
  // seconds. Make-up is a real part of a compressor; the fix is that it is
  // separate and says what it is, not that it is absent.
  const levels = keys.filter((key) => /output|volume|gain/i.test(key));
  assert.deepEqual(levels, [OUTPUT_KEY]);
  assert.equal(RANGES[OUTPUT_KEY].unit, "dB", "make-up is a gain, so it is in dB");
  // And it only goes up: turning the system volume down is not this tool's job.
  assert.equal(RANGES[OUTPUT_KEY].min, 0);
});

test("the level controls are in LU, because they are relative", () => {
  // LU is loudness relative to a reference; LUFS is absolute. Labelling these
  // "dB" is what makes a threshold above zero look like an overload.
  for (const key of ["holdAboveDb", "reachBelowDb"]) {
    assert.equal(RANGES[key].unit, "LU", key);
  }
  // A threshold above the programme's own level is ordinary, not a mistake:
  // film sits 15-20 dB below its own peaks.
  assert.ok(RANGES.holdAboveDb.max > 0);
});

test("strength drives all three values in one direction", () => {
  let previous = fromStrength(0);
  for (let strength = 5; strength <= 100; strength += 5) {
    const current = fromStrength(strength);
    assert.ok(current.holdAboveDb <= previous.holdAboveDb, `threshold at ${strength}`);
    assert.ok(current.reachBelowDb <= previous.reachBelowDb, `floor at ${strength}`);
    assert.ok(current.ratio >= previous.ratio, `ratio at ${strength}`);
    previous = current;
  }
  // The ends have to actually differ, or the slider does nothing.
  const gentle = fromStrength(0);
  const hard = fromStrength(100);
  assert.ok(gentle.holdAboveDb - hard.holdAboveDb > 10, "threshold barely travels");
  assert.ok(gentle.reachBelowDb - hard.reachBelowDb > 20, "floor barely travels");
});

test("switching modes is reversible and touches nothing else", () => {
  // Neither panel may write to the other's controls. An earlier version carried
  // the basic slider into the knobs on the way to advanced so the sound would
  // not change — and silently destroyed hand-set knob values in the process. A
  // level change is undone by switching back; a lost setting is not.
  const tuned = normalise({
    mode: "advanced",
    on: true,
    strength: 70,
    holdAboveDb: -7,
    reachBelowDb: -41,
    ratio: 17,
    outputDb: 9,
  });
  const roundTrip = withMode(withMode(tuned, "basic"), "advanced");
  assert.deepEqual(roundTrip, tuned);

  // And going the other way leaves the slider exactly where it was.
  assert.equal(withMode(tuned, "basic").strength, 70);
  assert.equal(withMode(tuned, "basic").outputDb, 9);
});

test("each mode's controls reach the engine and the other mode's do not", () => {
  const both = {
    on: true,
    strength: 20,
    holdAboveDb: -7,
    reachBelowDb: -41,
    ratio: 17,
  };
  assert.deepEqual(effective({ ...both, mode: "basic" }), fromStrength(20));
  assert.deepEqual(effective({ ...both, mode: "advanced" }), {
    holdAboveDb: -7,
    reachBelowDb: -41,
    ratio: 17,
  });
});

test("output and response are one control each, not one per mode", () => {
  // Deliberate exceptions to the separation: `output` appears in both panels
  // and `response` applies whichever panel is open, so neither is a per-mode
  // value that could disagree with itself.
  const loud = normalise({ mode: "advanced", outputDb: 9, response: "adaptive" });
  assert.equal(withMode(loud, "basic").outputDb, 9);
  assert.equal(withMode(loud, "basic").response, "adaptive");
  assert.equal(resolve(withMode(loud, "basic")).response, "adaptive");
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
  const midpoint = controls.valueAt("ratio", 0.5);
  assert.ok(midpoint - RANGES.ratio.min < RANGES.ratio.max - midpoint);
});

test("travel stays inside the range at the extremes", () => {
  for (const key of keys) {
    assert.equal(controls.valueAt(key, -5), RANGES[key].min);
    assert.equal(controls.valueAt(key, 5), RANGES[key].max);
  }
});

test("presets are one point expressed two ways", () => {
  // Clicking a preset writes only the panel it was clicked in, so recognition
  // has to work from either set of values on its own.
  for (const preset of PRESETS) {
    const asBasic = normalise({ strength: preset.strength, mode: "basic" });
    assert.equal(controls.presetFor(asBasic), preset.id);

    const asAdvanced = normalise({ ...fromStrength(preset.strength), mode: "advanced" });
    assert.equal(controls.presetFor(asAdvanced), preset.id);
  }
  assert.equal(controls.presetFor(normalise({ strength: 37 })), null);
});

test("presets get deeper in one direction", () => {
  // Light through Night should be a single axis. A preset row that wanders is a
  // preset row nobody trusts.
  for (let i = 1; i < PRESETS.length; i += 1) {
    assert.ok(
      PRESETS[i].strength > PRESETS[i - 1].strength,
      `${PRESETS[i].id} is not stronger than ${PRESETS[i - 1].id}`,
    );
  }
});

test("relative controls resolve against the measured programme level", () => {
  assert.equal(controls.absolute(4, -18), -14);
  assert.equal(controls.absolute(-28, -18), -46);
  // Nothing measured yet, or silence: there is no absolute value to show.
  assert.equal(controls.absolute(4, null), null);
  assert.equal(controls.absolute(4, -90), null);
});

test("formatting carries the unit, signed only where a sign means something", () => {
  assert.equal(controls.format("holdAboveDb", 4), "+4 LU");
  assert.equal(controls.format("reachBelowDb", -28), "−28 LU");
  assert.equal(controls.format("holdAboveDb", 0), "0 LU");
  assert.equal(controls.format("outputDb", 6), "6 dB");
  assert.equal(controls.format("ratio", 5), "5.0:1");
  assert.equal(controls.format("ratio", 12), "12:1");
  assert.equal(controls.format("strength", 55), "55%");
});
