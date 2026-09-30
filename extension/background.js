// Clotr — background service worker.
//
// - The single writer of the event log and the fingerprint salt, so writes from
//   several AI tabs at once can't overwrite each other. Stores metadata only:
//   content scripts send fingerprints, never detected values.
// - Toolbar icon/badge/tooltip: burnt-orange shield + today's count on protected tabs,
//   amber dot on pages that look like an unprotected AI chat.
// - Registers Clotr on AI sites the user added (per-site optional permission).
"use strict";

// Chrome: a service worker loads sites.js here. Firefox runs background scripts, listing
// sites.js before this file in the manifest (tools/package.js --firefox).
if (typeof importScripts === "function" && !globalThis.ClotrSites) importScripts("sites.js");
// The detection pair, for fingerprinting an admin's watch words (team policy, D62).
if (typeof importScripts === "function" && !globalThis.Clotr?.fingerprint) importScripts("patterns.js", "detector.js");
// Moving to a new computer: the backup file's format and cleaning (pre-release Batch 5).
if (typeof importScripts === "function" && !globalThis.Clotr?.Backup) importScripts("backup.js");

const LOG = "[Clotr]";
const MAX_EVENTS = 10000; // ~1.5 MB of the 10 MB storage quota (D54)
// "mentioned" = an AI reply brought up one of your vault details (D63); kept apart in `mentions` so it
// never counts as something found in your own messages.
const ACTIONS = new Set(["redacted", "allowed", "suppressed", "mentioned"]);
const MAX_MENTIONS = 2000;
const SEVERITIES = new Set(["high", "medium", "low"]);
const {
  CONTENT_JS,
  USER_SCRIPT_ID,
  AI_URL_REGEX,
  PROMPT_SELECTORS,
  userSitePatterns,
  applyPolicy,
  policyWords,
  policyShapes,
  mergePolicy,
  floorOf,
} = globalThis.ClotrSites;

const ICON = (variant) => ({ 16: `icons/icon-${variant}-16.png`, 32: `icons/icon-${variant}-32.png` });
const BADGE_BRAND = "#b84a0c"; // burnt orange (D76), white text 5.2:1
const BADGE_RED = "#d03b3b";

// Run storage read-modify-writes one at a time.
let queue = Promise.resolve();
function enqueue(task) {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

// ---------- Storage lock (S20) ----------
// Only Clotr's own pages (popup, report, vault) and this worker may read or write storage. The part
// running inside AI pages asks for what it needs by message: a compromised page can't read your
// history, the full settings of other sites, or write anything unchecked. (Firefox: not available.)
chrome.storage.local
  .setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" })
  .catch((err) => console.warn(LOG, "could not lock storage", err));

const RESPONSE_VALUES = new Set(["block", "warn", "log"]);
const SETTINGS_KEYS = ["responses", "paused", "vault", "siteModes", "guided", "largeText", "replyCheck", "bandage"];

// The admin's policy (managed storage), or {} when there is none.
async function readPolicy() {
  try {
    return mergePolicy((await chrome.storage.managed?.get(null)) || {});
  } catch {
    return mergePolicy({});
  }
}

// What one frame needs: its own site's pause and mode, not the whole map, with the team policy
// applied (its required responses win; its watch words arrive as fingerprints, never as words).
async function settingsFor(url) {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    /* no url: nothing site-specific */
  }
  const [r, policy] = await Promise.all([chrome.storage.local.get(SETTINGS_KEYS), readPolicy()]);
  const eff = applyPolicy(
    { responses: r.responses, paused: Boolean(host && r.paused?.[host]), largeText: r.largeText === true },
    policy,
  );
  let vault = Array.isArray(r.vault) ? r.vault : [];
  // A required block is a floor: an "OK to share" vault entry can't quietly weaken it (team-pack
  // item 3, loophole 1). The entry stays in storage; it just doesn't apply while the policy holds.
  vault = vault.filter((e) => !(e.mode === "allow" && floorOf(policy, e.type) === "block"));
  const words = policyWords(policy);
  if (words.length) {
    const salt = await ensureSalt();
    vault = vault.concat(
      words.map((phrase) => ({
        kind: "word",
        type: "watch_list",
        fp: globalThis.Clotr.fingerprint(salt, "watch_list", phrase),
        words: phrase.split(" ").length,
        managed: true,
      })),
    );
  }
  const shapes = policyShapes(policy);
  if (shapes.length) {
    vault = vault.concat(shapes.map((shape) => ({ kind: "shape", type: "watch_list", shape, managed: true })));
  }
  // A per-site "Just count" can't quietly weaken a required response either (loophole 2): under
  // any team policy, a "log" site mode is dropped, so the content script falls back to each
  // kind's own (floored) response instead of counting everything on that site.
  const rawSiteMode = (host && r.siteModes?.[host]) || null;
  const hasPolicy = Boolean(policy?.requiredResponses && Object.keys(policy.requiredResponses).length);
  return {
    responses: eff.responses,
    paused: eff.paused,
    siteMode: rawSiteMode === "log" && hasPolicy ? null : rawSiteMode,
    vault,
    guided: r.guided || {},
    largeText: eff.largeText,
    replyCheck: r.replyCheck !== false, // D63: on unless switched off in Settings
    // Bandage (D93): true = cover names on this site, false = the user said no, undefined = not asked yet.
    bandage: host && typeof r.bandage?.[host] === "boolean" ? r.bandage[host] : undefined,
  };
}

// Bandage on or off for the site of the tab that asked (its first-time offer, D93).
async function setBandage(url, on) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return { error: "bad request" };
  }
  if (!host || typeof on !== "boolean") return { error: "bad request" };
  const { bandage = {} } = await chrome.storage.local.get("bandage");
  bandage[host] = on;
  await chrome.storage.local.set({ bandage });
  return { ok: true };
}

async function setResponses(ids, value) {
  if (!RESPONSE_VALUES.has(value) || !Array.isArray(ids)) return { error: "bad request" };
  const clean = ids.filter((id) => typeof id === "string" && /^[a-z0-9_]{1,64}$/.test(id));
  if (!clean.length) return { error: "bad request" };
  const { responses = {} } = await chrome.storage.local.get("responses");
  for (const id of clean) responses[id] = value;
  await chrome.storage.local.set({ responses });
  return { ok: true };
}

// A setting changed (popup, vault, another tab): tell open Clotr tabs to fetch theirs again.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "managed" && (area !== "local" || !SETTINGS_KEYS.some((k) => changes[k]))) return;
  // Every tab, not just the registered ones: a tab still starting up would otherwise miss the
  // change (EG1 caught it). Tabs without Clotr just don't answer.
  chrome.tabs.query({}).then((tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: "clotr:settingsChanged" }).catch(() => {
        /* no Clotr in this tab */
      });
    }
  });
});

// ---------- Salt & events ----------

async function ensureSalt() {
  const { salt } = await chrome.storage.local.get("salt");
  if (salt) return salt;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const fresh = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  await chrome.storage.local.set({ salt: fresh });
  return fresh;
}

// Keep only known fields with sane values; drop anything else a page might inject.
function sanitize(e) {
  if (!e || typeof e !== "object") return null;
  if (!ACTIONS.has(e.action) || !SEVERITIES.has(e.severity)) return null;
  const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
  const out = {
    t: Number.isFinite(e.t) ? e.t : Date.now(),
    site: str(e.site, 253),
    type: str(e.type, 64),
    name: str(e.name, 64),
    severity: e.severity,
    action: e.action,
    fp: /^[0-9a-f]{16}$/.test(e.fp) ? e.fp : "",
  };
  // How a "redacted" event happened: Bandage swapped it for a label while typing, apart from
  // hand-hidden ("Hide it" in the dialog/notice), so the report can tell them apart (D93).
  if (e.via === "bandage") out.via = "bandage";
  return out;
}

// "Keep history for" (dashboard): 90, 365 (default) or 730 days (D54).
const KEEP_DAYS = new Set([90, 365, 730]);
const keepCutoff = (keepDays) => Date.now() - (KEEP_DAYS.has(keepDays) ? keepDays : 365) * 86400000;

async function appendEvents(incoming) {
  const clean = (Array.isArray(incoming) ? incoming : []).map(sanitize).filter(Boolean);
  if (!clean.length) return 0;
  const { events = [], mentions = [], keepDays } = await chrome.storage.local.get(["events", "mentions", "keepDays"]);
  const cutoff = keepCutoff(keepDays);
  const add = (list, items, max) =>
    list
      .concat(items)
      .filter((e) => e.t >= cutoff)
      .slice(-max);
  const found = clean.filter((e) => e.action !== "mentioned");
  const said = clean.filter((e) => e.action === "mentioned");
  const next = {};
  if (found.length) next.events = add(events, found, MAX_EVENTS);
  if (said.length) next.mentions = add(mentions, said, MAX_MENTIONS);
  await chrome.storage.local.set(next);
  return clean.length;
}

// Drop records older than the chosen period; writes only when something is removed.
async function pruneEvents() {
  const { events = [], mentions = [], keepDays } = await chrome.storage.local.get(["events", "mentions", "keepDays"]);
  const cutoff = keepCutoff(keepDays);
  const kept = events.filter((e) => e.t >= cutoff);
  const keptMentions = mentions.filter((e) => e.t >= cutoff);
  if (kept.length !== events.length) await chrome.storage.local.set({ events: kept });
  if (keptMentions.length !== mentions.length) await chrome.storage.local.set({ mentions: keptMentions });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.keepDays) enqueue(pruneEvents);
});

// ---------- Toolbar: tooltip (all tabs) and badge (protected tabs only) ----------

function todaySummary(events) {
  const start = new Date().setHours(0, 0, 0, 0);
  const today = events.filter((e) => e.t >= start);
  const count = (a) => today.filter((e) => e.action === a).length;
  return {
    total: today.length,
    redacted: count("redacted"),
    allowed: count("allowed"),
    silenced: count("suppressed"),
    riskyAllowed: today.some((e) => e.action === "allowed" && e.severity === "high"),
  };
}

// Protected tabs are tracked in session storage because the worker can be shut down at any time.
async function getProtectedTabs() {
  const { protectedTabs = {} } = await chrome.storage.session.get("protectedTabs");
  return protectedTabs;
}

async function refreshToolbar() {
  const { events = [] } = await chrome.storage.local.get("events");
  const s = todaySummary(events);
  const title = s.total
    ? `Clotr — today: ${s.total} found\n${s.redacted} hidden · ${s.allowed} sent · ${s.silenced} just counted`
    : "Clotr — nothing found today";
  await chrome.action.setTitle({ title });

  const tabs = await getProtectedTabs();
  for (const [id, state] of Object.entries(tabs)) {
    const tabId = Number(id);
    // Self-check: a failed edit outranks the count, so a blind tab never looks fine.
    const failed = (state.editFailed || state.uiRemoved) && !state.paused;
    const text = failed ? "!" : !state.paused && s.total ? String(s.total) : "";
    try {
      await chrome.action.setBadgeText({ tabId, text });
      if (text)
        await chrome.action.setBadgeBackgroundColor({
          tabId,
          color: failed || s.riskyAllowed ? BADGE_RED : BADGE_BRAND,
        });
      await chrome.action.setTitle({
        tabId,
        title: !failed ? title : state.uiRemoved ? UI_REMOVED_TITLE : EDIT_FAILED_TITLE,
      });
    } catch {
      delete tabs[id]; // tab is gone
    }
  }
  await chrome.storage.session.set({ protectedTabs: tabs });
}

const UI_REMOVED_TITLE = "This page removed Clotr's warnings, so Clotr can't warn you here.";
const EDIT_FAILED_TITLE =
  "Clotr couldn't edit the chat box on this page. Delete flagged details by hand before sending.";

// A content script (top frame) reports that Clotr is running in its tab. The self-check fields
// (editor seen, last edit failed) come from any frame via clotr:health and are kept.
async function markTab(tabId, paused) {
  const tabs = await getProtectedTabs();
  tabs[tabId] = { editor: false, editFailed: false, ...tabs[tabId], paused: Boolean(paused) };
  await chrome.storage.session.set({ protectedTabs: tabs });
  // A tab-specific icon outranks the declarative "spotted" icon, so protected pages never show the amber dot.
  await chrome.action.setIcon({ tabId, path: ICON(paused ? "off" : "on") });
  await refreshToolbar();
}

function forgetTab(tabId) {
  enqueue(async () => {
    const tabs = await getProtectedTabs();
    if (tabs[tabId]) {
      delete tabs[tabId];
      await chrome.storage.session.set({ protectedTabs: tabs });
    }
  });
}

chrome.tabs.onRemoved.addListener(forgetTab);
async function noteHealth(tabId, msg) {
  const tabs = await getProtectedTabs();
  const t = { paused: false, editor: false, editFailed: false, ...tabs[tabId] };
  if (msg.editor === true) t.editor = true;
  if (typeof msg.editFailed === "boolean") t.editFailed = msg.editFailed;
  if (msg.uiRemoved === true) t.uiRemoved = true;
  tabs[tabId] = t;
  await chrome.storage.session.set({ protectedTabs: tabs });
  await refreshToolbar();
}

// A new page load in the tab: forget it until its content script (if any) reports in again,
// so a later non-AI page in the same tab never gets our badge.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") forgetTab(tabId);
  if (changeInfo.status === "complete") recheckTab(tabId);
});

// Single-page apps (a new ChatGPT chat, grok.com after loading) report "loading" for an in-page
// URL change although the page, and Clotr in it, stay. Ask the tab's Clotr; if it answers,
// restore its state (HC4). A tab without Clotr simply doesn't answer.
function recheckTab(tabId) {
  enqueue(async () => {
    if ((await getProtectedTabs())[tabId]) return;
    let state = null;
    try {
      state = await chrome.tabs.sendMessage(tabId, { type: "clotr:ping" }, { frameId: 0 });
    } catch {
      /* no Clotr in this tab */
    }
    if (!state?.alive) return;
    await markTab(tabId, state.paused);
    await noteHealth(tabId, {
      editor: state.editor === true,
      editFailed: Boolean(state.editFailed),
      uiRemoved: state.uiRemoved === true,
    });
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "refresh-toolbar") return;
  enqueue(refreshToolbar); // rolls "today" over after midnight
  enqueue(pruneEvents);
});

// ---------- Spotting new AI tools ----------

async function loadImageData(path) {
  const blob = await (await fetch(chrome.runtime.getURL(path))).blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

async function installSpotRules() {
  if (!chrome.declarativeContent) return; // Firefox: no page-state rules; the popup's page check still works
  const imageData = {
    16: await loadImageData("icons/icon-spot-16.png"),
    32: await loadImageData("icons/icon-spot-32.png"),
  };
  const conditions = PROMPT_SELECTORS.map(
    (selector) =>
      new chrome.declarativeContent.PageStateMatcher({
        pageUrl: { urlMatches: AI_URL_REGEX },
        css: [selector],
      }),
  );
  await chrome.declarativeContent.onPageChanged.removeRules();
  await chrome.declarativeContent.onPageChanged.addRules([
    {
      conditions,
      actions: [new chrome.declarativeContent.SetIcon({ imageData })],
    },
  ]);
  console.info(LOG, "AI-chat spotting rules installed");
}

// ---------- User-added AI sites ----------

// Keep one dynamic content script whose matches = the sites the user granted.
// Registered under the old product name (ChainSec) before v0.9.2; removed so user-added
// sites don't end up with two registrations.
const LEGACY_USER_SCRIPT_IDS = ["chainsec-user-sites"];

async function syncUserSites() {
  const legacy = await chrome.scripting.getRegisteredContentScripts({ ids: LEGACY_USER_SCRIPT_IDS });
  if (legacy.length) await chrome.scripting.unregisterContentScripts({ ids: legacy.map((s) => s.id) });
  const matches = await userSitePatterns();
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [USER_SCRIPT_ID] });
  if (!matches.length) {
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [USER_SCRIPT_ID] });
    return;
  }
  const script = {
    id: USER_SCRIPT_ID,
    matches,
    js: CONTENT_JS,
    runAt: "document_start", // before page scripts, so Clotr sees Enter first (M8)
    allFrames: true,
    persistAcrossSessions: true,
  };
  if (existing.length) await chrome.scripting.updateContentScripts([script]);
  else await chrome.scripting.registerContentScripts([script]);
  console.info(LOG, "user-added AI sites:", matches);
}

// Start protecting already-open tabs of a newly added site without a reload: only tabs
// inside the sections the user chose, not every page of the host.
async function injectIntoOpenTabs(origins) {
  const hosts = new Set(origins.map((o) => new URL(o.replace(/\*$/, "")).hostname));
  const patterns = (await userSitePatterns()).filter((p) => hosts.has(new URL(p.replace(/\*$/, "")).hostname));
  if (!patterns.length) return;
  const tabs = await chrome.tabs.query({ url: patterns });
  for (const tab of tabs) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: CONTENT_JS });
    } catch (err) {
      console.warn(LOG, "could not start on open tab", tab.id, err);
    }
  }
}

// Seamless updates (D39): start the new version in every open AI tab right after an
// install or update, so nobody has to reload a page. Needs host access to the built-in
// sites (manifest host_permissions = the content-script matches) plus the user's sites.
// An orphaned older copy in the tab steps aside when the new one starts (content.js).
async function startInOpenTabs() {
  const patterns = [...chrome.runtime.getManifest().content_scripts[0].matches, ...(await userSitePatterns())];
  const tabs = await chrome.tabs.query({ url: patterns });
  let started = 0;
  for (const tab of tabs) {
    if (tab.discarded) continue; // a discarded tab reloads (with the new version) when it's opened
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: CONTENT_JS });
      started++;
    } catch (err) {
      console.info(LOG, "could not start in open tab", tab.id, String(err?.message || err));
    }
  }
  if (tabs.length) console.info(LOG, `started in ${started} of ${tabs.length} open AI tabs`);
  return started;
}

chrome.permissions.onAdded.addListener(({ origins = [] }) => {
  enqueue(async () => {
    await syncUserSites();
    await injectIntoOpenTabs(origins);
  }).catch((err) => console.error(LOG, "adding site failed", err));
});

chrome.permissions.onRemoved.addListener(() => {
  enqueue(syncUserSites).catch((err) => console.error(LOG, "removing site failed", err));
});

// Sections changed without a permission change (another section on an already-granted host,
// or one removed): update where Clotr runs.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.siteScopes) {
    enqueue(syncUserSites).catch((err) => console.error(LOG, "site sync failed", err));
  }
});

// ---------- Settings migration ----------

// v0.5: "Don't warn me again" (suppressed.global[id]) became the "log" response.
async function migrateSuppressed() {
  const { suppressed, responses = {} } = await chrome.storage.local.get(["suppressed", "responses"]);
  if (!suppressed) return;
  const next = { ...responses };
  for (const [id, on] of Object.entries(suppressed.global || {})) if (on && !next[id]) next[id] = "log";
  await chrome.storage.local.set({ responses: next });
  await chrome.storage.local.remove("suppressed");
  console.info(LOG, "moved silenced patterns to responses", next);
}

// Every settings migration, oldest first; each is a no-op once done (e2e MIG1 runs this
// on the settings each earlier version saved). One failing doesn't stop the others.
async function runMigrations() {
  for (const step of [migrateSuppressed, migrateToVault, migrateOffToLog]) {
    try {
      await step();
    } catch (err) {
      console.error(LOG, `settings migration ${step.name} failed`, err);
    }
  }
}

// v0.9: there is no "off" any more; everything is recorded (DECISIONS D21). Old "off" → "log".
async function migrateOffToLog() {
  const { responses } = await chrome.storage.local.get("responses");
  if (!responses || !Object.values(responses).includes("off")) return;
  const next = Object.fromEntries(Object.entries(responses).map(([id, r]) => [id, r === "off" ? "log" : r]));
  await chrome.storage.local.set({ responses: next });
  console.info(LOG, "turned old Off settings into Log only");
}

// v0.8: "It's me" (mine) and the watch list (watch) became the vault. It's-me entries keep
// their meaning as "OK to share" items.
async function migrateToVault() {
  const { mine, watch, vault = [] } = await chrome.storage.local.get(["mine", "watch", "vault"]);
  if (!mine && !watch) return;
  const next = vault.slice();
  for (const x of mine || []) next.push({ kind: "value", type: x.type, fp: x.fp, mode: "allow", added: x.added });
  for (const w of watch || []) next.push({ ...w, type: "watch_list" });
  await chrome.storage.local.set({ vault: dedupeVault(next) });
  await chrome.storage.local.remove(["mine", "watch"]);
  console.info(LOG, "moved It's me + watch list into the vault:", next.length, "entries");
}

// ---------- Vault (only this worker writes it; entries hold fingerprints or formats, never values) ----------

const VAULT_KINDS = new Set(["value", "word", "shape"]);
const VAULT_MODES = new Set(["protect", "allow"]);
const vaultKey = (e) =>
  e.kind === "shape" ? `shape:${e.type}:${String(e.shape).toLowerCase()}` : `${e.kind}:${e.type}:${e.fp}`;

function dedupeVault(entries) {
  const seen = new Set();
  return entries.filter((e) => !seen.has(vaultKey(e)) && seen.add(vaultKey(e)));
}

// Accept only well-formed entries, so nothing else (least of all a raw value) is ever stored.
function cleanVaultEntry(e) {
  if (!e || !VAULT_KINDS.has(e.kind) || typeof e.type !== "string" || !/^[a-z_]{2,40}$/.test(e.type)) return null;
  const out = { kind: e.kind, type: e.type, added: Number.isFinite(e.added) ? e.added : Date.now() };
  if (e.kind === "shape") {
    if (typeof e.shape !== "string" || !/[#@].*[#@]/.test(e.shape) || /\d/.test(e.shape) || e.shape.length > 40)
      return null;
    out.shape = e.shape;
  } else {
    if (!/^[0-9a-f]{16}$/.test(e.fp)) return null;
    out.fp = e.fp;
    if (e.kind === "word") out.words = Math.min(4, Math.max(1, Number(e.words) || 1));
    if (e.kind === "value") out.mode = VAULT_MODES.has(e.mode) ? e.mode : "protect";
  }
  if (e.learned) out.learned = true;
  return out;
}

async function vaultAdd(entries) {
  const clean = (Array.isArray(entries) ? entries : []).map(cleanVaultEntry).filter(Boolean);
  const { vault = [] } = await chrome.storage.local.get("vault");
  const before = new Set(vault.map(vaultKey));
  const next = dedupeVault(vault.concat(clean));
  await chrome.storage.local.set({ vault: next });
  return {
    added: clean.filter((e) => !before.has(vaultKey(e))).length,
    rejected: (entries?.length || 0) - clean.length,
  };
}

// Moving to a new computer (pre-release Batch 5): a backup's settings, vault and salt replace this browser's.
// Everything is cleaned again here (Backup.clean, cleanVaultEntry), so a changed file can store nothing else.
// A setting the file doesn't have goes back to its default; this browser's salt stays if the file has none.
// History isn't touched.
async function importBackup(settings) {
  const clean = globalThis.Clotr.Backup.clean(settings);
  const vault = dedupeVault((clean.vault || []).map(cleanVaultEntry).filter(Boolean));
  const next = { ...clean, vault };
  const drop = globalThis.Clotr.Backup.KEYS.filter((k) => !(k in next) && k !== "salt");
  if (drop.length) await chrome.storage.local.remove(drop);
  await chrome.storage.local.set(next);
  return { ok: true, vault: vault.length, responses: Object.keys(clean.responses || {}).length };
}

async function vaultUpdate(key, change) {
  const { vault = [] } = await chrome.storage.local.get("vault");
  const next =
    change === "remove"
      ? vault.filter((e) => vaultKey(e) !== key)
      : vault.map((e) =>
          vaultKey(e) === key && e.kind === "value" && VAULT_MODES.has(change) ? { ...e, mode: change } : e,
        );
  await chrome.storage.local.set({ vault: next });
  return { ok: true };
}

// ---------- Learning from ignores (type + timestamps only, never values) ----------

const DAY = 86400000;
const IGNORES_TO_OFFER = 3;
const validType = (t) => typeof t === "string" && /^[a-z_]{2,40}$/.test(t);

// The user kept a warning of these types. Returns a type to offer relaxing, if one is due:
// kept 3 times within 14 days, and not declined within the last 30 days.
async function noteIgnored(types) {
  const now = Date.now();
  const { ignores = {}, relaxDeclined = {} } = await chrome.storage.local.get(["ignores", "relaxDeclined"]);
  for (const t of (Array.isArray(types) ? types : []).filter(validType)) {
    ignores[t] = (ignores[t] || []).filter((x) => now - x < 14 * DAY).concat(now);
  }
  await chrome.storage.local.set({ ignores });
  const offer = Object.keys(ignores).find(
    (t) => types.includes(t) && ignores[t].length >= IGNORES_TO_OFFER && !(now - (relaxDeclined[t] || 0) < 30 * DAY),
  );
  return { offer: offer || null, count: offer ? ignores[offer].length : 0 };
}

async function relaxAnswer(id, accepted) {
  if (!validType(id)) return { ok: false };
  const { ignores = {}, relaxDeclined = {} } = await chrome.storage.local.get(["ignores", "relaxDeclined"]);
  delete ignores[id];
  if (!accepted) relaxDeclined[id] = Date.now();
  await chrome.storage.local.set({ ignores, relaxDeclined });
  return { ok: true };
}

// ---------- Updates (no network: DECISIONS D25) ----------
// Store installs are updated by the Chrome Web Store. An unpacked install (developer, or
// someone running from a git clone that a script keeps pulled) re-reads its own manifest
// from disk every minute and reloads itself when the version changed.

const IS_UNPACKED = !("update_url" in chrome.runtime.getManifest());

async function localVersionOnDisk() {
  const res = await fetch(chrome.runtime.getURL("manifest.json"), { cache: "no-store" });
  return (await res.json()).version;
}

// A reload restarts Clotr in open tabs (D39), which closes any dialog or warning they show,
// so it waits while one is open: at most MAX_UPDATE_WAIT, then updates anyway (D38).
const MAX_UPDATE_WAIT = 2 * 60 * 60000;

async function tabBusy(tabId) {
  try {
    return (await chrome.tabs.sendMessage(tabId, { type: "clotr:busy?" })) === true;
  } catch {
    return false; // no Clotr in that tab, or nothing open: no frame answered
  }
}

// A developer copy can follow a "live" line of commits: a local updater writes local-update.txt (git-ignored,
// never packaged) after each update, so new files reload Clotr without a version bump. "" when there's none.
async function localStampOnDisk() {
  try {
    const res = await fetch(chrome.runtime.getURL("local-update.txt"), { cache: "no-store" });
    return res.ok ? (await res.text()).trim().slice(0, 200) : "";
  } catch {
    return "";
  }
}

async function checkForLocalUpdate() {
  if (!IS_UNPACKED) return false;
  const onDisk = await localVersionOnDisk();
  const running = chrome.runtime.getManifest().version;
  const stamp = await localStampOnDisk();
  const { localStamp } = await chrome.storage.session.get("localStamp");
  if (localStamp === undefined) await chrome.storage.session.set({ localStamp: stamp }); // this run's starting point
  const restamped = localStamp !== undefined && stamp !== localStamp;
  if (onDisk === running && !restamped) return false;
  const tabIds = Object.keys(await getProtectedTabs()).map(Number);
  const busy = (await Promise.all(tabIds.map(tabBusy))).some(Boolean);
  if (busy) {
    let { updateWaitingSince } = await chrome.storage.session.get("updateWaitingSince");
    if (!updateWaitingSince) {
      updateWaitingSince = Date.now();
      await chrome.storage.session.set({ updateWaitingSince });
    }
    if (Date.now() - updateWaitingSince < MAX_UPDATE_WAIT) {
      console.info(LOG, `files updated on disk (${running} → ${onDisk}); waiting: a Clotr dialog or warning is open`);
      return false;
    }
  }
  console.info(LOG, `files updated on disk (${running} → ${onDisk}${restamped ? ", new local build" : ""}); reloading`);
  await chrome.storage.session.remove("updateWaitingSince");
  await chrome.storage.session.set({ localStamp: stamp }); // never reload twice for the same files
  chrome.runtime.reload();
  return true;
}

function scheduleUpdateCheck() {
  if (IS_UNPACKED) chrome.alarms.create("local-update-check", { periodInMinutes: 1 });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "local-update-check") checkForLocalUpdate().catch(() => {});
});

// ---------- Lifecycle ----------

chrome.runtime.onInstalled.addListener((details) => {
  // After an update, the popup shows "Updated to vX: what's new" once (from changelog.json).
  if (details?.reason === "update" && details.previousVersion !== chrome.runtime.getManifest().version) {
    chrome.storage.local.set({
      lastUpdate: {
        from: details.previousVersion,
        to: chrome.runtime.getManifest().version,
        t: Date.now(),
        seen: false,
      },
    });
  }
  scheduleUpdateCheck();
  // First install: ask "What should I protect?" once. Everything on that page is optional.
  if (details?.reason === "install")
    chrome.tabs.create({ url: chrome.runtime.getURL("vault.html?welcome=1") }).catch(() => {});
  enqueue(runMigrations).catch((err) => console.error(LOG, "settings migration failed", err));
  enqueue(ensureSalt).catch((err) => console.error(LOG, "salt setup failed", err));
  enqueue(syncUserSites).catch((err) => console.error(LOG, "site sync failed", err));
  if (details?.reason === "install" || details?.reason === "update") {
    startInOpenTabs().catch((err) => console.warn(LOG, "could not start in open tabs", err));
  }
  installSpotRules().catch((err) => console.error(LOG, "spotting rules failed", err));
  chrome.alarms.create("refresh-toolbar", { periodInMinutes: 30 });
  enqueue(refreshToolbar).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  scheduleUpdateCheck();
  enqueue(syncUserSites).catch((err) => console.error(LOG, "site sync failed", err));
  enqueue(refreshToolbar).catch(() => {});
});

// ---------- First-time tips (D43): which kinds of data the user was already guided about ----------

async function markGuided(id) {
  if (!validType(id)) return { ok: false };
  const { guided = {} } = await chrome.storage.local.get("guided");
  if (!guided[id]) {
    guided[id] = Date.now();
    await chrome.storage.local.set({ guided });
  }
  return { ok: true };
}

// ---------- Keyboard: Alt+Shift+C jumps to Clotr's warning (M4 accessibility) ----------

function handleCommand(command, tab) {
  if (command === "focus-notice" && tab?.id)
    chrome.tabs.sendMessage(tab.id, { type: "clotr:focusNotice" }).catch(() => {});
}
chrome.commands?.onCommand.addListener(handleCommand); // none on Firefox for Android

// ---------- Messages from content scripts / popup ----------

// Clotr's own pages (vault, settings, move), as opposed to its scripts inside AI sites, which share their page with
// the site's code and so never get to remove or loosen a protected detail (release review 2026-09-30).
const fromClotrPage = (sender) => (sender.url || "").startsWith(chrome.runtime.getURL(""));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;

  const reply = (task) => {
    enqueue(task)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: String(err) }));
    return true; // respond asynchronously
  };

  switch (msg?.type) {
    case "clotr:getSalt":
      return reply(async () => ({ salt: await ensureSalt() }));
    case "clotr:events":
      return reply(async () => {
        const count = await appendEvents(msg.events);
        await refreshToolbar();
        return { ok: true, count };
      });
    case "clotr:vaultAdd":
      return reply(() => vaultAdd(msg.entries));
    case "clotr:vaultUpdate":
      // Only the vault page removes an entry or switches it to "allow".
      if (!fromClotrPage(sender)) return false;
      return reply(() => vaultUpdate(msg.key, msg.change));
    case "clotr:importBackup":
      // Only from Clotr's own pages (the "Move to a new computer" section), never from a website's tab.
      if (!fromClotrPage(sender)) return false;
      return reply(() => importBackup(msg.settings));
    case "clotr:ignored":
      return reply(() => noteIgnored(msg.types));
    case "clotr:guided":
      return reply(() => markGuided(msg.id));
    case "clotr:relaxAnswer":
      return reply(() => relaxAnswer(msg.id, msg.accepted));
    case "clotr:getSettings":
      return reply(() => settingsFor(sender.url || sender.tab?.url || ""));
    case "clotr:setBandage":
      return reply(() => setBandage(sender.url || sender.tab?.url || "", msg.on));
    case "clotr:setResponses":
      return reply(() => setResponses(msg.ids, msg.value));
    case "clotr:health":
      if (!sender.tab?.id) return false;
      return reply(async () => {
        await noteHealth(sender.tab.id, msg);
        return { ok: true };
      });
    case "clotr:tabState":
      if (!sender.tab?.id) return false;
      return reply(async () => {
        await markTab(sender.tab.id, msg.paused);
        return { ok: true };
      });
    default:
      return false;
  }
});
