// Clotr AI Privacy Guard — which sites Clotr runs on, and how new AI tools are spotted.
// Shared by background.js (importScripts) and popup.js. Not a content script.
//
// Scope rule: Clotr only ever runs on AI chat / AI tool sites. New tools are
// *spotted* automatically, but protecting one always takes a user click plus a
// browser permission prompt for that one site. Never all websites.
(() => {
  "use strict";

  const CONTENT_JS = ["patterns.js", "detector.js", "attachments.js", "ui-styles.js", "editor.js", "content.js"];
  const USER_SCRIPT_ID = "clotr-user-sites";

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

  // The settings in force: the policy's required responses win over the user's, bad entries are ignored.
  function applyPolicy(user = {}, policy = {}) {
    const responses = { ...(user.responses || {}) };
    const required =
      policy && typeof policy.requiredResponses === "object" && policy.requiredResponses
        ? policy.requiredResponses
        : {};
    for (const [id, value] of Object.entries(required)) {
      if (/^[a-z0-9_]{1,64}$/.test(id) && POLICY_RESPONSES.has(value)) responses[id] = value;
    }
    return {
      responses,
      paused: policy.allowPause === false ? false : Boolean(user.paused),
      largeText: policy.largeText === true || Boolean(user.largeText),
      locked: policy.lockSettings === true,
      pauseAllowed: policy.allowPause !== false,
    };
  }

  // The admin's watch words, cleaned: trimmed, lowercased, up to 4 words and 100 characters, 200 at most.
  function policyWords(policy = {}) {
    if (!Array.isArray(policy.watchWords)) return [];
    const out = [];
    for (const w of policy.watchWords) {
      if (typeof w !== "string") continue;
      const phrase = w.trim().toLowerCase().replace(/\s+/g, " ");
      if (!phrase || phrase.length > 100 || phrase.split(" ").length > 4 || out.includes(phrase)) continue;
      out.push(phrase);
      if (out.length >= 200) break;
    }
    return out;
  }

  globalThis.ClotrSites = {
    healthText,
    applyPolicy,
    policyWords,
    CONTENT_JS,
    USER_SCRIPT_ID,
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
