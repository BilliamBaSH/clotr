// Clotr AI Privacy Guard — toolbar popup / mini dashboard.
// Reads settings and event metadata from chrome.storage.local; writes only the
// user's settings (pause, per-pattern responses, added sites) and clears history on request.
"use strict";

const { PATTERNS, RESPONSES, defaultResponse, responseFor, msg } = globalThis.Clotr;
const VAULT_LABELS = {
  my_name: msg("pp_vName", "Name"),
  family_name: msg("pp_vFamily", "Family"),
  employer: msg("pp_vWork", "Work"),
  street_address: msg("pp_vAddresses", "Addresses"),
  phone_number: msg("pp_vPhones", "Phones"),
  email: msg("pp_vEmails", "Emails"),
  my_id: msg("pp_vIdFormats", "ID formats"),
  watch_list: msg("pp_vWatchWords", "Watch words"),
};
const RESPONSE_LABELS = {
  block: msg("popup_askBeforeSending", "Ask before sending"),
  warn: msg("popup_warn", "Warn"),
  log: msg("popup_justCount", "Just count"),
}; // plain words (D40)
const GROUPS = [
  { id: "credentials", name: msg("pp_gCredentials", "Passwords, keys & servers") },
  { id: "personal", name: msg("pp_gPersonal", "Personal info") },
  { id: "custom", name: msg("pp_gCustom", "Your watch list") },
];
const Sites = globalThis.ClotrSites;
const PATTERN_NAMES = Object.fromEntries(PATTERNS.map((p) => [p.id, p.name]));
const BUILT_IN = Sites.builtInMatches();

const SERIES = [
  { action: "redacted", label: msg("pp_covered", "Hidden"), cls: "s1", color: "var(--series-1)" },
  { action: "allowed", label: msg("pp_sent", "Sent"), cls: "s2", color: "var(--series-2)" },
  { action: "suppressed", label: msg("pp_justCounted", "Just counted"), cls: "s3", color: "var(--series-3)" },
];
const OUTCOME = Object.fromEntries(SERIES.map((s) => [s.action, s]));
const ACTIVITY_LIMIT = 100;
const SVG_NS = "http://www.w3.org/2000/svg";

let state = {
  events: [],
  paused: {},
  responses: {},
  vault: [],
  siteModes: {},
  advanced: false,
  userSites: [],
  builtInTools: [],
  lock: null,
  largeText: false,
};
let site = { kind: "none" }; // none | protected | spotted | not-ai
let rangeDays = readPref("rangeDays", 7);
let siteFilter = readPref("siteFilter", ""); // "" = all AI tools

// Events for the chosen AI tool (or all), shared by Overview and Activity.
function viewEvents() {
  return siteFilter ? state.events.filter((e) => e.site === siteFilter) : state.events;
}

function renderSiteFilter() {
  const counts = countBy(state.events, (e) => e.site);
  if (siteFilter && !counts.some(([site]) => site === siteFilter)) siteFilter = "";
  $("site-filter").replaceChildren(
    el("option", { value: "", textContent: msg("pp_allTools", "All AI tools"), selected: !siteFilter }),
    ...counts.map(([site, n]) =>
      el("option", { value: site, textContent: `${site} (${n})`, selected: site === siteFilter }),
    ),
  );
  $("filter-bar").hidden = counts.length < 2 && !siteFilter;
  // With one tool chosen, its per-site mode sits right next to it.
  $("site-mode").hidden = !siteFilter;
  $("site-mode").value = state.siteModes[siteFilter] || "";
  $("site-mode").classList.toggle("changed", Boolean(state.siteModes[siteFilter]));
}

const $ = (id) => document.getElementById(id);
$("site-mode").addEventListener("change", async (e) => {
  const site = siteFilter; // read before awaiting: the filter may change meanwhile
  const mode = e.target.value;
  if (!site) return;
  const { siteModes = {} } = await chrome.storage.local.get("siteModes");
  if (mode) siteModes[site] = mode;
  else delete siteModes[site];
  await chrome.storage.local.set({ siteModes });
});
$("site-filter").addEventListener("change", (e) => {
  siteFilter = e.target.value;
  writePref("siteFilter", siteFilter);
  renderAll();
});

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "style") Object.assign(node.style, v);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

// Per-viewer convenience only; the popup works fine without it.
function readPref(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v ?? fallback;
  } catch {
    return fallback;
  }
}
function writePref(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

function prettyPattern(p) {
  return p.replace(/^https:\/\//, "").replace(/\/\*$/, "");
}

// ---------- Current site ----------

async function detectSite() {
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    /* no tab */
  }
  const url = tab?.url ? new URL(tab.url) : null;
  if (!url || !/^https?:$/.test(url.protocol)) {
    site = { kind: "none" };
    return;
  }

  const base = { tabId: tab.id, host: url.hostname, url: url.href };
  const builtIn = Sites.urlMatchesAny(url.href, BUILT_IN);
  const added = Sites.urlMatchesAny(url.href, state.userSites);
  if (builtIn || added) {
    // Self-check: what this tab's Clotr reported (no entry = it isn't running here).
    let health = null;
    try {
      health = (await chrome.storage.session.get("protectedTabs")).protectedTabs?.[tab.id] || null;
    } catch {
      /* unknown: treat as not reported */
    }
    site = { ...base, kind: "protected", source: builtIn ? "built-in" : "added by you", health };
    return;
  }
  if (url.protocol !== "https:") {
    site = { ...base, kind: "not-ai" };
    return;
  }

  // Unknown https site: check it now (activeTab grants one-time access because the user opened the popup).
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: Sites.inspectPageForAIChat,
    });
    site = { ...base, kind: result?.looksLikeAI ? "spotted" : "not-ai", signals: result?.signals || [] };
  } catch {
    site = { ...base, kind: "not-ai", signals: [] };
  }
}

async function protectSite(url) {
  // Record the section first: the browser's prompt (for exactly this one host) may close
  // the popup, and background.js finishes the setup from storage either way.
  const scope = Sites.protectScope(url);
  const perm = Sites.permissionFor(scope);
  const { siteScopes = {} } = await chrome.storage.local.get("siteScopes");
  if (scope === perm)
    delete siteScopes[perm]; // the whole host
  else siteScopes[perm] = [...new Set([...(siteScopes[perm] || []), scope])];
  await chrome.storage.local.set({ siteScopes });
  const granted = await chrome.permissions.request({ origins: [perm] });
  if (granted) {
    state.userSites = await Sites.userSitePatterns();
    await detectSite();
    renderSite();
    renderSettings();
  }
}

async function setPaused(host, value) {
  const { paused = {} } = await chrome.storage.local.get("paused");
  if (value) paused[host] = true;
  else delete paused[host];
  await chrome.storage.local.set({ paused });
}

const SIGNALS = {
  "AI wording in the address": "pp_sigAddress",
  "AI wording in the page title": "pp_sigTitle",
  "a chat-style prompt box": "pp_sigBox",
  "a send button": "pp_sigSend",
};
const signalText = (s) => (SIGNALS[s] ? msg(SIGNALS[s], s) : s);

// Away from an AI chat, say where Clotr does work (first impression: "is it on?").
function coverageLine() {
  const names = state.builtInTools.map((t) => t.name);
  const text =
    names.length > 3
      ? msg(
          "pp_coverage",
          "Clotr works on $1 and $2 more AI chats. Using another one? Open this popup there.",
          names.slice(0, 3).join(", "),
          names.length - 3,
        )
      : msg("pp_coverageShort", "Clotr works on AI chat sites. Using another one? Open this popup there.");
  return el("div", { className: "why", textContent: text });
}

function renderSite() {
  const box = $("site");
  const stateLine = (dotCls, text) =>
    el("div", { className: "state" }, [el("i", { className: `dot ${dotCls}` }), text]);

  if (site.kind === "none") {
    box.replaceChildren(
      el("div", { className: "grow" }, [stateLine("", msg("pp_noPage", "No web page in this tab.")), coverageLine()]),
    );
    return;
  }

  if (site.kind === "protected") {
    const isPaused = Boolean(state.paused[site.host]);
    const toggle = el("button", {
      className: "btn",
      textContent: isPaused ? msg("pp_resume", "Resume") : msg("pp_pause", "Pause"),
    });
    toggle.addEventListener("click", () => setPaused(site.host, !isPaused));
    if (isLocked() || state.policy?.allowPause === false) {
      toggle.disabled = true;
      toggle.title =
        state.policy?.allowPause === false
          ? msg("pp_orgKeepsOn", "Your organization keeps Clotr on")
          : msg("pp_lockedTab", "Settings are locked (Settings tab)");
    }
    box.replaceChildren(
      el("div", { className: "grow" }, [
        el("div", { className: "host", textContent: site.host }),
        (() => {
          const h = Sites.healthText({
            running: Boolean(site.health),
            paused: isPaused,
            editor: site.health?.editor,
            editFailed: site.health?.editFailed,
            uiRemoved: site.health?.uiRemoved,
          });
          const line = stateLine(h.level, msg(h.key, h.text));
          line.dataset.health = h.level;
          line.title =
            site.source === "built-in"
              ? msg("pp_builtInSite", "Built-in AI site")
              : msg("pp_addedSite", "AI site you added");
          return line;
        })(),
      ]),
      toggle,
    );
    return;
  }

  // Exactly what a click would cover, so it's never a surprise (shared hosts: just a section).
  const willCover = () =>
    el("div", {
      className: "why",
      textContent: msg("pp_willProtect", "Will protect: $1", prettyPattern(Sites.protectScope(site.url))),
    });

  if (site.kind === "spotted") {
    const add = el("button", { className: "btn primary", textContent: msg("pp_protectSite", "Protect this site") });
    add.addEventListener("click", () => protectSite(site.url));
    box.replaceChildren(
      el("div", { className: "grow" }, [
        el("div", { className: "host", textContent: site.host }),
        stateLine("spot", msg("pp_spotted", "Looks like an AI chat, not protected yet")),
        el("div", {
          className: "why",
          textContent: msg("pp_found", "Found $1.", site.signals.map(signalText).join(", ")),
        }),
        willCover(),
      ]),
      add,
    );
    return;
  }

  // not-ai
  const override = el("button", {
    className: "linkish",
    textContent: msg("pp_override", "It is an AI tool, protect it"),
  });
  override.addEventListener("click", () => protectSite(site.url));
  const https = Boolean(site.host && site.url?.startsWith("https:"));
  box.replaceChildren(
    el("div", { className: "grow" }, [
      el("div", { className: "host", textContent: site.host }),
      stateLine("", msg("pp_notAi", "Not an AI tool. Clotr stays off here.")),
      coverageLine(),
      https ? override : "",
      https ? willCover() : "",
    ]),
  );
}

// ---------- Overview (dashboard) ----------

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function lastNDays(n) {
  const today = startOfDay(Date.now());
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(today);
    d.setDate(today.getDate() - (n - 1 - i));
    return d;
  });
}

function niceCeil(v) {
  if (v <= 1) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= v) return Math.ceil(m * pow);
  return v;
}

function countBy(list, keyFn) {
  const out = new Map();
  for (const item of list) out.set(keyFn(item), (out.get(keyFn(item)) || 0) + 1);
  return [...out.entries()].sort((a, b) => b[1] - a[1]);
}

function renderOverview() {
  const days = lastNDays(rangeDays);
  const since = days[0].getTime();
  const events = viewEvents().filter((e) => e.t >= since);

  for (const b of document.querySelectorAll(".range button")) {
    b.setAttribute("aria-checked", String(Number(b.dataset.days) === rangeDays));
  }

  renderExposure(); // all history, so it shows even when this range is quiet
  renderMiniMap();
  renderDigest();
  const empty = events.length === 0;
  const quiet = empty && viewEvents().length > 0; // history exists, just not in this range
  $("empty-title").textContent = quiet
    ? msg("pp_quietDays", "Quiet $1 days.", rangeDays)
    : msg("popup_nothingFoundYet", "Nothing found yet.");
  $("empty-hint").hidden = quiet;
  $("empty-quiet").hidden = !quiet;
  $("empty-overview").hidden = !empty;
  $("overview-body").hidden = empty;
  if (empty) return;

  const n = (action) => events.filter((e) => e.action === action).length;

  // Hero
  $("hero-value").textContent = n("redacted").toLocaleString();
  $("hero-label").textContent =
    n("redacted") === 1
      ? msg("pp_heroOne", "leak stopped in the last $1 days", rangeDays)
      : msg("pp_heroMany", "leaks stopped in the last $1 days", rangeDays);
  $("hero-sub").textContent = msg(
    "pp_heroSub",
    "$1 found · $2 sent · $3 just counted",
    events.length,
    n("allowed"),
    n("suppressed"),
  );

  renderAlerts(events);
  renderLegend(events);
  renderChart(days, events);
  renderHBars(
    $("by-site"),
    countBy(events, (e) => e.site),
  );
  renderHBars(
    $("by-type"),
    countBy(events, (e) => PATTERN_NAMES[e.type] || e.name || e.type),
  );
}

// The small AI connection map (D57): all history; the full one is in the report.
function renderMiniMap() {
  const rows = globalThis.ClotrInsights.drawConnectionMap($("mini-map"), viewEvents(), { compact: true });
  $("mini-map-card").hidden = rows.length === 0;
}

// Weekly digest: this week against last week, and the one thing to do now (v1.0). Local, no notifications.
function renderDigest() {
  const DAY = 86400000;
  const now = Date.now();
  const all = viewEvents();
  const week = all.filter((e) => e.t >= now - 7 * DAY);
  const last = all.filter((e) => e.t >= now - 14 * DAY && e.t < now - 7 * DAY).length;
  $("digest").hidden = week.length === 0 && last === 0;
  if ($("digest").hidden) return;
  const n = (action) => week.filter((e) => e.action === action).length;
  const trend =
    week.length < last
      ? msg("pp_fewer", "fewer than last week ($1)", last)
      : week.length > last
        ? msg("pp_more", "more than last week ($1)", last)
        : msg("pp_same", "the same as last week");
  $("digest-line").textContent = msg(
    "pp_digest",
    "This week: $1 found, $2 hidden, $3 sent anyway. That's $4.",
    week.length,
    n("redacted"),
    n("allowed"),
    trend,
  );
  const risky = week.filter((e) => e.action === "allowed" && e.severity === "high").at(-1);
  $("digest-todo").textContent = risky
    ? msg(
        "pp_todo",
        "To do: the $1 sent to $2. $3",
        PATTERN_NAMES[risky.type] || risky.name || risky.type,
        risky.site,
        globalThis.ClotrInsights.adviceFor(risky.type),
      )
    : msg("pp_nothingRisky", "Nothing high-risk went out this week.");
  $("digest-todo").classList.toggle("urgent", Boolean(risky));
}

// Profile exposure: distinct personal details (by fingerprint) each AI tool actually
// received, i.e. sent with outcome "allowed". All stored history, not just the range.
const PROFILE_TYPES = new Set(PATTERNS.filter((p) => p.group === "personal" || p.group === "custom").map((p) => p.id));
function renderExposure() {
  const seen = new Map(); // site → Set(fp)
  for (const e of viewEvents()) {
    if (e.action !== "allowed" || !e.fp || !PROFILE_TYPES.has(e.type)) continue;
    if (!seen.has(e.site)) seen.set(e.site, new Set());
    seen.get(e.site).add(`${e.type}:${e.fp}`);
  }
  const rows = [...seen].map(([site, fps]) => [site, fps.size]).sort((a, b) => b[1] - a[1]);
  renderHBars($("exposure"), rows);
  $("exposure-empty").hidden = rows.length > 0;
  $("exposure-card").hidden = viewEvents().length === 0; // nothing at all yet: the empty card covers it
}

function renderAlerts(events) {
  const alerts = [];

  const riskyAllowed = events.filter((e) => e.action === "allowed" && e.severity === "high");
  if (riskyAllowed.length) {
    alerts.push(
      riskyAllowed.length === 1
        ? msg("pp_riskyOne", "You sent 1 high-risk item anyway in this period.")
        : msg("pp_riskyMany", "You sent $1 high-risk items anyway in this period.", riskyAllowed.length),
    );
  }

  // The same secret seen more than once (by fingerprint); only high-severity ones are worth nagging about.
  const high = events.filter((e) => e.fp && e.severity === "high");
  const repeats = countBy(high, (e) => e.fp)
    .filter(([, count]) => count > 1)
    .slice(0, 2);
  for (const [fp, count] of repeats) {
    const hit = high.find((e) => e.fp === fp);
    alerts.push(
      msg(
        "pp_repeat",
        "Clotr found the same $1 $2 times. If it's a real password or key, change it.",
        PATTERN_NAMES[hit.type] || hit.name,
        count,
      ),
    );
  }

  $("alerts").replaceChildren(
    ...alerts.map((text) =>
      el("div", { className: "alert", role: "note" }, [
        el("span", { className: "icon", textContent: "⚠️", "aria-hidden": "true" }),
        el("span", { textContent: text }),
      ]),
    ),
  );
}

function renderLegend(events) {
  $("legend").replaceChildren(
    ...SERIES.map((s) =>
      el("span", {}, [
        el("i", { style: { background: s.color } }),
        s.label,
        el("b", { textContent: String(events.filter((e) => e.action === s.action).length) }),
      ]),
    ),
  );
}

function colPath(x, y, w, h, r) {
  r = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function renderChart(days, events) {
  const chart = $("chart");
  const tooltip = $("tooltip");
  const W = chart.clientWidth || 352;
  const H = 132;
  const pad = { top: 8, right: 2, bottom: 18, left: 20 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const base = pad.top + plotH;

  // Bucket events per day and outcome.
  const buckets = days.map((d) => ({ date: d, redacted: 0, allowed: 0, suppressed: 0 }));
  const index = new Map(days.map((d, i) => [d.getTime(), i]));
  for (const e of events) {
    const i = index.get(startOfDay(e.t).getTime());
    if (i !== undefined && e.action in buckets[i]) buckets[i][e.action]++;
  }
  const total = (b) => b.redacted + b.allowed + b.suppressed;
  const yMax = niceCeil(Math.max(1, ...buckets.map(total)));
  const y = (v) => (v / yMax) * plotH;

  chart.setAttribute("viewBox", `0 0 ${W} ${H}`);
  chart.replaceChildren();

  // Recessive grid: top + midpoint (when it's a whole number) + baseline.
  const ticks = yMax >= 2 && yMax % 2 === 0 ? [yMax / 2, yMax] : [yMax];
  for (const t of ticks) {
    const ty = base - y(t);
    chart.append(svg("line", { class: "gridline", x1: pad.left, x2: W - pad.right, y1: ty, y2: ty }));
    const label = svg("text", { class: "tick", x: pad.left - 5, y: ty + 3, "text-anchor": "end" });
    label.textContent = String(t);
    chart.append(label);
  }
  const zero = svg("text", { class: "tick", x: pad.left - 5, y: base + 3, "text-anchor": "end" });
  zero.textContent = "0";
  chart.append(zero);

  const band = plotW / buckets.length;
  const barW = Math.min(24, Math.max(3, band * 0.62));
  const GAP = 2;
  const fmtDay = new Intl.DateTimeFormat(
    [],
    rangeDays <= 7 ? { weekday: "short" } : { month: "short", day: "numeric" },
  );
  const fmtFull = new Intl.DateTimeFormat([], { weekday: "short", month: "short", day: "numeric" });
  const labelEvery = rangeDays <= 7 ? 1 : 7;

  buckets.forEach((b, i) => {
    const x0 = pad.left + i * band;
    const bx = x0 + (band - barW) / 2;
    const col = svg("g", { class: "col" });

    // Stack bottom → top; 2px surface gap between segments; only the top one gets rounded corners.
    const segs = SERIES.map((s) => ({ s, v: b[s.action] })).filter((seg) => seg.v > 0);
    let cursor = base;
    segs.forEach((seg, k) => {
      const h = Math.max(3, y(seg.v));
      const top = cursor - h;
      const drawH = h - (k > 0 ? GAP : 0);
      const isTop = k === segs.length - 1;
      col.append(
        isTop
          ? svg("path", { class: seg.s.cls, d: colPath(bx, top, barW, drawH, 4) })
          : svg("rect", { class: seg.s.cls, x: bx, y: top, width: barW, height: drawH }),
      );
      cursor = top;
    });
    chart.append(col);

    // Sparse x labels (last one always), anchored to the right edge for "today".
    const isLast = i === buckets.length - 1;
    if (i % labelEvery === 0 || isLast) {
      if (!(rangeDays > 7 && !isLast && buckets.length - 1 - i < labelEvery / 2)) {
        const tx = svg("text", { class: "tick", x: x0 + band / 2, y: H - 4, "text-anchor": "middle" });
        tx.textContent = isLast ? "Today" : fmtDay.format(b.date);
        chart.append(tx);
      }
    }

    // Hit target = the whole day band (bigger than the bar), keyboard focusable.
    const summary = msg(
      "pp_daySummary",
      "$1: $2 hidden, $3 sent, $4 just counted",
      fmtFull.format(b.date),
      b.redacted,
      b.allowed,
      b.suppressed,
    );
    const hit = svg("rect", {
      class: "hit",
      x: x0,
      y: pad.top,
      width: band,
      height: plotH,
      tabindex: 0,
      role: "img",
      "aria-label": summary,
    });
    const show = () => {
      chart.classList.add("hovering");
      col.classList.add("active");
      tooltip.replaceChildren(
        el("div", { className: "tt-date", textContent: fmtFull.format(b.date) }),
        ...SERIES.map((s) =>
          el("div", { className: "tt-row" }, [
            el("i", { className: "key", style: { background: s.color } }),
            el("b", { textContent: String(b[s.action]) }),
            s.label,
          ]),
        ),
        el("div", { className: "tt-total", textContent: msg("pp_nFound", "$1 found", total(b)) }),
      );
      tooltip.hidden = false;
      // Place beside the column, flipping sides past the midpoint so it never covers the hovered bar.
      const cx = x0 + band / 2;
      const tw = tooltip.offsetWidth;
      const left = cx < W / 2 ? cx + barW / 2 + 8 : cx - barW / 2 - 8 - tw;
      tooltip.style.left = `${Math.max(0, Math.min(W - tw, left))}px`;
      tooltip.style.top = "0px";
    };
    const hide = () => {
      chart.classList.remove("hovering");
      col.classList.remove("active");
      tooltip.hidden = true;
    };
    hit.addEventListener("pointerenter", show);
    hit.addEventListener("focus", show);
    hit.addEventListener("pointerleave", hide);
    hit.addEventListener("blur", hide);
    chart.append(hit);
  });

  chart.append(svg("line", { class: "baseline", x1: pad.left, x2: W - pad.right, y1: base, y2: base }));
}

function renderHBars(container, rows) {
  const top = rows.slice(0, 5);
  const max = Math.max(1, ...top.map(([, v]) => v));
  container.replaceChildren(
    ...top.map(([label, v]) =>
      el("div", { className: "hbar", title: `${label}: ${v}` }, [
        el("span", { className: "label", textContent: label }),
        el("span", { className: "track" }, [
          el("span", { className: "bar", style: { width: `calc((100% - 32px) * ${v / max})` } }),
          el("span", { className: "val", textContent: String(v) }),
        ]),
      ]),
    ),
  );
}

// ---------- Activity (table view) ----------

function renderActivity() {
  const seen = {};
  const events = viewEvents();
  for (const e of events) if (e.fp) seen[e.fp] = (seen[e.fp] || 0) + 1;

  const today = startOfDay(Date.now()).getTime();
  const fmtTime = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" });
  const fmtDate = new Intl.DateTimeFormat([], { month: "short", day: "numeric" });

  const rows = events
    .slice(-ACTIVITY_LIMIT)
    .reverse()
    .map((e) => {
      const when = e.t >= today ? fmtTime.format(e.t) : `${fmtDate.format(e.t)} ${fmtTime.format(e.t)}`;
      const what = el("td", {}, [
        el("span", { className: `sev ${e.severity}`, textContent: msg(`sev_${e.severity}`, e.severity) }),
        PATTERN_NAMES[e.type] || e.name || e.type,
      ]);
      if (seen[e.fp] > 1) {
        what.append(
          el("span", {
            className: "repeat",
            textContent: `×${seen[e.fp]}`,
            title: msg("pp_sameItem", "Clotr found this same item $1 times", seen[e.fp]),
          }),
        );
      }
      what.append(el("span", { className: "site-name", textContent: e.site }));
      const o = OUTCOME[e.action];
      return el("tr", {}, [
        el("td", { className: "when", textContent: when }),
        what,
        el("td", {}, [
          el("span", { className: "outcome" }, [
            el("i", { style: { background: o?.color || "var(--muted)" } }),
            o?.label || e.action,
          ]),
        ]),
      ]);
    });

  $("events-body").replaceChildren(...rows);
  $("events-empty").hidden = rows.length > 0;
}

// ---------- Settings ----------

// Stores overrides only, so a pattern set back to its default follows future default changes.
async function setResponse(id, value) {
  const { responses = {} } = await chrome.storage.local.get("responses");
  if (value === defaultResponse(id)) delete responses[id];
  else responses[id] = value;
  await chrome.storage.local.set({ responses });
}

// One control for a whole group: "default" clears the group's overrides.
async function setGroupResponse(ids, value) {
  const { responses = {} } = await chrome.storage.local.get("responses");
  for (const id of ids) {
    if (value === "default" || value === defaultResponse(id)) delete responses[id];
    else responses[id] = value;
  }
  await chrome.storage.local.set({ responses });
}

// "default" when nothing is overridden, the shared response when all agree, else "custom".
function groupValue(ids) {
  if (!ids.some((id) => id in state.responses)) return "default";
  const values = new Set(ids.map((id) => responseFor(id, state.responses)));
  return values.size === 1 ? [...values][0] : "custom";
}

$("open-vault").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("vault.html") }));
$("open-stored").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("stored.html") }));
for (const id of ["open-dashboard", "digest-open", "mini-map-open"])
  $(id).addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") }));

// Removes one protected section; the host's permission goes when none are left.
async function removeUserSite(pattern) {
  const perm = Sites.permissionFor(pattern);
  const { siteScopes = {} } = await chrome.storage.local.get("siteScopes");
  const rest = (siteScopes[perm] || []).filter((s) => s !== pattern);
  if (rest.length && pattern !== perm) {
    siteScopes[perm] = rest;
    await chrome.storage.local.set({ siteScopes });
  } else {
    delete siteScopes[perm];
    await chrome.storage.local.set({ siteScopes });
    await chrome.permissions.remove({ origins: [perm] });
  }
  state.userSites = await Sites.userSitePatterns();
  await detectSite();
  renderSite();
  renderSettings();
}

// ---------- Helping someone: larger warnings, stricter personal details, PIN lock (D61) ----------
// The PIN is kept only as a salted PBKDF2 hash. It guards against accidental changes; whoever can
// remove the extension can reset it (the Settings tab says so). Unlocking lasts 10 minutes.
const PERSONAL_IDS = PATTERNS.filter((p) => p.group === "personal").map((p) => p.id);
const UNLOCK_MS = 10 * 60 * 1000;
const PIN_ITERATIONS = 150000;
let unlockedUntil = 0;
let wrongTries = 0;
let retryAt = 0;

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
async function pinHash(pin, saltHex, iterations) {
  const salt = Uint8Array.from(saltHex.match(/../g), (h) => parseInt(h, 16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  return toHex(
    new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256)),
  );
}
const managedLock = () => state.policy?.lockSettings === true;
const isLocked = () => managedLock() || (Boolean(state.lock) && Date.now() >= unlockedUntil);
async function markUnlocked() {
  unlockedUntil = Date.now() + UNLOCK_MS;
  await chrome.storage.session.set({ unlockedUntil }).catch(() => {});
}
const say = (id, text, error = false) => {
  $(id).textContent = text;
  $(id).classList.toggle("error", error);
};

function renderHelper() {
  const locked = isLocked();
  $("managed-note").hidden = !managedLock();
  $("unlock").hidden = !locked || managedLock(); // an organization's lock has no PIN
  $("settings-body").hidden = locked;
  $("large-text").checked = state.largeText;
  $("strict-personal").checked = PERSONAL_IDS.every((id) => state.responses[id] === "block");
  $("lock-remove").hidden = !state.lock;
  $("lock-set").textContent = state.lock
    ? msg("pp_changePin", "Change the PIN")
    : msg("popup_lockSettings", "Lock settings");
}

$("large-text").addEventListener("change", (e) => chrome.storage.local.set({ largeText: e.target.checked }));
$("strict-personal").addEventListener("change", (e) =>
  setGroupResponse(PERSONAL_IDS, e.target.checked ? "block" : "default"),
);
$("lock-set").addEventListener("click", async () => {
  const pin = $("pin").value.trim();
  if (!/^\d{4,8}$/.test(pin)) return say("lock-msg", msg("pp_pinDigits", "Use 4 to 8 digits."), true);
  const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
  const lock = { salt, iterations: PIN_ITERATIONS, hash: await pinHash(pin, salt, PIN_ITERATIONS) };
  await markUnlocked(); // you set it, so you stay in for now
  await chrome.storage.local.set({ lock });
  $("pin").value = "";
  say("lock-msg", msg("pp_locked", "Settings locked. Clotr will ask for the PIN next time."));
});
$("lock-remove").addEventListener("click", async () => {
  await chrome.storage.local.remove("lock");
  say("lock-msg", msg("pp_pinRemoved", "PIN removed: settings are open again."));
});
async function tryUnlock() {
  if (Date.now() < retryAt) return say("unlock-msg", msg("pp_tooMany", "Too many tries: wait half a minute."), true);
  const pin = $("unlock-pin").value.trim();
  const lock = state.lock;
  const ok = Boolean(lock && /^\d{4,8}$/.test(pin)) && (await pinHash(pin, lock.salt, lock.iterations)) === lock.hash;
  $("unlock-pin").value = "";
  if (!ok) {
    if (++wrongTries >= 5) {
      retryAt = Date.now() + 30000;
      wrongTries = 0;
    }
    return say("unlock-msg", msg("pp_wrongPin", "That PIN didn't match."), true);
  }
  wrongTries = 0;
  say("unlock-msg", "");
  await markUnlocked();
  renderAll();
}
$("unlock-go").addEventListener("click", tryUnlock);
$("unlock-pin").addEventListener("keydown", (e) => {
  if (e.key === "Enter") tryUnlock();
});

function renderSettings() {
  renderHelper();
  const userItems = state.userSites.map((p) => {
    const btn = el("button", { className: "btn", textContent: msg("pp_remove", "Remove") });
    btn.addEventListener("click", () => removeUserSite(p));
    const label = el("span", { className: "grow", textContent: prettyPattern(p) });
    if (Sites.isWiderThanNeeded(p)) {
      label.append(
        el("span", {
          className: "why",
          textContent: msg(
            "pp_wider",
            "Every page of this site: wider than an AI tool needs. Remove it, then protect just the AI page.",
          ),
        }),
      );
    }
    return el("li", {}, [label, btn]);
  });
  $("user-sites").replaceChildren(...userItems);
  $("user-sites-empty").hidden = userItems.length > 0;

  // Named list from ai-sites.json; falls back to the raw manifest patterns.
  const tools = state.builtInTools.length
    ? state.builtInTools
    : BUILT_IN.map((p) => ({ name: prettyPattern(p), matches: [] }));
  $("builtin-count").textContent = String(tools.length);
  $("builtin-sites").replaceChildren(
    ...tools.map((t) =>
      el("li", {}, [
        el("b", { textContent: t.name }),
        t.matches.length ? ` — ${t.matches.map(prettyPattern).join(", ")}` : "",
      ]),
    ),
  );

  const openGroups = new Set([...document.querySelectorAll(".resp-group details[open]")].map((d) => d.dataset.group));
  const patternRow = (p) => {
    const current = responseFor(p.id, state.responses);
    const select = el(
      "select",
      { className: "resp", title: msg("pp_whatDoes", "What Clotr does when it finds: $1", p.name) },
      RESPONSES.map((r) =>
        el("option", {
          value: r,
          selected: r === current,
          textContent: RESPONSE_LABELS[r] + (r === defaultResponse(p.id) ? msg("pp_defaultSuffix", " (default)") : ""),
        }),
      ),
    );
    select.dataset.pattern = p.id;
    select.classList.toggle("changed", current !== defaultResponse(p.id));
    select.setAttribute("aria-label", msg("pp_responseFor", "Response for $1", p.name));
    select.addEventListener("change", () => setResponse(p.id, select.value));
    return el("li", {}, [
      el("span", { className: "grow" }, [
        el("span", { className: `sev ${p.severity}`, textContent: msg(`sev_${p.severity}`, p.severity) }),
        p.name,
      ]),
      select,
    ]);
  };
  $("responses").replaceChildren(
    ...GROUPS.map((g) => {
      const members = PATTERNS.filter((p) => p.group === g.id);
      const ids = members.map((p) => p.id);
      const value = groupValue(ids);
      const options = [
        ["default", msg("pp_defaultWarn", "Default (warn)")],
        ...RESPONSES.map((r) => [r, RESPONSE_LABELS[r]]),
      ];
      if (value === "custom") options.push(["custom", msg("pp_custom", "Custom")]);
      const select = el(
        "select",
        { className: "resp" },
        options.map(([v, label]) =>
          el("option", { value: v, selected: v === value, textContent: label, disabled: v === "custom" }),
        ),
      );
      select.dataset.group = g.id;
      select.classList.toggle("changed", value !== "default");
      select.setAttribute("aria-label", msg("pp_responseForAll", "Response for all: $1", g.name));
      select.addEventListener("change", () => setGroupResponse(ids, select.value));
      const details = el("details", { className: "advanced-only", open: openGroups.has(g.id) }, [
        el("summary", { textContent: msg("pp_chooseEach", "Choose for each ($1)", members.length) }),
        el("ul", { className: "list" }, members.map(patternRow)),
      ]);
      details.dataset.group = g.id;
      return el("div", { className: "resp-group" }, [
        el("div", { className: "head" }, [el("span", { className: "grow", textContent: g.name }), select]),
        details,
      ]);
    }),
  );

  // Simple mode by default (M4): per-type settings, per-site modes and the built-in list
  // appear only with "Show advanced options"; a note says when hidden ones are in use.
  document.body.classList.toggle("advanced", state.advanced);
  $("advanced").checked = state.advanced;
  const customized = GROUPS.some(
    (g) => groupValue(PATTERNS.filter((p) => p.group === g.id).map((p) => p.id)) === "custom",
  );
  $("advanced-in-use").hidden = state.advanced || !(customized || Object.keys(state.siteModes).length);

  // Vault summary: counts by category (the vault page has the details).
  const byCat = countBy(state.vault, (e) => VAULT_LABELS[e.type] || msg("pp_other", "Other"));
  $("vault-summary").textContent = byCat.length
    ? byCat.map(([cat, n]) => `${cat} ${n}`).join(" · ")
    : msg("pp_vaultEmpty", "Empty. Add your details so Clotr knows what's yours to protect.");
}

// Two clicks to clear, so a stray click can't wipe history.
const clearBtn = $("clear");
let clearArmed = null;
function disarmClear() {
  clearTimeout(clearArmed);
  clearArmed = null;
  clearBtn.textContent = msg("popup_clearHistory", "Clear history");
  clearBtn.classList.remove("confirm");
}
clearBtn.addEventListener("click", async () => {
  if (!clearArmed) {
    clearBtn.textContent = msg("pp_clearAgain", "Click again to clear all history");
    clearBtn.classList.add("confirm");
    clearArmed = setTimeout(disarmClear, 3000);
    return;
  }
  disarmClear();
  await chrome.storage.local.set({ events: [] });
});

// ---------- Tabs & range ----------

const TABS = ["overview", "activity", "settings"];
function selectTab(name) {
  for (const t of TABS) {
    $(`tab-${t}`).setAttribute("aria-selected", String(t === name));
    $(`panel-${t}`).hidden = t !== name;
  }
  document.body.dataset.tab = name; // the site filter only applies to Overview and Activity
  if (name === "overview") renderOverview(); // chart needs a visible panel to measure its width
}
for (const t of TABS) $(`tab-${t}`).addEventListener("click", () => selectTab(t));

for (const b of document.querySelectorAll(".range button")) {
  b.addEventListener("click", () => {
    rangeDays = Number(b.dataset.days);
    writePref("rangeDays", rangeDays);
    renderOverview();
  });
}

// ---------- Startup & live updates ----------

function renderAll() {
  renderSite();
  renderSiteFilter();
  if (!$("panel-overview").hidden) renderOverview();
  renderActivity();
  renderSettings();
}

// "Updated to vX: what's new", once per update (background sets lastUpdate on update).
async function renderWhatsNew() {
  const { lastUpdate } = await chrome.storage.local.get("lastUpdate");
  if (!lastUpdate || lastUpdate.seen) {
    $("whats-new").hidden = true;
    return;
  }
  let notes = [];
  try {
    const log = await (await fetch(chrome.runtime.getURL("changelog.json"))).json();
    const minor = lastUpdate.to.split(".").slice(0, 2).join(".");
    const lang = chrome.i18n.getUILanguage().split("-")[0];
    notes = log.translations?.[lang]?.[minor] || log[minor] || [];
  } catch {
    /* the title alone still helps */
  }
  $("whats-new-title").textContent = lastUpdate.from
    ? msg("pp_updatedFrom", "Updated to v$1 (from v$2)", lastUpdate.to, lastUpdate.from)
    : msg("pp_updated", "Updated to v$1", lastUpdate.to);
  $("whats-new-list").replaceChildren(...notes.map((n) => el("li", { textContent: n })));
  $("whats-new").hidden = false;
}
$("whats-new-ok").addEventListener("click", async () => {
  const { lastUpdate } = await chrome.storage.local.get("lastUpdate");
  await chrome.storage.local.set({ lastUpdate: { ...lastUpdate, seen: true } });
  $("whats-new").hidden = true;
});

async function loadBuiltInTools() {
  try {
    return await (await fetch(chrome.runtime.getURL("ai-sites.json"))).json();
  } catch (err) {
    console.warn("[Clotr] could not read ai-sites.json", err);
    return [];
  }
}

async function init() {
  const stored = await chrome.storage.local.get([
    "events",
    "paused",
    "responses",
    "vault",
    "siteModes",
    "advanced",
    "lock",
    "largeText",
  ]);
  unlockedUntil = (await chrome.storage.session.get("unlockedUntil").catch(() => ({}))).unlockedUntil || 0;
  const policy = (await chrome.storage.managed?.get(null).catch(() => ({}))) || {};
  state = {
    events: stored.events || [],
    paused: stored.paused || {},
    responses: stored.responses || {},
    vault: stored.vault || [],
    siteModes: stored.siteModes || {},
    advanced: stored.advanced === true,
    lock: stored.lock || null,
    policy,
    largeText: stored.largeText === true,
    userSites: await Sites.userSitePatterns(),
    builtInTools: await loadBuiltInTools(),
  };
  await detectSite();
  renderAll();
  renderWhatsNew();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "managed") {
    chrome.storage.managed
      .get(null)
      .then((policy) => {
        state.policy = policy || {};
        renderAll();
      })
      .catch(() => {});
    return;
  }
  if (area !== "local") return;
  for (const key of ["events", "paused", "responses", "vault", "siteModes"]) {
    if (changes[key]) state[key] = changes[key].newValue || (["events", "vault"].includes(key) ? [] : {});
  }
  if (changes.advanced) state.advanced = changes.advanced.newValue === true;
  if (changes.lock) state.lock = changes.lock.newValue || null;
  if (changes.largeText) state.largeText = changes.largeText.newValue === true;
  renderAll();
});

$("advanced").addEventListener("change", (e) => chrome.storage.local.set({ advanced: e.target.checked }));
$("tips-again").addEventListener("click", async () => {
  await chrome.storage.local.remove("guided");
  $("tips-again").textContent = msg("pp_tipsAgain", "Tips will show again");
});

init();
