// Levora — the control surface.
//
// Two modes over one mechanism. Basic is two sliders; advanced is the three
// numbers the engine actually takes. Basic does not simplify by hiding a
// feature — it drives the same three values off one curve, so switching to
// advanced shows you where you already were rather than starting somewhere
// else.
//
//   strength     0..100. Drives holdAbove, reachBelow and ratio together.
//   holdAbove    LU above the programme's own loudness. Anything louder is
//                held down to this line, at both timescales.
//   reachBelow   LU below it. Levelling tapers to nothing here, so this is how
//                deep it reaches.
//   ratio        how hard the compression is above the threshold.
//   output       make-up gain, in dB.
//
// The two level controls are in LU, not dB, and that distinction is doing work.
// LU is the unit for loudness *relative* to a reference; LUFS is the absolute
// scale. "+8 LU" means eight above this programme's own level — which for
// ordinary material lands somewhere near -12 LUFS, nowhere near full scale.
// Labelling it "dB" invites the reasonable question of why a threshold is
// allowed above zero, and the answer is that it is not that kind of zero: film
// sits 15-20 dB below its own peaks, so a threshold above the programme level
// is still well under the ceiling.
//
// `output` is the one control that changes loudness, and it says so. Everything
// else must not: a dynamics control that also moves the level gets tuned by
// level, because louder wins in the first few seconds. Making make-up explicit
// and separate is what keeps that honest — it is not a loophole in the rule, it
// is the rule stated properly.
//
// Loads as a content script, a popup import and a test import, so it writes to
// globalThis rather than exporting.

(() => {
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const lerp = (a, b, t) => a + (b - a) * t;

  /**
   * Knob and slider ranges. `taper` bends the travel: 1 is linear, higher gives
   * more of the sweep to the low end. Ratio gets a taper because the difference
   * between 2:1 and 4:1 is enormous and the difference between 16:1 and 18:1 is
   * nothing.
   */
  const RANGES = {
    strength: { min: 0, max: 100, step: 1, taper: 1, unit: "%", signed: false },
    holdAboveDb: { min: -12, max: 18, step: 0.5, taper: 1, unit: "LU", signed: true },
    reachBelowDb: { min: -48, max: -6, step: 1, taper: 1, unit: "LU", signed: true },
    ratio: { min: 1, max: 20, step: 0.1, taper: 2, unit: ":1", signed: false },
    outputDb: { min: 0, max: 18, step: 0.5, taper: 1, unit: "dB", signed: false },
  };

  const ADVANCED_KEYS = ["holdAboveDb", "reachBelowDb", "ratio"];
  const BASIC_KEYS = ["strength"];
  const OUTPUT_KEY = "outputDb";
  const keys = [...BASIC_KEYS, ...ADVANCED_KEYS, OUTPUT_KEY];

  const MODES = ["basic", "advanced"];

  /**
   * How the gain is arrived at.
   *
   *   static    Gain is a function of the current level and nothing else. The
   *             same input level always gives the same output level, so a quiet
   *             line after an explosion sounds as it would in silence.
   *   adaptive  A slow loop chases the programme level. It levels scene to
   *             scene far more completely — about 2 dB of a 16 dB gap, against
   *             roughly 7 for static — but because the gain depends on what came
   *             before, the end of a loud passage lets quiet material drift up
   *             and its return pushes it back down. Smooth, but a swing, and an
   *             audible one.
   *
   * Static is the default because predictability is worth more here than the
   * last few dB of levelling, and the swing is the thing people notice.
   */
  const RESPONSES = ["static", "adaptive"];

  const DEFAULTS = {
    on: false,
    mode: "basic",
    response: "static",
    strength: 55,
    holdAboveDb: 4,
    reachBelowDb: -28,
    ratio: 5,
    outputDb: 0,
  };

  // Knee, attack and release are not on either surface. They shape character
  // rather than amount, the program-dependent release already adapts the part
  // that matters most, and a panel stops being read past about three knobs.
  const FIXED = { knee: 8, attack: 0.005, release: 0.25 };

  // The ends of the basic slider. Gentle is close to transparent: a threshold
  // well above the programme, a floor that reaches almost nowhere, and barely
  // any ratio.
  const GENTLE = { holdAboveDb: 14, reachBelowDb: -8, ratio: 1.5 };
  const HARD = { holdAboveDb: -4, reachBelowDb: -44, ratio: 16 };

  /** Presets are points on the basic curve, so both modes agree on them. */
  const PRESETS = [
    { id: "light", strength: 25 },
    { id: "speech", strength: 45 },
    { id: "movie", strength: 65 },
    { id: "night", strength: 85 },
  ];

  /** Clamp and quantise one control to its range. */
  function coerce(key, value) {
    const range = RANGES[key];
    if (!range) return value;
    const number = Number(value);
    if (!Number.isFinite(number)) return DEFAULTS[key];
    const stepped = Math.round(number / range.step) * range.step;
    return clamp(Number(stepped.toFixed(4)), range.min, range.max);
  }

  /** The three engine values a basic strength stands for. */
  function fromStrength(strength) {
    const t = coerce("strength", strength) / 100;
    return {
      holdAboveDb: coerce("holdAboveDb", lerp(GENTLE.holdAboveDb, HARD.holdAboveDb, t)),
      reachBelowDb: coerce("reachBelowDb", lerp(GENTLE.reachBelowDb, HARD.reachBelowDb, t)),
      ratio: coerce("ratio", lerp(GENTLE.ratio, HARD.ratio, t)),
    };
  }

  /** A complete, valid settings object from whatever was stored or sent. */
  function normalise(settings) {
    const result = {
      on: !!settings?.on,
      mode: MODES.includes(settings?.mode) ? settings.mode : DEFAULTS.mode,
      response: RESPONSES.includes(settings?.response)
        ? settings.response
        : DEFAULTS.response,
    };
    for (const key of keys) {
      result[key] = coerce(key, settings?.[key] ?? DEFAULTS[key]);
    }
    return result;
  }

  /** The three values in force, whichever mode is driving them. */
  function effective(settings) {
    const normalised = normalise(settings);
    if (normalised.mode === "basic") return fromStrength(normalised.strength);
    return {
      holdAboveDb: normalised.holdAboveDb,
      reachBelowDb: normalised.reachBelowDb,
      ratio: normalised.ratio,
    };
  }

  /**
   * What the worklet is given.
   *
   * `bypass` rides along with the rest because the worklet is always in the
   * signal path — being off means it passes the delayed input through, not that
   * a second path takes over. Two paths meant the same audio reaching the
   * output twice, a lookahead apart.
   */
  function resolve(settings) {
    const normalised = normalise(settings);
    return {
      ...FIXED,
      ...effective(normalised),
      response: normalised.response,
      outputDb: normalised.outputDb,
      bypass: !normalised.on,
    };
  }

  /**
   * Switch modes. Nothing else changes.
   *
   * Each mode owns its own controls and neither writes to the other's, so the
   * switch is reversible: whatever the knobs were left on is what you find when
   * you come back, and the same for the slider.
   *
   * An earlier version carried the basic slider's meaning into the knobs on the
   * way to advanced, so that the sound would not change at the switch. That
   * traded a surprise for a loss: carefully set knobs were silently overwritten
   * by a glance at basic mode. A level change is undone by switching back; a
   * destroyed setting is not.
   *
   * The two exceptions are deliberate and are the same control in both panels
   * rather than two of them: `output`, which is shown in both, and `response`,
   * which is a preference about character and applies whichever panel is open.
   */
  function withMode(settings, mode) {
    return normalise({ ...normalise(settings), mode });
  }

  // --- travel --------------------------------------------------------------

  /** Control value -> 0..1 along the sweep. */
  function positionOf(key, value) {
    const { min, max, taper } = RANGES[key];
    const linear = (coerce(key, value) - min) / (max - min);
    return clamp(linear, 0, 1) ** (1 / taper);
  }

  /** 0..1 along the sweep -> control value. */
  function valueAt(key, position) {
    const { min, max, taper } = RANGES[key];
    return coerce(key, min + (max - min) * clamp(position, 0, 1) ** taper);
  }

  // --- display -------------------------------------------------------------

  function format(key, value) {
    const range = RANGES[key];
    const number = coerce(key, value);
    if (key === "ratio") return `${number.toFixed(number < 10 ? 1 : 0)}:1`;
    if (range.unit === "%") return `${Math.round(number)}%`;
    const sign = range.signed && number > 0 ? "+" : number < 0 ? "−" : "";
    const magnitude = Math.abs(number).toFixed(number % 1 === 0 ? 0 : 1);
    return `${sign}${magnitude} ${range.unit}`;
  }

  /**
   * The absolute level a relative control lands on, given the programme
   * loudness the worklet is reporting. Null until it has reported.
   */
  function absolute(value, programmeDb) {
    if (!Number.isFinite(programmeDb) || programmeDb <= -70) return null;
    return programmeDb + Number(value);
  }

  function presetFor(settings) {
    const normalised = normalise(settings);
    const near = (a, b) => Math.abs(a - b) < 1e-6;
    const hit = PRESETS.find((preset) => {
      if (normalised.mode === "basic") return near(preset.strength, normalised.strength);
      const values = fromStrength(preset.strength);
      return ADVANCED_KEYS.every((key) => near(values[key], normalised[key]));
    });
    return hit ? hit.id : null;
  }

  globalThis.LevoraControls = {
    RANGES,
    DEFAULTS,
    RESPONSES,
    FIXED,
    GENTLE,
    HARD,
    PRESETS,
    MODES,
    keys,
    BASIC_KEYS,
    ADVANCED_KEYS,
    OUTPUT_KEY,
    clamp,
    coerce,
    fromStrength,
    normalise,
    effective,
    resolve,
    withMode,
    positionOf,
    valueAt,
    format,
    absolute,
    presetFor,
  };
})();
