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
  const api = globalThis.browser ?? globalThis.chrome;
  const message = (key, fallback) => api?.i18n?.getMessage(key) || fallback;
  if (!engine || !controls || window.__levoraOverlay) return;
  window.__levoraOverlay = true;

  // Two controls here, not the popup's four: how much, and how loud. Those are
  // the two things anyone reaches for mid-film — the floor and the ratio are set
  // once and left. Which "how much" means depends on the mode, so the overlay
  // follows it rather than pinning one key.
  //
  // Sliders rather than knobs: a wide horizontal target is far easier to hit
  // than a knob when the pointer is somewhere over a picture.
  const amountKey = (settings) => (settings.mode === "advanced" ? "holdAboveDb" : "strength");
  const OUTPUT = controls.OUTPUT_KEY;

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
      /* A translucent material rather than a slab: this floats over a moving
         picture, and a solid bar reads as a hole punched in the film. The blur
         is modest because it composites over video on every frame. */
      background: rgba(28, 28, 30, 0.72);
      backdrop-filter: blur(16px) saturate(160%);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      font-size: 12px;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
      opacity: 0;
      pointer-events: none;
      transition: opacity 180ms cubic-bezier(0.23, 1, 0.32, 1),
        transform 180ms cubic-bezier(0.23, 1, 0.32, 1);
    }
    .bar[data-visible="true"] {
      opacity: 1;
      pointer-events: auto;
      transform: translateX(-50%) translateY(0);
    }
    .power {
      width: 30px; height: 30px;
      flex: none;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      border: none;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.14);
      color: #fff;
      cursor: pointer;
      transition: background 150ms cubic-bezier(0.23, 1, 0.32, 1),
        transform 160ms cubic-bezier(0.23, 1, 0.32, 1);
    }
    /* Acknowledge the press, not the release. */
    .power:active { transform: scale(0.94); }
    /* The glyph is drawn in currentColor, so it flips with the button. */
    .power[aria-pressed="true"] { background: #5ac8fa; color: #10233a; }
    .power svg { display: block; }
    .slider {
      -webkit-appearance: none; appearance: none;
      width: 110px; height: 20px;
      margin: 0; background: transparent; cursor: pointer;
    }
    /* One rule per vendor pseudo-element, never a shared selector list: a
       selector list is invalid as a whole if any selector in it is, and each
       engine treats the other's pseudo-element as unknown — so a combined rule
       is dropped by both and the slider falls back to its default look. */
    .slider::-moz-range-track {
      height: 4px; border-radius: 2px;
      background: linear-gradient(to right,
        #5ac8fa 0 var(--fill, 50%), rgba(255,255,255,0.22) var(--fill, 50%) 100%);
    }
    .slider::-webkit-slider-runnable-track {
      height: 4px; border-radius: 2px;
      background: linear-gradient(to right,
        #5ac8fa 0 var(--fill, 50%), rgba(255,255,255,0.22) var(--fill, 50%) 100%);
    }
    .slider::-moz-range-thumb {
      appearance: none;
      width: 14px; height: 14px; border: none; border-radius: 50%; background: #fff;
    }
    .slider::-webkit-slider-thumb {
      -webkit-appearance: none; appearance: none;
      width: 14px; height: 14px; border: none; border-radius: 50%; background: #fff;
      margin-top: -5px;
    }
    .value { min-width: 44px; font-variant-numeric: tabular-nums; text-align: right; }
    .group { display: flex; align-items: center; gap: 6px; }
    .tag { font-size: 10px; opacity: 0.6; }
    /* Gain reduction runs right-to-left: the bar grows as the compressor works,
       which is the direction every hardware meter moves. */
    .meter {
      width: 44px; height: 4px; border-radius: 2px;
      background: rgba(255, 255, 255, 0.22); overflow: hidden;
    }
    /* scaleX, not width: this updates ten times a second over playing video,
       and width would re-layout the bar on every one. */
    .meter > i {
      display: block; height: 100%; width: 100%;
      transform: scaleX(0); transform-origin: left center;
      background: #5ac8fa; transition: transform 150ms linear;
    }
    .bar[data-disabled="true"] { opacity: 0.4; }

    /* Reduced motion keeps the fade — it carries the "this appeared" meaning —
       and drops the travel and the press scale. */
    @media (prefers-reduced-motion: reduce) {
      .bar { transform: translateX(-50%); transition: opacity 180ms linear; }
      .bar[data-visible="true"] { transform: translateX(-50%); }
      .power { transition: background 150ms linear; }
      .power:active { transform: none; }
      .meter > i { transition: none; }
    }

    /* Translucency is a preference, not a given. Frosted glass over a film is
       exactly the case someone turns this off for. */
    @media (prefers-reduced-transparency: reduce) {
      .bar { background: #1c1c1e; backdrop-filter: none; }
    }

    @media (prefers-contrast: more) {
      .bar { background: #000; backdrop-filter: none; border-color: #fff; }
    }
  `;

  const SVG_NS = "http://www.w3.org/2000/svg";

  const element = (tag, attributes = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    node.append(...children);
    return node;
  };

  const svgElement = (tag, attributes) => {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    return node;
  };

  /**
   * The IEC power mark: a ring broken at the top with a stroke through the gap.
   *
   * large-arc=1 with sweep=0 is the long way round, below. With sweep=1 the same
   * endpoints pick the other centre, which sits above the glyph and puts most of
   * the ring outside the box.
   */
  function powerGlyph() {
    const svg = svgElement("svg", {
      viewBox: "0 0 24 24",
      width: "15",
      height: "15",
      "aria-hidden": "true",
      focusable: "false",
    });
    svg.append(
      svgElement("path", {
        d: "M6.7 6.7 A 7.5 7.5 0 1 0 17.3 6.7",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": "2.2",
        "stroke-linecap": "round",
      }),
      svgElement("line", {
        x1: "12",
        y1: "3.2",
        x2: "12",
        y2: "11.6",
        stroke: "currentColor",
        "stroke-width": "2.2",
        "stroke-linecap": "round",
      }),
    );
    return svg;
  }

  /**
   * Built node by node rather than from an innerHTML template.
   *
   * The template was a static string with nothing interpolated into it, so it
   * was safe — but a reviewer cannot tell that from the outside, and neither can
   * a linter: AMO flags every innerHTML assignment on sight. Constructing the
   * tree costs a few more lines and removes the question.
   */
  function buildTree() {
    const bar = element("div", { class: "bar", part: "bar" });

    const power = element("button", {
      class: "power",
      type: "button",
      "aria-pressed": "false",
    });
    power.append(powerGlyph());

    const slider = (role) => element("input", { class: "slider", "data-role": role, type: "range" });
    const readout = (role) => element("span", { class: "value", "data-role": role });

    const amountGroup = element("span", { class: "group" }, [
      slider("amount"),
      readout("amount-value"),
    ]);
    const outputGroup = element("span", { class: "group" }, [
      element("span", { class: "tag", "data-role": "output-tag" }),
      slider("output"),
      readout("output-value"),
    ]);

    const meter = element("span", { class: "meter" }, [element("i", {})]);

    bar.append(power, amountGroup, outputGroup, meter);
    return bar;
  }

  function build() {
    host = document.createElement("div");
    host.setAttribute("data-levora-overlay", "");
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = CSS;
    const wrapper = document.createElement("div");
    wrapper.append(buildTree());
    shadow.append(style, wrapper);

    ui = {
      bar: wrapper.querySelector(".bar"),
      power: wrapper.querySelector(".power"),
      amount: wrapper.querySelector('[data-role="amount"]'),
      amountValue: wrapper.querySelector('[data-role="amount-value"]'),
      output: wrapper.querySelector('[data-role="output"]'),
      outputValue: wrapper.querySelector('[data-role="output-value"]'),
      outputTag: wrapper.querySelector('[data-role="output-tag"]'),
      meter: wrapper.querySelector(".meter > i"),
    };

    ui.power.addEventListener("click", () => {
      const current = engine.getSettings();
      engine.pushSettings({ ...current, on: !current.on });
      render(engine.getCapabilities());
      wake();
    });

    // Both sliders run 0..1000 and map through the control's own taper, so the
    // ratio's curve and the level controls' straight travel behave the same way
    // here as they do on the popup's knobs.
    for (const [input, resolveKey] of [
      [ui.amount, amountKey],
      [ui.output, () => OUTPUT],
    ]) {
      input.min = "0";
      input.max = "1000";
      input.step = "1";
      input.addEventListener("input", () => {
        dragging = true;
        const current = engine.getSettings();
        const key = resolveKey(current);
        const value = controls.valueAt(key, Number(input.value) / 1000);
        paint({ ...current, [key]: value });
        engine.pushSettings({ ...current, on: true, [key]: value });
        wake();
      });
      // `change` alone is not enough: a pointer released outside the control
      // never fires it, and the bar then ignores every update that follows.
      const release = () => {
        dragging = false;
      };
      input.addEventListener("change", release);
      input.addEventListener("pointerup", release);
      input.addEventListener("pointercancel", release);
      input.addEventListener("blur", release);
    }

    // Pointer over the bar keeps it alive; otherwise it fades while you reach
    // for it.
    ui.bar.addEventListener("pointerenter", () => {
      clearTimeout(idleTimer);
      idleTimer = null;
    });
    ui.bar.addEventListener("pointerleave", wake);
  }

  function paint(settings) {
    const pairs = [
      [amountKey(settings), ui.amount, ui.amountValue],
      [OUTPUT, ui.output, ui.outputValue],
    ];
    for (const [key, input, readout] of pairs) {
      const position = controls.positionOf(key, settings[key]);
      input.value = String(Math.round(position * 1000));
      input.style.setProperty("--fill", `${position * 100}%`);
      input.setAttribute("aria-label", key);
      readout.textContent = controls.format(key, settings[key]);
    }
    ui.outputTag.textContent = "OUT";
  }

  function render(capabilities) {
    if (!ui) return;
    const usable = capabilities.routed > 0 || capabilities.media > 0 || capabilities.webAudio;
    ui.bar.dataset.disabled = usable ? "false" : "true";
    const on = !!capabilities.settings?.on;
    ui.power.setAttribute("aria-pressed", String(on));
    ui.power.setAttribute(
      "aria-label",
      on ? message("disable", "Disable") : message("enable", "Enable"),
    );
    if (!dragging) paint(controls.normalise(capabilities.settings));
    // Reduction runs 0..−20 dB or so across the available ranges.
    const reduction = Math.min(0, capabilities.reduction || 0);
    ui.meter.style.transform = `scaleX(${Math.min(1, -reduction / 20)})`;
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
