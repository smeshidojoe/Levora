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
const { RANGES, DEFAULTS, PRESETS, keys, normalise, positionOf, valueAt, format } =
  controls;

const LEASE_MS = 1000; // the content side expires the meter lease after 3 s
const SWEEP = 270; // degrees of knob travel
const START = -135;
const DRAG_PX = 150; // pixels of vertical drag for the full sweep
const FINE = 5; // shift divides the sensitivity by this

const el = {
  origin: document.getElementById("origin"),
  control: document.getElementById("control"),
  power: document.getElementById("power"),
  knobs: document.getElementById("knobs"),
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
const knobs = new Map();

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
      absolute.textContent = resolvedDb == null ? "" : `${resolvedDb.toFixed(1)} dBFS`;
      root.setAttribute("aria-valuenow", String(current));
      root.setAttribute("aria-valuetext", format(key, current));
      root.setAttribute("aria-label", message(`knob_${key}`, key));
    },
  };
}

// --- rendering -------------------------------------------------------------

function localise() {
  for (const node of document.querySelectorAll("[data-i18n]")) {
    const text = message(node.dataset.i18n, node.textContent);
    if (text) node.textContent = text;
  }
}

function buildKnobs() {
  for (const key of keys) {
    const knob = createKnob(key, (next) => apply({ [key]: next, on: true }));
    knobs.set(key, knob);
    el.knobs.append(knob.root);
  }
}

function buildPresets() {
  el.presets.replaceChildren(
    ...PRESETS.map((preset) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.preset = preset.id;
      button.textContent = message(`preset_${preset.id}`, preset.id);
      button.addEventListener("click", () => apply({ ...preset, on: true }));
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

  for (const key of keys) {
    knobs.get(key).render(settings[key], controls.absolute(settings[key], programmeDb));
  }

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
      : `${message("programme", "Programme")} ${programmeDb.toFixed(1)} dBFS`;

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
  el.meter.style.width = `${Math.min(100, (-reduction / 20) * 100)}%`;
  el.reduction.textContent = `${reduction.toFixed(1)} dB`;
}

async function apply(next) {
  settings = normalise({ ...settings, ...next });
  render();
  await api.runtime.sendMessage({
    type: "levora:setSettings",
    tabId,
    origin,
    settings,
  });
}

async function refresh() {
  const state = await api.runtime.sendMessage({ type: "levora:getState", tabId, origin });
  if (!state) return;
  settings = normalise(state.settings);
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
  if (incoming.settings) settings = normalise(incoming.settings);
  if (incoming.frames) frames = { ...frames, ...incoming.frames };
  render();
});

(async () => {
  localise();
  buildKnobs();
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
