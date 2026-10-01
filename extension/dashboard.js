// Clotr: "Your exposure report", the full-page dashboard.
// Reads the stored history (kind, site, time, outcome, fingerprint; never values). Fingerprints
// are only used to count "different" details and repeats; they're never shown. Nothing leaves
// the page except an export file the user asks for.
"use strict";

const $ = (id) => document.getElementById(id);
const SVG_NS = "http://www.w3.org/2000/svg";
const { PATTERNS, msg } = globalThis.Clotr;
const TYPE = Object.fromEntries(PATTERNS.map((p) => [p.id, p]));
const PERSONAL = new Set(PATTERNS.filter((p) => p.group === "personal" || p.group === "custom").map((p) => p.id));
const SERIES = [
  { action: "redacted", label: msg("pp_covered", "Hidden"), color: "var(--series-1)" },
  { action: "allowed", label: msg("pp_sent", "Sent"), color: "var(--series-2)" },
  { action: "suppressed", label: msg("pp_justCounted", "Just counted"), color: "var(--series-3)" },
];
const DAY = 86400000;

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}
function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}
const nameOf = (e) => TYPE[e.type]?.name || e.name || e.type; // in the browser's language
const tools = (n) => (n === 1 ? msg("db_tool1", "1 AI tool") : msg("db_toolN", "$1 services", n));
const fmtDay = new Intl.DateTimeFormat([], { month: "short", day: "numeric" });
const fmtWhen = new Intl.DateTimeFormat([], { dateStyle: "medium", timeStyle: "short" });

const advice = globalThis.ClotrInsights.adviceFor;

function renderTotals(events) {
  const count = (a) => events.filter((e) => e.action === a).length;
  $("totals").replaceChildren(
    el("div", { className: "stat" }, [
      el("b", { textContent: String(events.length) }),
      el("span", { textContent: msg("db_foundTotal", "found in total") }),
    ]),
    ...SERIES.map((s) =>
      el("div", { className: "stat" }, [
        el("b", { textContent: String(count(s.action)) }),
        el("span", { textContent: s.label }),
      ]),
    ),
  );
  $("since").textContent = events.length
    ? msg("db_since", "Since $1 · $2", fmtDay.format(events[0].t), tools(new Set(events.map((e) => e.site)).size))
    : msg("db_nothingYet", "Nothing here yet. What Clotr notices shows up here as you go.");
}

function renderExposure(events) {
  const bySite = new Map();
  for (const e of events) {
    if (e.action !== "allowed" || !e.fp || !PERSONAL.has(e.type)) continue;
    if (!bySite.has(e.site)) bySite.set(e.site, new Map());
    bySite.get(e.site).set(`${e.type}:${e.fp}`, e);
  }
  const rows = [...bySite.entries()].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]));
  $("exposure").replaceChildren(
    ...(rows.length
      ? rows.map(([site, details]) => {
          const kinds = new Map();
          for (const e of details.values()) kinds.set(nameOf(e), (kinds.get(nameOf(e)) || 0) + 1);
          const node = el("div", { className: "tool" }, [
            el("div", {
              className: "name",
              textContent: msg(
                "db_siteDetails",
                "$1: $2",
                site,
                details.size === 1
                  ? msg("db_detail1", "1 personal detail")
                  : msg("db_detailN", "$1 personal details", details.size),
              ),
            }),
            el("div", {
              className: "kinds",
              textContent: [...kinds].map(([k, n]) => (n > 1 ? `${n} × ${k}` : k)).join(" · "),
            }),
          ]);
          node.dataset.site = site;
          node.dataset.details = String(details.size);
          return node;
        })
      : [
          el("p", {
            className: "empty-note",
            textContent: msg("db_noDetails", "No personal details have been sent to any service. 👍"),
          }),
        ]),
  );
}

// What Bandage kept from each AI (pre-release Batch 2, D93): "redacted" events with `via: "bandage"`,
// apart from what you hid by hand. Only shown once Bandage has covered something.
function renderBandageKept(events) {
  const bySite = new Map();
  for (const e of events) {
    if (e.action !== "redacted" || e.via !== "bandage") continue;
    bySite.set(e.site, (bySite.get(e.site) || 0) + 1);
  }
  $("bandage-section").hidden = bySite.size === 0;
  if (!bySite.size) return;
  const rows = [...bySite.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  $("bandage-kept").replaceChildren(
    ...rows.map(([site, n]) => {
      const node = el("div", { className: "tool" }, [
        el("div", {
          className: "name",
          textContent: msg(
            "db_bandageSiteKept",
            "$1: $2",
            site,
            n === 1 ? msg("db_kept1", "1 detail kept") : msg("db_keptN", "$1 details kept", n),
          ),
        }),
      ]);
      node.dataset.site = site;
      node.dataset.kept = String(n);
      return node;
    }),
  );
}

// Mind map of everything you could be leaking (D75): history, reply mentions, your vault and the
// AI tools Clotr spotted but doesn't protect. The model and layout live in insights.js / mindmap.js.
const mapData = { events: [], mentions: [], vault: [], spotted: {} };
let mapView = readView();
let mapChosen = null;
function readView() {
  try {
    return localStorage.getItem("clotr.mapView") === "kind" ? "kind" : "service";
  } catch {
    return "service";
  }
}

// Spotted sites that are still unprotected (protecting one takes it off the blind spots).
async function blindSpots() {
  const covered = [...globalThis.ClotrSites.builtInMatches(), ...(await globalThis.ClotrSites.userSitePatterns())];
  return globalThis.ClotrInsights.unprotectedHosts(mapData.spotted, covered);
}

async function renderMap() {
  // Draw at the real width so text stays readable on a narrow window.
  mapWidth = $("map").parentElement.clientWidth; // the section: the map itself is narrower as an outline
  const w = Math.round(Math.min(960, Math.max(340, mapWidth || 760)));
  $("map").dataset.room = `0 0 ${w} ${Math.round(w * (w < 560 ? 1 : 0.72))}`;
  const { exposureModel, buildMindMapTree } = globalThis.ClotrInsights;
  const { layoutRadial, layoutList, renderMindMap, renderMindMapTable } = globalThis.ClotrMindMap;
  const model = exposureModel({ ...mapData, blind: await blindSpots() });
  // Wide: a radial mind map. Narrow (a phone, a side panel): the same tree as an outline, which
  // stays readable at any width.
  const narrow = w < 560;
  const built = buildMindMapTree(model, { view: mapView, max: w < 640 ? 5 : 8, leaves: w >= 640 });
  const tree = narrow ? layoutList(built) : layoutRadial(built);
  $("map").classList.toggle("as-list", narrow);
  const show = (n) => {
    mapChosen = n.id;
    $("map-details").textContent = n.detail || n.label;
  };
  renderMindMap($("map"), tree, { onSelect: show });
  let chosen = null;
  const find = (n) => {
    if (n.id === mapChosen) chosen = n;
    n.children.forEach(find);
  };
  find(tree);
  const empty = !model.has.bySite.length && !model.near.bySite.length;
  if (chosen) show(chosen);
  else
    $("map-details").textContent = empty
      ? msg("db_mapEmpty", "Nothing here yet. The map fills in as Clotr notices things in your chats and email.")
      : "";
  renderMindMapTable($("map-table").tBodies[0], tree);
  for (const btn of $("map-view").querySelectorAll("button"))
    btn.setAttribute("aria-checked", String(btn.dataset.view === mapView));
}

$("map-view").addEventListener("click", (e) => {
  const view = e.target.closest("button")?.dataset.view;
  if (!view || view === mapView) return;
  mapView = view;
  mapChosen = null;
  try {
    localStorage.setItem("clotr.mapView", view); // this page's view only (a convenience, not a setting)
  } catch {
    /* private window: the toggle still works for this visit */
  }
  renderMap();
});

// Only a new width redraws: a height change (a phone's address bar, a full-page capture) leaves the map still.
let mapResize = null;
let mapWidth = 0;
window.addEventListener("resize", () => {
  clearTimeout(mapResize);
  mapResize = setTimeout(() => {
    if ($("map").parentElement.clientWidth !== mapWidth) renderMap();
  }, 150);
});

function renderWeeks(events) {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const start = now.getTime() - 83 * DAY; // 12 weeks, ending today
  const weeks = Array.from({ length: 12 }, (_, i) => ({
    from: start + i * 7 * DAY,
    redacted: 0,
    allowed: 0,
    suppressed: 0,
  }));
  for (const e of events) {
    const i = Math.floor((e.t - start) / (7 * DAY));
    if (i >= 0 && i < 12 && e.action in weeks[i]) weeks[i][e.action]++;
  }
  const W = 720,
    H = 200,
    pad = { l: 28, r: 8, t: 8, b: 24 };
  const max = Math.max(1, ...weeks.map((w) => w.redacted + w.allowed + w.suppressed));
  const band = (W - pad.l - pad.r) / 12;
  const plot = H - pad.t - pad.b;
  const nodes = [
    svg("line", { class: "grid", x1: pad.l, x2: W - pad.r, y1: H - pad.b, y2: H - pad.b }),
    Object.assign(svg("text", { class: "tick", x: 2, y: pad.t + 10 }), { textContent: String(max) }),
  ];
  weeks.forEach((w, i) => {
    const x = pad.l + i * band + band * 0.18;
    const width = band * 0.64;
    let y = H - pad.b;
    const g = svg("g", {
      tabindex: 0,
      role: "img",
      "aria-label": msg(
        "db_weekLabel",
        "Week of $1: $2 hidden, $3 sent, $4 just counted",
        fmtDay.format(w.from),
        w.redacted,
        w.allowed,
        w.suppressed,
      ),
    });
    g.dataset.week = String(i);
    for (const s of SERIES) {
      const h = (w[s.action] / max) * plot;
      if (h > 0) {
        y -= h;
        g.append(svg("rect", { x, y, width, height: h, fill: s.color, rx: 2 }));
      }
    }
    g.append(Object.assign(svg("title"), { textContent: g.getAttribute("aria-label") }));
    nodes.push(g);
    if (i % 2 === 0)
      nodes.push(
        Object.assign(svg("text", { class: "tick", x: x + width / 2, y: H - 6, "text-anchor": "middle" }), {
          textContent: fmtDay.format(w.from),
        }),
      );
  });
  $("weeks").replaceChildren(...nodes);
  $("legend").replaceChildren(...SERIES.map((s) => el("span", {}, [Object.assign(el("i"), { style: "" }), s.label])));
  $("legend")
    .querySelectorAll("i")
    .forEach((i, k) => {
      i.style.background = SERIES[k].color;
    });
  $("weeks-table").tBodies[0].replaceChildren(
    ...weeks.map((w) =>
      el("tr", {}, [
        el("td", { textContent: fmtDay.format(w.from) }),
        el("td", { textContent: String(w.redacted) }),
        el("td", { textContent: String(w.allowed) }),
        el("td", { textContent: String(w.suppressed) }),
      ]),
    ),
  );
}

function renderRisky(events) {
  const risky = events.filter(
    (e) =>
      (e.action === "allowed" && e.severity === "high" && !PERSONAL.has(e.type)) ||
      (e.action === "allowed" &&
        [
          "credit_card",
          "us_ssn",
          "bank_account",
          "national_id",
          "passport",
          "medical_record",
          "crypto_secret",
        ].includes(e.type)),
  );
  $("risky").replaceChildren(
    ...(risky.length
      ? risky
          .slice()
          .reverse()
          .slice(0, 20)
          .map((e) =>
            el("div", { className: "moment" }, [
              el("div", { className: "what", textContent: msg("db_sentTo", "$1 sent to $2", nameOf(e), e.site) }),
              el("div", { className: "when", textContent: fmtWhen.format(e.t) }),
              el("div", { className: "todo", textContent: msg("db_whatToDo", "What to do now: $1", advice(e.type)) }),
            ]),
          )
      : [
          el("p", { className: "empty-note", textContent: msg("db_noRisky", "No high-risk items have been sent. 👍") }),
        ]),
  );
}

function renderRepeats(events) {
  const groups = new Map();
  for (const e of events) {
    if (e.action !== "allowed" || !e.fp) continue;
    const key = `${e.type}:${e.fp}`;
    if (!groups.has(key)) groups.set(key, { name: nameOf(e), times: 0, sites: new Set() });
    const g = groups.get(key);
    g.times++;
    g.sites.add(e.site);
  }
  const rows = [...groups.values()].filter((g) => g.times > 1).sort((a, b) => b.times - a.times);
  $("repeats").replaceChildren(
    ...(rows.length
      ? [
          el(
            "ul",
            {},
            rows.map((g) =>
              el("li", {
                textContent: msg(
                  "db_repeat",
                  "The same $1 went out $2 times, to $3. If it's yours, add it to your vault and Clotr will always watch for it.",
                  g.name,
                  g.times,
                  tools(g.sites.size),
                ),
              }),
            ),
          ),
        ]
      : [el("p", { className: "empty-note", textContent: msg("db_noRepeats", "Nothing was sent more than once.") })]),
  );
}

function renderCard(events) {
  const sent = events.filter((e) => e.action === "allowed").length;
  const covered = events.filter((e) => e.action === "redacted").length;
  const toolCount = new Set(events.map((e) => e.site)).size;
  const caught =
    events.length === 1
      ? msg("db_private1", "1 private detail")
      : msg("db_privateN", "$1 private details", events.length);
  const text = msg(
    "db_card",
    "Clotr caught $1 on its way to $2: $3 hidden, $4 sent anyway. Checked on my own computer; nothing ever left it.",
    caught,
    tools(toolCount),
    covered,
    sent,
  );
  $("card").replaceChildren(el("b", { textContent: msg("db_cardTitle", "🛡️ My privacy, so far") }), el("br"), text);
  $("copy-card").onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      $("copy-msg").textContent = msg("db_copied", "Copied.");
    } catch {
      $("copy-msg").textContent = msg("db_copyFailed", "Couldn't copy; select the text instead.");
    }
  };
}

// ---------- Your data ----------

$("export").addEventListener("click", async () => {
  const {
    events = [],
    vault = [],
    responses = {},
    siteModes = {},
  } = await chrome.storage.local.get(["events", "vault", "responses", "siteModes"]);
  const data = {
    exported: new Date().toISOString(),
    note: "Clotr history: kinds of data, sites, times and outcomes. No detected values. The fingerprint secret is not included.",
    events,
    vault,
    responses,
    siteModes,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  let a = $("export-link");
  if (!a) {
    a = el("a", { id: "export-link", textContent: msg("db_downloadAgain", "Download again") });
    $("data-msg").after(a);
  }
  if (a.href.startsWith("blob:")) URL.revokeObjectURL(a.href); // free the previous export
  a.href = url;
  a.download = `clotr-history-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  $("data-msg").textContent =
    events.length === 1
      ? msg("db_exported1", "Exported 1 record.")
      : msg("db_exportedN", "Exported $1 records.", events.length);
});

// The background removes older records when this changes (D54).
chrome.storage.local.get("keepDays").then(({ keepDays = 365 }) => {
  $("keep-days").value = String(keepDays);
});
$("keep-days").addEventListener("change", async (e) => {
  await chrome.storage.local.set({ keepDays: Number(e.target.value) });
  $("data-msg").textContent = msg("db_keeping", "Keeping $1 of history.", e.target.selectedOptions[0].textContent);
});

let armed = null;
$("delete-history").addEventListener("click", async () => {
  const b = $("delete-history");
  if (!armed) {
    // two clicks, so a stray click can't wipe history
    b.classList.add("armed");
    b.textContent = msg("db_deleteAgain", "Click again to delete all history");
    armed = setTimeout(() => {
      armed = null;
      b.classList.remove("armed");
      b.textContent = msg("dash_deleteMyHistory", "Delete my history");
    }, 4000);
    return;
  }
  clearTimeout(armed);
  armed = null;
  await chrome.storage.local.set({ events: [], mentions: [], spotted: {} });
  b.classList.remove("armed");
  b.textContent = msg("dash_deleteMyHistory", "Delete my history");
  $("data-msg").textContent = msg("db_deleted", "History deleted. Your settings and vault are still here.");
});

function renderAll(events) {
  mapData.events = events;
  renderTotals(events);
  renderExposure(events);
  renderBandageKept(events);
  renderMap();
  renderWeeks(events);
  renderRisky(events);
  renderRepeats(events);
  renderCard(events);
}

chrome.storage.local.get(["events", "mentions", "vault", "spotted"]).then((s) => {
  Object.assign(mapData, { mentions: s.mentions || [], vault: s.vault || [], spotted: s.spotted || {} });
  renderAll(s.events || []);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.mentions) mapData.mentions = changes.mentions.newValue || [];
  if (changes.vault) mapData.vault = changes.vault.newValue || [];
  if (changes.spotted) mapData.spotted = changes.spotted.newValue || {};
  if (changes.events) renderAll(changes.events.newValue || []);
  else if (changes.mentions || changes.vault || changes.spotted) renderMap();
});
