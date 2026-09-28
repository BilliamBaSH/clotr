// Clotr: plain-words advice shared by the popup and the full report (dashboard).
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
        "Move your funds to a new wallet: a seed phrase or key can't be changed, only abandoned.",
      );
    if (KEYS.has(type))
      return msg(
        "ad_key",
        "Deactivate it and make a new one (or change the password) now: once sent, treat it as public.",
      );
    if (type === "credit_card")
      return msg("ad_card", "Watch your statements, and ask your bank for a new card if you're unsure.");
    if (type === "bank_account")
      return msg("ad_bank", "Tell your bank if you didn't mean to share it, and watch for unexpected activity.");
    if (IDS.has(type))
      return msg("ad_id", "Watch for identity theft; in the US a free credit freeze stops new accounts in your name.");
    return msg(
      "ad_other",
      "Delete that chat in the AI service if you can, and turn off using your chats for training.",
    );
  }

  // ---------- AI connection map (D57) ----------
  // From history only (kinds, sites, outcomes): what went to each AI service, and what
  // Clotr stopped on the way. "Sent" = sent after a warning; "stopped" = hidden.
  const RANK = { high: 3, medium: 2, low: 1 };
  const RISK_WORD = {
    high: msg("rk_high", "High"),
    medium: msg("rk_medium", "Medium"),
    low: msg("rk_low", "Low"),
    none: msg("rk_none", "Nothing sent"),
  };
  const RISK_RING = { high: "var(--high-fg)", medium: "var(--medium-fg)", low: "var(--low-fg)", none: "var(--axis)" };

  function connections(events) {
    const by = new Map();
    for (const e of events) {
      if (e.action !== "allowed" && e.action !== "redacted") continue;
      if (!by.has(e.site))
        by.set(e.site, {
          site: e.site,
          sent: 0,
          stopped: 0,
          risk: "none",
          sentKinds: new Map(),
          stoppedKinds: new Map(),
        });
      const c = by.get(e.site);
      const name = typeName(e);
      if (e.action === "allowed") {
        c.sent++;
        c.sentKinds.set(name, (c.sentKinds.get(name) || 0) + 1);
        if ((RANK[e.severity] || 0) > (RANK[c.risk] || 0)) c.risk = e.severity;
      } else {
        c.stopped++;
        c.stoppedKinds.set(name, (c.stoppedKinds.get(name) || 0) + 1);
      }
    }
    return [...by.values()].sort((a, b) => b.sent - a.sent || b.stopped - a.stopped || a.site.localeCompare(b.site));
  }

  const kindsText = (kinds) => [...kinds].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(", ");
  const describe = (c) =>
    msg("mp_describe", "$1: $2 sent (riskiest: $3), $4 stopped by Clotr", c.site, c.sent, RISK_WORD[c.risk], c.stopped);

  function svgEl(tag, attrs = {}, text) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    if (text != null) node.textContent = text;
    return node;
  }

  // Draws "you" in the middle and a line to each AI service into `svg` (its viewBox sets the size).
  // compact: the popup's small version (short labels only, not focusable). onSelect(c): a
  // service was chosen by click, Enter or Space. Returns the services drawn.
  function drawConnectionMap(svg, events, { compact = false, max = compact ? 6 : 12, onSelect } = {}) {
    // The most room the map may take: the caller's data-room, else the page's first viewBox. The
    // viewBox is then trimmed to the drawing (three services leave the bottom of an ellipse empty).
    svg.dataset.room ??= svg.getAttribute("viewBox") || "0 0 720 400";
    const [, , W, H] = svg.dataset.room.split(/\s+/).map(Number);
    const rows = connections(events).slice(0, max);
    const cx = W / 2,
      cy = H / 2;
    const nodeR = compact ? 15 : 22;
    // An ellipse, leaving room for labels at the sides and above/below the nodes.
    const rx = Math.max(40, W / 2 - (compact ? 48 : 90));
    const ry = Math.max(30, H / 2 - nodeR - (compact ? 16 : 36));
    const nodes = [];
    const lines = [];
    const youR = compact ? 18 : 26;
    let top = cy - youR,
      bottom = cy + youR; // how far the drawing reaches, labels included
    rows.forEach((c, i) => {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(rows.length, 1);
      const x = cx + rx * Math.cos(angle),
        y = cy + ry * Math.sin(angle);
      const nx = -Math.sin(angle) * 3.5,
        ny = Math.cos(angle) * 3.5; // side-by-side offset
      if (c.sent)
        lines.push(
          svgEl("line", {
            x1: cx + nx,
            y1: cy + ny,
            x2: x + nx,
            y2: y + ny,
            stroke: "var(--series-2)",
            "stroke-width": 1.5 + Math.min(8, c.sent * 1.5),
            "stroke-linecap": "round",
          }),
        );
      if (c.stopped)
        lines.push(
          svgEl("line", {
            x1: cx - nx,
            y1: cy - ny,
            x2: x - nx,
            y2: y - ny,
            stroke: "var(--series-1)",
            "stroke-width": 1.5 + Math.min(6, c.stopped),
            "stroke-dasharray": "5 4",
          }),
        );
      const g = svgEl("g", { class: "map-node" });
      g.dataset.service = c.site;
      g.dataset.sent = String(c.sent);
      g.dataset.stopped = String(c.stopped);
      g.dataset.risk = c.risk;
      g.setAttribute("aria-label", describe(c));
      g.append(svgEl("title", {}, describe(c)));
      g.append(
        svgEl("circle", {
          cx: x,
          cy: y,
          r: nodeR,
          fill: "var(--surface)",
          stroke: RISK_RING[c.risk],
          "stroke-width": 3,
        }),
      );
      g.append(svgEl("text", { x, y: y + 4, "text-anchor": "middle", class: "map-count" }, String(c.sent)));
      const below = y >= cy - 1;
      const label = c.site.replace(/^www\./, "");
      const labels = compact ? 16 : 36; // label (and the sent/stopped line) beyond the circle
      top = Math.min(top, y - nodeR - (below ? 0 : labels));
      bottom = Math.max(bottom, y + nodeR + (below ? labels : 0));
      if (compact) {
        g.append(
          svgEl(
            "text",
            { x, y: below ? y + nodeR + 12 : y - nodeR - 5, "text-anchor": "middle", class: "map-label" },
            label,
          ),
        );
      }
      if (!compact) {
        const ly = below ? y + nodeR + 16 : y - nodeR - 22;
        g.append(svgEl("text", { x, y: ly, "text-anchor": "middle", class: "map-label" }, label));
        g.append(
          svgEl(
            "text",
            { x, y: ly + 14, "text-anchor": "middle", class: "map-sub" },
            msg("mp_sub", "$1 sent · $2 stopped", c.sent, c.stopped),
          ),
        );
        g.setAttribute("tabindex", "0");
        g.setAttribute("role", "button");
        const choose = () => onSelect?.(c);
        g.addEventListener("click", choose);
        g.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            choose();
          }
        });
      } else {
        g.setAttribute("role", "img");
      }
      nodes.push(g);
    });
    const you = svgEl("g", { class: "map-you" });
    you.dataset.you = "";
    you.append(svgEl("circle", { cx, cy, r: youR, fill: "var(--ink)" }));
    you.append(
      svgEl(
        "text",
        { x: cx, y: cy + 4, "text-anchor": "middle", fill: "var(--page)", class: "map-you-label" },
        msg("mp_you", "You"),
      ),
    );
    svg.replaceChildren(...lines, you, ...nodes);
    const pad = 6;
    const y0 = Math.max(0, top - pad),
      y1 = Math.min(H, bottom + pad);
    svg.setAttribute("viewBox", `0 ${y0} ${W} ${y1 - y0}`);
    return rows;
  }

  globalThis.ClotrInsights = { adviceFor, connections, drawConnectionMap, kindsText, describe, RISK_WORD };
})();
