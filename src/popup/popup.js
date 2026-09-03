// Levora popup.
//
// The knobs write through the background, which owns persistence, rather than
// straight to the tab — so the value that is applied and the value that is
// stored can never disagree.
//
// The meter is pushed rather than polled. Gain reduction moves continuously,
// and the content script's own reports are debounced and event-driven — right
// for state, wrong for a meter. Polling is worse still: tabs.sendMessage
// reaches every frame but resolves on whichever answers first, so on a page
// whose video sits in an iframe it would report the empty top frame. Instead
// the popup leases the meter, every frame pushes its own snapshot, and they are
// merged here by frame id.

import "../lib/controls.js";

const api = globalThis.browser ?? globalThis.chrome;
const controls = globalThis.LevoraControls;
const {
  RANGES,
  DEFAULTS,
  PRESETS,
  MODES,
  BASIC_KEYS,
  ADVANCED_KEYS,
  OUTPUT_KEY,
  normalise,
  positionOf,
  valueAt,
  format,
} = controls;

// Basic gets the two sliders the job actually needs: how much, and how loud.
// Advanced gets the engine's own three plus the same output.
const LAYOUT = {
  basic: [...BASIC_KEYS, OUTPUT_KEY],
  advanced: [...ADVANCED_KEYS, OUTPUT_KEY],
};

const LEASE_MS = 1000; // the content side expires the meter lease after 3 s
const SWEEP = 270; // degrees of knob travel
const START = -135;
const DRAG_PX = 150; // pixels of vertical drag for the full sweep
const FINE = 5; // shift divides the sensitivity by this

const el = {
  origin: document.getElementById("origin"),
  control: document.getElementById("control"),
  power: document.getElementById("power"),
  modes: document.getElementById("modes"),
  sliders: document.getElementById("sliders"),
  knobs: document.getElementById("knobs"),
  advanced: document.getElementById("advanced"),
  responses: document.getElementById("responses"),
  presets: document.getElementById("presets"),
  meter: document.getElementById("meter"),
  reduction: document.getElementById("reduction"),
  programme: document.getElementById("programme"),
  notice: document.getElementById("notice"),
};

const message = (key, fallback) => api.i18n?.getMessage(key) || fallback;

let tabId = null;
let origin = null;
let settings = { ...DEFAULTS };
let frames = {};
// While a control is being dragged, the background is still broadcasting the
// settings it has already stored — which lag the drag by a round trip. Letting
// those land would snap the control back under the pointer, which reads as the
// slider not working at all.
let lastEdit = 0;
const HOLD_MS = 500;
const holding = () => Date.now() - lastEdit < HOLD_MS;
const knobs = new Map();
const sliders = new Map();

// --- knob ------------------------------------------------------------------

const SVG = "http://www.w3.org/2000/svg";

function polar(cx, cy, radius, degrees) {
  const radians = ((degrees - 90) * Math.PI) / 180;
  return { x: cx + radius * Math.cos(radians), y: cy + radius * Math.sin(radians) };
}

function arc(cx, cy, radius, fromDegrees, toDegrees) {
  const from = polar(cx, cy, radius, fromDegrees);
  const to = polar(cx, cy, radius, toDegrees);
  const large = Math.abs(toDegrees - fromDegrees) > 180 ? 1 : 0;
  return `M ${from.x.toFixed(2)} ${from.y.toFixed(2)} A ${radius} ${radius} 0 ${large} 1 ${to.x.toFixed(2)} ${to.y.toFixed(2)}`;
}

function createKnob(key, onChange) {
  const range = RANGES[key];
  const root = document.createElement("div");
  root.className = "knob";
  root.tabIndex = 0;
  root.setAttribute("role", "slider");
  root.setAttribute("aria-valuemin", String(range.min));
  root.setAttribute("aria-valuemax", String(range.max));

  const size = 58;
  const centre = size / 2;
  const radius = 20;
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);

  const track = document.createElementNS(SVG, "path");
  track.setAttribute("class", "arc-track");
  track.setAttribute("fill", "none");
  track.setAttribute("stroke-width", "4");
  track.setAttribute("stroke-linecap", "round");
  track.setAttribute("d", arc(centre, centre, radius, START, START + SWEEP));

  const value = document.createElementNS(SVG, "path");
  value.setAttribute("class", "arc-value");
  value.setAttribute("fill", "none");
  value.setAttribute("stroke-width", "4");
  value.setAttribute("stroke-linecap", "round");

  const pointer = document.createElementNS(SVG, "line");
  pointer.setAttribute("class", "pointer");
  pointer.setAttribute("stroke-width", "2");
  pointer.setAttribute("stroke-linecap", "round");

  svg.append(track, value, pointer);

  const name = document.createElement("div");
  name.className = "knob-name";
  const readout = document.createElement("div");
  readout.className = "knob-value";
  const absolute = document.createElement("div");
  absolute.className = "knob-absolute";

  root.append(name, svg, readout, absolute);

  const nudge = (steps) => onChange(controls.coerce(key, settings[key] + steps * range.step));

  let dragging = null;
  root.addEventListener("pointerdown", (event) => {
    root.setPointerCapture(event.pointerId);
    dragging = { y: event.clientY, position: positionOf(key, settings[key]) };
    root.focus();
    event.preventDefault();
  });
  root.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const travel = (dragging.y - event.clientY) / (event.shiftKey ? DRAG_PX * FINE : DRAG_PX);
    onChange(valueAt(key, dragging.position + travel));
  });
  const release = (event) => {
    if (!dragging) return;
    dragging = null;
    root.releasePointerCapture?.(event.pointerId);
  };
  root.addEventListener("pointerup", release);
  root.addEventListener("pointercancel", release);

  root.addEventListener("wheel", (event) => {
    event.preventDefault();
    const step = (event.shiftKey ? 0.004 : 0.02) * (event.deltaY < 0 ? 1 : -1);
    onChange(valueAt(key, positionOf(key, settings[key]) + step));
  });

  root.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 1 : 2;
    if (event.key === "ArrowUp" || event.key === "ArrowRight") nudge(step);
    else if (event.key === "ArrowDown" || event.key === "ArrowLeft") nudge(-step);
    else if (event.key === "Home") onChange(range.min);
    else if (event.key === "End") onChange(range.max);
    else if (event.key === "Enter" || event.key === " ") onChange(DEFAULTS[key]);
    else return;
    event.preventDefault();
  });

  // Double-click to default is the convention every plugin knob follows.
  root.addEventListener("dblclick", () => onChange(DEFAULTS[key]));

  return {
    root,
    render(current, resolvedDb) {
      const position = positionOf(key, current);
      const angle = START + position * SWEEP;
      value.setAttribute("d", arc(centre, centre, radius, START, Math.max(START + 0.01, angle)));
      const outer = polar(centre, centre, radius - 2, angle);
      const inner = polar(centre, centre, radius - 9, angle);
      pointer.setAttribute("x1", inner.x.toFixed(2));
      pointer.setAttribute("y1", inner.y.toFixed(2));
      pointer.setAttribute("x2", outer.x.toFixed(2));
      pointer.setAttribute("y2", outer.y.toFixed(2));
      name.textContent = message(`knob_${key}`, key);
      readout.textContent = format(key, current);
      absolute.textContent = resolvedDb == null ? "" : `${resolvedDb.toFixed(1)} LUFS`;
      root.setAttribute("aria-valuenow", String(current));
      root.setAttribute("aria-valuetext", format(key, current));
      root.setAttribute("aria-label", message(`knob_${key}`, key));
    },
  };
}

/**
 * A horizontal slider for basic mode. Deliberately not a knob: a knob is for
 * trimming a value you already understand, and basic mode is for people who
 * want "more" or "less" without learning what a threshold is. Left to right
 * reads as less to more without a label explaining it.
 */
function createSlider(key, onChange) {
  const range = RANGES[key];
  const root = document.createElement("div");
  root.className = "slider-row";

  const name = document.createElement("label");
  name.className = "slider-name";
  name.textContent = message(`slider_${key}`, key);

  const readout = document.createElement("span");
  readout.className = "slider-value";

  const input = document.createElement("input");
  input.type = "range";
  input.className = "slider";
  input.min = "0";
  input.max = "1000";
  input.step = "1";
  name.append(readout);

  input.addEventListener("input", () => {
    onChange(valueAt(key, Number(input.value) / 1000));
  });

  root.append(name, input);
  return {
    root,
    render(current) {
      const position = positionOf(key, current);
      input.value = String(Math.round(position * 1000));
      input.style.setProperty("--fill", `${position * 100}%`);
      input.setAttribute("aria-label", message(`slider_${key}`, key));
      input.setAttribute("aria-valuetext", format(key, current));
      readout.textContent = format(key, current);
    },
  };
}

/**
 * Static or adaptive. Advanced only: basic mode is two sliders and stays two
 * sliders, and static is the default, so the swing that adaptive can produce is
 * not something a basic user meets by accident.
 */
function buildResponses() {
  el.responses.replaceChildren(
    ...controls.RESPONSES.map((response) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "response";
      button.dataset.response = response;
      button.textContent = message(`response_${response}`, response);
      button.addEventListener("click", () => apply({ response }));
      return button;
    }),
  );
}

function buildModes() {
  el.modes.replaceChildren(
    ...MODES.map((mode) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "mode";
      button.dataset.mode = mode;
      button.setAttribute("role", "tab");
      button.textContent = message(`mode_${mode}`, mode);
      button.addEventListener("click", () => {
        // Switching must not move the sound: going to advanced carries the
        // basic slider's current meaning into the knobs.
        lastEdit = Date.now();
        settings = controls.withMode(settings, mode);
        render();
        persist();
      });
      return button;
    }),
  );
}

// --- rendering -------------------------------------------------------------

function localise() {
  for (const node of document.querySelectorAll("[data-i18n]")) {
    const text = message(node.dataset.i18n, node.textContent);
    if (text) node.textContent = text;
  }
}

function buildControls() {
  for (const key of LAYOUT.advanced) {
    const knob = createKnob(key, (next) => apply({ [key]: next, on: true }));
    knobs.set(key, knob);
    el.knobs.append(knob.root);
  }
  for (const key of LAYOUT.basic) {
    const slider = createSlider(key, (next) => apply({ [key]: next, on: true }));
    sliders.set(key, slider);
    el.sliders.append(slider.root);
  }
}

function buildPresets() {
  el.presets.replaceChildren(
    ...PRESETS.map((preset) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.preset = preset.id;
      button.textContent = message(`preset_${preset.id}`, preset.id);
      // A preset writes only the controls of the panel it was clicked in, for
      // the same reason switching modes writes nothing: neither panel may
      // silently overwrite the other's settings. It still lights up in both,
      // because a preset is one point expressed two ways.
      button.addEventListener("click", () =>
        apply(
          settings.mode === "advanced"
            ? { ...controls.fromStrength(preset.strength), on: true }
            : { strength: preset.strength, on: true },
        ),
      );
      return button;
    }),
  );
}

/** Sum the frame reports into one answer about this page. */
function summarise(reports) {
  return Object.values(reports ?? {}).reduce(
    (acc, frame) => ({
      media: acc.media + (frame.media ?? 0),
      routed: acc.routed + (frame.routed ?? 0),
      blocked: acc.blocked + (frame.blocked ?? 0),
      webAudio: acc.webAudio || !!frame.webAudio,
      reduction: Math.min(acc.reduction, frame.reduction ?? 0),
      programmeDb: frame.programmeDb ?? acc.programmeDb,
    }),
    { media: 0, routed: 0, blocked: 0, webAudio: false, reduction: 0, programmeDb: null },
  );
}

function render() {
  const summary = summarise(frames);
  const programmeDb = summary.programmeDb;

  el.power.setAttribute("aria-pressed", String(settings.on));
  el.power.textContent = settings.on
    ? message("disable", "Disable")
    : message("enable", "Enable");

  const basic = settings.mode === "basic";
  el.sliders.dataset.inactive = String(!basic);
  el.advanced.dataset.inactive = String(basic);
  for (const button of el.responses.children) {
    button.setAttribute("aria-pressed", String(button.dataset.response === settings.response));
  }
  for (const button of el.modes.children) {
    const active = button.dataset.mode === settings.mode;
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  }

  for (const [key, knob] of knobs) {
    // Only the two level controls resolve to an absolute loudness; a ratio and
    // a make-up gain are not points on the LUFS scale.
    const resolved = RANGES[key].unit === "LU" ? controls.absolute(settings[key], programmeDb) : null;
    knob.render(settings[key], resolved);
  }
  for (const [key, slider] of sliders) slider.render(settings[key]);

  const active = controls.presetFor(settings);
  for (const button of el.presets.children) {
    button.setAttribute(
      "aria-pressed",
      String(settings.on && button.dataset.preset === active),
    );
  }

  el.programme.textContent =
    programmeDb == null
      ? ""
      : `${message("programme", "Programme")} ${programmeDb.toFixed(1)} LUFS`;

  const usable = summary.routed > 0 || summary.webAudio || summary.media > summary.blocked;
  el.control.dataset.disabled = String(!usable);
  if (usable) {
    el.notice.hidden = true;
  } else {
    el.notice.hidden = false;
    el.notice.textContent =
      summary.media === 0 && !summary.webAudio
        ? message("noAudio", "No audio detected on this page")
        : message("unavailable", "This page's audio is protected and cannot be processed");
  }

  // Reduction is negative dB. 20 dB of travel covers what these ranges ask for.
  const reduction = Math.min(0, summary.reduction);
  el.meter.style.transform = `scaleX(${Math.min(1, -reduction / 20)})`;
  el.reduction.textContent = `${reduction.toFixed(1)} dB`;
}

function persist() {
  return api.runtime.sendMessage({ type: "levora:setSettings", tabId, origin, settings });
}

async function apply(next) {
  lastEdit = Date.now();
  settings = normalise({ ...settings, ...next });
  render();
  await persist();
}

async function refresh() {
  const state = await api.runtime.sendMessage({ type: "levora:getState", tabId, origin });
  if (!state) return;
  if (!holding()) settings = normalise(state.settings);
  frames = { ...frames, ...state.frames };
  render();
}

/**
 * Take out a short lease on the meter. Renewed while the popup is open; it
 * lapses by itself when the popup closes, which is the only reliable way to
 * stop it — popups are not guaranteed an unload event.
 */
function renewMeterLease() {
  try {
    Promise.resolve(
      api.tabs.sendMessage(tabId, { type: "levora:watch" }),
    )?.catch?.(() => {});
  } catch {
    // No content script here; the notice already says so.
  }
}

el.power.addEventListener("click", () => apply({ on: !settings.on }));

api.runtime.onMessage.addListener((incoming, sender) => {
  if (incoming?.type === "levora:meter") {
    if (sender.tab?.id !== tabId) return;
    frames[String(sender.frameId ?? 0)] = incoming.capabilities;
    render();
    return;
  }
  if (incoming?.type !== "levora:state" || incoming.tabId !== tabId) return;
  if (incoming.settings && !holding()) settings = normalise(incoming.settings);
  if (incoming.frames) frames = { ...frames, ...incoming.frames };
  render();
});

(async () => {
  localise();
  buildModes();
  buildResponses();
  buildControls();
  buildPresets();
  render();
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  tabId = tab.id;
  try {
    origin = new URL(tab.url).origin;
  } catch {
    origin = null;
  }
  el.origin.textContent = origin ? origin.replace(/^https?:\/\//, "") : "";
  await refresh();
  renewMeterLease();
  setInterval(renewMeterLease, LEASE_MS);
})();
