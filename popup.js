const STORAGE_STATS = "stats";
/** Same key as background.js */
const SESSION_KEY = "activeSession";

const LIST_TOP = 10;
const WEEK_STACK_TOP = 5;

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

/** @type {{ text: string; variant: string } | null} */
let lastStatusSnapshot = null;

async function updateActiveStatus(statusEl) {
  if (!statusEl) return;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const { [SESSION_KEY]: session } = await chrome.storage.session.get(SESSION_KEY);

    let text = "";
    let variant = "is-neutral";

    if (!tab) {
      text = "No tab in this window.";
      variant = "is-neutral";
    } else {
      const host = parseHostname(tab.url || "");

      if (!host) {
        text = "This tab isn’t tracked — use a normal website (http/https) to see active time here.";
        variant = "is-muted";
      } else {
        const trackingThisTab =
          session && session.tabId === tab.id && session.hostname === host;

        if (trackingThisTab) {
          text = `Recording time on ${host}`;
          variant = "is-tracking";
        } else if (session?.hostname && session.tabId !== tab.id) {
          text = `Time is counting on another tab: ${session.hostname}`;
          variant = "is-other";
        } else {
          text = "Not recording — focus this tab on a website (idle pauses the timer).";
          variant = "is-waiting";
        }
      }
    }

    if (
      lastStatusSnapshot &&
      lastStatusSnapshot.text === text &&
      lastStatusSnapshot.variant === variant
    ) {
      return;
    }
    lastStatusSnapshot = { text, variant };

    statusEl.textContent = text;
    statusEl.className = `active-status ${variant}`;
  } catch {
    if (lastStatusSnapshot?.text !== "") {
      lastStatusSnapshot = { text: "", variant: "is-neutral" };
      statusEl.textContent = "";
      statusEl.className = "active-status is-neutral";
    }
  }
}

function addDays(date, n) {
  const x = new Date(date);
  x.setDate(x.getDate() + n);
  return x;
}

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** Compact label for axis ticks (seconds). */
function formatAxisDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function mergeDayBuckets(daysObj, keys) {
  const out = {};
  for (const k of keys) {
    const bucket = daysObj[k];
    if (!bucket || typeof bucket !== "object") continue;
    for (const [host, sec] of Object.entries(bucket)) {
      if (typeof sec !== "number" || sec <= 0) continue;
      out[host] = (out[host] || 0) + sec;
    }
  }
  return out;
}

function sortedEntries(obj) {
  return Object.entries(obj).sort((a, b) => b[1] - a[1]);
}

function sitesVisitedLabel(count) {
  if (count === 0) return "Sites: 0";
  if (count === 1) return "Sites: 1";
  return `Sites: ${count}`;
}

function aggregatedFingerprint(aggregated) {
  return JSON.stringify(sortedEntries(aggregated));
}

async function loadStatsDays() {
  const { [STORAGE_STATS]: raw } = await chrome.storage.local.get(STORAGE_STATS);
  return raw?.days && typeof raw.days === "object" ? raw.days : {};
}

async function loadAggregated(range) {
  const days = await loadStatsDays();
  const today = localDayKey();
  const dayKeys = Object.keys(days).sort();

  if (range === "today") {
    return mergeDayBuckets(days, [today]);
  }
  if (range === "week") {
    const keys = [];
    for (let i = 0; i < 7; i++) {
      keys.push(localDayKey(addDays(new Date(), -i)));
    }
    return mergeDayBuckets(days, keys);
  }
  return mergeDayBuckets(days, dayKeys);
}

function shortDayLabel(date) {
  const d = date.getDate();
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getDay()];
  return `${wd} ${d}`;
}

/** Oldest → newest (7 slots), each { dayKey, label, bucket } */
async function loadWeekDaySeries() {
  const days = await loadStatsDays();
  const series = [];
  for (let i = 6; i >= 0; i--) {
    const dt = addDays(new Date(), -i);
    const key = localDayKey(dt);
    const bucket = days[key] && typeof days[key] === "object" ? { ...days[key] } : {};
    series.push({ dayKey: key, label: shortDayLabel(dt), bucket });
  }
  return series;
}

function totalBucketSeconds(bucket) {
  let t = 0;
  for (const v of Object.values(bucket)) {
    if (typeof v === "number" && v > 0) t += v;
  }
  return t;
}

const CHART_HUES = [28, 12, 42, 0, 345, 55, 20, 330];

function colorForIndex(i) {
  const h = CHART_HUES[i % CHART_HUES.length];
  return `hsl(${h} 85% 55%)`;
}

function colorOther() {
  return "hsl(24 10% 75%)";
}

/** @type {string | null} */
let lastListFingerprint = null;

function applyFooter(totalEl, siteCountEl, aggregated) {
  const entries = sortedEntries(aggregated);
  const total = entries.reduce((sum, [, sec]) => sum + sec, 0);
  if (siteCountEl) siteCountEl.textContent = sitesVisitedLabel(entries.length);
  totalEl.textContent = `Total: ${formatDuration(total)}`;
}

function renderList(listEl, aggregated) {
  const fp = aggregatedFingerprint(aggregated);
  if (fp === lastListFingerprint && listEl.childElementCount > 0) {
    applyFooter(totalEl, siteCountEl, aggregated);
    return;
  }
  lastListFingerprint = fp;

  const entries = sortedEntries(aggregated);
  const max = entries.length ? entries[0][1] : 0;
  applyFooter(totalEl, siteCountEl, aggregated);

  if (!entries.length) {
    listEl.innerHTML =
      '<div class="empty" role="listitem">No tracked time yet. Focus a tab on a website to start.</div>';
    return;
  }

  const frag = document.createDocumentFragment();
  for (const [host, sec] of entries) {
    const pct = max > 0 ? Math.round((sec / max) * 100) : 0;
    const row = document.createElement("div");
    row.className = "row";
    row.setAttribute("role", "listitem");

    const main = document.createElement("div");
    main.className = "row-main";

    const hostEl = document.createElement("div");
    hostEl.className = "host";
    hostEl.title = host;
    hostEl.textContent = host;

    const barWrap = document.createElement("div");
    barWrap.className = "bar-wrap";
    barWrap.setAttribute("aria-hidden", "true");
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.style.width = `${pct}%`;
    barWrap.appendChild(bar);

    main.appendChild(hostEl);
    main.appendChild(barWrap);

    const timeEl = document.createElement("div");
    timeEl.className = "time";
    timeEl.textContent = formatDuration(sec);

    row.appendChild(main);
    row.appendChild(timeEl);
    frag.appendChild(row);
  }
  listEl.replaceChildren(frag);
}

/** @type {string | null} */
let lastChartFingerprint = null;

function weekSeriesFingerprint(series) {
  return JSON.stringify(
    series.map((s) => [s.dayKey, totalBucketSeconds(s.bucket), sortedEntries(s.bucket)])
  );
}

function elSvg(name, attrs = {}) {
  const n = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v != null && v !== false) n.setAttribute(k, String(v));
  }
  return n;
}

function renderHorizontalBarChart(svg, aggregated) {
  const entries = sortedEntries(aggregated);
  const shown = entries.slice(0, LIST_TOP);
  const rest = entries.slice(LIST_TOP);
  const otherSec = rest.reduce((s, [, sec]) => s + sec, 0);
  const rows = otherSec > 0 ? [...shown, ["Other", otherSec]] : shown;

  const maxSec = rows.length ? Math.max(...rows.map(([, s]) => s)) : 0;
  const W = 336;
  const padL = 92;
  const padR = 10;
  const padT = 6;
  const padB = 30;
  const rowH = 22;
  const barH = 12;
  const innerW = W - padL - padR;
  const H = padT + padB + rows.length * rowH;

  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("role", "img");

  const total = entries.reduce((sum, [, sec]) => sum + sec, 0);
  svg.setAttribute(
    "aria-label",
    `Time by site, ${rows.length} bars. Total tracked ${formatDuration(total)}.`
  );

  if (!rows.length || maxSec <= 0) {
    const t = elSvg("text", {
      x: W / 2,
      y: H / 2,
      "text-anchor": "middle",
      fill: "#a1a1aa",
      "font-size": "12",
      "font-family": "system-ui,sans-serif",
    });
    t.textContent = "No data for this range";
    svg.appendChild(t);
    return { height: H, caption: "" };
  }

  const scale = innerW / maxSec;
  const axisY = H - padB + 8;

  const axis = elSvg("line", {
    x1: padL,
    y1: axisY,
    x2: W - padR,
    y2: axisY,
    stroke: "#e4e4e7",
    "stroke-width": "1",
  });
  svg.appendChild(axis);

  const tickCount = 4;
  for (let i = 0; i <= tickCount; i++) {
    const v = (maxSec * i) / tickCount;
    const x = padL + v * scale;
    const line = elSvg("line", {
      x1: x,
      y1: axisY,
      x2: x,
      y2: axisY + 4,
      stroke: "#d4d4d8",
      "stroke-width": "1",
    });
    svg.appendChild(line);
    const lab = elSvg("text", {
      x,
      y: H - 4,
      "text-anchor": "middle",
      fill: "#71717a",
      "font-size": "9",
      "font-family": "system-ui,sans-serif",
    });
    lab.textContent = formatAxisDuration(v);
    svg.appendChild(lab);
  }

  rows.forEach(([host, sec], i) => {
    const y = padT + i * rowH;
    const label = elSvg("text", {
      x: padL - 8,
      y: y + rowH / 2 + 4,
      "text-anchor": "end",
      fill: "#18181b",
      "font-size": "10",
      "font-family": "system-ui,sans-serif",
    });
    label.textContent = host.length > 18 ? `${host.slice(0, 16)}…` : host;
    svg.appendChild(label);

    const bw = Math.max(2, sec * scale);
    const rect = elSvg("rect", {
      x: padL,
      y: y + (rowH - barH) / 2,
      width: bw,
      height: barH,
      rx: "3",
      fill: host === "Other" ? colorOther() : colorForIndex(i),
    });
    svg.appendChild(rect);

    const timeLab = elSvg("text", {
      x: padL + bw + 4,
      y: y + rowH / 2 + 4,
      fill: "#52525b",
      "font-size": "9",
      "font-family": "system-ui,sans-serif",
    });
    timeLab.textContent = formatDuration(sec);
    svg.appendChild(timeLab);
  });

  const caption = `Bar length is exact time per site (top ${LIST_TOP}${otherSec > 0 ? ", plus Other" : ""}). Axis shows total span.`;
  return { height: H, caption };
}

function renderWeekStackedChart(svg, series) {
  const W = 336;
  const padL = 4;
  const padR = 4;
  const chartTop = 8;
  const chartBottom = 168;
  const chartLeft = 24;
  const chartRight = W - padR;
  const innerChartW = chartRight - chartLeft;
  const slot = innerChartW / 7;
  const barW = Math.min(28, slot * 0.62);

  const merged = {};
  for (const { bucket } of series) {
    for (const [h, sec] of Object.entries(bucket)) {
      if (typeof sec === "number" && sec > 0) merged[h] = (merged[h] || 0) + sec;
    }
  }
  const topHosts = sortedEntries(merged)
    .slice(0, WEEK_STACK_TOP)
    .map(([h]) => h);

  const maxDay = Math.max(...series.map((s) => totalBucketSeconds(s.bucket)));
  const innerH = chartBottom - chartTop;

  const H = 200;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("role", "img");

  const weekTotal = series.reduce((sum, s) => sum + totalBucketSeconds(s.bucket), 0);
  svg.setAttribute(
    "aria-label",
    `Seven-day stacked bar chart. Total tracked ${formatDuration(weekTotal)}.`
  );

  if (maxDay <= 0) {
    const t = elSvg("text", {
      x: W / 2,
      y: H / 2,
      "text-anchor": "middle",
      fill: "#a1a1aa",
      "font-size": "12",
      "font-family": "system-ui,sans-serif",
    });
    t.textContent = "No data for this range";
    svg.appendChild(t);
    return { height: H, caption: "", legend: [] };
  }

  const scale = innerH / maxDay;

  const hasOther = series.some(({ bucket }) =>
    Object.entries(bucket).some(([h, v]) => {
      if (typeof v !== "number" || v <= 0) return false;
      return !topHosts.includes(h);
    })
  );
  const stackKeysBase = [...topHosts, ...(hasOther ? ["__other__"] : [])];

  const axisY = chartBottom + 2;
  svg.appendChild(
    elSvg("line", {
      x1: chartLeft - 4,
      y1: axisY,
      x2: chartRight,
      y2: axisY,
      stroke: "#e4e4e7",
      "stroke-width": "1",
    })
  );

  for (let i = 0; i < 7; i++) {
    const cx = chartLeft + i * slot + slot / 2;
    const { label, bucket } = series[i];
    const lbl = elSvg("text", {
      x: cx,
      y: H - 6,
      "text-anchor": "middle",
      fill: "#71717a",
      "font-size": "9",
      "font-family": "system-ui,sans-serif",
    });
    lbl.textContent = label;
    svg.appendChild(lbl);

    let yTop = chartBottom;
    for (const key of stackKeysBase) {
      let sec = 0;
      if (key === "__other__") {
        for (const [h, v] of Object.entries(bucket)) {
          if (typeof v !== "number" || v <= 0) continue;
          if (!topHosts.includes(h)) sec += v;
        }
      } else {
        sec = typeof bucket[key] === "number" ? bucket[key] : 0;
      }
      if (sec <= 0) continue;
      const hPx = sec * scale;
      yTop -= hPx;
      const fill =
        key === "__other__" ? colorOther() : colorForIndex(topHosts.indexOf(key));
      svg.appendChild(
        elSvg("rect", {
          x: cx - barW / 2,
          y: yTop,
          width: barW,
          height: hPx,
          fill,
          stroke: "#fff",
          "stroke-width": "0.5",
        })
      );
    }
  }

  const yTicks = 4;
  for (let t = 0; t <= yTicks; t++) {
    const sec = (maxDay * t) / yTicks;
    const y = chartBottom - sec * scale;
    svg.appendChild(
      elSvg("line", {
        x1: chartLeft - 3,
        y1: y,
        x2: chartLeft - 1,
        y2: y,
        stroke: "#d4d4d8",
        "stroke-width": "1",
      })
    );
    const lab = elSvg("text", {
      x: chartLeft - 6,
      y: y + 3,
      "text-anchor": "end",
      fill: "#a1a1aa",
      "font-size": "8",
      "font-family": "system-ui,sans-serif",
    });
    lab.textContent = formatAxisDuration(sec);
    svg.appendChild(lab);
  }

  const legend = hasOther ? [...topHosts, "__other__"] : [...topHosts];

  const caption = `Each column is one calendar day (left = older). Stacks use the top ${WEEK_STACK_TOP} sites by week total${hasOther ? "; remaining time is Other" : ""}. Bar height matches seconds that day.`;
  return { height: H, caption, legend };
}

function buildLegend(container, legendHosts) {
  container.replaceChildren();
  const wrap = document.createElement("div");
  wrap.className = "chart-legend";
  legendHosts.forEach((h, i) => {
    const item = document.createElement("span");
    item.className = "chart-legend-item";
    const sw = document.createElement("span");
    sw.className = "chart-legend-swatch";
    sw.style.background = h === "__other__" ? colorOther() : colorForIndex(i);
    const lb = document.createElement("span");
    lb.className = "chart-legend-label";
    lb.textContent = h === "__other__" ? "Other" : h;
    item.appendChild(sw);
    item.appendChild(lb);
    wrap.appendChild(item);
  });
  container.appendChild(wrap);
}

async function renderChartPanel(chartRoot, captionEl, range, aggregated) {
  let fp;
  let series = null;

  if (range === "week") {
    series = await loadWeekDaySeries();
    fp = `week|${weekSeriesFingerprint(series)}`;
  } else {
    fp = `${range}|${aggregatedFingerprint(aggregated)}`;
  }

  if (fp === lastChartFingerprint && chartRoot.querySelector("svg")) {
    applyFooter(totalEl, siteCountEl, aggregated);
    return;
  }
  lastChartFingerprint = fp;

  chartRoot.replaceChildren();
  const svg = elSvg("svg", { "aria-hidden": "false" });
  let caption = "";
  let legendHosts = null;

  if (range === "week") {
    const r = renderWeekStackedChart(svg, series);
    caption = r.caption;
    legendHosts = r.legend;
  } else {
    const r = renderHorizontalBarChart(svg, aggregated);
    caption = r.caption;
  }

  chartRoot.appendChild(svg);

  const legendSlot = document.createElement("div");
  legendSlot.className = "chart-legend-slot";
  chartRoot.appendChild(legendSlot);
  if (legendHosts && legendHosts.length) {
    buildLegend(legendSlot, legendHosts);
  }

  if (captionEl) captionEl.textContent = caption;
  applyFooter(totalEl, siteCountEl, aggregated);
}

function setActiveTab(buttons, activeBtn) {
  buttons.forEach((b) => {
    const on = b === activeBtn;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
}

function setViewPanels(view) {
  const listPanel = document.getElementById("panel-list");
  const chartPanel = document.getElementById("panel-chart");
  const isChart = view === "chart";
  if (listPanel) {
    listPanel.classList.toggle("is-hidden", isChart);
  }
  if (chartPanel) {
    chartPanel.classList.toggle("is-hidden", !isChart);
    chartPanel.setAttribute("aria-hidden", isChart ? "false" : "true");
  }
}

const listEl = document.getElementById("list");
const totalEl = document.getElementById("total");
const siteCountEl = document.getElementById("site-count");
const statusEl = document.getElementById("active-status");
const rangeTabButtons = [...document.querySelectorAll(".tabs .tab")];
const viewTabButtons = [...document.querySelectorAll(".view-tab")];
const privacyBtn = document.getElementById("open-privacy");
const chartRoot = document.getElementById("chart-root");
const chartCaptionEl = document.getElementById("chart-caption");

let currentRange = "today";
let currentView = "list";

async function loadAndPaint() {
  const agg = await loadAggregated(currentRange);
  if (currentView === "list") {
    renderList(listEl, agg);
  } else if (chartRoot && chartCaptionEl) {
    await renderChartPanel(chartRoot, chartCaptionEl, currentRange, agg);
  } else {
    applyFooter(totalEl, siteCountEl, agg);
  }
}

function refreshAll() {
  updateActiveStatus(statusEl);
  loadAndPaint();
}

function onTabContextMaybeChanged() {
  lastStatusSnapshot = null;
  updateActiveStatus(statusEl);
}

function attachPopupListeners() {
  const onActivated = () => onTabContextMaybeChanged();
  const onUpdated = (tabId, info) => {
    if (info.status === "complete" || info.url !== undefined) {
      chrome.tabs.query({ active: true, currentWindow: true }, ([t]) => {
        if (t && t.id === tabId) onTabContextMaybeChanged();
      });
    }
  };

  chrome.tabs.onActivated.addListener(onActivated);
  chrome.tabs.onUpdated.addListener(onUpdated);

  window.addEventListener(
    "pagehide",
    () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    },
    { once: true }
  );
}

rangeTabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    currentRange = btn.dataset.range;
    lastListFingerprint = null;
    lastChartFingerprint = null;
    setActiveTab(rangeTabButtons, btn);
    refreshAll();
  });
});

viewTabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    currentView = btn.dataset.view;
    setActiveTab(viewTabButtons, btn);
    setViewPanels(currentView);
    lastListFingerprint = null;
    lastChartFingerprint = null;
    refreshAll();
  });
});

if (privacyBtn) {
  privacyBtn.addEventListener("click", () => {
    const url = chrome.runtime.getURL("privacy.html");
    chrome.tabs.create({ url });
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes[SESSION_KEY]) {
    lastStatusSnapshot = null;
    updateActiveStatus(statusEl);
    return;
  }
  if (area === "local" && changes[STORAGE_STATS]) {
    lastListFingerprint = null;
    lastChartFingerprint = null;
    loadAndPaint();
  }
});

setViewPanels(currentView);
attachPopupListeners();
refreshAll();
