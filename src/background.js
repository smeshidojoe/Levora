// Levora — background coordinator.
//
// Classic script on purpose: it has to load both as an MV3 service worker
// (Chrome) and as a background script (Firefox), so no module syntax.
//
// Two stores with deliberately different lifetimes:
//
//   storage.local, keyed by origin — the user's compression setting. This is a
//   taste ("I always want YouTube levelled"), not a per-session tweak, so it
//   outlives the tab and the browser. Safe to persist because the controls are
//   stated relative to the programme's own loudness and none of them is an
//   output level: restoring one on a fresh page cannot surprise anyone with a
//   jump in volume.
//
//   storage.session, keyed by tab — the last capability report from each frame,
//   so the popup can explain a disabled control. Pure cache; the service worker
//   is evicted after ~30 s idle, so nothing lives in memory.

const api = globalThis.browser ?? globalThis.chrome;

// Deliberately not a full settings object. The shape belongs to
// lib/controls.js, which the content script and the popup both normalise
// against; duplicating it here is how the two drift apart. All this side needs
// to know is that an origin nobody has touched is off.
const DEFAULTS = { on: false };
const ACCENT = "#5AC8FA";
const INK = "#10233A";

const originKey = (origin) => `origin:${origin}`;
const tabKey = (tabId) => `tab:${tabId}`;

function originOf(url) {
  try {
    const { origin, protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:" || protocol === "file:"
      ? origin
      : null;
  } catch {
    return null;
  }
}

async function readSettings(origin) {
  if (!origin) return { ...DEFAULTS };
  const stored = await api.storage.local.get(originKey(origin));
  return { ...DEFAULTS, ...(stored[originKey(origin)] ?? null) };
}

async function writeSettings(origin, settings) {
  if (!origin || !settings) return;
  await api.storage.local.set({ [originKey(origin)]: settings });
}

async function readFrames(tabId) {
  const stored = await api.storage.session.get(tabKey(tabId));
  return stored[tabKey(tabId)] ?? { origin: null, frames: {} };
}

async function writeFrames(tabId, value) {
  await api.storage.session.set({ [tabKey(tabId)]: value });
}

// Whichever control the user is actually holding. Read straight off the stored
// object rather than resolved through lib/controls.js, which this file cannot
// import — a badge is not worth a duplicated mapping.
function badgeLabel(settings) {
  if (!settings?.on) return "";
  if (settings.mode === "advanced") {
    const ratio = Number(settings.ratio);
    return Number.isFinite(ratio) ? `${ratio.toFixed(0)}:1` : "";
  }
  const strength = Number(settings.strength);
  return Number.isFinite(strength) ? String(Math.round(strength)) : "";
}

async function updateBadge(tabId, settings) {
  try {
    await api.action.setBadgeText({ tabId, text: badgeLabel(settings) });
    await api.action.setBadgeBackgroundColor({ tabId, color: ACCENT });
    await api.action.setBadgeTextColor?.({ tabId, color: INK });
  } catch {
    // Tab closed mid-flight.
  }
}

/**
 * Push a setting to every tab on that origin, not just the one the popup was
 * open in.
 *
 * The setting is stored per site, so applying it to a single tab made the two
 * disagree: a second YouTube tab kept the old behaviour until it happened to
 * reload. Per-site has to mean per-site everywhere at once, or it is a per-tab
 * setting that merely remembers.
 */
async function applyToOrigin(origin, settings) {
  // Parsed inside the guard, not as part of it: a file:// page has the opaque
  // origin "null", and `new URL("null")` throws — which happened before the
  // condition could reject it.
  let scheme = null;
  try {
    scheme = origin ? new URL(origin).protocol : null;
  } catch {
    return;
  }
  if (scheme !== "http:" && scheme !== "https:") return;

  let tabs = [];
  try {
    tabs = await api.tabs.query({ url: `${origin}/*` });
  } catch {
    return; // no match-pattern access to this origin
  }
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id == null) return;
      try {
        await api.tabs.sendMessage(tab.id, { type: "levora:apply", settings });
      } catch {
        // Browser-internal page, or a tab with no content script yet.
      }
      await updateBadge(tab.id, settings);
    }),
  );
}

function notifyPopup(tabId, payload) {
  try {
    Promise.resolve(
      api.runtime.sendMessage({ type: "levora:state", tabId, ...payload }),
    )?.catch?.(() => {});
  } catch {
    // No popup open — expected most of the time.
  }
}

async function handleFrameReport(tabId, frameId, capabilities, isHello) {
  const record = await readFrames(tabId);
  if (capabilities.isTopFrame) {
    record.origin = capabilities.origin;
    if (isHello) record.frames = {};
  }
  record.frames[String(frameId)] = capabilities;
  await writeFrames(tabId, record);

  const settings = await readSettings(record.origin ?? capabilities.origin);
  await updateBadge(tabId, settings);
  notifyPopup(tabId, { settings, frames: record.frames, origin: record.origin });
  return settings;
}

async function handleMessage(message, sender) {
  const type = message?.type;

  if (type === "levora:hello" || type === "levora:report") {
    const tabId = sender.tab?.id;
    if (tabId == null) return null;
    const settings = await handleFrameReport(
      tabId,
      sender.frameId ?? 0,
      message.capabilities,
      type === "levora:hello",
    );
    // Only the top frame is told what to apply; sub-frames inherit through the
    // same broadcast on the next setSettings, and a fresh iframe picks the
    // value up from its own hello.
    return { settings };
  }

  // The fullscreen overlay changed something. It has already applied it
  // locally; our job is to make it stick for this origin.
  if (type === "levora:persist") {
    const origin = originOf(sender.tab?.url ?? "") ?? sender.origin ?? null;
    await writeSettings(origin, message.settings);
    await applyToOrigin(origin, message.settings);
    if (sender.tab?.id != null) await updateBadge(sender.tab.id, message.settings);
    notifyPopup(sender.tab?.id, { settings: message.settings, origin });
    return { ok: true };
  }

  if (type === "levora:getState") {
    const record = await readFrames(message.tabId);
    const origin = message.origin ?? record.origin;
    const settings = await readSettings(origin);
    try {
      Promise.resolve(
        api.tabs.sendMessage(message.tabId, { type: "levora:probe" }),
      )?.catch?.(() => {});
    } catch {
      // Browser-internal page with no content script.
    }
    return { settings, frames: record.frames, origin };
  }

  if (type === "levora:setSettings") {
    const origin = message.origin;
    await writeSettings(origin, message.settings);
    // The tab the popup is open in first, so the control the user is holding
    // responds without waiting on a query across every window.
    try {
      await api.tabs.sendMessage(message.tabId, {
        type: "levora:apply",
        settings: message.settings,
      });
    } catch {
      // No content script in this tab.
    }
    await updateBadge(message.tabId, message.settings);
    applyToOrigin(origin, message.settings);
    return { settings: message.settings, origin };
  }

  return null;
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse, () => sendResponse(null));
  return true; // response is async
});

api.tabs.onRemoved.addListener((tabId) => {
  api.storage.session.remove(tabKey(tabId));
});

api.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await api.tabs.get(tabId);
    updateBadge(tabId, await readSettings(originOf(tab.url ?? "")));
  } catch {
    // Tab vanished.
  }
});

api.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return;
  updateBadge(tabId, await readSettings(originOf(changeInfo.url)));
});
