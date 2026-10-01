// Clotr — which sites Clotr runs on, and how new AI tools are spotted.
// Shared by background.js (importScripts) and popup.js. Not a content script.
//
// Scope rule: out of the box Clotr runs only on AI chat / AI tool sites. New tools are
// *spotted* automatically, but protecting one always takes a user click plus a
// browser permission prompt for that one site. Email and chat apps work the same
// way (D134): never built in, one site at a time when you switch it on. Never all websites.
(() => {
  "use strict";

  const CONTENT_JS = ["patterns.js", "detector.js", "attachments.js", "ui-styles.js", "editor.js", "content.js"];
  const USER_SCRIPT_ID = "clotr-user-sites";

  // Everyday sites (D134): email and chat apps, where you write to people rather than to an AI. None is built in:
  // Settings lists them, and each runs Clotr only after you switch it on and the browser grants that one site.
  // There, Bandage and the reply check stay off: cover names would reach people, and replies are other people's.
  const EVERYDAY_SITES = [
    { name: "Gmail", kind: "email", matches: ["https://mail.google.com/*"] },
    { name: "Outlook", kind: "email", matches: ["https://outlook.live.com/*", "https://outlook.office.com/*"] },
    { name: "Yahoo Mail", kind: "email", matches: ["https://mail.yahoo.com/*"] },
    { name: "Discord", kind: "chat", matches: ["https://discord.com/*"] },
    { name: "Slack", kind: "chat", matches: ["https://app.slack.com/*"] },
    { name: "WhatsApp", kind: "chat", matches: ["https://web.whatsapp.com/*"] },
    { name: "Messenger", kind: "chat", matches: ["https://www.messenger.com/*"] },
    { name: "Microsoft Teams", kind: "chat", matches: ["https://teams.microsoft.com/*", "https://teams.live.com/*"] },
  ];
  const hostOf = (pattern) => new URL(pattern.replace(/\*$/, "")).hostname;

  function everydaySiteFor(host) {
    return EVERYDAY_SITES.find((s) => s.matches.some((p) => hostOf(p) === host)) || null;
  }

  // Is this a site where you write to people? One from the list, or one you switched on as "not an AI"
  // (storage `siteKinds`: host → "everyday" | "ai"; your choice wins over the list).
  function isEveryday(host, siteKinds = {}) {
    if (!host) return false;
    if (siteKinds[host] === "everyday") return true;
    if (siteKinds[host] === "ai") return false;
    return Boolean(everydaySiteFor(host));
  }

  // Built-in AI sites come straight from the manifest, so there is one list.
  function builtInMatches() {
    return chrome.runtime.getManifest().content_scripts.flatMap((cs) => cs.matches);
  }

  // Converts an extension match pattern like "https://huggingface.co/chat/*" to a RegExp.
  function matchPatternToRegExp(pattern) {
    const m = /^(https?|\*):\/\/([^/]+)(\/.*)$/.exec(pattern);
    if (!m) return null;
    const [, scheme, host, pathPart] = m;
    const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    const hostRe = host === "*" ? "[^/]+" : host.startsWith("*.") ? `([^/]+\\.)?${esc(host.slice(2))}` : esc(host);
    const schemeRe = scheme === "*" ? "https?" : scheme;
    return new RegExp(`^${schemeRe}://${hostRe}${esc(pathPart).replace(/\*/g, ".*")}$`);
  }

  function urlMatchesAny(url, patterns) {
    return patterns.some((p) => matchPatternToRegExp(p)?.test(url));
  }

  function originPattern(hostname) {
    return `https://${hostname}/*`;
  }

  // Hosts where the AI tool is only one part of the site: a built-in entry covers just a
  // section of them (huggingface.co/chat/*). Adding one of their pages must not cover the
  // whole host (bug found 2026-09-24: protecting a Hugging Face page covered all of it).
  function sharedHosts() {
    return new Set(
      builtInMatches()
        .map((p) => /^https:\/\/([^/]+)(\/.*)$/.exec(p))
        .filter((m) => m && m[2] !== "/*")
        .map((m) => m[1]),
    );
  }

  // What "Protect this site" covers for the page at `url`: the whole host for an AI site,
  // or the page's section (up to 3 path parts) on a shared host.
  function protectScope(url) {
    const u = new URL(url);
    if (!sharedHosts().has(u.hostname)) return originPattern(u.hostname);
    const parts = u.pathname.split("/").filter(Boolean).slice(0, 3);
    return parts.length ? `https://${u.hostname}/${parts.join("/")}/*` : `https://${u.hostname}/`;
  }

  // Browser permissions are per host, so the permission is always the whole host; where
  // Clotr actually runs is narrowed by the chosen scopes (storage `siteScopes`).
  function permissionFor(scope) {
    return originPattern(new URL(scope.replace(/\*$/, "")).hostname);
  }

  function isWiderThanNeeded(pattern) {
    const m = /^https:\/\/([^/]+)\/\*$/.exec(pattern);
    return Boolean(m && sharedHosts().has(m[1]));
  }

  // Where Clotr runs for sites the user added: for each granted host (minus the built-in
  // list), the sections they chose, or the whole host for grants made before v0.9.3.
  async function userSitePatterns() {
    const builtIn = new Set(builtInMatches());
    const { origins = [] } = await chrome.permissions.getAll();
    const { siteScopes = {} } = await chrome.storage.local.get("siteScopes");
    return origins
      .filter((o) => !builtIn.has(o) && o !== "https://*/*")
      .flatMap((o) => (siteScopes[o]?.length ? siteScopes[o] : [o]))
      .sort();
  }

  // ---------- Automatic spotting (browser-side, no page access needed) ----------
  // chrome.declarativeContent lets the *browser* check pages against these rules
  // and light up our icon, without Clotr reading or running on the page.
  // A page is "spotted" when its URL has AI wording AND it has a prompt-style input.

  // RE2 syntax (no lookarounds). "ai" must be a whole host label or TLD, so
  // e.g. mail.google.com doesn't count; gpt/llm/copilot/assistant can be anywhere in the host.
  const AI_URL_REGEX = "^https://(([^/]*[.-])?ai([.-][^/]*)?|[^/]*(gpt|llm|copilot|assistant)[^/]*)/";

  // Compound selectors only (declarativeContent limitation). Fragments like
  // "sk " / "essage" cover both "Ask"/"ask" and "Message"/"message".
  const PROMPT_SELECTORS = [
    'textarea[placeholder*="sk "]',
    'textarea[placeholder*="nything"]',
    'textarea[placeholder*="essage"]',
    'textarea[placeholder*="rompt"]',
    'textarea[aria-label*="rompt"]',
    '[contenteditable="true"][aria-label*="rompt"]',
    '[contenteditable="true"][aria-label*="essage"]',
    '[contenteditable="true"][data-placeholder]',
    'div.ProseMirror[contenteditable="true"]',
  ];

  // ---------- On-demand check (popup, via activeTab) ----------
  // Injected into the current tab only when the user opens the popup there.
  // Must be self-contained: it is serialized and run inside the page.
  function inspectPageForAIChat() {
    const AI_WORDS =
      /\b(ai|a\.i\.|gpt|llm|chatbot|copilot|assistant|claude|gemini|mistral|llama|deepseek|perplexity|grok|qwen|kimi|language model)\b/i;
    const host = location.hostname;
    const meta = document.querySelector('meta[name="description"], meta[property="og:description"]')?.content || "";
    const signals = [];

    if (/(^|[.-])ai([.-]|$)|gpt|llm|copilot|assistant/i.test(host)) signals.push("AI wording in the address");
    if (AI_WORDS.test(`${document.title} ${meta}`)) signals.push("AI wording in the page title");

    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 150 && r.height > 16;
    };
    const describe = (el) =>
      [
        el.getAttribute("placeholder"),
        el.getAttribute("aria-label"),
        el.getAttribute("data-placeholder"),
        (el.textContent || "").slice(0, 120),
      ].join(" ");
    const inputs = [...document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""]')].filter(
      visible,
    );
    const promptBox = inputs.some((el) =>
      /ask|message|prompt|anything|question|describe|chat|type/i.test(describe(el)),
    );
    if (promptBox) signals.push("a chat-style prompt box");
    if (
      document.querySelector(
        'button[aria-label*="send" i], button[aria-label*="submit" i], button[data-testid*="send" i]',
      )
    ) {
      signals.push("a send button");
    }

    const aiWording = signals.some((s) => s.startsWith("AI wording"));
    // A prompt box alone could be any messaging app; require AI wording too.
    return { looksLikeAI: promptBox && aiWording, signals };
  }

  // Self-check: what the popup says about a protected tab, from what its content script reported
  // (the background keeps it in session storage). level: on | idle | warn | paused.
  function healthText({ running = false, paused = false, editor = false, editFailed = false, uiRemoved = false } = {}) {
    if (!running)
      return {
        level: "warn",
        key: "hc_notRunning",
        text: "Clotr isn't running in this tab yet. Reload the page to start it.",
      };
    if (paused) return { level: "paused", key: "hc_paused", text: "Paused on this site" };
    if (uiRemoved)
      return {
        level: "warn",
        key: "hc_uiRemoved",
        text: "This page removed Clotr's warnings, so Clotr can't warn you here. Messages are never held on this page.",
      };
    if (editFailed)
      return {
        level: "warn",
        key: "hc_editFailed",
        text: "Clotr couldn't edit the chat box here last time. Delete flagged details by hand before sending.",
      };
    if (editor) return { level: "on", key: "hc_watching", text: "Protecting this site: watching the chat box ✓" };
    return { level: "idle", key: "hc_noBox", text: "Protecting this site: no chat box on this page yet" };
  }

  // ---------- Team policy (managed storage set by an admin; docs/team-rollout.md, D62) ----------
  // Pure functions, so the rules are unit-tested; the background and popup apply them.
  const POLICY_RESPONSES = new Set(["block", "warn", "log"]);

  // Ready-made policies an admin sets with one word (`preset` in managed storage), team-pack
  // design section 3.2. The ids are listed literally (sites.js loads before patterns.js in the
  // worker, D-team-pack item 1): tests/sites.test.js checks them against Clotr.PATTERNS groups
  // as a drift guard, so a new credentials/personal kind is a deliberate choice here, not a miss.
  const PRESETS = {
    // Dev shops: every secret kind must be asked about. Drops the two public-by-design
    // credentials kinds (stripe_publishable_key, internal_ip) to cut noise.
    keys_never: {
      requiredResponses: Object.fromEntries(
        [
          "private_key",
          "aws_access_key",
          "github_token",
          "stripe_secret_key",
          "anthropic_key",
          "openai_key",
          "google_api_key",
          "slack_token",
          "crypto_secret",
          "service_token",
          "connection_string",
          "jwt",
          "internal_ip",
          "internal_host",
          "password",
          "stripe_publishable_key",
        ].map((id) => [id, "block"]),
      ),
      allowPause: false,
    },
    // Law, accounting, agencies: client names (via watchWords) always ask; every personal-detail
    // kind is at least a warn (a floor, so nobody can set their own SSN to "Just count").
    client_names: {
      requiredResponses: {
        watch_list: "block",
        ...Object.fromEntries(
          [
            "us_ssn",
            "credit_card",
            "street_address",
            "bank_account",
            "national_id",
            "medical_record",
            "public_ip",
            "medicare_id",
            "passport",
            "drivers_license",
            "insurance_id",
            "date_of_birth",
            "phone_number",
            "my_name",
            "family_name",
            "employer",
            "my_id",
            "email",
          ].map((id) => [id, "warn"]),
        ),
      },
      allowPause: false,
    },
    // A clinic: patient and staff identifiers must ask. lockSettings is left off on purpose so
    // staff can still add their own names to the vault.
    clinic: {
      requiredResponses: {
        medical_record: "block",
        medicare_id: "block",
        insurance_id: "block",
        us_ssn: "block",
        date_of_birth: "block",
        my_name: "block",
        family_name: "block",
      },
      largeText: true,
      allowPause: false,
    },
  };

  // The admin's raw managed policy plus a chosen preset, explicit fields winning field by field
  // (design 3.2). Guards `__proto__` by hand: bracket-assigning that key to a plain object
  // changes its prototype instead of adding a property.
  function mergePolicy(raw) {
    const policy = raw && typeof raw === "object" ? raw : {};
    const presetId = typeof policy.preset === "string" ? policy.preset : "";
    const preset = Object.hasOwn(PRESETS, presetId) ? PRESETS[presetId] : null;
    const requiredResponses = { ...(preset?.requiredResponses || {}) };
    const explicit = policy.requiredResponses;
    if (explicit && typeof explicit === "object") {
      for (const [id, value] of Object.entries(explicit)) {
        if (id === "__proto__") continue;
        requiredResponses[id] = value;
      }
    }
    const merged = {
      requiredResponses,
      watchWords: [
        ...(Array.isArray(preset?.watchWords) ? preset.watchWords : []),
        ...(Array.isArray(policy.watchWords) ? policy.watchWords : []),
      ],
    };
    for (const key of ["allowPause", "lockSettings", "largeText"]) {
      const value =
        typeof policy[key] === "boolean"
          ? policy[key]
          : preset && typeof preset[key] === "boolean"
            ? preset[key]
            : undefined;
      if (value !== undefined) merged[key] = value;
    }
    if (typeof policy.orgName === "string") merged.orgName = policy.orgName.slice(0, 80);
    if (preset) merged.preset = presetId;
    return merged;
  }

  // Whether a kind is required to be blocked under a merged policy (team-pack item 3): the
  // background uses this to keep an "OK to share" vault entry from silently weakening it, since
  // the floor above only guards the responses map, not the vault's own "allow" override.
  function floorOf(policy, type) {
    return policy && typeof policy.requiredResponses === "object" && policy.requiredResponses?.[type] === "block"
      ? "block"
      : null;
  }

  // The settings in force: the policy's required responses are a floor (D115, changing D62) —
  // the stricter of the user's own choice and the policy wins, so a required "warn" can never
  // downgrade someone's own "block". Bad entries (unknown id, bad value) are ignored.
  function applyPolicy(user = {}, policy = {}) {
    const responses = { ...(user.responses || {}) };
    const required =
      policy && typeof policy.requiredResponses === "object" && policy.requiredResponses
        ? policy.requiredResponses
        : {};
    const C = globalThis.Clotr;
    for (const [id, value] of Object.entries(required)) {
      if (!/^[a-z0-9_]{1,64}$/.test(id) || !POLICY_RESPONSES.has(value)) continue;
      const current = C?.responseFor ? C.responseFor(id, user.responses) : responses[id];
      responses[id] = C?.stricter ? C.stricter(current ?? value, value) : value;
    }
    return {
      responses,
      paused: policy.allowPause === false ? false : Boolean(user.paused),
      largeText: policy.largeText === true || Boolean(user.largeText),
      locked: policy.lockSettings === true,
      pauseAllowed: policy.allowPause !== false,
    };
  }

  // A watched format like "EMP-#####" (# for a digit, @ for a letter): the same rule as
  // vault.js's toShape and cleanVaultEntry (patterns.js), so admin and employee formats
  // behave alike. Formats aren't secret (D-team-pack item 2), so they travel as typed.
  function isShape(p) {
    if (typeof p !== "string") return false;
    const s = p.trim();
    if (!s || s.length > 40) return false;
    const marks = (s.match(/[#@]/g) || []).length;
    return marks >= 4 && !/\d/.test(s);
  }

  // The admin's watch formats (isShape), up to 20, in the order given, duplicates dropped.
  function policyShapes(policy = {}) {
    if (!Array.isArray(policy.watchWords)) return [];
    const out = [];
    for (const w of policy.watchWords) {
      const s = typeof w === "string" ? w.trim() : "";
      if (!isShape(s) || out.includes(s)) continue;
      out.push(s);
      if (out.length >= 20) break;
    }
    return out;
  }

  // The admin's watch words, cleaned: trimmed, lowercased, up to 4 words and 100 characters, 200 at most.
  // A format (isShape) is watched separately (policyShapes), never hashed as a literal phrase.
  function policyWords(policy = {}) {
    if (!Array.isArray(policy.watchWords)) return [];
    const out = [];
    for (const w of policy.watchWords) {
      if (typeof w !== "string" || isShape(w)) continue;
      const phrase = w.trim().toLowerCase().replace(/\s+/g, " ");
      if (!phrase || phrase.length > 100 || phrase.split(" ").length > 4 || out.includes(phrase)) continue;
      out.push(phrase);
      if (out.length >= 200) break;
    }
    return out;
  }

  // Whether the merged policy actually sets anything (mergePolicy always returns an object with
  // an empty requiredResponses/watchWords, so those alone don't count): used to show the popup's
  // banner and the attestation page's "no policy" line (team-pack item 4).
  function hasPolicy(policy) {
    const p = policy && typeof policy === "object" ? policy : {};
    return Boolean(
      (p.requiredResponses && Object.keys(p.requiredResponses).length) ||
      (Array.isArray(p.watchWords) && p.watchWords.length) ||
      typeof p.allowPause === "boolean" ||
      typeof p.lockSettings === "boolean" ||
      typeof p.largeText === "boolean" ||
      typeof p.orgName === "string" ||
      typeof p.preset === "string",
    );
  }

  // A stable short code for one merged, validated policy (design 3.7, the attestation page):
  // a preset and its expanded JSON print the same code, so an admin can compare it with a test
  // machine's page. Unsalted on purpose: it's not a secret (the docs say so). `preset`, `orgName`
  // and the extension version are left out, so it changes only when the policy itself does.
  function policyFingerprint(policy) {
    const p = policy && typeof policy === "object" ? policy : {};
    const required = p.requiredResponses && typeof p.requiredResponses === "object" ? p.requiredResponses : {};
    const r = Object.entries(required)
      .filter(([id, v]) => /^[a-z0-9_]{1,64}$/.test(id) && POLICY_RESPONSES.has(v))
      .sort(([a], [b]) => a.localeCompare(b));
    const canon = JSON.stringify({
      v: 1,
      r,
      w: policyWords(p).slice().sort(),
      s: policyShapes(p)
        .map((x) => x.toLowerCase())
        .sort(),
      p: p.allowPause !== false,
      l: p.lockSettings === true,
      t: p.largeText === true,
    });
    return globalThis.Clotr.sha256(canon).slice(0, 16).toUpperCase();
  }

  globalThis.ClotrSites = {
    healthText,
    PRESETS,
    mergePolicy,
    applyPolicy,
    floorOf,
    isShape,
    policyShapes,
    policyWords,
    policyFingerprint,
    hasPolicy,
    CONTENT_JS,
    USER_SCRIPT_ID,
    EVERYDAY_SITES,
    everydaySiteFor,
    isEveryday,
    AI_URL_REGEX,
    PROMPT_SELECTORS,
    builtInMatches,
    matchPatternToRegExp,
    urlMatchesAny,
    originPattern,
    protectScope,
    permissionFor,
    isWiderThanNeeded,
    userSitePatterns,
    inspectPageForAIChat,
  };
})();
