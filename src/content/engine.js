// Levora — isolated-world audio engine.
//
// Runs in every frame, including cross-origin iframes, which is how embedded
// players get covered without same-origin gymnastics.
//
// All signal processing lives in the AudioWorklet (worklet/levora-processor.js).
// This file's job is routing: find media, decide whether it can be touched,
// wire it up once, and pass parameters through.
//
// Four rules shape everything here:
//
//   1. createMediaElementSource is a one-way door. An element routed through
//      Web Audio can never be routed back. So we do not touch an element until
//      the user has turned compression on for this site.
//
//   2. Never route into a suspended AudioContext. Autoplay policy starts the
//      context suspended, and a suspended context on the far side of that
//      one-way door is silence with no way back short of a reload. Because
//      settings are remembered per origin, "on" can arrive at page load, long
//      before any user gesture — so routing waits for a real play event AND a
//      running context, never for the setting alone.
//
//   3. Never route before the worklet module has loaded, for the same reason:
//      addModule is asynchronous, and an element routed into a chain we cannot
//      finish building is an element we have taken and broken. Not being ready
//      is temporary and is retried; it is not a failure.
//
//   4. A CORS-tainted or DRM-protected element yields silence, not sound.
//      Those are detected before routing, marked blocked, and reported, so the
//      popup can say why instead of showing a dead slider.

(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  if (!api?.runtime?.id) return;
  if (window.__levoraEngine) return;

  const { DEFAULTS, normalise, resolve } = globalThis.LevoraControls;

  const TICK_MS = 200; // routing sweep and meter only; the DSP is not on a timer
  const MIX_RAMP = 0.05; // seconds, click-free bypass crossfade
  const WORKLET_URL = api.runtime.getURL("worklet/levora-processor.js");

  const LIMITER = {
    threshold: -1.5,
    knee: 0,
    ratio: 20,
    attack: 0.003,
    release: 0.25,
  };

  let settings = { ...DEFAULTS };
  let params = resolve(settings);

  let context = null;
  let workletReady = false;
  let timer = null;
  let meterUntil = 0; // popups renew this; it lapses on its own if one closes abruptly

  const graphs = new WeakMap(); // media element -> its node graph
  const failed = new WeakSet(); // routing attempted or ruled out
  const protectedMedia = new WeakSet(); // fired 'encrypted', i.e. DRM
  const liveGraphs = new Set();
  const listeners = new Set(); // overlay subscribers

  // Every root we are watching: the document, plus each open shadow root we
  // have found. Kept because none of the three mechanisms we rely on crosses a
  // shadow boundary by itself — see observeRoot().
  const roots = new Set();

  function mediaElements() {
    const found = [];
    for (const root of roots) {
      for (const element of root.querySelectorAll("video, audio")) found.push(element);
    }
    return found;
  }

  const isPlaying = (element) =>
    !element.paused && !element.ended && element.readyState >= 2;

  function ensureContext() {
    if (context) return context;
    const Ctor = window.AudioContext ?? window.webkitAudioContext;
    if (!Ctor) return null;
    context = new Ctor();
    context.audioWorklet
      ?.addModule(WORKLET_URL)
      .then(() => {
        workletReady = true;
        sweep(); // a play event may have arrived and been turned away meanwhile
        report();
      })
      .catch(() => {
        // Without the processor there is no chain to build. Leaving
        // workletReady false means nothing is ever routed, which is the safe
        // failure: the page keeps its own audio, untouched.
      });
    return context;
  }

  function isTainted(element) {
    const source = element.currentSrc || element.src;
    if (!source) return false;
    // blob: and data: sources (MSE players such as YouTube) are same-origin.
    if (/^(blob:|data:|mediastream:)/i.test(source)) return false;
    try {
      const url = new URL(source, location.href);
      if (url.origin === location.origin) return false;
      return !element.crossOrigin;
    } catch {
      return false;
    }
  }

  function setParam(audioParam, value) {
    try {
      audioParam.setTargetAtTime(value, context.currentTime, MIX_RAMP);
    } catch {
      audioParam.value = value;
    }
  }

  function buildGraph(ctx, source) {
    const dry = ctx.createGain();
    const wet = ctx.createGain();

    const node = new AudioWorkletNode(ctx, "levora", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      // Explicit, so the browser applies its standard down/upmix before the
      // block reaches us. Left on the default the node would hand us however
      // many channels the source has, and the processor would write the first
      // two and silently drop the rest of a surround mix.
      channelCount: 2,
      channelCountMode: "explicit",
    });

    // The limiter stays a native node. Peak detection is the wrong instrument
    // for judging loudness — which is why the compressor moved into the worklet
    // — but it is exactly the right one for catching peaks, which is all this
    // does.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = LIMITER.threshold;
    limiter.knee.value = LIMITER.knee;
    limiter.ratio.value = LIMITER.ratio;
    limiter.attack.value = LIMITER.attack;
    limiter.release.value = LIMITER.release;

    // A real bypass path rather than a transparent processor: with the wet
    // chain silenced, nothing downstream can colour the signal when we are off.
    source.connect(dry).connect(ctx.destination);
    source.connect(node).connect(limiter).connect(wet).connect(ctx.destination);

    const graph = {
      source,
      dry,
      wet,
      node,
      limiter,
      reduction: 0,
      gainDb: 0,
      programmeDb: null,
      thresholdDb: null,
    };
    node.port.onmessage = (event) => {
      graph.reduction = event.data?.reduction ?? 0;
      graph.gainDb = event.data?.gainDb ?? 0;
      graph.programmeDb = event.data?.programmeDb ?? null;
      graph.thresholdDb = event.data?.thresholdDb ?? null;
    };
    return graph;
  }

  function applyParams(graph) {
    graph.node.port.postMessage({ type: "params", params });
  }

  function applyMix(graph) {
    setParam(graph.wet.gain, settings.on ? 1 : 0);
    setParam(graph.dry.gain, settings.on ? 0 : 1);
  }

  function attach(element) {
    const existing = graphs.get(element);
    if (existing) return existing;
    if (failed.has(element)) return null;
    if (protectedMedia.has(element) || isTainted(element)) {
      failed.add(element);
      return null;
    }
    const ctx = ensureContext();
    if (!ctx) {
      failed.add(element);
      return null;
    }
    // Rules 2 and 3. Neither marks the element failed — both are states that
    // pass, and the sweep retries.
    if (ctx.state !== "running") {
      ctx.resume().catch(() => {});
      return null;
    }
    if (!workletReady) return null;

    try {
      const graph = buildGraph(ctx, ctx.createMediaElementSource(element));
      graphs.set(element, graph);
      liveGraphs.add(graph);
      applyParams(graph);
      applyMix(graph);
      startTimer();
      return graph;
    } catch {
      failed.add(element);
      return null;
    }
  }

  /** Route anything that is already playing, if the user asked us to. */
  function sweep() {
    if (!settings.on) return;
    for (const element of mediaElements()) {
      if (graphs.has(element) || failed.has(element)) continue;
      if (isPlaying(element)) attach(element);
    }
  }

  function tick() {
    sweep();

    const watched = meterUntil > Date.now();
    if (!listeners.size && !watched) {
      stopTimerIfIdle();
      return;
    }

    const snapshot = collectCapabilities();
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {
        // A broken overlay must not stop the sweep.
      }
    }
    // Gain reduction moves continuously, so the popup cannot get it from the
    // debounced event-driven reports. It also cannot poll: tabs.sendMessage
    // reaches every frame but resolves on whichever answers first, which on a
    // page whose video sits in an iframe is the frame with no audio. So each
    // frame pushes its own snapshot, but only while a popup has said it is
    // watching, so a closed popup costs nothing.
    if (watched) {
      try {
        api.runtime
          .sendMessage({ type: "levora:meter", capabilities: snapshot })
          ?.catch?.(() => {});
      } catch {
        // Popup closed between the check and the send.
      }
    }
  }

  function startTimer() {
    if (timer !== null) return;
    timer = setInterval(tick, TICK_MS);
  }

  function stopTimerIfIdle() {
    if (timer === null) return;
    if (settings.on || liveGraphs.size || listeners.size) return;
    clearInterval(timer);
    timer = null;
  }

  function applySettings(next) {
    settings = normalise(next);
    const previous = params;
    params = resolve(settings);
    const changed = JSON.stringify(previous) !== JSON.stringify(params);

    for (const graph of liveGraphs) {
      if (changed) applyParams(graph);
      applyMix(graph);
    }
    publishToPageWorld();
    if (settings.on) {
      ensureContext();
      if (context?.state === "suspended") context.resume().catch(() => {});
      scheduleDiscovery(); // a player may have been hiding in a shadow root all along
      sweep();
      startTimer();
    }
  }

  /**
   * Hand the computed parameters and the processor's URL to the page world.
   * Only data crosses: the control surface lives in one file, and the page world
   * cannot reach runtime.getURL to find the worklet on its own.
   */
  function publishToPageWorld() {
    const root = document.documentElement;
    if (!root) return;
    root.setAttribute(
      "data-levora",
      JSON.stringify(
        settings.on
          ? { on: true, params, limiter: LIMITER, worklet: WORKLET_URL }
          : { on: false, worklet: WORKLET_URL },
      ),
    );
  }

  function collectCapabilities() {
    const elements = mediaElements();
    let routed = 0;
    let blocked = 0;
    let reduction = 0;
    let gainDb = 0;
    let programmeDb = null;
    let thresholdDb = null;
    for (const element of elements) {
      const graph = graphs.get(element);
      if (graph) {
        routed += 1;
        reduction = Math.min(reduction, graph.reduction);
        gainDb = graph.gainDb;
        programmeDb = graph.programmeDb;
        thresholdDb = graph.thresholdDb;
      } else if (failed.has(element) || protectedMedia.has(element)) {
        blocked += 1;
      }
    }
    return {
      origin: location.origin,
      isTopFrame: window.top === window,
      media: elements.length,
      routed,
      blocked,
      webAudio: document.documentElement?.getAttribute("data-levora-webaudio") === "1",
      settings: { ...settings },
      reduction,
      gainDb,
      programmeDb,
      thresholdDb,
    };
  }

  let reportTimer = null;
  function report() {
    clearTimeout(reportTimer);
    reportTimer = setTimeout(() => {
      try {
        api.runtime
          .sendMessage({ type: "levora:report", capabilities: collectCapabilities() })
          ?.catch?.(() => {});
      } catch {
        // Extension reloaded or context torn down.
      }
    }, 120);
  }

  /** Used by the fullscreen overlay: apply now, persist for this origin. */
  function pushSettings(next) {
    applySettings(next);
    try {
      api.runtime
        .sendMessage({ type: "levora:persist", settings: { ...settings } })
        ?.catch?.(() => {});
    } catch {
      // Nothing to do.
    }
    report();
  }

  api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "levora:apply") {
      applySettings(message.settings);
      sendResponse({ capabilities: collectCapabilities() });
      report();
      return false;
    }
    if (message?.type === "levora:probe") {
      sendResponse({ capabilities: collectCapabilities() });
      report();
      return false;
    }
    // A popup is open and wants the meter. The lease is short and renewed, so a
    // popup that closes without warning simply stops renewing.
    if (message?.type === "levora:watch") {
      meterUntil = Date.now() + 3000;
      startTimer();
      sendResponse({ capabilities: collectCapabilities() });
      return false;
    }
    return false;
  });

  /**
   * Watch one root for media. Called for the document and for every open shadow
   * root we discover, because a shadow boundary stops all three of the things
   * this does:
   *
   *   * querySelectorAll does not descend into a shadow root, so a player built
   *     out of web components is not "blocked" for us — it is invisible.
   *   * MutationObserver with subtree does not descend into one either.
   *   * Media events are not composed, so `play` inside a shadow root never
   *     reaches a listener on the document, capture phase included.
   */
  function observeRoot(root) {
    if (roots.has(root)) return;
    roots.add(root);

    root.addEventListener(
      "encrypted",
      (event) => {
        const element = event.target;
        if (element instanceof HTMLMediaElement) {
          protectedMedia.add(element);
          failed.add(element);
          report();
        }
      },
      true,
    );

    for (const eventName of ["play", "playing", "loadstart", "pause"]) {
      root.addEventListener(
        eventName,
        (event) => {
          const element = event.target;
          if (!(element instanceof HTMLMediaElement)) return;
          if (eventName === "play" || eventName === "playing") {
            if (context?.state === "suspended") context.resume().catch(() => {});
            if (settings.on) attach(element);
          }
          report();
        },
        true,
      );
    }

    // SPA navigation and lazy players: new media inherits the current setting.
    new MutationObserver((records) => {
      let touched = false;
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches?.("video, audio") || node.querySelector?.("video, audio")) {
            touched = true;
          }
        }
        if (record.removedNodes.length) touched = true;
      }
      // A shadow host can be added at any time, and the player inside it may
      // never touch the light DOM again.
      scheduleDiscovery();
      if (!touched) return;
      sweep();
      report();
    }).observe(root, { childList: true, subtree: true });
  }

  /**
   * Find open shadow roots and start watching them too.
   *
   * This walks every element, so it is debounced and driven by mutations rather
   * than run on the sweep. Closed shadow roots stay out of reach: there is no
   * way to obtain one from outside, and prying it open by patching attachShadow
   * would mean changing how the page behaves for everyone, not just for us.
   */
  let discoveryTimer = null;
  function scheduleDiscovery() {
    if (discoveryTimer !== null) return;
    discoveryTimer = setTimeout(() => {
      discoveryTimer = null;
      let found = false;
      for (const root of Array.from(roots)) {
        for (const element of root.querySelectorAll("*")) {
          if (element.shadowRoot && !roots.has(element.shadowRoot)) {
            observeRoot(element.shadowRoot);
            found = true;
          }
        }
      }
      if (found) {
        sweep();
        report();
      }
    }, 400);
  }

  // A page-world graph may appear long after load (a game starting up).
  new MutationObserver(() => report()).observe(document, {
    attributes: true,
    subtree: true,
    attributeFilter: ["data-levora-webaudio"],
  });

  window.__levoraEngine = {
    getCapabilities: collectCapabilities,
    getSettings: () => ({ ...settings }),
    pushSettings,
    subscribe(listener) {
      listeners.add(listener);
      startTimer();
      return () => listeners.delete(listener);
    },
  };

  observeRoot(document);
  scheduleDiscovery();

  // The page world needs the processor URL before it can build anything, and it
  // cannot ask for it itself.
  publishToPageWorld();

  // Announce ourselves and pick up whatever this origin was left on.
  Promise.resolve(
    api.runtime.sendMessage({
      type: "levora:hello",
      capabilities: collectCapabilities(),
    }),
  )
    .then((response) => {
      if (response?.settings) applySettings(response.settings);
    })
    .catch(() => {});
})();
