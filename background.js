const ALARM_TICK = "tab-time-tick";
const STORAGE_STATS = "stats";
const SESSION_KEY = "activeSession";

function localDayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseHostname(url) {
  try {
    const u = new URL(url);
    if (!["http:", "https:"].includes(u.protocol)) return null;
    const host = u.hostname;
    if (!host) return null;
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return null;
  }
}

function isTrackableTab(tab) {
  if (!tab?.url) return false;
  return parseHostname(tab.url) !== null;
}

async function getStats() {
  const { [STORAGE_STATS]: raw } = await chrome.storage.local.get(STORAGE_STATS);
  return raw && typeof raw === "object" ? raw : { days: {} };
}

async function saveStats(stats) {
  await chrome.storage.local.set({ [STORAGE_STATS]: stats });
}

const STORAGE_LIMITS = "siteLimits";

async function getLimits() {
  const { [STORAGE_LIMITS]: limits } = await chrome.storage.local.get(STORAGE_LIMITS);
  return limits && typeof limits === "object" ? limits : {};
}

async function isHostBlocked(hostname) {
  if (!hostname) return false;
  const limits = await getLimits();
  const limitMin = limits[hostname];
  if (!limitMin || limitMin <= 0) return false;

  const stats = await getStats();
  const key = localDayKey();
  const todaySec = stats.days?.[key]?.[hostname] || 0;

  return todaySec >= limitMin * 60;
}

async function addSecondsForHost(hostname, seconds) {
  if (!hostname || seconds <= 0) return;
  const key = localDayKey();
  const hour = new Date().getHours(); // 0-23
  const stats = await getStats();
  if (!stats.days) stats.days = {};
  if (!stats.days[key]) stats.days[key] = {};
  stats.days[key][hostname] = (stats.days[key][hostname] || 0) + seconds;

  // Also store hourly breakdown for the Activity Trend graph
  if (!stats.days[key].__hours__) stats.days[key].__hours__ = {};
  if (!stats.days[key].__hours__[hour]) stats.days[key].__hours__[hour] = {};
  stats.days[key].__hours__[hour][hostname] =
    (stats.days[key].__hours__[hour][hostname] || 0) + seconds;

  await saveStats(stats);
}

async function getSession() {
  const { [SESSION_KEY]: s } = await chrome.storage.session.get(SESSION_KEY);
  return s && typeof s === "object" ? s : null;
}

async function setSession(session) {
  if (session == null) {
    await chrome.storage.session.remove(SESSION_KEY);
  } else {
    await chrome.storage.session.set({ [SESSION_KEY]: session });
  }
}

/** Credit elapsed time since session.startedAt; optionally keep session with fresh startedAt */
async function flushSession({ keep = false } = {}) {
  const session = await getSession();
  if (!session?.hostname || !session.startedAt) {
    if (!keep) await setSession(null);
    return;
  }
  const now = Date.now();
  const sec = Math.floor((now - session.startedAt) / 1000);
  if (sec > 0) {
    await addSecondsForHost(session.hostname, sec);
  }
  if (keep && session.hostname) {
    await setSession({
      ...session,
      startedAt: now,
    });
    if (await isHostBlocked(session.hostname)) {
       const blockedUrl = chrome.runtime.getURL(`blocked.html?host=${encodeURIComponent(session.hostname)}`);
       chrome.tabs.update(session.tabId, { url: blockedUrl }).catch(() => {});
    }
  } else {
    await setSession(null);
  }
}

async function startSessionFromTab(tab) {
  await flushSession({ keep: false });
  if (!tab?.id || !isTrackableTab(tab)) {
    await setSession(null);
    return;
  }
  const hostname = parseHostname(tab.url);

  if (await isHostBlocked(hostname)) {
    await setSession(null);
    const blockedUrl = chrome.runtime.getURL(`blocked.html?host=${encodeURIComponent(hostname)}`);
    chrome.tabs.update(tab.id, { url: blockedUrl }).catch(() => {});
    return;
  }

  await setSession({
    tabId: tab.id,
    windowId: tab.windowId,
    hostname,
    startedAt: Date.now(),
  });
}

async function syncToActiveTab() {
  const idleState = await chrome.idle.queryState(60);
  if (idleState !== "active") {
    await flushSession({ keep: false });
    return;
  }
  const win = await chrome.windows.getLastFocused({ populate: false }).catch(() => null);
  if (!win?.focused) {
    await flushSession({ keep: false });
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
  if (!tab) {
    await flushSession({ keep: false });
    return;
  }
  const session = await getSession();
  const hostname = parseHostname(tab.url || "");
  if (
    session &&
    session.tabId === tab.id &&
    session.hostname === hostname &&
    hostname
  ) {
    return;
  }
  await startSessionFromTab(tab);
}

async function onTabActivated(activeInfo) {
  const win = await chrome.windows.get(activeInfo.windowId).catch(() => null);
  if (!win?.focused) return;

  const idleState = await chrome.idle.queryState(60);
  if (idleState !== "active") {
    await flushSession({ keep: false });
    return;
  }
  const tab = await chrome.tabs.get(activeInfo.tabId).catch(() => null);
  if (!tab || !tab.active) return;
  await startSessionFromTab(tab);
}

async function onTabUpdated(tabId, changeInfo, tab) {
  const urlOrNavDone =
    changeInfo.status === "complete" || changeInfo.url !== undefined;
  if (!urlOrNavDone) return;
  if (!tab.active) return;

  const win = await chrome.windows.get(tab.windowId).catch(() => null);
  if (!win?.focused) return;

  const idleState = await chrome.idle.queryState(60);
  if (idleState !== "active") return;

  // Always start a session for the active tab when its URL changes or
  // finishes loading.  The previous guard (session?.tabId !== tabId) caused
  // new tabs to be silently skipped because the session was still bound to
  // the previous tab.
  await startSessionFromTab(tab);
}

async function onTabRemoved(tabId) {
  const session = await getSession();
  if (session?.tabId === tabId) {
    await flushSession({ keep: false });
  }
}

async function onWindowFocusChanged(windowId) {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    await flushSession({ keep: false });
    return;
  }
  await syncToActiveTab();
}

async function onIdleStateChanged(newState) {
  if (newState !== "active") {
    await flushSession({ keep: false });
    return;
  }
  await syncToActiveTab();
}

function ensureAlarm() {
  chrome.alarms.get(ALARM_TICK, (a) => {
    if (!a) {
      chrome.alarms.create(ALARM_TICK, { periodInMinutes: 1 });
    }
  });
}

// --- Config Preference ---
const STORAGE_VIEW_MODE = "viewMode";
const STORAGE_IDLE_TIMEOUT = "idleTimeout";

async function applyViewModePreference() {
  const { [STORAGE_VIEW_MODE]: mode } = await chrome.storage.local.get(STORAGE_VIEW_MODE);
  
  if (mode === "side_panel") {
    // If preference is side panel, disable popup and enable side panel on click
    await chrome.action.setPopup({ popup: "" });
    if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    }
  } else {
    // Default is popup
    await chrome.action.setPopup({ popup: "popup.html" });
    if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
    }
  }
}

async function applyIdleTimeoutPreference() {
  const { [STORAGE_IDLE_TIMEOUT]: timeout } = await chrome.storage.local.get(STORAGE_IDLE_TIMEOUT);
  if (timeout && typeof timeout === "number") {
    chrome.idle.setDetectionInterval(timeout);
  } else {
    chrome.idle.setDetectionInterval(60);
  }
}

ensureAlarm();
applyIdleTimeoutPreference();
syncToActiveTab();

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  applyIdleTimeoutPreference();
  syncToActiveTab();
  applyViewModePreference();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  applyIdleTimeoutPreference();
  syncToActiveTab();
  applyViewModePreference();
});

chrome.tabs.onActivated.addListener((info) => {
  onTabActivated(info);
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  onTabUpdated(tabId, info, tab);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  onTabRemoved(tabId);
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  onWindowFocusChanged(windowId);
});

chrome.idle.onStateChanged.addListener((s) => {
  onIdleStateChanged(s);
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_TICK) return;

  // Pause tracking when user is idle (AFK / screen locked)
  const idleState = await chrome.idle.queryState(60);
  if (idleState !== "active") {
    await flushSession({ keep: false });
    return;
  }

  const win = await chrome.windows.getLastFocused().catch(() => null);
  if (!win?.focused) {
    await flushSession({ keep: false });
    return;
  }
  await flushSession({ keep: true });
  await syncToActiveTab();
});

// Also apply immediately
applyViewModePreference();
