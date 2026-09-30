// Clotr — guided setup for helping someone (D61, pre-release Batch 3): the popup's "Helping someone set this up?"
// settings as four steps on one page. Same storage and the same PIN rules (helper-core.js): when a PIN is set and
// not unlocked in the last 10 minutes, or an organization manages Clotr, the steps stay hidden.
"use strict";

const { msg, Helper } = globalThis.Clotr;
const $ = (id) => document.getElementById(id);
let lock = null;
let managed = false;
let unlockedUntil = 0;
let wrongTries = 0;
let retryAt = 0;

const say = (id, text, error = false) => {
  $(id).textContent = text;
  $(id).classList.toggle("error", error);
};

async function render() {
  const s = await chrome.storage.local.get(["largeText", "responses", "lock", "vault"]);
  const policy = (await chrome.storage.managed?.get(null).catch(() => ({}))) || {};
  managed = policy.lockSettings === true;
  lock = s.lock || null;
  unlockedUntil = await Helper.unlockedUntil();
  const locked = managed || (Boolean(lock) && Date.now() >= unlockedUntil);
  $("managed-note").hidden = !managed;
  $("unlock").hidden = !locked || managed; // an organization's lock has no PIN
  $("steps").hidden = locked;
  $("done").hidden = locked;
  $("large-text").checked = Boolean(s.largeText);
  $("strict-personal").checked = Helper.asksBeforePersonal(s.responses);
  const n = (s.vault || []).length;
  $("vault-count").textContent = n ? msg("hp_detailsSaved", "$1 saved so far", n) : "";
  $("lock-set").textContent = lock ? msg("pp_changePin", "Change the PIN") : msg("popup_lockSettings", "Lock settings");
}

$("open-vault").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("vault.html") }));
$("open-share").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("share.html") }));
$("large-text").addEventListener("change", (e) => chrome.storage.local.set({ largeText: e.target.checked }));
$("strict-personal").addEventListener("change", (e) => Helper.setAskBeforePersonal(e.target.checked));
$("lock-set").addEventListener("click", async () => {
  const pin = $("pin").value.trim();
  if (!Helper.validPin(pin)) return say("lock-msg", msg("pp_pinDigits", "Use 4 to 8 digits."), true);
  const next = await Helper.makeLock(pin);
  unlockedUntil = await Helper.markUnlocked(); // you set it, so you stay in for now
  await chrome.storage.local.set({ lock: next });
  $("pin").value = "";
  say("lock-msg", msg("pp_locked", "Settings locked. Clotr will ask for the PIN next time."));
});

async function tryUnlock() {
  if (Date.now() < retryAt) return say("unlock-msg", msg("pp_tooMany", "Too many tries: wait half a minute."), true);
  const ok = await Helper.pinMatches($("unlock-pin").value.trim(), lock);
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
  await Helper.markUnlocked();
  render();
}
$("unlock-go").addEventListener("click", tryUnlock);
$("unlock-pin").addEventListener("keydown", (e) => {
  if (e.key === "Enter") tryUnlock();
});

// Details added in the vault tab, or settings changed in the popup, show up here too.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && ["largeText", "responses", "lock", "vault"].some((k) => k in changes)) render();
});
render();
