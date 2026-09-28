// Clotr — "What should I protect?" page (the vault).
// Each line becomes a salted fingerprint of its normalized form (or, for account/ID numbers,
// just its format) before it leaves this page; the background worker stores only that.
// The typed text is cleared right after saving and is never written anywhere.
"use strict";

const { detect, fingerprint, addressCore, msg } = globalThis.Clotr;
const $ = (id) => document.getElementById(id);

const CATEGORY = {
  my_name: msg("vt_cName", "Your name"),
  family_name: msg("vt_cFamily", "Family member"),
  employer: msg("vt_cWork", "Where you work"),
  street_address: msg("vt_cAddress", "Address"),
  phone_number: msg("vt_cPhone", "Phone number"),
  email: msg("vt_cEmail", "Email address"),
  my_id: msg("vt_cIdFormat", "Account/ID format"),
  watch_list: msg("vt_cWatch", "Watch word"),
};
const categoryOf = (e) =>
  e.kind === "value" && e.type === "my_id" ? msg("vt_cYourId", "Your ID number") : CATEGORY[e.type] || e.type;

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

// An example like "AB-123456" becomes its format "@@-######"; a format stays as typed.
function toShape(line) {
  const shape = /[#@]/.test(line) ? line : line.replace(/\d/g, "#").replace(/[A-Za-z]/g, "@");
  const marks = (shape.match(/[#@]/g) || []).length;
  return marks >= 4 && !/\d/.test(shape) ? shape : null;
}

// One typed line → vault entries, or an error message.
function entriesFor(kind, type, line, salt) {
  if (kind === "word") {
    if (type === "watch_list" && /[#@]/.test(line)) {
      const shape = toShape(line);
      return shape ? [{ kind: "shape", type, shape }] : msg("vt_errFormat", "a format needs 4+ # or @ marks");
    }
    const phrase = line.replace(/\s+/g, " ");
    if (phrase.split(" ").length > 4) return msg("vt_errWords", "up to 4 words per line");
    return [{ kind: "word", type, fp: fingerprint(salt, "watch_list", phrase), words: phrase.split(" ").length }];
  }
  if (kind === "shape") {
    const shape = toShape(line);
    if (!shape) return msg("vt_errShape", "needs at least 4 letters/digits, like AB-123456");
    const out = [{ kind: "shape", type, shape }];
    // A real example is also kept as a fingerprint, so Clotr can tell your own ID from others
    // with the same format (D23). Typing only the format (AB-######) keeps just the format.
    if (!/[#@]/.test(line)) out.push({ kind: "value", type, fp: fingerprint(salt, type, line), mode: "protect" });
    return out;
  }
  if (type === "street_address") {
    if (!addressCore(line))
      return msg("vt_errAddress", "doesn't read as a street address (number + street name + St/Ave/Rd…) or PO Box");
    return [{ kind: "value", type, fp: fingerprint(salt, type, line), mode: "protect" }];
  }
  const found = detect(line).find((r) => r.id === type);
  if (!found)
    return type === "email"
      ? msg("vt_errEmail", "doesn't look like an email address")
      : msg("vt_errPhone", "doesn't look like a phone number");
  return found.matches.map((m) => ({ kind: "value", type, fp: fingerprint(salt, type, m), mode: "protect" }));
}

$("vault-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { salt } = await chrome.runtime.sendMessage({ type: "clotr:getSalt" });
  if (!salt) {
    $("save-msg").textContent = msg("vt_saveFailed", "Couldn't save right now. Try again.");
    return;
  }

  const entries = [];
  const problems = [];
  for (const box of document.querySelectorAll("textarea[data-type]")) {
    const lines = box.value
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const keep = [];
    for (const line of lines) {
      const out = entriesFor(box.dataset.kind, box.dataset.type, line, salt);
      if (typeof out === "string") {
        problems.push(`${CATEGORY[box.dataset.type]}: "${line}" ${out}`);
        keep.push(line);
      } else entries.push(...out);
    }
    box.value = keep.join("\n"); // clear what was saved; leave only lines to fix
  }
  const { added = 0 } = entries.length ? await chrome.runtime.sendMessage({ type: "clotr:vaultAdd", entries }) : {};
  $("save-msg").textContent =
    [
      entries.length
        ? added === 1
          ? msg("vt_savedOne", "Saved 1 new item.")
          : msg("vt_savedMany", "Saved $1 new items.", added)
        : "",
      entries.length && added < entries.length ? msg("vt_already", "$1 already there.", entries.length - added) : "",
      ...problems,
    ]
      .filter(Boolean)
      .join(" · ") || msg("vt_nothingToSave", "Nothing to save.");
});

// ---------- The list (fingerprints only, so items show as hidden) ----------

const vaultKey = (e) =>
  e.kind === "shape" ? `shape:${e.type}:${String(e.shape).toLowerCase()}` : `${e.kind}:${e.type}:${e.fp}`;
const fmtDate = new Intl.DateTimeFormat([], { month: "short", day: "numeric" });

function describe(e) {
  if (e.kind === "shape") return [el("code", { textContent: e.shape })];
  if (e.kind === "word")
    return [
      e.words > 1 ? msg("vt_wordsHidden", "$1 words (hidden)", e.words) : msg("vt_wordHidden", "1 word (hidden)"),
    ];
  return [msg("vt_hidden", "Hidden")];
}

function render(vault) {
  $("vault-list").replaceChildren(
    ...vault.map((e) => {
      const remove = el("button", { className: "btn", textContent: msg("pp_remove", "Remove") });
      remove.addEventListener("click", () =>
        chrome.runtime.sendMessage({ type: "clotr:vaultUpdate", key: vaultKey(e), change: "remove" }),
      );
      const controls = [remove];
      if (e.kind === "value") {
        const mode = el("select", { className: "resp" }, [
          el("option", { value: "protect", textContent: msg("vault_watch", "Watch"), selected: e.mode !== "allow" }),
          el("option", {
            value: "allow",
            textContent: msg("vault_okToShare", "OK to share"),
            selected: e.mode === "allow",
          }),
        ]);
        mode.setAttribute("aria-label", msg("vt_modeLabel", "$1: watch or OK to share", categoryOf(e)));
        mode.addEventListener("change", () =>
          chrome.runtime.sendMessage({ type: "clotr:vaultUpdate", key: vaultKey(e), change: mode.value }),
        );
        controls.unshift(mode);
      }
      return el("li", {}, [
        el("span", { className: "grow words" }, [
          el("span", {
            className: "cat",
            textContent: `${categoryOf(e)}${e.learned ? msg("vt_learned", " · learned") : ""} · ${msg("vt_added", "added $1", fmtDate.format(e.added))}`,
          }),
          ...describe(e),
        ]),
        ...controls,
      ]);
    }),
  );
  $("vault-empty").hidden = vault.length > 0;
}

chrome.storage.local.get("vault").then(({ vault = [] }) => render(vault));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.vault) render(changes.vault.newValue || []);
});

// ---------- First install: welcome + practice box (vault.html?welcome=1) ----------
// The practice box runs the same local detector as the chat pages; nothing is saved or sent.

const mask = (v) => (v.length <= 8 ? "•".repeat(v.length) : `${v.slice(0, 4)}…${v.slice(-2)}`);

function tryIt() {
  const text = $("try").value;
  const found = text.trim() ? detect(text) : [];
  if (!found.length) {
    $("try-result").replaceChildren(
      ...(text.trim() ? [el("p", { textContent: msg("vt_nothingFound", "Nothing sensitive found.") })] : []),
    );
    return;
  }
  const redact = el("button", { className: "btn primary", type: "button", textContent: msg("coverIt", "Hide it") });
  redact.addEventListener("click", () => {
    let out = $("try").value;
    for (const r of found) for (const m of r.matches) out = out.split(m).join(`[REDACTED ${r.name.toUpperCase()}]`);
    $("try").value = out;
    tryIt();
    $("try").focus();
  });
  const items = found.flatMap((r) => r.matches.map((m) => `${r.name} (${mask(m)})`));
  $("try-result").replaceChildren(
    el("div", { className: "try-notice" }, [
      el("b", { textContent: msg("noticeTitle", "⚠️ Heads up") }),
      el("p", {
        textContent:
          msg("noticeContains", "Your message contains ") +
          items.join(", ") +
          msg("noticeShared", ". It will be shared with this AI if you send it."),
      }),
      redact,
    ]),
  );
}

if (new URLSearchParams(location.search).has("welcome")) {
  document.title = msg("vt_welcome", "Welcome to Clotr");
  $("page-title").textContent = msg("vt_welcome", "Welcome to Clotr");
  $("welcome").hidden = false;
  $("vault-lead").hidden = true;
  let timer = null;
  $("try").addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(tryIt, 300);
  });
  // Pinned yet? The browser can tell us (Chrome/Edge/Brave; older browsers keep the instructions).
  const checkPinned = async () => {
    const settings = await chrome.action.getUserSettings?.().catch(() => null);
    if (!settings?.isOnToolbar) return false;
    $("pin-step").replaceChildren(
      msg("vt_pinned", "✓ Clotr is pinned. Its count shows on the shield in your toolbar."),
    );
    $("pin-step").classList.add("done");
    return true;
  };
  checkPinned().then((done) => {
    if (done) return;
    const poll = setInterval(async () => {
      if (await checkPinned()) clearInterval(poll);
    }, 1500);
  });
  $("skip").addEventListener("click", async () => {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id) chrome.tabs.remove(tab.id);
  });
}

// Browsers restore form fields on Back/Forward and after a crash. Details typed here but not
// saved must not end up in that restore data, so the fields are emptied whenever the page is
// hidden (M8). Saved items are fingerprints already.
window.addEventListener("pagehide", () => {
  for (const box of document.querySelectorAll("textarea")) box.value = "";
});

// Helping someone (D61): with a PIN set and not unlocked in the popup (10 minutes), the vault
// can't be changed here. The first-run welcome never has a PIN yet.
(async () => {
  const { lock } = await chrome.storage.local.get("lock");
  const { unlockedUntil = 0 } = await chrome.storage.session.get("unlockedUntil").catch(() => ({}));
  const policy = (await chrome.storage.managed?.get(null).catch(() => ({}))) || {};
  if (policy.lockSettings !== true && (!lock || Date.now() < unlockedUntil)) return;
  document.getElementById("vault-locked").hidden = false;
  for (const id of ["vault-lead", "vault-form", "vault-list", "vault-empty"]) {
    const node = document.getElementById(id);
    if (node) node.hidden = true;
  }
})();
