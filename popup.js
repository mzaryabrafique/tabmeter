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
    let targetHost = null;

    window.currentActiveHost = null;
    window.isTrackingActiveHost = false;

    if (!tab) {
      text = "No tab in this window.";
      variant = "is-neutral";
    } else {
      const host = parseHostname(tab.url || "");

      if (!host) {
        text = "This tab isn’t tracked, use a normal website (http/https) to see active time here.";
        variant = "is-muted";
      } else {
        targetHost = host;
        const trackingThisTab =
          session && session.tabId === tab.id && session.hostname === host;

        if (trackingThisTab) {
          window.currentActiveHost = host;
          window.isTrackingActiveHost = true;
          text = `Recording time on ${host}`;
          variant = "is-tracking";
        } else if (session?.hostname && session.tabId !== tab.id) {
          text = `Time is counting on another tab: ${session.hostname}`;
          variant = "is-other";
        } else {
          text = "Not recording, focus this tab on a website (idle pauses the timer).";
          variant = "is-waiting";
        }
      }
    }

    if (
      lastStatusSnapshot &&
      lastStatusSnapshot.text === text &&
      lastStatusSnapshot.variant === variant
    ) {
      // It's the same visual state, but we might have changed host.
      // Update the targetHost silently.
      if (window.isTrackingActiveHost && activeSiteCard) {
        if (quickLimitBtn) quickLimitBtn.classList.add("is-hidden");
        if (activeCardLimitBtn) activeCardLimitBtn.dataset.host = window.currentActiveHost;
      } else {
        if (quickLimitBtn) {
          if (targetHost) {
            quickLimitBtn.classList.remove("is-hidden");
            quickLimitBtn.dataset.host = targetHost;
          } else {
            quickLimitBtn.classList.add("is-hidden");
          }
        }
      }
      return;
    }
    lastStatusSnapshot = { text, variant };

    statusEl.textContent = text;
    statusEl.className = `active-status ${variant}`;
    
    if (window.isTrackingActiveHost && activeSiteCard) {
      activeSiteCard.classList.remove("is-hidden");
      statusEl.classList.add("is-hidden");
      if (quickLimitBtn) quickLimitBtn.classList.add("is-hidden");
      if (activeCardHost) activeCardHost.textContent = window.currentActiveHost;
      if (activeCardLimitBtn) activeCardLimitBtn.dataset.host = window.currentActiveHost;
    } else {
      if (activeSiteCard) activeSiteCard.classList.add("is-hidden");
      statusEl.classList.remove("is-hidden");
      if (quickLimitBtn) {
        if (targetHost) {
          quickLimitBtn.classList.remove("is-hidden");
          quickLimitBtn.dataset.host = targetHost;
        } else {
          quickLimitBtn.classList.add("is-hidden");
        }
      }
    }
  } catch {
    if (lastStatusSnapshot?.text !== "") {
      lastStatusSnapshot = { text: "", variant: "is-neutral" };
      statusEl.textContent = "";
      statusEl.className = "active-status is-neutral";
      if (activeSiteCard) activeSiteCard.classList.add("is-hidden");
      statusEl.classList.remove("is-hidden");
      if (quickLimitBtn) quickLimitBtn.classList.add("is-hidden");
      window.currentActiveHost = null;
      window.isTrackingActiveHost = false;
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
      if (host === "__hours__") continue; // skip hourly sub-bucket
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
  return count.toString();
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

/** Load daily totals for the line chart.
 *  - "today" / "week": last 7 days
 *  - "all": all recorded days (capped at 30 most recent) */
async function loadDailyTotals(range) {
  const days = await loadStatsDays();
  const todayKey = localDayKey();
  const entries = [];

  if (range === "today" || range === "week") {
    for (let i = 6; i >= 0; i--) {
      const dt = addDays(new Date(), -i);
      const key = localDayKey(dt);
      const bucket = days[key] && typeof days[key] === "object" ? days[key] : {};
      entries.push({
        label: shortDayLabel(dt),
        value: totalBucketSeconds(bucket),
        isToday: i === 0,
        dayKey: key,
      });
    }
  } else {
    const allKeys = Object.keys(days).sort();
    for (const key of allKeys) {
      const bucket = days[key] && typeof days[key] === "object" ? days[key] : {};
      const parts = key.split("-");
      const dt = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
      entries.push({
        label: shortDayLabel(dt),
        value: totalBucketSeconds(bucket),
        isToday: key === todayKey,
        dayKey: key,
      });
    }
    // Cap at 30 most recent days
    if (entries.length > 30) {
      entries.splice(0, entries.length - 30);
    }
  }
  return entries;
}

function totalBucketSeconds(bucket) {
  let t = 0;
  for (const [k, v] of Object.entries(bucket)) {
    if (k === "__hours__") continue; // skip hourly sub-bucket
    if (typeof v === "number" && v > 0) t += v;
  }
  return t;
}

/** Load hourly totals for today's Activity Trend line chart.
 *  Returns 24 entries (0h–23h) with total seconds per hour. */
async function loadHourlyTotals() {
  const days = await loadStatsDays();
  const todayKey = localDayKey();
  const todayBucket = days[todayKey];
  const hours = todayBucket?.__hours__ || {};
  const currentHour = new Date().getHours();
  const entries = [];

  for (let h = 0; h <= currentHour; h++) {
    const hourBucket = hours[h] || {};
    let total = 0;
    for (const v of Object.values(hourBucket)) {
      if (typeof v === "number" && v > 0) total += v;
    }
    const ampm = h === 0 ? "12am" : h < 12 ? `${h}am` : h === 12 ? "12pm" : `${h - 12}pm`;
    entries.push({
      label: ampm,
      value: total,
      isToday: h === currentHour,
      hour: h,
    });
  }
  return entries;
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
let lastLimitsFingerprint = null;

function applyFooter(totalEl, siteCountEl, aggregated) {
  const entries = sortedEntries(aggregated);
  const total = entries.reduce((sum, [, sec]) => sum + sec, 0);
  if (siteCountEl) siteCountEl.textContent = entries.length.toString();
  totalEl.textContent = formatDuration(total);
}

function renderList(listEl, aggregated, siteLimits = {}) {
  const fp = aggregatedFingerprint(aggregated) + JSON.stringify(siteLimits);
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

    const hostContainer = document.createElement("div");
    hostContainer.className = "host-container";

    const hostEl = document.createElement("div");
    hostEl.className = "host";
    hostEl.title = host;
    hostEl.textContent = host;
    hostContainer.appendChild(hostEl);

    // Limit Badge UI
    const limitSec = siteLimits[host];
    if (limitSec && limitSec > 0) {
      const limitBadge = document.createElement("div");
      limitBadge.className = "limit-badge";
      const limitStr = formatDuration(limitSec);
      limitBadge.title = `Daily limit: ${limitStr}`;
      limitBadge.textContent = `${limitStr} limit`;
      hostContainer.appendChild(limitBadge);
    }
    
    // Set limit button
    const limitBtn = document.createElement("button");
    limitBtn.type = "button";
    limitBtn.className = "limit-btn";
    limitBtn.title = limitSec ? "Edit Limit" : "Set Limit";
    limitBtn.innerHTML = "⏱️";
    limitBtn.dataset.host = host;
    limitBtn.addEventListener("click", () => openLimitModal(host, limitSec));
    hostContainer.appendChild(limitBtn);

    const barWrap = document.createElement("div");
    barWrap.className = "bar-wrap";
    barWrap.setAttribute("aria-hidden", "true");
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.style.width = `${pct}%`;
    barWrap.appendChild(bar);

    main.appendChild(hostContainer);
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
function renderLimitsPanel(listEl, emptyEl, siteLimits = {}, aggregated = {}) {
  const fp = JSON.stringify(siteLimits) + aggregatedFingerprint(aggregated);
  if (fp === lastLimitsFingerprint && listEl.childElementCount > 0) {
    return;
  }
  lastLimitsFingerprint = fp;

  const hosts = Object.keys(siteLimits);
  if (!hosts.length) {
    listEl.classList.add("is-hidden");
    emptyEl.classList.remove("is-hidden");
    return;
  }

  listEl.classList.remove("is-hidden");
  emptyEl.classList.add("is-hidden");

  const frag = document.createDocumentFragment();
  // Sort by host name or limit? Let's sort alphabetically by host.
  hosts.sort().forEach(host => {
    const limitSec = siteLimits[host];
    const sec = aggregated[host] || 0;

    const row = document.createElement("div");
    row.className = "row";
    row.setAttribute("role", "listitem");

    const main = document.createElement("div");
    main.className = "row-main";

    const hostContainer = document.createElement("div");
    hostContainer.className = "host-container";

    const hostEl = document.createElement("div");
    hostEl.className = "host";
    hostEl.title = host;
    hostEl.textContent = host;
    hostContainer.appendChild(hostEl);

    const limitBadge = document.createElement("div");
    limitBadge.className = "limit-badge";
    limitBadge.textContent = `${formatDuration(limitSec)} limit`;
    hostContainer.appendChild(limitBadge);

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "limit-btn";
    editBtn.title = "Edit Limit";
    editBtn.innerHTML = "⏱️";
    editBtn.addEventListener("click", () => openLimitModal(host, limitSec));
    hostContainer.appendChild(editBtn);

    main.appendChild(hostContainer);

    const timeEl = document.createElement("div");
    timeEl.className = "time";
    timeEl.textContent = formatDuration(sec);

    row.appendChild(main);
    row.appendChild(timeEl);
    frag.appendChild(row);
  });
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
      if (h === "__hours__") continue;
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
      if (h === "__hours__") return false;
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
          if (h === "__hours__") continue;
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

/** Render a smooth line chart SVG from daily totals. */
function renderLineChart(container, entries) {
  container.replaceChildren();

  if (!entries.length || entries.every((e) => e.value === 0)) {
    const empty = document.createElement("div");
    empty.className = "line-empty-text";
    empty.textContent = "No activity data yet";
    container.appendChild(empty);
    return;
  }

  const W = 336;
  const H = 140;
  const padL = 38;
  const padR = 12;
  const padT = 14;
  const padB = 26;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;

  const svg = elSvg("svg", { viewBox: `0 0 ${W} ${H}`, "aria-hidden": "false" });
  svg.setAttribute(
    "aria-label",
    `Activity trend line chart with ${entries.length} data points.`
  );

  const maxVal = Math.max(...entries.map((e) => e.value));
  const safeMax = maxVal > 0 ? maxVal : 1;

  // Defs: gradient fill under the line
  const defs = elSvg("defs");
  const gradId = "line-area-grad-" + Math.random().toString(36).slice(2, 8);
  const grad = elSvg("linearGradient", { id: gradId, x1: "0", y1: "0", x2: "0", y2: "1" });
  const stop1 = elSvg("stop", { offset: "0%", "stop-color": "#ff3b34", "stop-opacity": "0.18" });
  const stop2 = elSvg("stop", { offset: "100%", "stop-color": "#ffb74f", "stop-opacity": "0.02" });
  grad.appendChild(stop1);
  grad.appendChild(stop2);
  defs.appendChild(grad);
  svg.appendChild(defs);

  // Horizontal grid lines
  const gridCount = 4;
  for (let i = 0; i <= gridCount; i++) {
    const y = padT + (chartH * i) / gridCount;
    const val = safeMax * (1 - i / gridCount);

    svg.appendChild(
      elSvg("line", {
        x1: padL,
        y1: y,
        x2: W - padR,
        y2: y,
        stroke: i === gridCount ? "#e4e4e7" : "#f2f3f5",
        "stroke-width": "1",
        "stroke-dasharray": i > 0 && i < gridCount ? "3,3" : "0",
      })
    );

    // Y-axis labels (skip 0 at bottom for cleanliness)
    if (i < gridCount) {
      const lab = elSvg("text", {
        x: padL - 6,
        y: y + 3.5,
        "text-anchor": "end",
        fill: "#a1a1aa",
        "font-size": "8.5",
        "font-family": "system-ui,sans-serif",
      });
      lab.textContent = formatAxisDuration(val);
      svg.appendChild(lab);
    }
  }

  // Calculate points
  const n = entries.length;
  const points = entries.map((e, i) => {
    const x = n === 1 ? padL + chartW / 2 : padL + (i / (n - 1)) * chartW;
    const y = padT + chartH - (e.value / safeMax) * chartH;
    return { x, y, ...e };
  });

  // Build smooth path (cubic bezier)
  if (points.length > 1) {
    let pathD = `M${points[0].x},${points[0].y}`;
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const curr = points[i];
      const cpx = (prev.x + curr.x) / 2;
      pathD += ` C${cpx},${prev.y} ${cpx},${curr.y} ${curr.x},${curr.y}`;
    }

    // Area fill
    const areaD =
      pathD +
      ` L${points[points.length - 1].x},${padT + chartH}` +
      ` L${points[0].x},${padT + chartH} Z`;
    svg.appendChild(
      elSvg("path", {
        d: areaD,
        fill: `url(#${gradId})`,
      })
    );

    // Line stroke
    svg.appendChild(
      elSvg("path", {
        d: pathD,
        fill: "none",
        stroke: "#ff3b34",
        "stroke-width": "2",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      })
    );
  }

  // Data point dots
  points.forEach((p) => {
    svg.appendChild(
      elSvg("circle", {
        cx: p.x,
        cy: p.y,
        r: p.isToday ? "4" : "2.5",
        fill: p.isToday ? "#ff3b34" : "#ffffff",
        stroke: "#ff3b34",
        "stroke-width": p.isToday ? "2" : "1.5",
      })
    );
  });

  // X-axis labels — show at most 8 evenly spaced
  const maxLabels = 8;
  const step = Math.max(1, Math.ceil(n / maxLabels));
  points.forEach((p, i) => {
    if (n > maxLabels && i % step !== 0 && i !== n - 1) return;
    const lab = elSvg("text", {
      x: p.x,
      y: H - 4,
      "text-anchor": "middle",
      fill: p.isToday ? "#ff3b34" : "#71717a",
      "font-size": "8.5",
      "font-weight": p.isToday ? "600" : "400",
      "font-family": "system-ui,sans-serif",
    });
    lab.textContent = p.label;
    svg.appendChild(lab);
  });

  container.appendChild(svg);
}

const chartLineRoot = document.getElementById("chart-line-root");

async function renderChartPanel(chartRoot, captionEl, range, aggregated) {
  let fp;
  let series = null;

  if (range === "week") {
    series = await loadWeekDaySeries();
    fp = `week|${weekSeriesFingerprint(series)}`;
  } else {
    fp = `${range}|${aggregatedFingerprint(aggregated)}`;
  }

  // Load data for the line chart: hourly for "today", daily for other ranges
  let lineChartData = null;
  if (range === "today") {
    lineChartData = await loadHourlyTotals();
  } else {
    lineChartData = await loadDailyTotals(range);
  }
  fp += `|line:${JSON.stringify(lineChartData.map((d) => d.value))}`;

  if (fp === lastChartFingerprint && chartRoot.querySelector("svg")) {
    applyFooter(totalEl, siteCountEl, aggregated);
    return;
  }
  lastChartFingerprint = fp;

  // Render line chart (hourly for today, daily for other ranges)
  if (chartLineRoot) {
    renderLineChart(chartLineRoot, lineChartData);
  }

  // Render bar / stacked chart
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
  const limitsPanel = document.getElementById("panel-limits");

  if (listPanel) listPanel.classList.toggle("is-hidden", view !== "list");
  if (chartPanel) {
    chartPanel.classList.toggle("is-hidden", view !== "chart");
    chartPanel.setAttribute("aria-hidden", view === "chart" ? "false" : "true");
  }
  if (limitsPanel) {
    limitsPanel.classList.toggle("is-hidden", view !== "limits");
    limitsPanel.setAttribute("aria-hidden", view === "limits" ? "false" : "true");
  }
}

const listEl = document.getElementById("list");
const totalEl = document.getElementById("total");
const siteCountEl = document.getElementById("site-count");
const statusEl = document.getElementById("active-status");
const quickLimitBtn = document.getElementById("quick-limit-btn");

const activeSiteCard = document.getElementById("active-site-card");
const activeCardHost = document.getElementById("active-card-host");
const activeCardTime = document.getElementById("active-card-time");
const activeCardLimitBtn = document.getElementById("active-card-limit-btn");
const activeCardLimitBadge = document.getElementById("active-card-limit-badge");

const limitsListEl = document.getElementById("limits-list");
const limitsEmptyEl = document.getElementById("limits-empty");
const rangeTabButtons = [...document.querySelectorAll(".tabs .tab")];
const viewTabButtons = [...document.querySelectorAll(".view-tab")];
const privacyBtn = document.getElementById("open-privacy");
const chartRoot = document.getElementById("chart-root");
const chartCaptionEl = document.getElementById("chart-caption");

let currentRange = "today";
let currentView = "list";

const STORAGE_LIMITS = "siteLimits";

async function loadSiteLimits() {
  const { [STORAGE_LIMITS]: limits } = await chrome.storage.local.get(STORAGE_LIMITS);
  return limits && typeof limits === "object" ? limits : {};
}

async function saveSiteLimits(limits) {
  await chrome.storage.local.set({ [STORAGE_LIMITS]: limits });
  // Invalidate UI cache
  lastListFingerprint = null;
  loadAndPaint();
}

async function loadAndPaint() {
  const agg = await loadAggregated(currentRange);
  const limits = await loadSiteLimits();

  // LIVE UPDATE: Add elapsed time from current session if applicable
  if (currentRange === "today" || currentRange === "all") {
    const { [SESSION_KEY]: session } = await chrome.storage.session.get(SESSION_KEY);
    if (session && session.hostname && session.startedAt) {
      const elapsed = Math.floor((Date.now() - session.startedAt) / 1000);
      if (elapsed > 0) {
        agg[session.hostname] = (agg[session.hostname] || 0) + elapsed;
      }
    }
  }

  if (window.isTrackingActiveHost && activeCardTime && window.currentActiveHost) {
    const trackedSec = agg[window.currentActiveHost] || 0;
    activeCardTime.textContent = formatDuration(trackedSec);
    
    if (activeCardLimitBadge) {
      const limitSec = limits[window.currentActiveHost];
      if (limitSec && limitSec > 0) {
        activeCardLimitBadge.textContent = `${formatDuration(limitSec)} limit`;
        activeCardLimitBadge.classList.remove("is-hidden");
        if (activeCardLimitBtn) {
          activeCardLimitBtn.innerHTML = '<span aria-hidden="true">⏱️</span> Edit Limit';
        }
      } else {
        activeCardLimitBadge.classList.add("is-hidden");
        if (activeCardLimitBtn) {
          activeCardLimitBtn.innerHTML = '<span aria-hidden="true">⏱️</span> Set Limit';
        }
      }
    }
  }

  // Always update footer stats to ensure live updates for "Total Tracked"
  applyFooter(totalEl, siteCountEl, agg);

  if (currentView === "list") {
    renderList(listEl, agg, limits);
  } else if (currentView === "chart" && chartRoot && chartCaptionEl) {
    await renderChartPanel(chartRoot, chartCaptionEl, currentRange, agg);
  } else if (currentView === "limits" && limitsListEl && limitsEmptyEl) {
    renderLimitsPanel(limitsListEl, limitsEmptyEl, limits, agg);
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

// --- Modal Logic ---
const limitModal = document.getElementById("limit-modal");
const limitOverlay = document.getElementById("limit-modal-overlay");
const limitHostName = document.getElementById("limit-host-name");
const limitH = document.getElementById("limit-h");
const limitM = document.getElementById("limit-m");
const limitS = document.getElementById("limit-s");
const limitBtnSave = document.getElementById("limit-btn-save");
const limitBtnRemove = document.getElementById("limit-btn-remove");
const limitBtnCancel = document.getElementById("limit-btn-cancel");

// Add wheel support for time inputs with scroll prevention
[limitH, limitM, limitS].forEach(input => {
  input.addEventListener('wheel', (e) => {
    // If input is focused, let the wheel change value and prevent page scroll
    if (document.activeElement === input) {
      e.preventDefault();
      const step = 1;
      const min = parseInt(input.min) || 0;
      const max = parseInt(input.max) || 59;
      // Hours can go higher
      const actualMax = input.id === 'limit-h' ? 23 : max;
      
      let val = parseInt(input.value) || 0;
      if (e.deltaY < 0) {
        val = Math.min(actualMax, val + step);
      } else {
        val = Math.max(min, val - step);
      }
      input.value = val;
    }
  }, { passive: false });
});

let currentModalHost = null;

function openLimitModal(host, currentLimitSec) {
  currentModalHost = host;
  limitHostName.textContent = host;
  if (currentLimitSec) {
    const h = Math.floor(currentLimitSec / 3600);
    const m = Math.floor((currentLimitSec % 3600) / 60);
    const s = currentLimitSec % 60;
    limitH.value = h;
    limitM.value = m;
    limitS.value = s;
    limitBtnRemove.style.display = "inline-flex";
  } else {
    limitH.value = 0;
    limitM.value = 30; // Default to 30 mins
    limitS.value = 0;
    limitBtnRemove.style.display = "none";
  }
  
  // Lock body scroll
  document.body.style.overflow = "hidden";
  
  limitModal.classList.remove("is-hidden");
  limitModal.setAttribute("aria-hidden", "false");
  limitM.focus();
}

function closeLimitModal() {
  currentModalHost = null;
  limitModal.classList.add("is-hidden");
  limitModal.setAttribute("aria-hidden", "true");
  // Restore body scroll
  document.body.style.overflow = "";
}

limitOverlay.addEventListener("click", closeLimitModal);
limitBtnCancel.addEventListener("click", closeLimitModal);

limitBtnSave.addEventListener("click", async () => {
  if (!currentModalHost) return;
  const h = parseInt(limitH.value, 10) || 0;
  const m = parseInt(limitM.value, 10) || 0;
  const s = parseInt(limitS.value, 10) || 0;
  const totalSec = h * 3600 + m * 60 + s;
  
  if (totalSec > 0) {
    const lims = await loadSiteLimits();
    lims[currentModalHost] = totalSec;
    await saveSiteLimits(lims);
  }
  closeLimitModal();
});

limitBtnRemove.addEventListener("click", async () => {
  if (!currentModalHost) return;
  const lims = await loadSiteLimits();
  if (lims[currentModalHost]) {
    delete lims[currentModalHost];
    await saveSiteLimits(lims);
  }
  closeLimitModal();
});

if (quickLimitBtn) {
  quickLimitBtn.addEventListener("click", async () => {
    const host = quickLimitBtn.dataset.host;
    if (!host) return;
    const limits = await loadSiteLimits();
    openLimitModal(host, limits[host] || 0);
  });
}

if (activeCardLimitBtn) {
  activeCardLimitBtn.addEventListener("click", async () => {
    const host = activeCardLimitBtn.dataset.host;
    if (!host) return;
    const limits = await loadSiteLimits();
    openLimitModal(host, limits[host] || 0);
  });
}

setViewPanels(currentView);
attachPopupListeners();
refreshAll();

// Keep the UI updated live every second
setInterval(refreshAll, 1000);

// ─── Sidebar Logic ───────────────────────────────────────

const sidebarToggle = document.getElementById("sidebar-toggle");
const sidebar = document.getElementById("sidebar");
const sidebarOverlay = document.getElementById("sidebar-overlay");
const sidebarClose = document.getElementById("sidebar-close");
const sidebarPrivacyBtn = document.getElementById("sidebar-privacy-btn");
const sidebarSidePanelBtn = document.getElementById("sidebar-sidepanel-btn");
const sidebarSettingsBtn = document.getElementById("sidebar-settings-btn");
const sidebarHelpBtn = document.getElementById("sidebar-help-btn");
const sidebarSupportBtn = document.getElementById("sidebar-support-btn");

function openSidebar() {
  sidebar.classList.add("is-open");
  sidebar.setAttribute("aria-hidden", "false");
  sidebarOverlay.classList.add("is-visible");
  sidebarToggle.setAttribute("aria-expanded", "true");
  document.body.classList.add("sidebar-is-open");
  // Focus the close button for accessibility
  requestAnimationFrame(() => sidebarClose.focus());
}

function closeSidebar() {
  sidebar.classList.remove("is-open");
  sidebar.setAttribute("aria-hidden", "true");
  sidebarOverlay.classList.remove("is-visible");
  sidebarToggle.setAttribute("aria-expanded", "false");
  document.body.classList.remove("sidebar-is-open");
  sidebarToggle.focus();
}

if (sidebarToggle) sidebarToggle.addEventListener("click", openSidebar);
if (sidebarClose) sidebarClose.addEventListener("click", closeSidebar);
if (sidebarOverlay) sidebarOverlay.addEventListener("click", closeSidebar);

// Escape key closes sidebar
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && sidebar.classList.contains("is-open")) {
    closeSidebar();
  }
});

// Sidebar privacy link
if (sidebarPrivacyBtn) {
  sidebarPrivacyBtn.addEventListener("click", () => {
    const url = chrome.runtime.getURL("privacy.html");
    chrome.tabs.create({ url });
    closeSidebar();
  });
}

// Detect if we are currently in the popup
let isPopup = true;
try {
  isPopup = chrome.extension.getViews({ type: "popup" }).includes(window);
} catch (e) {
  console.warn("Could not determine view type:", e);
}

// Side Panel / Popup toggle button
if (sidebarSidePanelBtn) {
  const btnText = sidebarSidePanelBtn.querySelector('.sidebar-item-text');
  if (!isPopup && btnText) {
    btnText.textContent = "Switch to popup";
  }

  sidebarSidePanelBtn.addEventListener("click", async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      if (isPopup) {
        // Switch to Side Panel mode
        await chrome.storage.local.set({ viewMode: "side_panel" });
        await chrome.action.setPopup({ popup: "" });
        
        if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
          await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
          await chrome.sidePanel.open({ windowId: tab.windowId });
        } else {
          console.info("Side Panel API is not available.");
        }
        window.close(); // Close the popup after opening side panel
      } else {
        // Switch to Popup mode
        await chrome.storage.local.set({ viewMode: "popup" });
        await chrome.action.setPopup({ popup: "popup.html" });
        
        if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
          await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
        }
        
        if (chrome.action && chrome.action.openPopup) {
          // await chrome.action.openPopup({ windowId: tab.windowId });
        } else {
          console.info("Open Popup API is not available in this browser version.");
        }
        window.close(); // Close the side panel
      }
    } catch (err) {
      console.warn("Could not toggle view:", err);
    }
  });
}

// Settings button — open inline settings panel
if (sidebarSettingsBtn) {
  sidebarSettingsBtn.addEventListener("click", () => {
    closeSidebar();
    openSettingsPanel();
  });
}

// Help button — open inline help panel
if (sidebarHelpBtn) {
  sidebarHelpBtn.addEventListener("click", () => {
    closeSidebar();
    openHelpPanel();
  });
}

// Support button — open inline support panel
if (sidebarSupportBtn) {
  sidebarSupportBtn.addEventListener("click", () => {
    closeSidebar();
    openSupportPanel();
  });
}

// ─── Inline Settings Panel ───────────────────────────────

const STORAGE_IDLE_TIMEOUT = "idleTimeout";

const settingsPanel = document.getElementById("settings-panel");
const settingsBackBtn = document.getElementById("settings-back-btn");
const idleTimeoutSelect = document.getElementById("idle-timeout-select");
const viewModeSelect = document.getElementById("view-mode-select");
const exportDataBtn = document.getElementById("export-data-btn");
const clearDataBtn = document.getElementById("clear-data-btn");
const settingsToast = document.getElementById("settings-toast");

// ─── Generic panel open/close helpers ────────────────────

function openPanel(panel, backBtn) {
  panel.classList.remove("is-hidden");
  panel.setAttribute("aria-hidden", "false");
  void panel.offsetWidth;
  panel.classList.add("is-visible");
  if (backBtn) backBtn.focus();
}

function closePanel(panel) {
  panel.classList.remove("is-visible");
  const onEnd = () => {
    panel.classList.add("is-hidden");
    panel.setAttribute("aria-hidden", "true");
    panel.removeEventListener("transitionend", onEnd);
  };
  panel.addEventListener("transitionend", onEnd);
}

// ─── Settings ────────────────────────────────────────────

function openSettingsPanel() {
  loadSettingsValues();
  openPanel(settingsPanel, settingsBackBtn);
}

function closeSettingsPanel() {
  closePanel(settingsPanel);
}

if (settingsBackBtn) {
  settingsBackBtn.addEventListener("click", closeSettingsPanel);
}

// Escape key closes any open panel
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (settingsPanel && !settingsPanel.classList.contains("is-hidden")) {
    closeSettingsPanel();
  } else if (helpPanel && !helpPanel.classList.contains("is-hidden")) {
    closeHelpPanel();
  } else if (supportPanel && !supportPanel.classList.contains("is-hidden")) {
    closeSupportPanel();
  }
});

function showSettingsToast(message) {
  settingsToast.textContent = message;
  settingsToast.classList.remove("is-hidden");
  // Reset animation
  settingsToast.style.animation = "none";
  void settingsToast.offsetWidth;
  settingsToast.style.animation = "";

  clearTimeout(settingsToast._hideTimer);
  settingsToast._hideTimer = setTimeout(() => {
    settingsToast.classList.add("is-hidden");
  }, 2500);
}

async function loadSettingsValues() {
  const data = await chrome.storage.local.get(["viewMode", STORAGE_IDLE_TIMEOUT]);

  if (viewModeSelect) {
    viewModeSelect.value = data.viewMode || "popup";
  }
  if (idleTimeoutSelect) {
    idleTimeoutSelect.value = (data[STORAGE_IDLE_TIMEOUT] || 60).toString();
  }
}

// Idle Timeout change
if (idleTimeoutSelect) {
  idleTimeoutSelect.addEventListener("change", async (e) => {
    const timeout = parseInt(e.target.value, 10);
    await chrome.storage.local.set({ [STORAGE_IDLE_TIMEOUT]: timeout });
    chrome.idle.setDetectionInterval(timeout);
    showSettingsToast("Idle timeout updated");
  });
}

// View Mode change
if (viewModeSelect) {
  viewModeSelect.addEventListener("change", async (e) => {
    const mode = e.target.value;
    await chrome.storage.local.set({ viewMode: mode });

    if (mode === "side_panel") {
      await chrome.action.setPopup({ popup: "" });
      if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
        await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
      }
    } else {
      await chrome.action.setPopup({ popup: "popup.html" });
      if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
        await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
      }
    }
    showSettingsToast("View mode updated");
  });
}

// Export Data
if (exportDataBtn) {
  exportDataBtn.addEventListener("click", async () => {
    try {
      const data = await chrome.storage.local.get([STORAGE_STATS, STORAGE_LIMITS]);
      const exportObj = {
        exportedAt: new Date().toISOString(),
        version: "1.1.0",
        data: data,
      };

      const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `tabmeter-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showSettingsToast("Data exported");
    } catch (err) {
      console.error("Export failed:", err);
      showSettingsToast("Export failed");
    }
  });
}

// Clear Data
if (clearDataBtn) {
  clearDataBtn.addEventListener("click", async () => {
    const ok = confirm("Delete all tracked time and site limits?\nThis cannot be undone.");
    if (ok) {
      await chrome.storage.local.remove([STORAGE_STATS, STORAGE_LIMITS]);
      lastListFingerprint = null;
      lastChartFingerprint = null;
      loadAndPaint();
      showSettingsToast("All data cleared");
    }
  });
}

// ─── Help Center Panel ───────────────────────────────────

const helpPanel = document.getElementById("help-panel");
const helpBackBtn = document.getElementById("help-back-btn");
const helpGoSupportBtn = document.getElementById("help-go-support-btn");

function openHelpPanel() {
  openPanel(helpPanel, helpBackBtn);
}

function closeHelpPanel() {
  closePanel(helpPanel);
}

if (helpBackBtn) {
  helpBackBtn.addEventListener("click", closeHelpPanel);
}

// "Contact Support" CTA inside help panel
if (helpGoSupportBtn) {
  helpGoSupportBtn.addEventListener("click", () => {
    closeHelpPanel();
    // Small delay so the help panel finishes closing before support opens
    setTimeout(() => openSupportPanel(), 340);
  });
}

// ─── Contact Support Panel ───────────────────────────────

const SUPPORT_EMAIL = "muhammadzaryabrafique@gmail.com";

const supportPanel = document.getElementById("support-panel");
const supportBackBtn = document.getElementById("support-back-btn");
const supportSubject = document.getElementById("support-subject");
const supportMessage = document.getElementById("support-message");
const supportSendBtn = document.getElementById("support-send-btn");

function openSupportPanel() {
  // Reset form each time
  if (supportSubject) supportSubject.value = "Bug Report";
  if (supportMessage) supportMessage.value = "";
  openPanel(supportPanel, supportBackBtn);
}

function closeSupportPanel() {
  closePanel(supportPanel);
}

if (supportBackBtn) {
  supportBackBtn.addEventListener("click", closeSupportPanel);
}

// Send via mailto
if (supportSendBtn) {
  supportSendBtn.addEventListener("click", () => {
    const subject = supportSubject ? supportSubject.value : "TabMeter Support";
    const body = supportMessage ? supportMessage.value.trim() : "";

    if (!body) {
      supportMessage.focus();
      return;
    }

    const mailtoUrl =
      `mailto:${SUPPORT_EMAIL}` +
      `?subject=${encodeURIComponent(`[TabMeter] ${subject}`)}` +
      `&body=${encodeURIComponent(body + "\n\n---\nSent from TabMeter v1.1.0")}`;

    window.open(mailtoUrl, "_blank");
  });
}
