# How Clotr is put together

For contributors: where things live, how the parts talk, and what is stored. Design decisions are numbered
(`D30`…): see [design-notes.md](design-notes.md). Security findings (`S18`…) are in
[security-review.md](security-review.md).

## The extension (`extension/`, the folder you load unpacked)

### Content scripts (in AI chat pages)
Classic scripts, no `import`/`export`: they share code through `globalThis.Clotr` and load in this order. The
list must be the same in `manifest.json` and in `sites.js` → `CONTENT_JS` (for sites people add), and `popup.html`
loads the first two (all rule-checked).
1. `patterns.js`: what to look for. A pattern has either a `regex` (plus an optional `validate`; `secret: true`
   drops placeholders) or a `find(text)`. Phone numbers, SSNs and emails use `find` with the number reader
   (`numberRuns`) to catch spelled-out and mixed forms; passwords use `findSecrets` (context words). Also
   `Clotr.msg()` for translations.
2. `detector.js`: `detect()`, each kind's response (`responseFor()`), the text cleaner (invisible characters,
   look-alike digits, D51), `normalize()` with a synchronous `sha256()` → `fingerprint()`, and `redact()`.
3. `attachments.js`: `Clotr.readAttachment(file)` reads text, PDF and Office files locally, with hard size caps.
4. `ui-styles.js`: `Clotr.styles`, the CSS for the dialog, the corner warning and the reload prompt (all in closed
   shadow roots).
5. `editor.js`: `Clotr.editor` finds the chat box (never a sign-in field) and replaces its text so the page's own
   framework sees real input, and checks that the edit took (`replaceText()` → true/false). If
   `execCommand("insertText")` doesn't work, it falls back to an input event (text boxes) or a `beforeinput` event
   (rich editors), never a direct rewrite of a rich editor's content.
6. `content.js`: watches what's typed, runs detection and responds per kind: the *Ask before sending* dialog, the
   corner warning, or just counting. It holds a send only when asked to, and reports what happened to the
   background. Wording (D40, D47): **Hide it / Leave it in**, plus **More choices** (this one is fine to share →
   vault "allow"; stop warning me about this kind → just count; hide it and always watch for it → vault "protect").
   Keys (D36, D41, `guardKeys()`): Space never chooses; Enter does nothing for 0.6 s or while held, then presses the
   focused button or the forward one; Esc or Backspace go back to the message (the dialog returns on send).

### The rest
- `manifest.json`: Manifest V3. The content-script `matches` and `host_permissions` are generated from
  `ai-sites.json` by `npm run sites` and must stay equal (rule-checked).
- `ai-sites.json`: the built-in AI sites (`{ name, matches }`); the popup shows the names.
- `background.js`: the service worker. The only writer of history and of the fingerprint salt (through a queue);
  toolbar icon, badge and tooltip; the rules that spot unknown AI chats; registers sites people add; after an install
  or update it starts the new version in open AI tabs (`startInOpenTabs()`, D39), and the old copy steps aside on the
  page event `clotr:hello` or asks for a reload if nothing replaced it.
- `sites.js`: shared by the background and the popup (not a content script): built-in site helpers, spotting rules,
  the on-demand page check, and the team policy: `mergePolicy()` (an admin's raw managed storage plus a chosen
  `preset`, explicit fields winning field by field, D62/D115), `applyPolicy()` (the floor over the person's own
  choice, `Clotr.stricter`), `floorOf()` (whether one kind is a required block, so the background can keep a vault
  "OK to share" entry or a site's "Just count" from weakening it), `policyWords()`/`policyShapes()` (watch words
  and watch formats like `EMP-#####`), `policyFingerprint()` (a stable, unsalted short code for one merged policy,
  team-pack design 3.7) and `hasPolicy()` (whether the merged policy actually sets anything).
- `popup.html/css/js`: the toolbar popup (Overview, Activity, Settings).
- `vault.html/css/js`: "What should I protect?" Opens once on install and from Settings; turns each typed line into
  a fingerprint (or a format) before anything reaches the background.
- `stored.html/css/js`: "What Clotr stores": every stored record (salt hidden) and the known limits. Its *Move to
  a new computer* section is `move.js` with `backup.js` (shared with the background): one file with the settings, the
  vault, the salt and the PIN hash, encrypted on the computer (PBKDF2-SHA-256 600,000 rounds, AES-GCM 256) with a
  password the person chooses. Loading it sends `clotr:importBackup` (Clotr's own pages only); the background cleans
  every key again (`Backup.clean`, `cleanVaultEntry`) and replaces those keys. History never moves.
- `dashboard.html/css/js`: "Your AI exposure report". Reads history only and never shows fingerprints.
  `insights.js` holds the plain-words advice (`adviceFor()`) and the mind map's model (`exposureModel()`,
  `buildMindMapTree()`, D75); `mindmap.js` lays it out (`layoutRadial()`, or `layoutList()` on a narrow window) and
  draws it with its motion and table view. Both are shared with the popup's small version.
- `helper.html/css/js`: "Set Clotr up for someone", the guided setup (Settings → *Set it up step by step*): their
  details (opens the vault), larger warnings, ask before personal details, a PIN. `helper-core.js` holds what it
  shares with the popup's Settings: the PIN hash and check, the 10-minute unlock in session storage, and the
  personal-details group switch (D61).
- `share.html/css/js`: "Share Clotr with someone" (Settings, and the end of the guided setup): the link to send and a
  one-page guide to print, black on white whatever the theme. The website has the same guide as `site/guide.html`.
- `fonts/`: Atkinson Hyperlegible (SIL OFL, `fonts/OFL.txt`), bundled for Clotr's own pages only (D77).
- `managed_schema.json`: what an administrator can set through browser policy (D62, [team-rollout.md](team-rollout.md)).
- `policy.html/css/js`: "Organization policy applied here" (popup Settings → *See what's applied*), an unsigned,
  printable self-attestation: the organization, the version, date and browser, the preset (or "Custom", or
  "with organization changes"), the policy fingerprint, and counts of kinds by response, watch words and watch
  formats. Reads the managed policy and the manifest only; writes and sends nothing.
- `_locales/`: Spanish in `es/messages.json` (`en/` holds only the manifest description). Code calls
  `Clotr.msg(key, "English with $1", value)`; kinds of data are translated as `type_<id>`. Pages mark elements with
  `data-i18n="key"` (or `data-i18n-aria-label`, `-title`, `-placeholder`), keep the English in the HTML and load
  `page-i18n.js` first. Every key in use needs a Spanish message (rule-checked).
- `changelog.json`: "What's new", shown once after an update. A new minor version needs an entry, with a Spanish
  translation of the same length (rule-checked).
- `icons/`: generated by `tools/make-icons.js` from the brand tile in `tools/brand.js` (on = protecting, off =
  default, spot = AI chat spotted). The README header, social card and store promo tiles come from
  `tools/make-brand.js` (`npm run brand`).

The website is `site/` (D81): `index.html` and `style.css` are written by hand; `npm run site` (`tools/make-site.js`)
builds its assets (the animated mind map, the tile, favicons, screenshots, fonts). It runs no script and loads nothing
from other sites (rule-checked). The `Website` workflow publishes it to GitHub Pages from the public repo only.

## Messages and storage
Storage is locked to Clotr's own pages (S20): content scripts never touch `chrome.storage` (rule-checked). They
ask the background with `clotr:getSettings` (their own site's pause and mode, plus `responses`, `vault`, `guided`
`largeText` and `replyCheck`) and change responses with `clotr:setResponses`; the background sends `clotr:settingsChanged` to
open tabs when those keys change. **Nothing stored is ever a detected value.**

`chrome.storage.local`:
- `responses`: `{ [kindId]: "block" | "warn" | "log" }`, overrides only. The default is `warn` for every kind
  (`defaultResponse()` in `detector.js`; nothing blocks until someone chooses it, D1). There is no "off": every
  detection is recorded (D21); an old stored "off" reads as "log" and `migrateOffToLog()` rewrites it. "More choices
  → stop warning me about this kind" sets `log` (D40). Replaced v0.4's `suppressed` (`migrateSuppressed()`).
- `paused`: `{ [hostname]: true }`.
- `siteModes`: `{ [hostname]: "block" | "log" }`, a per-site "stricter here" / "quieter here" on top of `responses`.
- `guided`: `{ [kindId]: time }`, the kinds whose first-time tip was shown (D43); "Show first-time tips again" clears it.
- `advanced`: `true` shows the popup's advanced options; off by default (simple mode, D42).
- `ignores`: `{ [kindId]: [times] }` of explicit keep/allow clicks (last 14 days), and `relaxDeclined`:
  `{ [kindId]: time }`. After 3 keeps the warning offers "just count it". Learning from a deletion keeps its state in
  the page only, and adds to the vault only on the person's click.
- `vault`: `[{ kind: "value" | "word" | "shape", type, fp?, words?, shape?, mode?, added, learned? }]`. `value` = the
  fingerprint of a phone, email, address… as the patterns find it (`mode`: `protect` = always at least warn, even if
  that kind is set to just count; `allow` = fine to share); `word` = the fingerprint of a lowercased phrase of up to 4
  words (`my_name`, `family_name`, `employer`, `watch_list`); `shape` = a format like `@@-######`. An example ID typed
  on the vault page also adds a `value` of type `my_id`, so your own ID is told apart from others in the same format
  (`splitOwnIds()`, D23). Only the background writes it (`clotr:vaultAdd`, `clotr:vaultUpdate`), and it rejects
  anything that isn't fingerprint- or format-shaped. v0.7's `mine`/`watch` were migrated by `migrateToVault()`.
- `events`: `[{ t, site, type, name, severity, action, fp }]`, newest last, capped at 10,000 (`MAX_EVENTS`).
  `action` is `redacted` (hidden), `allowed` (sent, including a warned item that was sent) or `suppressed`
  (a just-counted detection).
- `mentions`: the same shape with `action: "mentioned"`: an AI reply brought up one of your vault details (D63),
  capped at 2,000, pruned and deleted with `events`. Kept apart so it never counts as something found.
- `replyCheck`: `false` switches the reply check off (Settings); on by default.
- `spotted`: `{ [hostname]: true }`, AI tools spotted when the popup was opened on them that Clotr doesn't protect
  (names only, at most 200), for the mind map's blind spots; written by the popup, cleared with the history.
- `keepDays`: 90, 365 or 730 (default 365, D54), how long `events` are kept; pruned only by the background.
- `largeText`: `true` = larger warnings (D61).
- `lock`: `{ salt, iterations, hash }` of the helper PIN (salted PBKDF2-SHA-256, D61), never the PIN itself.
- `salt`: random hex, created only by the background. Event `fp`s use the same normalized `fingerprint()` (synchronous
  SHA-256, so a send can be checked against the vault instantly).
- `siteScopes`: `{ ["https://host/*"]: [section patterns] }`. Sites people add are the granted optional host
  permissions, narrowed by this: on a *shared host* (one whose built-in entry is only a section, such as
  huggingface.co) "Protect this site" records the page's section (`protectScope()`), and Clotr runs only there. No
  entry = the whole host. `userSitePatterns()` returns where Clotr runs (D35).

`chrome.storage.session`:
- `protectedTabs`: `{ [tabId]: { paused, editor, editFailed, uiRemoved } }` for the badge and the self-check (D58):
  `editor` = a chat box was seen; `editFailed` = the last *Hide it* didn't take; `uiRemoved` = the page removed Clotr's
  warning, so it no longer holds messages there (S21). The last two show a red **!**. Restored after in-page
  navigation by `recheckTab()`.
- `unlockedUntil`: 10 minutes after a correct helper PIN.

## Tests and tools
- `npm test`: detection unit tests (`tests/patterns.test.js`), attachments, sites, packaging, and the rule checks
  (`tests/rules.test.js`): classic scripts only, narrow site access, no `innerHTML`, no network code, logs without
  values, `setIcon` always with a `tabId`, workflows read-only and pinned. Add a test for every new pattern, missed
  detail or false alarm, and a rule check for every new hard rule.
- `npm run lint` (Prettier and ESLint); `npm run format` fixes formatting.
- `npm run test:e2e`: drives a real browser (Brave, Chrome or Edge, found automatically) with the extension loaded,
  against the fake AI pages in `tests/e2e/pages/`; every other request is blocked. `--only <ID>`, `--headed`,
  `--ext <dir>` (run against another copy). Output and screenshots: `tests/e2e/output/`.
- `npm run test:stress` (huge pastes, many tabs, a full history, a day-long tab) and `npm run test:firefox`.
- `npm run package`: the release zip and its SHA-256 (`tools/package.js`, reproducible, D55); `-- --firefox` for
  the Firefox build.
- `npm run site-check`: opens each built-in site logged out and compares it with `tools/site-baseline.json` (D59).
- `tools/draft-leak-monitor.js`: shows whether a site sends anything typed before Send.
