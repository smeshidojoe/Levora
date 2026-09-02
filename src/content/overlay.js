// Levora — fullscreen overlay.
//
// The popup lives in browser chrome, and browser chrome is exactly what
// fullscreen hides. Films are watched in fullscreen, which is also where a
// compressor matters most, so without this the control is missing precisely
// when it is wanted.
//
// Two constraints drive the implementation:
//
//   1. The overlay must be a child of document.fullscreenElement. Anything
//      outside the fullscreen element is not rendered at all — appending to
//      <body> produces an invisible control, not a misplaced one.
//
//   2. It lives in a shadow root. The page's stylesheet cannot reach in, ours
//      cannot leak out, and `all: initial` on the host blocks the inheritable
//      properties a shadow boundary does not stop by itself.

(() => {
  const engine = window.__levoraEngine;
  const controls = globalThis.LevoraControls;
  if (!engine || !controls || window.__levoraOverlay) return;
  window.__levoraOverlay = true;

  // One control here, not the popup's three. In fullscreen you ride the
  // threshold; the floor and the ratio are set once and left. A wide horizontal
  // slider is also a far easier target than a knob when the pointer is
  // somewhere over a film.
  const KEY = "holdAboveDb";
  const RANGE = controls.RANGES[KEY];

  const IDLE_MS = 2500; // matches the feel of a native player's control bar
  const BOTTOM_PX = 84; // clear of the site's own fullscreen controls

  let host = null;
  let ui = null;
  let unsubscribe = null;
  let idleTimer = null;
  let dragging = false;

  const CSS = `
    :host { all: initial; }
    .bar {
      position: fixed;
      left: 50%;
      bottom: ${BOTTOM_PX}px;
      transform: translateX(-50%) translateY(6px);
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 14px;
      border-radius: 12px;
      background: rgba(28, 28, 30, 0.92);
      color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      font-size: 12px;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.18s ease, transform 0.18s ease;
    }
    .bar[data-visible="true"] {
      opacity: 1;
      pointer-events: auto;
      transform: translateX(-50%) translateY(0);
    }
    .power {
      width: 30px; height: 30px;
      flex: none;
      border: none;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.14);
      color: #fff;
      font: inherit;
      font-size: 13px;
      cursor: pointer;
    }
    .power[aria-pressed="true"] { background: #5ac8fa; color: #10233a; }
    .slider {
      -webkit-appearance: none; appearance: none;
      width: 150px; height: 20px;
      margin: 0; background: transparent; cursor: pointer;
    }
    .slider::-moz-range-track,
    .slider::-webkit-slider-runnable-track {
      height: 4px; border-radius: 2px;
      background: linear-gradient(to right,
        #5ac8fa 0 var(--fill, 50%), rgba(255,255,255,0.22) var(--fill, 50%) 100%);
    }
    .slider::-moz-range-thumb,
    .slider::-webkit-slider-thumb {
      -webkit-appearance: none; appearance: none;
      width: 14px; height: 14px; border: none; border-radius: 50%; background: #fff;
    }
    .slider::-webkit-slider-thumb { margin-top: -5px; }
    .value { min-width: 48px; font-variant-numeric: tabular-nums; text-align: right; }
    /* Gain reduction runs right-to-left: the bar grows as the compressor works,
       which is the direction every hardware meter moves. */
    .meter {
      width: 44px; height: 4px; border-radius: 2px;
      background: rgba(255, 255, 255, 0.22); overflow: hidden;
    }
    .meter > i {
      display: block; height: 100%; width: 0%;
      background: #5ac8fa; transition: width 0.15s linear;
    }
    .bar[data-disabled="true"] { opacity: 0.4; }
  `;

  const MARKUP = `
    <div class="bar" part="bar">
      <button class="power" type="button" aria-pressed="false" title="Levora">L</button>
      <input class="slider" type="range" />
      <span class="value"></span>
      <span class="meter"><i></i></span>
    </div>
  `;

  function build() {
    host = document.createElement("div");
    host.setAttribute("data-levora-overlay", "");
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = CSS;
    shadow.append(style);
    const wrapper = document.createElement("div");
    wrapper.innerHTML = MARKUP;
    shadow.append(wrapper);

    ui = {
      bar: wrapper.querySelector(".bar"),
      power: wrapper.querySelector(".power"),
      slider: wrapper.querySelector(".slider"),
      value: wrapper.querySelector(".value"),
      meter: wrapper.querySelector(".meter > i"),
    };

    ui.slider.min = String(RANGE.min);
    ui.slider.max = String(RANGE.max);
    ui.slider.step = String(RANGE.step);

    ui.power.addEventListener("click", () => {
      const current = engine.getSettings();
      engine.pushSettings({ ...current, on: !current.on });
      render(engine.getCapabilities());
      wake();
    });

    ui.slider.addEventListener("input", () => {
      dragging = true;
      const value = controls.coerce(KEY, ui.slider.value);
      paint(value);
      engine.pushSettings({ ...engine.getSettings(), on: true, [KEY]: value });
      wake();
    });
    ui.slider.addEventListener("change", () => {
      dragging = false;
    });

    // Pointer over the bar keeps it alive; otherwise it fades while you reach
    // for it.
    ui.bar.addEventListener("pointerenter", () => {
      clearTimeout(idleTimer);
      idleTimer = null;
    });
    ui.bar.addEventListener("pointerleave", wake);
  }

  function paint(value) {
    const fill = ((value - RANGE.min) / (RANGE.max - RANGE.min)) * 100;
    ui.slider.style.setProperty("--fill", `${fill}%`);
    ui.value.textContent = controls.format(KEY, value);
  }

  function render(capabilities) {
    if (!ui) return;
    const usable = capabilities.routed > 0 || capabilities.media > 0 || capabilities.webAudio;
    ui.bar.dataset.disabled = usable ? "false" : "true";
    ui.power.setAttribute("aria-pressed", String(capabilities.settings?.on));
    if (!dragging) {
      const value = capabilities.settings?.[KEY] ?? controls.DEFAULTS[KEY];
      ui.slider.value = String(value);
      paint(value);
    }
    // Reduction runs 0..−20 dB or so across the available ranges.
    const reduction = Math.min(0, capabilities.reduction || 0);
    ui.meter.style.width = `${Math.min(100, (-reduction / 20) * 100)}%`;
  }

  function show(visible) {
    if (ui) ui.bar.dataset.visible = String(visible);
  }

  function wake() {
    show(true);
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => show(false), IDLE_MS);
  }

  function mount(fullscreenElement) {
    if (!host) build();
    if (host.parentNode !== fullscreenElement) fullscreenElement.append(host);
    unsubscribe?.();
    unsubscribe = engine.subscribe(render);
    render(engine.getCapabilities());
    fullscreenElement.addEventListener("pointermove", wake, true);
    host.__target = fullscreenElement;
    wake();
  }

  function unmount() {
    unsubscribe?.();
    unsubscribe = null;
    clearTimeout(idleTimer);
    if (host?.__target) host.__target.removeEventListener("pointermove", wake, true);
    host?.remove();
  }

  document.addEventListener("fullscreenchange", () => {
    const target = document.fullscreenElement;
    if (target) mount(target);
    else unmount();
  });
})();
