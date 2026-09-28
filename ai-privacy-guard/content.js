// Clotr AI Privacy Guard — content script.
//
// Watches AI chat inputs and scans their text locally against Clotr.PATTERNS.
// What happens on a detection depends on the pattern's response (patterns.js):
// block → a modal dialog the user must answer (Hide it / Leave it in), sending
// waits; warn → a corner notice that doesn't block; log → counted quietly; off → ignored.
// Nothing leaves the browser: no network calls. Settings and event metadata
// (never the detected values) are kept in chrome.storage.local.
(() => {
  "use strict";

  const LOG = "[Clotr]";

  // Already running here (e.g. injected into an open tab right after the user added this site).
  if (globalThis.__clotrActive) return;
  globalThis.__clotrActive = true;

  const { detect, redact, responseFor, fingerprint, setVault, readAttachment, msg } = globalThis.Clotr;
  const { realTarget, findEditor, getText, replaceText } = globalThis.Clotr.editor;
  const IS_TOP = window === window.top;

  console.info(LOG, "active on", location.href, IS_TOP ? "(top frame)" : "(iframe)");

  // ---------- Fail open (D30) ----------
  // After an update reload, this page's copy of Clotr keeps running but is orphaned:
  // every extension call throws "Extension context invalidated". Extension calls go
  // through these helpers so they can never throw into the chat or Clotr's own UI.
  function message(msg) {
    try {
      return chrome.runtime.sendMessage(msg);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  function orphaned() {
    try {
      return !chrome.runtime?.id;
    } catch {
      return true;
    }
  }

  // An orphaned copy keeps protecting with the settings it last knew, but only warns:
  // it never holds a message and records nothing (D37). Reloading the page brings in
  // the new version.
  let orphanLogged = false;
  function noteOrphaned() {
    if (!orphanLogged)
      console.info(LOG, "Clotr was updated; this page keeps warning with the old copy until it's reloaded");
    orphanLogged = true;
  }

  // Seamless updates (D39): after an update the background starts the new version in open
  // tabs. The new copy runs in a fresh script world, so it announces itself with a page
  // event; an orphaned older copy hears it and steps aside. A page faking the event can't
  // switch off a working copy: only an orphaned one listens to it.
  let retired = false;
  document.addEventListener("clotr:hello", () => {
    if (!retired && orphaned()) retire();
  });
  document.dispatchEvent(new CustomEvent("clotr:hello"));

  function retire() {
    retired = true;
    clearTimeout(scanTimer);
    clearTimeout(offerTimer);
    closeDialog();
    closeNotice();
    closeReloadPrompt();
    console.info(LOG, "the updated Clotr took over this page");
  }

  // Lets the toolbar show the protected icon + today's count for this tab.
  function reportTabState() {
    if (!IS_TOP) return;
    message({ type: "clotr:tabState", paused: isPaused() }).catch((err) =>
      console.warn(LOG, "could not update toolbar", err),
    );
  }

  // ---------- Self-check: does Clotr see the chat box here, and did its last edit work? ----------
  // Reported to the background (per tab, any frame), which the popup and toolbar read.
  const health = { editor: false, editFailed: false, uiRemoved: false };

  // Clotr's own boxes (dialog, notice, reload prompt) sit directly under <html>. If one vanishes
  // without Clotr removing it, the page is removing Clotr's warnings (hostile, or a framework
  // rebuilding the page): stop holding messages there so nobody is stuck (D30, HP1) and say so.
  const ownRemovals = new WeakMap(); // node → removals by Clotr not yet seen by the observer
  const CLOTR_HOSTS = new Set(["CLOTR-GUARD", "CLOTR-NOTICE", "CLOTR-RELOAD"]);
  function removeOwn(node) {
    if (!node?.isConnected) return;
    ownRemovals.set(node, (ownRemovals.get(node) || 0) + 1);
    node.remove();
  }
  new MutationObserver((records) => {
    for (const r of records) {
      for (const node of r.removedNodes) {
        if (!CLOTR_HOSTS.has(node.nodeName)) continue;
        const mine = ownRemovals.get(node) || 0;
        if (mine) {
          ownRemovals.set(node, mine - 1);
          continue;
        }
        if (!health.uiRemoved && !retired) {
          console.info(LOG, "this page removed Clotr's warning; messages won't be held here");
          reportHealth({ uiRemoved: true });
        }
        // The dialog had the keyboard: give it back to the chat box so the user can carry on.
        if (node.nodeName === "CLOTR-GUARD" && activeEditor?.isConnected) activeEditor.focus();
      }
    }
  }).observe(document.documentElement || document, { childList: true });
  function reportHealth(change) {
    Object.assign(health, change);
    message({ type: "clotr:health", ...change }).catch(() => {}); // orphaned copy: nothing to report
  }
  function noteEditor() {
    if (!health.editor) reportHealth({ editor: true });
  }
  // A chat box on the page (textarea or rich editor, also inside open shadow roots), without
  // waiting for the user to type. Checked for a while after load; focus and typing catch the rest.
  function findChatBox(root = document, depth = 0) {
    for (const node of root.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""]')) {
      if (node.getClientRects().length && findEditor(node)) return true;
    }
    if (depth > 2) return false;
    for (const node of root.querySelectorAll("*")) {
      if (node.shadowRoot && findChatBox(node.shadowRoot, depth + 1)) return true;
    }
    return false;
  }
  let chatBoxChecks = 0;
  function lookForChatBox() {
    if (health.editor || retired) return;
    try {
      if (document.documentElement && findChatBox()) return noteEditor();
    } catch {
      /* never let the self-check break the page */
    }
    if (++chatBoxChecks < 15) setTimeout(lookForChatBox, 2000);
  }
  setTimeout(lookForChatBox, 500);
  window.addEventListener(
    "focusin",
    safely((e) => {
      if (!health.editor && findEditor(realTarget(e))) noteEditor();
    }),
    true,
  );

  // Send buttons on ChatGPT, Claude/Gemini and NotebookLM respectively, plus generic forms.
  const SEND_BUTTON_SELECTOR = [
    'button[data-testid="send-button"]',
    'button[aria-label*="send" i]',
    'button[aria-label*="submit" i]',
    'form button[type="submit"]',
  ].join(",");

  const SCAN_DELAY_MS = 400; // wait for typing to pause so half-typed keys don't trigger

  // Did the person do this (S24)? A page could otherwise put guesses in its own chat box by script,
  // fire a fake input or Enter, and watch whether Clotr's warning appears: that would tell it which
  // names or numbers are in your vault. Events a script makes right after a real key or click (sites
  // re-dispatch them) still count; where the browser can't tell, Clotr reacts as before.
  const byUser = (e) => e.isTrusted || navigator.userActivation?.isActive !== false;

  // ---------- Per-pattern responses (set in the popup, or "stop warning me about this kind" = log) ----------

  let responses = {}; // overrides only: { [patternId]: "block" | "warn" | "log" }

  // Per-site mode (popup → per-site view): "block" = stricter here, "log" = quieter here.
  let siteMode = null; // this site's mode, or null
  const responseOf = (patternId) => {
    const r = responseFor(patternId, responses);
    return siteMode || r;
  };

  function setToLog(patternIds) {
    setResponse(patternIds, "log");
    console.info(LOG, "won't warn again for", patternIds);
  }

  function setResponse(patternIds, value) {
    responses = { ...responses };
    for (const id of patternIds) responses[id] = value;
    try {
      message({ type: "clotr:setResponses", ids: patternIds, value }).catch((err) =>
        console.warn(LOG, "could not save preference", err),
      );
    } catch (err) {
      console.warn(LOG, "could not save preference", err);
    }
  }

  // ---------- Pause per site (toggled from the popup) ----------

  let paused = {};

  function isPaused() {
    return Boolean(paused[location.hostname]);
  }

  // ---------- Your vault (fingerprints only; see patterns.js setVault) ----------
  // Value entries (phone, email, address, …) mark something the regular patterns find as
  // yours: "protect" = always at least warn, even if that type is set to Log only;
  // "allow" = OK to share: never warns, still recorded (as "Just counted") like everything else. Words and ID formats are matched in patterns.js.

  let vaultEntries = [];
  const vaultCache = new Map(); // "type\0match" → "protect" | "allow" | null, hashed once per page

  function applyVault() {
    vaultCache.clear();
    setVault({ salt: saltValue, entries: vaultEntries });
  }

  function vaultMode(patternId, match) {
    if (!saltValue || !vaultEntries.some((e) => e.kind === "value")) return null;
    const key = `${patternId}\0${match}`;
    if (!vaultCache.has(key)) {
      if (vaultCache.size >= 2000) vaultCache.clear(); // a tab left open all day stays small
      const entry = (id) => {
        const fp = fingerprint(saltValue, id, match);
        return vaultEntries.find((e) => e.kind === "value" && e.type === patternId && e.fp === fp);
      };
      // An address saved before 0.9.68 kept its accents in the fingerprint: it still matches as typed.
      const found =
        entry(patternId) ||
        (patternId === "street_address" && /[^\x00-\x7f]/.test(match) && entry("street_address_accented"));
      vaultCache.set(key, found?.mode || null);
    }
    return vaultCache.get(key);
  }

  // With a fingerprint of your own ID in the vault (D23), IDs that only share its format are
  // named apart ("Account/ID Number") and ranked lower than yours ("Your Account/ID Number").
  function splitOwnIds(results) {
    if (!saltValue || !vaultEntries.some((e) => e.kind === "value" && e.type === "my_id")) return results;
    return results.flatMap((r) => {
      if (r.id !== "my_id") return [r];
      const own = r.matches.filter((m) => vaultMode("my_id", m));
      const other = r.matches.filter((m) => !vaultMode("my_id", m));
      return [
        ...(own.length ? [{ ...r, matches: own }] : []),
        ...(other.length
          ? [{ ...r, matches: other, name: msg("otherAccountId", "Account/ID Number"), severity: "medium" }]
          : []),
      ];
    });
  }

  // The response for one detected value: the type's response, adjusted by the vault.
  function respFor(r, m) {
    const mode = vaultMode(r.id, m);
    if (mode === "allow") return "log";
    const base = responseOf(r.id);
    return mode === "protect" && base === "log" ? "warn" : base;
  }

  // First-time tips (D21, D43): kinds of data the user has already been guided about.
  let guided = {};
  // Helping someone (settings → "Larger warnings"): bigger text and buttons in Clotr's boxes.
  let largeText = false;
  const sized = (cls) => (largeText ? `${cls} large` : cls);

  // Settings come from the background (storage is locked to Clotr's own pages, S20): only what
  // this frame needs, its own site's pause and mode included. Fetched at start, when the background
  // says something changed, and when the tab is shown again.
  let settingsLoaded = false;
  function loadSettings() {
    return message({ type: "clotr:getSettings" })
      .then((r) => {
        if (!r || r.error) throw new Error(r?.error || "no settings");
        const wasPaused = isPaused();
        guided = r.guided || {};
        largeText = r.largeText === true;
        responses = r.responses || {};
        siteMode = r.siteMode || null;
        vaultEntries = Array.isArray(r.vault) ? r.vault : [];
        applyVault();
        paused = r.paused ? { [location.hostname]: true } : {};
        if (!settingsLoaded) {
          settingsLoaded = true;
          console.info(LOG, "responses:", JSON.stringify(responses), isPaused() ? "(paused on this site)" : "");
          return;
        }
        if (wasPaused === isPaused()) return;
        console.info(LOG, isPaused() ? "paused on this site" : "resumed on this site");
        reportTabState();
        if (isPaused()) {
          closeDialog();
          closeNotice();
          pending = [];
          warnings = [];
          fileWarnings = [];
        }
      })
      .catch((err) => console.warn(LOG, "could not load preferences", err));
  }
  loadSettings().finally(reportTabState);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !retired) loadSettings();
  });

  // ---------- Event reporting (metadata only) ----------

  // Salted SHA-256 of the normalized value, computed here so the raw value never leaves
  // this script. Lets the popup spot "same secret pasted again" without storing it.
  let saltPromise = null;
  let saltValue = null; // set once loaded, for the synchronous "It's me" check
  function getSalt() {
    saltPromise ??= message({ type: "clotr:getSalt" })
      .then((r) => {
        if (!r?.salt) throw new Error(r?.error || "no salt");
        saltValue = r.salt;
        applyVault();
        return r.salt;
      })
      .catch((err) => {
        saltPromise = null; // retry next time
        throw err;
      });
    return saltPromise;
  }

  getSalt().catch((err) => console.warn(LOG, "could not load salt", err));

  // One event per detected value.
  async function report(results, action) {
    if (orphaned()) return; // nothing can be recorded after an update (D37)
    try {
      const t = Date.now();
      const salt = await getSalt();
      const events = [];
      for (const r of results) {
        for (const m of r.matches) {
          events.push({
            t,
            site: location.hostname,
            type: r.id,
            name: r.name,
            severity: r.severity,
            action,
            fp: fingerprint(salt, r.id, m),
          });
        }
      }
      if (events.length) await message({ type: "clotr:events", events });
    } catch (err) {
      console.warn(LOG, "could not record event", err);
    }
  }

  // ---------- State ----------

  // Both last for the message being written (DECISIONS D3): once it's sent or the box is
  // emptied, the next message warns (and logs) again like normal.
  const allowedValues = new Set(); // values the user kept ("Leave it in" in the dialog or notice) in this message
  const loggedSilenced = new Set(); // log-only values already recorded for this message
  function newMessage() {
    backToEdit = false;
    allowedValues.clear();
    loggedSilenced.clear();
  }
  let activeEditor = null; // the chat input the user last typed in
  let pending = []; // "block" detections the user hasn't answered yet
  let warnings = []; // "warn" detections shown in the notice, not yet answered
  let fileWarnings = []; // detections in attached files, not yet acknowledged
  const flagged = new Map(); // value → { id, name }: shown to the user and still in the text
  const offered = new Set(); // values already offered for the vault on this page
  let noticeKind = null; // what the corner notice shows: "warn" | "file" | "offer"
  let noticeOpenedAt = 0; // when the current warning first appeared (fast-send check, D52)
  // Types that come from the vault itself (nothing to learn there).
  const VAULT_TYPES = new Set(["my_name", "family_name", "employer", "my_id", "watch_list"]);
  let scanTimer = null;
  let backToEdit = false; // the user went back to the message from the dialog: don't reopen it until they send

  // ---------- Detection ----------

  // Keeps only the matches in `results` that pass `keep`, dropping empty results.
  function filterMatches(results, keep) {
    return results.map((r) => ({ ...r, matches: r.matches.filter((m) => keep(r, m)) })).filter((r) => r.matches.length);
  }

  // Never echo a full secret back into the page.
  function mask(value) {
    if (value.length <= 8) return "•".repeat(value.length);
    return `${value.slice(0, 4)}…${value.slice(-2)}`;
  }

  // ---------- Editor helpers (editor.js) ----------

  // Replaces the chat box's text; true only if it really changed. Clotr's own edit isn't
  // something to rescan, and nothing in it was removed by hand.
  async function setText(editor, text) {
    try {
      return await replaceText(editor, text);
    } finally {
      clearTimeout(scanTimer);
      flagged.clear();
    }
  }

  // Hide the found items in the chat box. Counted as hidden only once the text really
  // changed; otherwise say so plainly, so nobody sends a key they think is gone (Kimi, M2).
  async function coverIn(editor, results) {
    const ok = Boolean(editor) && (await setText(editor, redact(getText(editor), results)));
    if (ok) {
      report(results, "redacted");
      if (health.editFailed) reportHealth({ editFailed: false });
      return;
    }
    reportHealth({ editFailed: true });
    const names = [...new Set(results.map((r) => r.name))].join(", ");
    showOffer({
      title: msg("coverFailTitle", "⚠️ Clotr couldn't hide it here"),
      text: msg(
        "coverFailText",
        "This chat box didn't accept Clotr's edit, so your message still contains: $1. Please delete it by hand before you send.",
        names,
      ),
      yes: msg("coverFailOk", "OK, I'll delete it"),
      no: null,
    });
  }

  // ---------- Dialog (closed shadow DOM so site CSS/scripts can't interfere) ----------
  // Built with DOM APIs only: Google sites enforce Trusted Types, which rejects innerHTML.

  let host = null;
  let shadow = null;

  const DIALOG_CSS = globalThis.Clotr.styles.dialog;

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    node.append(...children);
    return node;
  }

  function isDialogOpen() {
    return Boolean(host && host.isConnected);
  }

  // ---------- Bulk pastes: summarize instead of listing every value ----------

  const BULK_ITEMS = 6; // more values than this → counts per type, no values
  const BULK_LINES = 20; // this many lines → mention the size

  const totalMatches = (results) => results.reduce((n, r) => n + r.matches.length, 0);

  // "Large paste: 400 lines, with Email Address ×37, Phone Number ×12." or null.
  function bulkSummary(results, file = null) {
    const lines = file ? file.lines : activeEditor ? getText(activeEditor).split("\n").length : 0;
    if (!file && totalMatches(results) <= BULK_ITEMS && lines < BULK_LINES) return null;
    const counts = results.map((r) => `${r.name} ×${r.matches.length}`).join(", ");
    if (file?.count > 1)
      return msg("bulkFiles", "$1 files you attached ($2) contain $3.", file.count, file.name, counts);
    if (file)
      return msg(
        "bulkFile",
        "The file “$1” you attached ($2) contains $3.",
        file.name,
        lines === 1 ? msg("linesOne", "1 line") : msg("linesMany", "$1 lines", lines),
        counts,
      );
    return lines >= BULK_LINES
      ? msg("bulkPaste", "Large paste: $1 lines, with $2.", lines, counts)
      : msg("bulkMessage", "This message has $1.", counts);
  }

  // One line per type; with many values, a count and a couple of masked examples.
  function describeValues(r) {
    const shown = r.matches.slice(0, 3).map(mask).join(", ");
    return r.matches.length > 3 ? `×${r.matches.length}: ${shown}, …` : shown;
  }

  // ---------- The choices, in plain words (D40) ----------
  // Every warning offers: this time only (Hide it / Leave it in), and from now on, for this
  // item (vault fingerprint: "fine to share" or "always watch") or for this kind of data.

  const kindsOf = (results) => [...new Set(results.map((r) => r.name))].join(", ");

  function addToVault(results, mode) {
    const entries = results.flatMap((r) =>
      r.matches.map((m) => ({
        kind: "value",
        type: r.id,
        fp: fingerprint(saltValue, r.id, m),
        mode,
        added: Date.now(),
      })),
    );
    message({ type: "clotr:vaultAdd", entries }).catch((err) => console.warn(LOG, "could not add to vault", err));
  }

  // "More choices": each one is today's answer plus a lasting one. `cover` is null for a file.
  function moreChoices(results, { leave, cover }) {
    const perItem =
      !orphaned() && saltValue && totalMatches(results) <= BULK_ITEMS && !results.some((r) => VAULT_TYPES.has(r.id));
    const one = totalMatches(results) === 1;
    const choice = (text, fn) => {
      const b = el("button", { className: "choice", textContent: text });
      b.addEventListener("click", fn);
      return b;
    };
    const buttons = [
      ...(perItem
        ? [
            choice(
              one
                ? msg("choiceAllowOne", "Leave it in, and don't warn me about this one again")
                : msg("choiceAllowMany", "Leave it in, and don't warn me about these again"),
              () => {
                addToVault(results, "allow");
                leave();
              },
            ),
          ]
        : []),
      choice(msg("choiceLogKinds", "Leave it in, and stop warning me about: $1", kindsOf(results)), () => {
        setToLog(results.map((r) => r.id));
        leave();
      }),
      ...(perItem && cover
        ? [
            choice(
              one
                ? msg("choiceProtectOne", "Hide it, and always watch for this one, however it's written")
                : msg("choiceProtectMany", "Hide them, and always watch for these, however they're written"),
              () => {
                addToVault(results, "protect");
                cover();
              },
            ),
          ]
        : []),
    ];
    return el("details", { className: "more" }, [
      el("summary", { textContent: msg("moreChoices", "More choices") }),
      el("div", { className: "choices" }, buttons),
    ]);
  }

  function showDialog(results) {
    if (!host) {
      host = document.createElement("clotr-guard");
      shadow = host.attachShadow({ mode: "closed" });
    }

    const items = results.map((r) =>
      el("li", {}, [
        el("span", { className: `sev ${r.severity}`, textContent: msg(`sev_${r.severity}`, r.severity) }),
        `${r.name}: `,
        el("code", { textContent: describeValues(r) }),
      ]),
    );
    const bulk = bulkSummary(results);

    const redactBtn = el("button", { className: "primary", textContent: msg("coverIt", "Hide it") });
    const allowBtn = el("button", { textContent: msg("leaveIt", "Leave it in") });
    const backBtn = el("button", {
      className: "link",
      textContent: msg("backToMessage", "Go back to my message (Esc)"),
    });

    const box = el("div", { className: sized("box"), tabIndex: -1 }, [
      el("h2", { textContent: msg("dialogTitle", "⚠️ This looks private") }),
      el("p", { textContent: msg("dialogLead", "If you send this, the AI service will see:") }),
      ...(bulk ? [el("p", { className: "bulk", textContent: bulk })] : []),
      el("ul", {}, items),
      el("div", {
        className: "note",
        textContent: msg(
          "dialogNote",
          "Clotr checked this on your computer. Nothing has been sent yet. Hide it swaps it for a label like $1.",
          `[REDACTED ${results[0].name.toUpperCase()}]`,
        ),
      }),
      el("div", { className: "actions" }, [allowBtn, redactBtn]),
      moreChoices(results, { leave: () => answer(false), cover: () => answer(true) }),
      el("div", { className: "keys" }, [el("span", { textContent: msg("enterCovers", "Enter: Hide it") }), backBtn]),
    ]);
    box.setAttribute("role", "alertdialog");
    box.setAttribute("aria-modal", "true");

    // Back to the message without choosing (D41): the dialog comes back when you send.
    const back = () => {
      closeDialog();
      backToEdit = true;
      activeEditor?.focus();
    };
    backBtn.addEventListener("click", back);
    box.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" && e.key !== "Backspace") return;
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
      e.preventDefault();
      e.stopPropagation();
      back();
    });

    const answer = (doRedact) => {
      if (doRedact) {
        closeDialog();
        closeNotice();
        flagged.clear(); // removed by Clotr, not by hand: nothing to learn
        coverIn(activeEditor, results);
      } else {
        report(results, "allowed");
        for (const r of results) for (const m of r.matches) allowedValues.add(m);
        closeDialog();
        closeNotice();
        activeEditor?.focus();
        noteIgnored(results);
      }
      console.info(
        LOG,
        doRedact ? "user redacted" : "user allowed once",
        results.map((r) => r.id),
      );
      pending = [];
      warnings = [];
    };
    redactBtn.addEventListener("click", () => answer(true));
    allowBtn.addEventListener("click", () => answer(false));

    const overlay = el("div", { className: "overlay" }, [box]);
    // Clicking outside doesn't dismiss: the user has to choose.
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) shakeDialog();
    });

    guardKeys(box, { enter: redactBtn });
    shadow.replaceChildren(el("style", { textContent: DIALOG_CSS }), overlay);
    if (!host.isConnected) document.documentElement.append(host);
    // Pull focus out of the chat box so further typing/Enter can't slip through.
    box.focus();
  }

  // Keys typed by habit never make a choice (user, 2026-09-24, DECISIONS D36): Space never
  // presses a button or ticks a box in Clotr's UI, and Enter does nothing in the first moment
  // after the UI appears (or while held down). After that, Enter presses the button the user
  // moved to with Tab, or else `enter`: the forward choice (D41). Mouse clicks always work.
  const KEY_GRACE_MS = 600;
  function guardKeys(container, { enter = null } = {}) {
    const shownAt = Date.now();
    let tabbed = false;
    let deliberate = false; // reached with Clotr's keyboard shortcut
    const stop = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    container.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Tab") {
          tabbed = true;
          return;
        }
        if ((e.key === " " || e.key === "Spacebar") && !deliberate) return stop(e);
        if (e.key !== "Enter") return;
        if (e.repeat || (!deliberate && Date.now() - shownAt < KEY_GRACE_MS)) return stop(e);
        const focused = container.getRootNode().activeElement;
        const control = focused instanceof HTMLButtonElement || focused?.tagName === "SUMMARY";
        if (control && focused !== enter && (tabbed || deliberate)) return; // presses (or opens) what the user moved to
        stop(e);
        if (enter) enter.click();
      },
      true,
    );
    container.addEventListener(
      "keyup",
      (e) => {
        if ((e.key === " " || e.key === "Spacebar") && !deliberate) stop(e);
      },
      true,
    );
    return () => {
      deliberate = true;
    }; // reaching a button with the keyboard shortcut is a deliberate choice
  }

  function closeDialog() {
    removeOwn(host);
  }

  // ---------- Warn notice (doesn't block, doesn't take focus) ----------

  let noticeHost = null;
  let noticeShadow = null;
  let noticeFocus = null; // () => focuses the notice's main button (keyboard shortcut Alt+Shift+C)
  const SHORTCUT_HINT = msg(
    "keyboardHint",
    "Keyboard: Alt+Shift+C jumps here, Enter chooses, Esc goes back to your message.",
  );

  // Keyboard users reach the notice with Clotr's shortcut; Esc returns to the chat box.
  function keyboardReach(box, main) {
    const arm = guardKeys(box, { enter: main });
    box.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" && e.key !== "Backspace") return;
      e.preventDefault();
      e.stopPropagation();
      activeEditor?.focus();
    });
    box.append(el("p", { className: "sr-only", textContent: SHORTCUT_HINT }));
    noticeFocus = () => {
      arm();
      main.focus();
    };
  }

  const NOTICE_CSS = globalThis.Clotr.styles.notice;

  function isNoticeOpen() {
    return Boolean(noticeHost && noticeHost.isConnected);
  }

  // ---------- "Why am I seeing this?" and first-time tips (D21, D43) ----------

  let whyOpen = false;
  let tip = null; // the first-time tip in the current notice: { id, name, match, single, status }
  const YOURS = new Set(["phone_number", "email", "street_address"]); // kinds of data that can be "mine"
  const REPORT_URL = "https://github.com/BilliamBaSH/clotr-ai-privacy-guard/issues/new";
  const aName = (name) => `${/^[AEIOU]/i.test(name) ? "an" : "a"} ${name}`; // "an Email Address"

  // Kinds a fake bank or "support" call asks for (codes, passwords, cards): the plain truth, once.
  const SCAM_TARGETS = new Set(["password", "credit_card", "us_ssn", "bank_account"]);
  const scamLine = (results) =>
    results.some((r) => SCAM_TARGETS.has(r.id))
      ? msg("whyScam", "No real bank, company or support line will ever ask you to share this. ")
      : "";

  function whyText(results, file) {
    const names = [...new Set(results.map((r) => r.name))].join(", ");
    if (file?.count > 1)
      return (
        msg("whyFoundFiles", "Clotr found what looks like: $1, in the files $2. ", names, file.name) +
        scamLine(results) +
        msg(
          "whyBody",
          "What you send to an AI service can be kept on its servers, read by its staff or used to train it. Nothing has left your computer yet. You decide: hide it, leave it in, or pick how Clotr treats it from now on (More choices).",
        )
      );
    return (
      (file
        ? msg("whyFoundFile", "Clotr found what looks like: $1, in the file “$2”. ", names, file.name)
        : msg("whyFound", "Clotr found what looks like: $1. ", names)) +
      scamLine(results) +
      msg(
        "whyBody",
        "What you send to an AI service can be kept on its servers, read by its staff or used to train it. Nothing has left your computer yet. You decide: hide it, leave it in, or pick how Clotr treats it from now on (More choices).",
      )
    );
  }

  // The first time Clotr warns about a kind of data, it asks how to treat it from now on,
  // and for your own kinds of data whether this one is yours. Shown once per kind; kept
  // while the notice is open (it's rebuilt on every pause in typing).
  function firstTimeTip(results) {
    if (orphaned()) return null;
    if (!tip || !results.some((r) => r.id === tip.id)) {
      const fresh = results.find((r) => !guided[r.id] && !VAULT_TYPES.has(r.id));
      if (!fresh) {
        tip = null;
        return null;
      }
      tip = { id: fresh.id, name: fresh.name, match: fresh.matches[0], single: fresh.matches.length === 1, status: "" };
      guided = { ...guided, [fresh.id]: Date.now() };
      message({ type: "clotr:guided", id: fresh.id }).catch(() => {});
    }
    const t = tip;
    const boxEl = el("div", { className: "tip" });
    const done = (text) => {
      t.status = text;
      boxEl.replaceChildren(el("p", { textContent: text }));
    };
    if (t.status) {
      done(t.status);
      return boxEl;
    }
    const current = responseOf(t.id);
    const choice = (value, label, after) => {
      const b = el("button", { className: value === current ? "chosen" : "", textContent: label });
      b.setAttribute("aria-pressed", String(value === current));
      b.addEventListener("click", () => {
        setResponse([t.id], value);
        done(after);
      });
      return b;
    };
    const parts = [
      el("p", {}, [
        el("b", { textContent: msg("tipNew", "New: ") }),
        msg("tipHow", "How should Clotr treat $1 from now on?", aName(t.name), t.name),
      ]),
      el("div", { className: "choices" }, [
        choice(
          "warn",
          msg("tipWarn", "Warn me"),
          msg("tipWarnDone", "OK: Clotr will keep warning you about $1.", aName(t.name), t.name),
        ),
        choice(
          "log",
          msg("tipLog", "Just count it"),
          msg(
            "tipLogDone",
            "OK: Clotr will just count $1, without a notice. Change it any time in Settings.",
            aName(t.name),
            t.name,
          ),
        ),
        choice(
          "block",
          msg("tipBlock", "Ask before sending"),
          msg(
            "tipBlockDone",
            "OK: Clotr will ask before sending $1. Change it any time in Settings.",
            aName(t.name),
            t.name,
          ),
        ),
      ]),
    ];
    if (YOURS.has(t.id) && t.single && saltValue) {
      const vault = (mode, after) => () => {
        message({
          type: "clotr:vaultAdd",
          entries: [{ kind: "value", type: t.id, fp: fingerprint(saltValue, t.id, t.match), mode, added: Date.now() }],
        }).catch((err) => console.warn(LOG, "could not add to vault", err));
        done(after);
      };
      const mine = el("button", { textContent: msg("tipMine", "Always watch it") });
      mine.addEventListener(
        "click",
        vault(
          "protect",
          msg("tipMineDone", "Saved to your vault: Clotr will always watch for this $1, however it's written.", t.name),
        ),
      );
      const share = el("button", { textContent: msg("tipShare", "It's fine to share") });
      share.addEventListener(
        "click",
        vault("allow", msg("tipShareDone", "Saved: this $1 is fine to share; Clotr will only count it.", t.name)),
      );
      parts.push(
        el("p", { textContent: msg("tipYours", "Is this $1 yours?", t.name) }),
        el("div", { className: "choices" }, [mine, share]),
      );
    }
    boxEl.replaceChildren(...parts);
    return boxEl;
  }

  // `file` = { name, lines } for an attached file: it can't be redacted, only removed by the user.
  function showNotice(results, file = null) {
    if (!noticeHost) {
      noticeHost = document.createElement("clotr-notice");
      noticeShadow = noticeHost.attachShadow({ mode: "closed" });
    }
    const bulk = bulkSummary(results, file);
    // One <code> per item: an item never breaks, but the line wraps between items
    // instead of running past the notice's edge.
    const what = bulk
      ? []
      : results
          .flatMap((r) => r.matches.map((m) => `${r.name} (${mask(m)})`))
          .flatMap((item, i) => [...(i ? [", "] : []), el("code", { textContent: item })]);
    const redactBtn = el("button", { className: "primary", textContent: msg("coverIt", "Hide it") });
    const keepBtn = el("button", { textContent: file ? msg("ok", "OK") : msg("leaveIt", "Leave it in") });
    const whyBtn = el("button", { className: "link", textContent: msg("why", "Why am I seeing this?") });
    whyBtn.setAttribute("aria-expanded", String(whyOpen));
    // "Wrong?" opens a prefilled GitHub issue with only the kind of data: never the value or
    // the site. It's a page the user chooses to open; Clotr itself sends nothing.
    const reportBtn = el("button", {
      className: "link",
      textContent: msg("reportFalseAlarm", "Wrong? Report a false alarm"),
    });
    reportBtn.addEventListener("click", () => {
      const kinds = [...new Set(results.map((r) => r.name))].join(", ");
      const url = `${REPORT_URL}?template=false-alarm.yml&title=${encodeURIComponent(`False alarm: ${kinds}`)}&kind=${encodeURIComponent(kinds)}`;
      window.open(url, "_blank", "noopener");
    });
    const why = el("div", { className: "why", hidden: !whyOpen }, [
      el("p", { textContent: whyText(results, file) }),
      reportBtn,
    ]);
    whyBtn.addEventListener("click", () => {
      whyOpen = !whyOpen;
      why.hidden = !whyOpen;
      whyBtn.setAttribute("aria-expanded", String(whyOpen));
    });
    const tipBox = !file && !bulk ? firstTimeTip(results) : null;
    const box = el("div", { className: sized("notice") }, [
      el("b", { textContent: msg("noticeTitle", "⚠️ Heads up") }),
      el(
        "p",
        {},
        bulk
          ? [bulk, msg("noticeSharedBulk", " It will be shared with this AI if you send it.")]
          : [
              msg("noticeContains", "Your message contains "),
              ...what,
              msg("noticeShared", ". It will be shared with this AI if you send it."),
            ],
      ),
      ...(file
        ? [
            el("p", {
              className: "hint",
              textContent:
                file.count > 1
                  ? msg("noticeFilesHint", "To keep them private, remove those files before sending.")
                  : msg("noticeFileHint", "To keep it private, remove the file before sending."),
            }),
          ]
        : []),
      ...(orphaned()
        ? [
            el("p", {
              className: "hint",
              textContent: msg("noticeUpdated", "Clotr was just updated. Reload this page so your choices are saved."),
            }),
          ]
        : []),
      el("div", { className: "actions" }, file ? [keepBtn] : [keepBtn, redactBtn]),
      moreChoices(results, { leave: () => keep(), cover: file ? null : () => cover() }),
      whyBtn,
      why,
      ...(tipBox ? [tipBox] : []),
    ]);
    box.setAttribute("role", "status");
    box.setAttribute("aria-live", "polite");

    function cover() {
      closeNotice();
      flagged.clear();
      coverIn(activeEditor, results);
      warnings = [];
      console.info(
        LOG,
        "user hid it (notice)",
        results.map((r) => r.id),
      );
    }
    function keep() {
      allowWarnings();
      activeEditor?.focus();
      noteIgnored(results);
    }
    redactBtn.addEventListener("click", cover);
    keepBtn.addEventListener("click", keep);

    keyboardReach(box, file ? keepBtn : redactBtn);
    if (!isNoticeOpen() || noticeKind !== (file ? "file" : "warn")) noticeOpenedAt = Date.now();
    noticeKind = file ? "file" : "warn";
    noticeShadow.replaceChildren(el("style", { textContent: NOTICE_CSS }), box);
    if (!noticeHost.isConnected) document.documentElement.append(noticeHost);
  }

  // ---------- "Clotr was updated: reload this page" (D37) ----------
  // Shown by an orphaned copy that no updated copy replaced. The page is greyed out until
  // the user answers; "Later" keeps the old copy warning (never holding a message).

  let reloadHost = null;
  let reloadAsked = false;
  const RELOAD_CSS = globalThis.Clotr.styles.reload;

  function showReloadPrompt() {
    if (reloadAsked || retired || !IS_TOP) return;
    reloadAsked = true;
    reloadHost = document.createElement("clotr-reload");
    const root = reloadHost.attachShadow({ mode: "closed" });
    const draft = activeEditor?.isConnected ? getText(activeEditor).trim() : "";
    const reloadBtn = el("button", {
      className: "primary",
      textContent: draft ? msg("reloadCopy", "Copy my message and reload") : msg("reloadPage", "Reload this page"),
    });
    const laterBtn = el("button", { textContent: msg("later", "Later") });
    const status = el("p", { className: "bulk", role: "status" });
    const box = el("div", { className: sized("box"), tabIndex: -1 }, [
      el("h2", { textContent: msg("reloadTitle", "🔄 Clotr was updated") }),
      el("p", {
        textContent: msg("reloadLead", "To keep protecting you on this page, Clotr needs the page to be reloaded."),
      }),
      ...(draft
        ? [
            el("p", {
              textContent: msg(
                "reloadDraft",
                "Reloading can clear the message you're writing, so Clotr copies it first: paste it back with Ctrl+V.",
              ),
            }),
          ]
        : []),
      el("div", {
        className: "note",
        textContent: msg("reloadNote", "Until then Clotr still warns you here, but can't save your choices."),
      }),
      status,
      el("div", { className: "actions" }, [laterBtn, reloadBtn]),
    ]);
    box.setAttribute("role", "alertdialog");
    box.setAttribute("aria-modal", "true");
    const later = () => {
      closeReloadPrompt();
      activeEditor?.focus();
    };
    let copyFailed = false;
    reloadBtn.addEventListener("click", async () => {
      if (draft && !copyFailed) {
        const copied = await navigator.clipboard.writeText(draft).then(
          () => true,
          () => false,
        );
        if (!copied) {
          // never lose the user's message: let them copy it themselves first
          copyFailed = true;
          status.textContent = msg(
            "reloadCopyFailed",
            "Clotr couldn't copy your message. Copy it yourself first (select it, then Ctrl+C), then reload.",
          );
          reloadBtn.textContent = msg("reloadAnyway", "Reload anyway");
          return;
        }
      }
      location.reload();
    });
    laterBtn.addEventListener("click", later);
    // Enter goes forward (reload), Esc or Backspace goes back to the page (D41).
    box.addEventListener("keydown", (e) => {
      if (e.key === "Escape" || e.key === "Backspace") {
        e.preventDefault();
        e.stopPropagation();
        later();
      }
    });
    box.addEventListener("keyup", (e) => e.stopPropagation());
    guardKeys(box, { enter: reloadBtn });
    const overlay = el("div", { className: "overlay" }, [box]);
    root.replaceChildren(el("style", { textContent: DIALOG_CSS + RELOAD_CSS }), overlay);
    document.documentElement.append(reloadHost);
    box.focus();
  }

  function closeReloadPrompt() {
    removeOwn(reloadHost);
  }

  // ---------- Learning offers (local only): "add to your vault?", "warn less?" ----------

  let offerTimer = null;
  function showOffer({ title, text, yes, no, onYes, onNo }) {
    if (!noticeHost) {
      noticeHost = document.createElement("clotr-notice");
      noticeShadow = noticeHost.attachShadow({ mode: "closed" });
    }
    const yesBtn = el("button", { className: "primary", textContent: yes });
    const noBtn = no ? el("button", { textContent: no }) : null;
    const box = el("div", { className: sized("notice offer") }, [
      el("b", { textContent: title }),
      el("p", { textContent: text }),
      el("div", { className: "actions" }, noBtn ? [noBtn, yesBtn] : [yesBtn]),
    ]);
    box.setAttribute("role", "status");
    const done = (fn) => () => {
      clearTimeout(offerTimer);
      closeNotice();
      fn?.();
      activeEditor?.focus();
    };
    yesBtn.addEventListener("click", done(onYes));
    noBtn?.addEventListener("click", done(onNo));
    keyboardReach(box, yesBtn);
    noticeKind = "offer";
    noticeShadow.replaceChildren(el("style", { textContent: NOTICE_CSS }), box);
    if (!noticeHost.isConnected) document.documentElement.append(noticeHost);
    clearTimeout(offerTimer);
    offerTimer = setTimeout(() => {
      if (noticeKind === "offer") closeNotice();
    }, 30000);
  }

  // The user deleted flagged items by hand before sending: offer to always watch for them.
  function offerVault(removed) {
    const items = removed.filter(
      (f) => !offered.has(f.value) && !VAULT_TYPES.has(f.id) && vaultMode(f.id, f.value) === null,
    );
    if (!items.length || !saltValue) return;
    items.forEach((f) => offered.add(f.value));
    const what = items.map((f) => `${f.name} (${mask(f.value)})`).join(", ");
    showOffer({
      title: msg("offerVaultTitle", "💡 Always watch for this?"),
      text:
        items.length === 1
          ? msg(
              "offerVaultOne",
              "You removed $1 before sending. Add it to your vault so Clotr always catches it, however it's written? Only a fingerprint is saved.",
              what,
            )
          : msg(
              "offerVaultMany",
              "You removed $1 before sending. Add them to your vault so Clotr always catches them, however they're written? Only fingerprints are saved.",
              what,
            ),
      yes: msg("offerVaultYes", "Add to my vault"),
      no: msg("noThanks", "No thanks"),
      onYes: () =>
        message({
          type: "clotr:vaultAdd",
          entries: items.map((f) => ({
            kind: "value",
            type: f.id,
            fp: fingerprint(saltValue, f.id, f.value),
            mode: "protect",
            learned: true,
            added: Date.now(),
          })),
        })
          .then(() =>
            console.info(
              LOG,
              "learned vault items",
              items.map((f) => f.id),
            ),
          )
          .catch((err) => console.warn(LOG, "could not add to vault", err)),
    });
  }

  // The user kept (ignored) a warning. After a few of the same type, offer to relax it.
  function noteIgnored(results) {
    if (orphaned()) return;
    const types = [...new Set(results.map((r) => r.id))];
    message({ type: "clotr:ignored", types })
      .then((r) => {
        const id = r?.offer;
        const p = id && results.find((x) => x.id === id);
        if (!p || !["warn", "block"].includes(responseOf(id)) || isDialogOpen()) return;
        showOffer({
          title: msg("relaxTitle", "💡 Warn less about $1?", p.name),
          text: msg(
            "relaxText",
            'You\'ve kept $1 $2 times lately. Switch it to "Just count": still counted in your history, but no more notices. You can change it back in Settings.',
            p.name,
            r.count,
          ),
          yes: msg("tipLog", "Just count it"),
          no: msg("keepWarning", "Keep warning"),
          onYes: () => {
            setToLog([id]);
            message({ type: "clotr:relaxAnswer", id, accepted: true }).catch(() => {});
          },
          onNo: () => message({ type: "clotr:relaxAnswer", id, accepted: false }).catch(() => {}),
        });
      })
      .catch((err) => console.warn(LOG, "could not record choice", err));
  }

  function closeNotice() {
    noticeKind = null;
    tip = null;
    whyOpen = false;
    removeOwn(noticeHost);
  }

  // The user kept the warned items (clicked "Leave it in" or sent anyway): count them as allowed.
  function allowWarnings() {
    const kept = warnings.concat(fileWarnings);
    if (!kept.length) return;
    report(kept, "allowed");
    for (const r of kept) for (const m of r.matches) allowedValues.add(m);
    console.info(
      LOG,
      "user kept warned items",
      kept.map((r) => r.id),
    );
    warnings = [];
    fileWarnings = [];
    closeNotice();
  }

  function shakeDialog() {
    const box = shadow && shadow.querySelector(".box");
    if (!box) return;
    box.classList.remove("shake");
    void box.offsetWidth; // restart the animation
    box.classList.add("shake");
  }

  // ---------- Scanning & blocking ----------

  function scan(editor) {
    activeEditor = editor;
    const lost = orphaned(); // after an update: warn only, record nothing (D37)
    if (lost) {
      noteOrphaned();
      // No updated copy took over (D39 couldn't start it here): ask for a reload (D37).
      if (!reloadAsked) setTimeout(safely(showReloadPrompt), 0);
    }
    if (isPaused()) return;
    const draft = getText(editor);
    if (!draft.trim()) newMessage();
    const all = splitOwnIds(detect(draft));
    noteTyped(all);

    // Log-only patterns don't interrupt, but are still counted (once per value per page).
    const silenced = filterMatches(all, (r, m) => respFor(r, m) === "log" && !loggedSilenced.has(m));
    if (silenced.length) {
      for (const r of silenced) for (const m of r.matches) loggedSilenced.add(m);
      report(silenced, "suppressed");
    }

    const open = (r, m) => !allowedValues.has(m);
    pending = filterMatches(all, (r, m) => respFor(r, m) === "block" && open(r, m));
    warnings = filterMatches(all, (r, m) => respFor(r, m) === "warn" && open(r, m));
    if (lost) {
      warnings = pending.concat(warnings);
      pending = [];
    }

    // Learning: flagged values that vanished while the message is still being written
    // were removed by hand.
    const text = getText(editor);
    const removed = [];
    for (const [value, f] of flagged) {
      if (text.includes(value)) continue;
      flagged.delete(value);
      // Edited into another value of the same type ("937-555-5636" → "…5637") isn't a removal.
      if (text.trim() && !all.some((r) => r.id === f.id)) removed.push({ value, ...f });
    }
    for (const r of all)
      for (const m of r.matches) if (respFor(r, m) !== "log") flagged.set(m, { id: r.id, name: r.name });
    if (pending.length && backToEdit) {
      // Editing after "Go back to my message": the dialog returns when they send.
    } else if (pending.length) {
      // One decision for everything: the dialog also lists the warn-level items.
      console.info(
        LOG,
        "detected",
        pending.concat(warnings).map((r) => r.id),
      );
      closeNotice();
      showDialog(pending.concat(warnings));
    } else {
      if (isDialogOpen()) closeDialog();
      if (warnings.length) {
        console.info(
          LOG,
          "warning about",
          warnings.map((r) => r.id),
        );
        showNotice(warnings);
      } else if (isNoticeOpen() && noticeKind === "warn") {
        closeNotice();
      }
      if (!warnings.length && removed.length && !lost) offerVault(removed);
    }
  }

  // Re-check right before a send, in case the debounced scan hasn't run yet.
  // Block-level items stop the send; warn-level items go through and count as allowed.
  // `unsure`: the click was on an unlabeled button in the chat box that may or may not send.
  // It can hold a message only for Ask before sending; for warnings nothing is recorded until
  // the box really empties (confirmSent), so an Attach or microphone click never counts.
  function shouldBlock(opts) {
    const held = shouldHold(opts);
    if (!held && activeEditor) openReplyWindow();
    return held;
  }

  function shouldHold({ unsure = false } = {}) {
    if (isPaused() || health.uiRemoved) return false; // a page removing Clotr's dialog must not leave you stuck
    if (isDialogOpen()) {
      if (!orphaned()) return true;
      closeDialog(); // opened before the update: an orphaned copy never holds a message
    }
    if (!activeEditor || !activeEditor.isConnected) return false;
    clearTimeout(scanTimer);
    backToEdit = false; // a send attempt brings the dialog back
    // Was a warning on screen long enough to read before this send? (fast paste-and-Enter)
    const seen = isNoticeOpen() && noticeKind === "warn" && Date.now() - noticeOpenedAt >= SEEN_MS;
    scan(activeEditor);
    if (pending.length) return true;
    if (warnings.length && (!seen || unsure)) {
      confirmSent(activeEditor, warnings.slice(), !seen);
      return false;
    }
    if (unsure) return false;
    allowWarnings();
    flagged.clear(); // the message is going out: an emptied box isn't a removal
    newMessage();
    return false;
  }

  // Warn never holds a message (D30). When it went out before the warning could be read,
  // say what went, right after, and offer to ask first next time (D52).
  const SEEN_MS = 1500;
  const CONFIRM_MS = 1200;
  // Only say "Just sent" (and record it) once the message really left: sites sometimes ignore
  // an Enter pressed too soon (Gemini did). If the text is still in the box, show the normal
  // warning instead, now that there's time to read it.
  function confirmSent(editor, results, tell = true) {
    const before = getText(editor).replace(/\s+/g, " ").trim();
    closeNotice(); // the half-shown warning; it comes back if the message didn't go
    warnings = [];
    setTimeout(
      safely(() => {
        const now = editor.isConnected ? getText(editor).replace(/\s+/g, " ").trim() : "";
        if (now === before) {
          scan(editor);
          return;
        } // not sent
        report(results, "allowed");
        for (const r of results) for (const m of r.matches) allowedValues.add(m);
        flagged.clear();
        newMessage();
        if (tell) justSent(results);
      }),
      CONFIRM_MS,
    );
  }

  function justSent(results) {
    if (orphaned()) return;
    const items = results.flatMap((r) => r.matches.map((m) => `${r.name} (${mask(m)})`));
    const types = [...new Set(results.map((r) => r.id))];
    showOffer({
      title: msg("justSentTitle", "⚠️ Just sent to this AI"),
      text: msg(
        "justSentText",
        "Your message included $1. If that was a mistake, delete the message in the chat. Clotr can ask you first next time.",
        items.join(", "),
      ),
      yes: msg("askFirstNextTime", "Ask me first next time"),
      no: msg("ok", "OK"),
      onYes: () => setResponse(types, "block"),
    });
  }

  function block(event, why) {
    event.preventDefault();
    event.stopImmediatePropagation();
    console.info(LOG, "blocked send via", why);
    shakeDialog();
  }

  function safely(fn) {
    return (event) => {
      if (retired) return; // a newer copy handles this page now
      try {
        fn(event);
      } catch (err) {
        console.error(LOG, "handler error", err);
      }
    };
  }

  // Capture-phase listeners on window run before the site's own handlers.
  window.addEventListener(
    "input",
    safely((e) => {
      if (isPaused() || globalThis.Clotr.editor.isEditing() || !byUser(e)) return;
      const editor = findEditor(realTarget(e));
      if (!editor) return;
      activeEditor = editor;
      noteEditor();
      clearTimeout(scanTimer);
      scanTimer = setTimeout(
        safely(() => scan(editor)),
        SCAN_DELAY_MS,
      );
    }),
    true,
  );

  window.addEventListener(
    "keydown",
    safely((e) => {
      if (e.key !== "Enter" || e.shiftKey || e.isComposing || !byUser(e)) return;
      const editor = findEditor(realTarget(e));
      if (!editor) return;
      activeEditor = editor;
      if (shouldBlock()) block(e, "Enter key");
    }),
    true,
  );

  // Send buttons without a "send" label (an icon in a div, DeepSeek-style): a button close
  // around the chat box whose label isn't one of the chat box's other tools.
  const NOT_SEND =
    /attach|upload|file|image|photo|camera|mic|voice|dictat|speak|record|model|mode|picker|select|switch|tool|plus|add|emoji|search|research|think|reason|canvas|setting|menu|more|option|stop|cancel|close|new|share|copy|edit|regenerat|retry|like|thumb|expand|collapse/i;
  function composerButton(target) {
    if (!activeEditor || !activeEditor.isConnected) return null;
    const btn = target.closest('button, [role="button"]');
    if (!btn || btn === activeEditor || btn.contains(activeEditor)) return null;
    const label = `${btn.getAttribute("aria-label") || ""} ${btn.getAttribute("title") || ""} ${btn.textContent || ""}`;
    if (NOT_SEND.test(label)) return null;
    let area = activeEditor;
    for (let i = 0; i < 5 && area.parentElement; i++) {
      area = area.parentElement;
      if (area.contains(btn)) return btn;
    }
    return null;
  }

  window.addEventListener(
    "click",
    safely((e) => {
      if (!byUser(e)) return;
      const target = realTarget(e);
      if (!(target instanceof Element)) return;
      if (target.closest(SEND_BUTTON_SELECTOR)) {
        if (shouldBlock()) block(e, "send button");
      } else if (composerButton(target) && shouldBlock({ unsure: true })) {
        block(e, "unlabeled button in the chat box");
      }
    }),
    true,
  );

  // ---------- Reply check: the AI mentions your own details that you didn't type here (D63) ----------
  // Only your vault details (fingerprints), only text that appears in the 90 s after you send (so an
  // old conversation opening never counts), never what you typed on this page, once per detail.
  // One check per message you send, once the reply has been quiet for a moment: the page controls
  // what appears, so more checks would let it test guess after guess (S24).
  const REPLY_WINDOW_MS = 90000;
  const REPLY_QUIET_MS = 3000;
  const OWN_WORD_TYPES = new Set(["my_name", "family_name", "employer", "watch_list"]);
  const typedHere = new Set(); // fingerprints of everything detected in the chat box on this page
  const mentioned = new Set(); // fingerprints already pointed out
  const replyNodes = new Set();
  let replyWindowUntil = 0;
  let replyTimer = null;
  let replyObserver = null;

  function fpOf(r, m) {
    return saltValue ? fingerprint(saltValue, r.id, m) : null;
  }
  function noteTyped(results) {
    for (const r of results)
      for (const m of r.matches) {
        const fp = fpOf(r, m);
        if (fp) typedHere.add(fp);
      }
  }
  const isOwn = (r, m) => OWN_WORD_TYPES.has(r.id) || (vaultMode(r.id, m) !== null && vaultMode(r.id, m) !== "allow");

  function openReplyWindow() {
    if (!saltValue || !vaultEntries.length) return; // nothing of yours to recognize
    replyWindowUntil = Date.now() + REPLY_WINDOW_MS;
    if (replyObserver || !document.body) return;
    replyObserver = new MutationObserver((records) => {
      if (Date.now() > replyWindowUntil) {
        replyObserver.disconnect();
        replyObserver = null;
        replyNodes.clear();
        return;
      }
      for (const rec of records) {
        const nodes = rec.type === "characterData" ? [rec.target.parentElement] : [...rec.addedNodes];
        for (const n of nodes) if (n && replyNodes.size < 500) replyNodes.add(n.nodeType === 3 ? n.parentElement : n);
      }
      clearTimeout(replyTimer);
      replyTimer = setTimeout(
        safely(() => {
          closeReplyWindow();
          checkReply();
        }),
        REPLY_QUIET_MS,
      ); // streaming: wait for a pause
    });
    replyObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function closeReplyWindow() {
    replyWindowUntil = 0;
    replyObserver?.disconnect();
    replyObserver = null;
  }

  function checkReply() {
    if (isPaused() || health.uiRemoved) return;
    let text = "";
    for (const n of replyNodes) {
      if (
        !n?.isConnected ||
        (activeEditor && (n === activeEditor || n.contains(activeEditor) || activeEditor.contains(n)))
      )
        continue;
      if (n.closest?.("textarea, input, [contenteditable='true'], [contenteditable='']")) continue;
      text += `${n.innerText || n.textContent || ""}\n`;
      if (text.length > 100000) break;
    }
    replyNodes.clear();
    if (!text.trim()) return;
    const own = filterMatches(splitOwnIds(detect(text)), (r, m) => {
      const fp = fpOf(r, m);
      return fp && isOwn(r, m) && !typedHere.has(fp) && !mentioned.has(fp);
    });
    if (!own.length) return;
    for (const r of own) for (const m of r.matches) mentioned.add(fpOf(r, m));
    if (isDialogOpen() || (isNoticeOpen() && noticeKind !== "offer")) return; // a warning has priority
    const names = [...new Set(own.map((r) => r.name))].join(", ");
    console.info(
      LOG,
      "a reply mentions your own details",
      own.map((r) => r.id),
    );
    showOffer({
      title: msg("replyTitle", "ℹ️ The AI's reply mentions your $1", names),
      text: msg(
        "replyText",
        "You didn't type it here, so this AI may have it from an earlier chat or its memory. You can delete old chats, and turn off its memory, in the AI's settings.",
      ),
      yes: msg("ok", "OK"),
      no: null,
    });
  }

  // ---------- Attached files (warn only; the upload itself isn't held, D19) ----------
  // attachments.js reads text files, PDFs and Office documents, with hard caps (hostile files).

  // Several files at once get one notice naming each file with something in it. A drop of
  // hundreds of files: the first MAX_FILES are read (each is capped), the rest pass unchecked.
  const MAX_FILES = 50;

  // Results for the same kind of data, from different files, as one entry per kind.
  function mergeResults(a, b) {
    const out = a.map((r) => ({ ...r, matches: [...r.matches] }));
    for (const r of b) {
      const same = out.find((o) => o.id === r.id);
      if (same) same.matches.push(...r.matches);
      else out.push({ ...r, matches: [...r.matches] });
    }
    return out;
  }

  async function scanFiles(files) {
    if (isPaused()) return;
    const list = [...(files || [])];
    if (list.length > MAX_FILES)
      console.info(LOG, "checking the first", MAX_FILES, "of", list.length, "attached files");
    const names = [];
    let found = [];
    let lines = 0;
    for (const f of list.slice(0, MAX_FILES)) {
      const text = await readAttachment(f); // null: not a kind Clotr reads, or unreadable (fail open)
      if (!text) continue;
      const all = splitOwnIds(detect(text));
      const silenced = filterMatches(all, (r, m) => respFor(r, m) === "log");
      if (silenced.length) report(silenced, "suppressed");
      const hits = filterMatches(all, (r, m) => respFor(r, m) !== "log" && !allowedValues.has(m));
      if (!hits.length) continue;
      console.info(
        LOG,
        "attached file",
        (f.name.match(/\.\w+$/) || [""])[0],
        "contains",
        hits.map((r) => r.id),
      ); // extension only: a file name can be personal
      names.push(f.name);
      lines += text.split("\n").length;
      found = mergeResults(found, hits);
    }
    if (!found.length) return;
    fileWarnings = mergeResults(fileWarnings, found); // an earlier file not yet acknowledged stays counted
    const shown =
      names
        .slice(0, 3)
        .map((n) => `“${n}”`)
        .join(", ") + (names.length > 3 ? ` ${msg("andMore", "and $1 more", names.length - 3)}` : "");
    if (!isDialogOpen())
      showNotice(found, names.length === 1 ? { name: names[0], lines } : { name: shown, lines, count: names.length });
  }

  window.addEventListener(
    "change",
    safely((e) => {
      const t = realTarget(e);
      if (t instanceof HTMLInputElement && t.type === "file")
        scanFiles(t.files).catch((err) => console.warn(LOG, "file scan failed", err));
    }),
    true,
  );
  window.addEventListener(
    "drop",
    safely((e) => {
      if (e.dataTransfer?.files?.length)
        scanFiles(e.dataTransfer.files).catch((err) => console.warn(LOG, "file scan failed", err));
    }),
    true,
  );
  window.addEventListener(
    "paste",
    safely((e) => {
      if (e.clipboardData?.files?.length)
        scanFiles(e.clipboardData.files).catch((err) => console.warn(LOG, "file scan failed", err));
    }),
    true,
  );

  // The background asks before an update reload. Only a frame showing a dialog or a
  // warning answers; if none does, the reload goes ahead.
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "clotr:busy?" && (isDialogOpen() || (isNoticeOpen() && noticeKind !== "offer")))
      sendResponse(true);
    if (msg?.type === "clotr:focusNotice" && IS_TOP && isNoticeOpen() && noticeFocus) noticeFocus();
    if (msg?.type === "clotr:settingsChanged" && !retired) loadSettings();
    // Still here after an in-page navigation: tell the background again (HC4).
    if (msg?.type === "clotr:ping" && IS_TOP && !retired) sendResponse({ alive: true, paused: isPaused(), ...health });
    return false;
  });

  window.addEventListener(
    "submit",
    safely((e) => {
      if (byUser(e) && shouldBlock()) block(e, "form submit");
    }),
    true,
  );
})();
