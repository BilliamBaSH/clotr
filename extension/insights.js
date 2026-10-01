// Clotr: plain-words advice and the mind map's model, shared by the popup and the full report (dashboard).
// Extension pages only; not a content script.
"use strict";

(() => {
  const KEYS = new Set([
    "aws_access_key",
    "github_token",
    "stripe_secret_key",
    "anthropic_key",
    "openai_key",
    "google_api_key",
    "slack_token",
    "service_token",
    "jwt",
    "connection_string",
    "private_key",
    "password",
  ]);
  const IDS = new Set([
    "us_ssn",
    "national_id",
    "passport",
    "drivers_license",
    "medicare_id",
    "insurance_id",
    "medical_record",
  ]);

  // English is written here and is the fallback (D65); patterns.js provides msg() on every page that loads this.
  const msg = (...a) =>
    globalThis.Clotr?.msg
      ? globalThis.Clotr.msg(...a)
      : a[1].replace(/\$(\d)/g, (_, n) => String(a[Number(n) + 1] ?? ""));
  const typeName = (e) => globalThis.Clotr?.PATTERNS?.find((p) => p.id === e.type)?.name || e.name || e.type;

  // What to do now about something that was sent to an AI service.
  function adviceFor(type) {
    if (type === "crypto_secret")
      return msg(
        "ad_crypto",
        "Move your funds to a new wallet. A seed phrase or key can't be changed, only left behind.",
      );
    if (KEYS.has(type))
      return msg(
        "ad_key",
        "Turn it off and make a new one (or change the password) now. Once it's been sent, treat it as public.",
      );
    if (type === "credit_card")
      return msg("ad_card", "Watch your statements, and ask your bank for a new card if you're unsure.");
    if (type === "bank_account")
      return msg("ad_bank", "Tell your bank if you didn't mean to share it, and watch for unexpected activity.");
    if (IDS.has(type))
      return msg(
        "ad_id",
        "Keep an eye out for identity theft. In the US, a free credit freeze stops anyone opening new accounts in your name.",
      );
    return msg("ad_other", "Delete that chat in the AI service if you can, and turn off training on your chats.");
  }

  // ---------- Mind map of everything you could be leaking (D75; was the connection map, D57) ----------
  // Pure data in, data out (unit-tested): history, reply mentions, your vault and spotted AI sites
  // become one tree. mindmap.js lays it out and draws it; the table view reads the same tree.
  const RANK = { high: 3, medium: 2, low: 1 };
  const RISK_WORD = {
    high: msg("rk_high", "High"),
    medium: msg("rk_medium", "Medium"),
    low: msg("rk_low", "Low"),
    none: msg("rk_none", "Nothing sent"),
  };
  const riskier = (a, b) => ((RANK[b] || 0) > (RANK[a] || 0) ? b : a);
  const kindsText = (kinds) => [...kinds].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(", ");

  // Places no browser extension can see, always listed under blind spots.
  const CANT_SEE = [
    ["desktop_apps", () => msg("mp_desktopApps", "AI apps on your computer")],
    ["phone_apps", () => msg("mp_phoneApps", "AI apps on your phone")],
    ["browser_panels", () => msg("mp_browserPanels", "AI side panels built into browsers")],
  ];

  // Counts per AI service and per kind of detail, each with the riskiest severity seen.
  function tally(list) {
    const bySite = new Map();
    const byType = new Map();
    const row = (map, key, label) => {
      if (!map.has(key)) map.set(key, { key, label, count: 0, severity: "none", parts: new Map() });
      return map.get(key);
    };
    for (const e of list) {
      const name = typeName(e);
      const site = row(bySite, e.site, e.site);
      site.count++;
      site.severity = riskier(site.severity, e.severity);
      site.parts.set(name, (site.parts.get(name) || 0) + 1);
      const kind = row(byType, e.type, name);
      kind.count++;
      kind.severity = riskier(kind.severity, e.severity);
      kind.parts.set(e.site, (kind.parts.get(e.site) || 0) + 1);
    }
    const sorted = (m) => [...m.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    return { bySite: sorted(bySite), byType: sorted(byType) };
  }

  // events: history (found in your own messages); mentions: replies that brought up your details
  // (D63); vault: your saved details (fingerprints/formats); blind: spotted AI site names Clotr
  // doesn't protect. Never sees a value: only kinds, sites, outcomes and fingerprints.
  function exposureModel({ events = [], mentions = [], vault = [], blind = [] } = {}) {
    const sentList = events.filter((e) => e.action === "allowed" || e.action === "suppressed");
    const reachedList = [...sentList, ...mentions];
    const reached = new Set(reachedList.map((e) => e.fp).filter(Boolean));
    const reachedTypes = new Set(reachedList.map((e) => e.type));
    const open = new Map();
    for (const v of vault) {
      if (!v || v.mode === "allow" || !v.type) continue;
      if (v.fp ? reached.has(v.fp) : reachedTypes.has(v.type)) continue;
      if (!open.has(v.type)) open.set(v.type, { key: v.type, label: typeName({ type: v.type }), count: 0 });
      open.get(v.type).count++;
    }
    return {
      has: tally(reachedList),
      mentioned: tally(mentions),
      near: tally(events.filter((e) => e.action === "redacted")),
      open: [...open.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
      blind: [...new Set(blind)].sort(),
    };
  }

  // Spotted AI sites (names only) that Clotr protects nowhere: `covered` = the match patterns Clotr runs on.
  // A site protected for one section only (huggingface.co/chat) counts as protected: it isn't a blind spot.
  function unprotectedHosts(spotted, covered) {
    const hosts = new Set(covered.map((p) => (p.match(/^https?:\/\/([^/]+)\//) || [])[1]).filter(Boolean));
    return Object.keys(spotted || {})
      .filter((host) => !hosts.has(host))
      .sort();
  }

  // Up to `max` children; the rest become one "+N more" node.
  function capped(children, max, idBase) {
    if (children.length <= max) return children;
    const rest = children.slice(max - 1);
    return [
      ...children.slice(0, max - 1),
      {
        id: `${idBase}/more`,
        type: "more",
        branch: children[0].branch,
        label: msg("mp_more", "+$1 more", rest.length),
        count: rest.reduce((n, c) => n + (c.count || 0), 0),
        children: [],
      },
    ];
  }

  const BRANCH_LABEL = {
    has: () => msg("mp_has", "Already has"),
    near: () => msg("mp_near", "Near misses"),
    open: () => msg("mp_open", "Not shared yet"),
    blind: () => msg("mp_blind", "Blind spots"),
  };

  const BRANCH_DETAIL = {
    has: () =>
      msg(
        "mp_hasDetail",
        "What services already have from you: sent after a warning, just counted, or brought up in their replies.",
      ),
    near: () => msg("mp_nearDetail", "What Clotr hid or held before it went out."),
    open: () => msg("mp_openDetailBranch", "Details in your vault that haven't gone anywhere yet."),
    blind: () =>
      msg(
        "mp_blindDetailBranch",
        "Where Clotr can't protect you: AI tools it spotted but doesn't cover, and places no extension can see.",
      ),
  };

  function detailFor(branch, byService, g, said) {
    const list = kindsText(g.parts);
    let text;
    if (branch === "near")
      text = byService
        ? msg("mp_nearService", "Clotr stopped on $1: $2", g.label, list)
        : msg("mp_nearKind", "$1, stopped by Clotr on: $2", g.label, list);
    else
      text = byService
        ? msg("mp_hasService", "$1 has: $2 (riskiest: $3)", g.label, list, RISK_WORD[g.severity] || RISK_WORD.none)
        : msg("mp_hasKind", "$1 reached: $2", g.label, list);
    if (said)
      text += ` ${msg("mp_mentionedToo", "Its replies brought up your details without you typing them ($1×).", said.count)}`;
    return text;
  }

  // view: "service" (you → branch → AI service → kinds) or "kind" (you → branch → kind → AI services).
  // compact: the popup's version: no leaves, only the branches with something in them.
  // leaves: false drops the outer ring only (a narrow window); their details stay in the table.
  function buildMindMapTree(model, { view = "service", max = 8, compact = false, leaves = !compact } = {}) {
    const byService = view !== "kind";
    const mentionedBy = new Map((byService ? model.mentioned.bySite : model.mentioned.byType).map((m) => [m.key, m]));
    const group = (branch, t) =>
      (byService ? t.bySite : t.byType).map((g) => {
        const said = branch === "has" ? mentionedBy.get(g.key) : null;
        const id = `${branch}/${g.key}`;
        return {
          id,
          type: byService ? "service" : "kind",
          branch,
          key: g.key,
          label: g.label,
          count: g.count,
          severity: g.severity,
          mentioned: said ? said.count : 0,
          detail: detailFor(branch, byService, g, said),
          children: !leaves
            ? []
            : capped(
                [...g.parts].map(([label, count]) => ({
                  id: `${id}/${label}`,
                  type: "leaf",
                  branch,
                  label,
                  count,
                  children: [],
                })),
                max,
                id,
              ),
        };
      });
    const open = model.open.map((o) => ({
      id: `open/${o.key}`,
      type: "kind",
      branch: "open",
      key: o.key,
      label: o.label,
      count: o.count,
      severity: "none",
      detail: msg("mp_openDetail", "$1: not shared anywhere yet ($2 of yours)", o.label, o.count),
      children: [],
    }));
    const blind = model.blind.map((host) => ({
      id: `blind/${host}`,
      type: "service",
      branch: "blind",
      key: host,
      label: host,
      count: 0,
      severity: "none",
      detail: msg(
        "mp_blindDetail",
        "$1 looks like an AI chat, but Clotr doesn't protect it. Open Clotr's toolbar button there to protect it.",
        host,
      ),
      children: [],
    }));
    const cantSee = {
      id: "blind/cant-see",
      type: "cant-see",
      branch: "blind",
      key: "cant-see",
      label: msg("mp_cantSee", "Clotr can't see"),
      count: 0,
      severity: "none",
      detail: msg(
        "mp_cantSeeDetail",
        "Clotr only works on AI websites in this browser, so be just as careful with these: $1.",
        CANT_SEE.map(([, label]) => label()).join(", "),
      ),
      children: CANT_SEE.map(([key, label]) => ({
        id: `blind/cant-see/${key}`,
        type: "leaf",
        branch: "blind",
        label: label(),
        count: 0,
        children: [],
      })),
    };
    const branches = [
      ["has", group("has", model.has)],
      ["near", group("near", model.near)],
      ["open", open],
      ["blind", compact ? blind : [...blind, cantSee]],
    ]
      .filter(([, children]) => !compact || children.length)
      .map(([key, children]) => ({
        id: key,
        type: "branch",
        branch: key,
        key,
        label: BRANCH_LABEL[key](),
        detail: BRANCH_DETAIL[key](),
        count: children.filter((c) => c.type !== "cant-see").length,
        children: capped(children, max, key),
      }));
    return { id: "you", type: "you", label: msg("mp_you", "You"), count: 0, children: branches };
  }

  globalThis.ClotrInsights = {
    adviceFor,
    exposureModel,
    buildMindMapTree,
    unprotectedHosts,
    kindsText,
    RISK_WORD,
    CANT_SEE,
  };
})();
