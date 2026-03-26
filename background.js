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

async function addSecondsForHost(hostname, seconds) {
  if (!hostname || seconds <= 0) return;
  const key = localDayKey();
  const stats = await getStats();
  if (!stats.days) stats.days = {};
  if (!stats.days[key]) stats.days[key] = {};
  stats.days[key][hostname] = (stats.days[key][hostname] || 0) + seconds;
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
  const win = await chrome.windows.get(tab.windowId).catch(() => null);
  if (!win?.focused) return;

  const idleState = await chrome.idle.queryState(60);
  if (idleState !== "active") return;
  const session = await getSession();
  if (session?.tabId !== tabId) return;
  if (!tab.active) return;
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

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  chrome.idle.setDetectionInterval(60);
  syncToActiveTab();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  chrome.idle.setDetectionInterval(60);
  syncToActiveTab();
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
  const win = await chrome.windows.getLastFocused().catch(() => null);
  if (!win?.focused) {
    await flushSession({ keep: false });
    return;
  }
  await flushSession({ keep: true });
  await syncToActiveTab();
});

ensureAlarm();
chrome.idle.setDetectionInterval(60);
syncToActiveTab();
