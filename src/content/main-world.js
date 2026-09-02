// Levora — MAIN world hook.
//
// Some pages never create a <video>/<audio> element at all: games, Howler.js
// and hand-rolled Web Audio players push buffers straight at
// AudioContext.destination. Those graphs live in the page's own JS world, so
// the isolated engine cannot reach them. This script runs in the page world and
// re-routes every connection to `destination` through a chain of its own.
//
// It runs the same worklet processor as the isolated engine, so both paths
// sound identical and there is one DSP implementation in the project rather
// than two that drift.
//
// The two worlds cannot share objects, so they talk through attributes on
// <html>: the isolated engine writes data-levora with the computed parameters
// and the processor's URL — which only it can produce, since runtime.getURL
// does not exist here — and we write data-levora-webaudio back so the popup
// knows this page has a live page-world graph.

(() => {
  const FLAG = "__levoraMainWorld";
  if (window[FLAG]) return;
  window[FLAG] = true;

  const AudioNodeProto = window.AudioNode && window.AudioNode.prototype;
  if (!AudioNodeProto || typeof AudioNodeProto.connect !== "function") return;

  const MIX_RAMP = 0.05;

  const nativeConnect = AudioNodeProto.connect;
  const chains = new Set();
  let config = { on: false };

  const root = () => document.documentElement;

  function readConfig() {
    const element = root();
    if (!element) return { on: false };
    try {
      return JSON.parse(element.getAttribute("data-levora") || "") || { on: false };
    } catch {
      return { on: false };
    }
  }

  function announce() {
    const element = root();
    if (element) element.setAttribute("data-levora-webaudio", "1");
  }

  function setParam(param, value, context) {
    try {
      param.setTargetAtTime(value, context.currentTime, MIX_RAMP);
    } catch {
      param.value = value;
    }
  }

  function ensureChain(context) {
    if (context.__levoraChain) return context.__levoraChain;

    const master = context.createGain();
    const dry = context.createGain();
    const wet = context.createGain();
    // A plain gain stands in until the worklet module resolves. addModule is
    // asynchronous but the patched connect() is not, so the chain has to be
    // complete and audible from the first call — a page whose audio waits on a
    // network fetch is a page we broke.
    const placeholder = context.createGain();
    const limiter = context.createDynamicsCompressor();

    nativeConnect.call(master, dry);
    nativeConnect.call(dry, context.destination);
    nativeConnect.call(master, placeholder);
    nativeConnect.call(placeholder, limiter);
    nativeConnect.call(limiter, wet);
    nativeConnect.call(wet, context.destination);

    const chain = { context, master, dry, wet, placeholder, limiter, node: null };
    context.__levoraChain = chain;
    chains.add(chain);
    apply(chain);
    announce();
    loadWorklet(chain);
    return chain;
  }

  function loadWorklet(chain) {
    const url = config.worklet;
    if (!url || chain.node || chain.loading || !chain.context.audioWorklet) return;
    chain.loading = true;
    chain.context.audioWorklet
      .addModule(url)
      .then(() => {
        // Splice the processor in where the placeholder was. Doing it in this
        // order means the signal is never disconnected from the destination.
        const node = new AudioWorkletNode(chain.context, "levora", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          // Explicit, so the browser applies its standard down/upmix before the
          // block reaches us; see buildGraph() in content/engine.js.
          channelCount: 2,
          channelCountMode: "explicit",
        });
        nativeConnect.call(chain.master, node);
        nativeConnect.call(node, chain.limiter);
        chain.master.disconnect(chain.placeholder);
        chain.placeholder.disconnect(chain.limiter);
        chain.node = node;
        apply(chain);
      })
      .catch(() => {
        // The placeholder stays. The page keeps its audio, unprocessed.
        chain.loading = false;
      });
  }

  function apply(chain) {
    const { context } = chain;
    setParam(chain.wet.gain, config.on ? 1 : 0, context);
    setParam(chain.dry.gain, config.on ? 0 : 1, context);
    if (!config.on) return;

    const limiter = config.limiter;
    if (limiter) {
      chain.limiter.threshold.value = limiter.threshold;
      chain.limiter.knee.value = limiter.knee;
      chain.limiter.ratio.value = limiter.ratio;
      chain.limiter.attack.value = limiter.attack;
      chain.limiter.release.value = limiter.release;
    }
    if (chain.node && config.params) {
      chain.node.port.postMessage({ type: "params", params: config.params });
    }
  }

  AudioNodeProto.connect = function connect(destination, ...rest) {
    try {
      const context = this.context;
      if (context && destination === context.destination) {
        const chain = ensureChain(context);
        const ours = this === chain.dry || this === chain.wet || this === chain.master;
        if (!ours) return nativeConnect.call(this, chain.master, ...rest);
      }
    } catch {
      // Never let the hook break the page's own audio graph.
    }
    return nativeConnect.call(this, destination, ...rest);
  };

  new MutationObserver(() => {
    config = readConfig();
    for (const chain of chains) {
      loadWorklet(chain); // the URL may only have arrived now
      apply(chain);
    }
  }).observe(document, {
    attributes: true,
    subtree: true,
    attributeFilter: ["data-levora"],
  });

  config = readConfig();
})();
