// Clotr — "What Clotr stores": shows the extension's stored records, read-only.
// Nothing here writes to storage or leaves the page. The fingerprint salt is masked.
"use strict";

const $ = (id) => document.getElementById(id);
const { msg } = globalThis.Clotr;

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

const fmt = new Intl.DateTimeFormat([], { dateStyle: "medium", timeStyle: "short" });
const when = (t) => (Number.isFinite(t) ? fmt.format(t) : "—");
const fmtShort = new Intl.DateTimeFormat([], { dateStyle: "short", timeStyle: "short" });
const OUTCOME = {
  redacted: msg("pp_covered", "Hidden"),
  allowed: msg("pp_sent", "Sent"),
  suppressed: msg("pp_justCounted", "Just counted"),
};
const RESPONSE = {
  block: msg("popup_askBeforeSending", "Ask before sending"),
  warn: msg("popup_warn", "Warn"),
  log: msg("popup_justCount", "Just count"),
};
const VAULT_TYPES = {
  my_name: msg("vt_cName", "Your name"),
  family_name: msg("vt_cFamily", "Family member"),
  employer: msg("vt_cWork", "Where you work"),
  street_address: msg("vt_cAddress", "Address"),
  phone_number: msg("vt_cPhone", "Phone number"),
  email: msg("vt_cEmail", "Email address"),
  my_id: msg("vt_cIdFormat", "Account/ID format"),
  watch_list: msg("vt_cWatch", "Watch word"),
};
const pretty = (id) => VAULT_TYPES[id] || id.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

function facts(target, rows) {
  $(target).replaceChildren(...rows.flatMap(([k, v]) => [el("dt", { textContent: k }), el("dd", { textContent: v })]));
}

function render(all) {
  const responses = Object.entries(all.responses || {});
  const siteModes = Object.entries(all.siteModes || {});
  const paused = Object.keys(all.paused || {}).filter((h) => all.paused[h]);
  facts("settings", [
    [
      msg("sj_changed", "Changed from the default (warn)"),
      responses.length
        ? responses.map(([id, r]) => `${pretty(id)}: ${RESPONSE[r] || r}`).join(" · ")
        : msg("sj_nothingChanged", "Nothing: everything warns"),
    ],
    [
      msg("sj_siteModes", "Stricter or quieter on one AI tool"),
      siteModes.length
        ? siteModes
            .map(([h, m]) => `${h}: ${m === "block" ? msg("sj_stricter", "stricter") : msg("sj_quieter", "quieter")}`)
            .join(" · ")
        : msg("sj_none", "None"),
    ],
    [msg("sj_pausedOn", "Paused on"), paused.length ? paused.join(", ") : msg("sj_nowhere", "Nowhere")],
    [msg("sj_advanced", "Advanced options shown"), all.advanced ? msg("sj_yes", "Yes") : msg("sj_no", "No")],
    [
      msg("dash_keepHistoryFor", "Keep history for"),
      { 90: msg("dash_3Months", "3 months"), 730: msg("dash_2Years", "2 years") }[all.keepDays] ||
        msg("dash_1Year", "1 year"),
    ],
    [
      msg("popup_aiToolsYouAdded", "AI tools you added"),
      Object.keys(all.siteScopes || {}).length
        ? Object.entries(all.siteScopes)
            .map(([o, s]) => `${o} (${s.join(", ")})`)
            .join(" · ")
        : msg("sj_seeSettings", "See Settings → AI tools you added"),
    ],
  ]);

  const vault = all.vault || [];
  $("vault-count").textContent = vault.length
    ? vault.length === 1
      ? msg("sj_item1", "1 item.")
      : msg("sj_itemN", "$1 items.", vault.length)
    : msg("sj_empty", "Empty.");
  $("vault-table").hidden = !vault.length;
  $("vault-table").tBodies[0].replaceChildren(
    ...vault.map((e) =>
      el("tr", {}, [
        el("td", { textContent: pretty(e.type) + (e.learned ? " (learned)" : "") }),
        el("td", {
          textContent:
            e.kind === "value" && e.mode === "allow"
              ? msg("vault_okToShare", "OK to share")
              : msg("vault_watch", "Watch"),
        }),
        el("td", {}, [
          e.kind === "shape"
            ? el("code", { textContent: e.shape })
            : el("code", { textContent: `fingerprint ${e.fp}` }),
        ]),
        el("td", { textContent: when(e.added) }),
      ]),
    ),
  );

  const events = all.events || [];
  $("history-count").textContent = events.length
    ? `${events.length} ${events.length === 1 ? "record" : "records"}, from ${when(events[0].t)} to ${when(events.at(-1).t)}. Clotr keeps them for the period set in the full report (1 year unless you changed it), up to 10,000.`
    : msg("sj_noRecords", "No records yet.");
  $("history-table").hidden = !events.length;
  $("history-table").tBodies[0].replaceChildren(
    ...events
      .slice(-100)
      .reverse()
      .map((e) =>
        el("tr", {}, [
          el("td", { textContent: Number.isFinite(e.t) ? fmtShort.format(e.t) : "—" }),
          el("td", { textContent: e.site }),
          el("td", { textContent: e.name || pretty(e.type) }),
          el("td", { textContent: OUTCOME[e.action] || e.action }),
          el("td", {}, [el("code", { textContent: e.fp || "—" })]),
        ]),
      ),
  );

  facts("other", [
    [
      msg("sj_salt", "Fingerprint secret"),
      all.salt
        ? msg(
            "sj_saltWhat",
            "A random number made on this computer, used so fingerprints can't be compared with anyone else's (hidden here). Moving to a new computer takes it along, so your vault keeps working there.",
          )
        : msg("sj_notYet", "Not created yet"),
    ],
    [
      msg("sj_kept", "Times you kept a warning (last 14 days)"),
      Object.entries(all.ignores || {})
        .map(([id, ts]) => `${pretty(id)}: ${ts.length}`)
        .join(" · ") || msg("sj_none", "None"),
    ],
    [
      msg("sj_tips", "First-time tips already shown for"),
      Object.keys(all.guided || {})
        .map(pretty)
        .join(", ") || msg("sj_noneYet", "None yet"),
    ],
    [
      msg("sj_replyCheck", "Check the AI's replies for my details"),
      all.replyCheck === false ? msg("sj_off", "Off") : msg("sj_on", "On"),
    ],
    [
      msg("sj_mentions", "AI replies that brought up your details (kind and fingerprint, never the text)"),
      (all.mentions || []).length
        ? Object.entries(
            (all.mentions || []).reduce(
              (n, e) => ({ ...n, [`${e.site}: ${pretty(e.type)}`]: (n[`${e.site}: ${pretty(e.type)}`] || 0) + 1 }),
              {},
            ),
          )
            .map(([k, c]) => (c > 1 ? `${k} ×${c}` : k))
            .join(" · ")
        : msg("sj_none", "None"),
    ],
    [
      msg("sj_spotted", "AI tools you opened Clotr on that it doesn't protect (names only)"),
      Object.keys(all.spotted || {}).join(", ") || msg("sj_none", "None"),
    ],
    [msg("sj_lastUpdate", "Last update"), all.lastUpdate ? `${all.lastUpdate.from} → ${all.lastUpdate.to}` : "—"],
  ]);

  const shown = { ...all, ...(all.salt ? { salt: "(hidden)" } : {}) };
  $("raw").textContent = JSON.stringify(shown, null, 2);
}

// "What Clotr can reach": read from the installed manifest, so it can't drift from what the browser enforces.
const WHY = {
  storage: msg("sj_pStorage", "Keeps your settings, vault fingerprints and history on this computer."),
  activeTab: msg(
    "sj_pActiveTab",
    "When you click Clotr's button, lets it look at that one tab to tell whether it's an AI chat. Nothing else.",
  ),
  scripting: msg("sj_pScripting", "Starts Clotr on AI chat sites you add yourself, only after you allow each one."),
  declarativeContent: msg(
    "sj_pDeclarative",
    "Lets the browser show the amber dot on pages that look like an AI chat, without Clotr reading them.",
  ),
  alarms: msg("sj_pAlarms", "Updates today's count after midnight and removes old history on schedule."),
};
function renderReach() {
  const m = chrome.runtime.getManifest();
  $("policy").textContent = m.content_security_policy?.extension_pages || "";
  const row = (id, label, why) => {
    const dt = el("dt", { textContent: label });
    dt.dataset.permission = id;
    return [dt, el("dd", { textContent: why })];
  };
  const sites = m.host_permissions || [];
  $("permissions").replaceChildren(
    ...(m.permissions || []).flatMap((p) =>
      row(p, p, WHY[p] || msg("sj_pOther", "Used by Clotr's own features on this computer.")),
    ),
    ...row(
      "AI sites",
      msg("sj_aiSitesN", "$1 AI chat sites", sites.length),
      msg(
        "sj_aiSitesWhy",
        "Reads what you type in the chat boxes of these AI chat sites, to warn you before you send: $1. Never any other site.",
        sites.map((s) => s.replace(/^https:\/\/|\/\*$/g, "")).join(", "),
      ),
    ),
    ...((m.optional_host_permissions || []).length
      ? row(
          "Sites you add",
          msg("sj_youAdd", "Sites you add"),
          msg(
            "sj_youAddWhy",
            "Only when you click Protect this site on an AI tool Clotr doesn't know yet, and only after the browser asks you.",
          ),
        )
      : []),
  );
}
renderReach();

chrome.storage.local.get(null).then(render);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") chrome.storage.local.get(null).then(render);
});
