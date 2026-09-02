// Levora — the control surface.
//
// Three numbers, all of them things a person can point at:
//
//   holdAbove   dB above the programme's own loudness. Anything louder than
//               this gets compressed. Raise it and only the peaks are touched;
//               lower it and the compressor works on most of the material.
//   reachBelow  dB below the programme's loudness. The levelling tapers to
//               nothing here, so this is how deep it reaches. Raise it and only
//               prominent material is lifted; lower it and quiet passages come
//               up too — with whatever noise is under them.
//   ratio       how hard the compression is above the threshold.
//
// The two dB controls are relative to the programme rather than absolute. An
// absolute threshold is right in a DAW, where the material is known; a browser
// sees YouTube near -14 LUFS, a disc rip near -27 and a podcast near -16, and
// one absolute number does three different things to them. Relative, one
// setting behaves the same everywhere — and since the worklet is measuring the
// programme anyway, the popup can show the resolved dBFS next to it.
//
// This replaced a single abstract 0..100 "strength" that drove threshold,
// ratio, knee, attack, release and levelling depth off one curve. It was
// opaque, and it welded together two genuinely independent decisions: how hard
// to compress, and how far down to reach.
//
// Loads as a content script, a popup import and a test import, so it writes to
// globalThis rather than exporting.

(() => {
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  /**
   * Knob ranges. `taper` bends the control's travel: 1 is linear, higher values
   * give more of the sweep to the low end. Ratio gets a taper because the
   * difference between 2:1 and 4:1 is enormous and the difference between 16:1
   * and 18:1 is nothing.
   */
  const RANGES = {
    holdAboveDb: { min: -12, max: 18, step: 0.5, taper: 1, unit: "dB", signed: true },
    reachBelowDb: { min: -48, max: -6, step: 1, taper: 1, unit: "dB", signed: true },
    ratio: { min: 1, max: 20, step: 0.1, taper: 2, unit: ":1", signed: false },
  };

  const DEFAULTS = { on: false, holdAboveDb: 4, reachBelowDb: -28, ratio: 5 };

  // Knee, attack and release are not on the surface. They shape character
  // rather than amount, the program-dependent release already adapts the part
  // that matters most, and three knobs is the point at which a control panel
  // stops being read.
  const FIXED = { knee: 8, attack: 0.005, release: 0.25 };

  const PRESETS = [
    { id: "light", holdAboveDb: 8, reachBelowDb: -16, ratio: 2.5 },
    { id: "speech", holdAboveDb: 3, reachBelowDb: -24, ratio: 5 },
    { id: "movie", holdAboveDb: 2, reachBelowDb: -32, ratio: 8 },
    { id: "night", holdAboveDb: -2, reachBelowDb: -42, ratio: 14 },
  ];

  const keys = Object.keys(RANGES);

  /** Clamp and quantise one control to its range. */
  function coerce(key, value) {
    const range = RANGES[key];
    if (!range) return value;
    const number = Number(value);
    if (!Number.isFinite(number)) return DEFAULTS[key];
    const stepped = Math.round(number / range.step) * range.step;
    return clamp(Number(stepped.toFixed(4)), range.min, range.max);
  }

  /** A complete, valid settings object from whatever was stored or sent. */
  function normalise(settings) {
    const result = { on: !!settings?.on };
    for (const key of keys) {
      result[key] = coerce(key, settings?.[key] ?? DEFAULTS[key]);
    }
    return result;
  }

  /** What the worklet is given. */
  function resolve(settings) {
    const normalised = normalise(settings);
    return {
      ...FIXED,
      holdAboveDb: normalised.holdAboveDb,
      reachBelowDb: normalised.reachBelowDb,
      ratio: normalised.ratio,
    };
  }

  // --- knob travel ---------------------------------------------------------

  /** Control value -> 0..1 along the knob's sweep. */
  function positionOf(key, value) {
    const { min, max, taper } = RANGES[key];
    const linear = (coerce(key, value) - min) / (max - min);
    return clamp(linear, 0, 1) ** (1 / taper);
  }

  /** 0..1 along the knob's sweep -> control value. */
  function valueAt(key, position) {
    const { min, max, taper } = RANGES[key];
    return coerce(key, min + (max - min) * clamp(position, 0, 1) ** taper);
  }

  // --- display -------------------------------------------------------------

  function format(key, value) {
    const range = RANGES[key];
    const number = coerce(key, value);
    if (key === "ratio") return `${number.toFixed(number < 10 ? 1 : 0)}:1`;
    const sign = range.signed && number > 0 ? "+" : number < 0 ? "−" : "";
    return `${sign}${Math.abs(number).toFixed(number % 1 === 0 ? 0 : 1)} dB`;
  }

  /**
   * The absolute level a relative control lands on, given the programme
   * loudness the worklet is currently reporting. Null until it has reported.
   */
  function absolute(value, programmeDb) {
    if (!Number.isFinite(programmeDb) || programmeDb <= -70) return null;
    return programmeDb + Number(value);
  }

  function presetFor(settings) {
    const hit = PRESETS.find((preset) =>
      keys.every((key) => Math.abs(preset[key] - settings[key]) < 1e-6),
    );
    return hit ? hit.id : null;
  }

  globalThis.LevoraControls = {
    RANGES,
    DEFAULTS,
    FIXED,
    PRESETS,
    keys,
    clamp,
    coerce,
    normalise,
    resolve,
    positionOf,
    valueAt,
    format,
    absolute,
    presetFor,
  };
})();
