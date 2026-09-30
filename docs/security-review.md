# Clotr security review (M5, 2026-09-24, v0.9.16)

Scope: everything in `extension/` plus the update tooling in `tools/`. Method: code review of every
entry point, plus automated checks that now run on every change (listed at the end).

## Found and fixed
| # | Finding | Impact | Fix | Test |
|---|---------|--------|-----|------|
| S1 | **ReDoS in the email pattern**: unbounded repeats backtracked quadratically; 20k characters like `a-a-a-…` took ~3 s | Any page (or a pasted log) could freeze typing and Enter | Parts bounded by their real limits (local part 64, domain 253, label 63) | Unit "no pattern is slow on hostile text" (fuzz of every pattern) |
| S2 | Same class in the internal-hostname pattern (~0.3 s per 20k characters) | Smaller freeze | Labels bounded to 63, at most 8 | Same fuzz |
| S3 | Same class in the street-address pattern (4 s per 40k characters of number words), found in M3 | Enter froze | Spelled-out house numbers capped at 8 words (0.9.7) | Unit budget test, e2e PERF1 |
| S4 | After an update, the orphaned copy's dialog couldn't close and blocked Enter (M3) | The chat could get stuck | Extension calls can't throw into the UI; the orphaned copy only warns (0.9.5, 0.9.9) | e2e FO1–FO4 |

## Reviewed, no change needed
- **Who can talk to Clotr.** No `externally_connectable` and no web-accessible resources, so web pages can't message the extension or load its pages. The background accepts messages only from Clotr's own scripts (`sender.id` check) and validates every write: events are rebuilt field by field (`sanitize`), vault entries must be fingerprint- or format-shaped (`cleanVaultEntry`), type ids must match `^[a-z_]{2,40}$`.
- **Page scripts vs. Clotr's UI.** The dialog and notice live in closed shadow roots; page scripts can't read them or press their buttons (synthetic events don't activate buttons, and the page has no reference to them). Detected values are masked in the UI anyway.
- **The fingerprint salt** reaches only Clotr's content-script world (isolated from page scripts) and extension pages; "What Clotr stores" hides it.
- **No remote code, no network.** No `eval`/`Function`, no `innerHTML` (rule-checked), no `fetch` except the extension's own `manifest.json` for the local update check (rule-checked).
- **Permissions.** Built-in AI sites only; other sites only after the user clicks "Protect this site" and approves one host (optional permission), narrowed to the chosen section on shared hosts (D35).

## Added in M8 (2026-09-24, v0.9.27–0.9.31)
| # | Finding | Fix | Test |
|---|---------|-----|------|
| S5 | Invisible or look-alike characters from copied text (no-break spaces, zero-width spaces, full-width digits…) hid leaks | Text cleaned before checking; matches map back to the original (D51) | unit + e2e UN1; rule: no raw invisible/bidi characters in shipped files |
| S6 | Paste-then-Enter sent before the warning could be read | "Just sent" after a confirmed send (D52) | e2e FS1–FS3 |
| S7 | Word/Excel/PowerPoint attachments were never read | Unzipped with hard zip-bomb caps; fail open | e2e R8d/R8x/R8z |
| S8 | An attached file's name was logged | Only the extension is logged | rule: no values/drafts/file names in logs |
| S10 | PDF parsing on attacker-controlled files: a regex stream finder took 24 s on 900 KB of unclosed dictionaries | Linear, bounded scanners (indexOf + capped windows); inflation capped | unit growth tests; e2e R8p/R8q/R8r |
| S13 | Office documents: the XML tag stripper (`/<[^>]*>/g`) took 54 s on 600 KB of `<a <a <a…` (under every size cap) | One linear pass; entities looked up at most 10 characters ahead | unit growth test (`assertLinear`) |
| S14 | PDFs without stream lengths: up to 400 searches to the end of a 20 MB file | Search capped to 2 MB ahead and 50 such streams | e2e R8s |
| S15 | Clotr started after the page's scripts (document_idle): a site's own early window-level Enter handler could send before Ask before sending held the message | Start at document_start (built-in and user-added sites) | e2e EG1 (reproduced first); rule check; real ChatGPT re-checked |
| S11 | Unlabeled send buttons bypassed Ask before sending | Composer buttons count as possible sends; Warn records only after the box empties (D53) | e2e UB1–UB3b |
| S12 | Vault fields could be kept in the browser's restore data or sent to cloud spell check | autocomplete/spellcheck off, cleared on pagehide | e2e V1s |
| S16 | Release packaging shipped every file in `extension/` except logs: a personal note, saved chat or editor backup left in the folder would have gone into a public zip | Only files git tracks are packaged (warning outside a git checkout); zips are reproducible with published SHA-256 (D55) | unit test: an untracked file with a phone number never reaches the zip |
| S17 | Sign-in pages on AI hosts: a username field, a password shown as text ("show password"), a one-time code or a sign-up form was watched like a chat box, so Clotr warned there and could record a fingerprint of your own login details | Inputs that are clearly sign-in fields (autocomplete hints, password/code names or labels, or in a form with a password field) are left alone (D56) | e2e LG1 (proven to fail before the fix; the chat box on the same page still warns) |
| S18 | Hide it (then called Cover it) could fail silently: on an editor that applies edits later (Kimi), the key stayed in the box (plus a hidden copy), the notice closed and history said *Hidden*, so a user would send it believing it was gone | Clotr waits for the editor's own update, records *Covered* only when the text really changed, and otherwise says "Clotr couldn't cover it here… delete it by hand" | e2e KM1, KM2 (both fail before the fix); verified on kimi.com |
| S19 | Tab state lost after an in-page navigation: sites that change their URL without reloading (a new ChatGPT chat, grok.com right after loading) made the background forget the tab, so the badge vanished and the tab looked unprotected | When a load completes and the tab is unknown, the background asks the tab's Clotr and restores its state from the answer | e2e HC4 (fails before the fix); verified on grok.com |
| S20 | The part of Clotr running inside AI pages could read all of Clotr's storage (your whole history across AI sites, every site's settings, the salt) and write any of it | Storage is locked to Clotr's own pages and worker; the in-page part asks by message for just what it needs (its own site's pause and mode, responses, vault, tips) and can only change responses through a checked message. **Still true:** it gets the vault fingerprints and the salt, because fingerprints are made inside the page so your typed text never leaves it; Firefox has no storage lock | e2e SEC1 (fails before the fix), rule check (content scripts never use storage), Firefox 4/4 |
| S21 | A page that removes Clotr's dialog (hostile, or an app rebuilding the page) left you stuck with *Ask before sending*: every Enter was held and the dialog never showed; focus was left on the page, not the chat box | Clotr notices its box vanishing without it closing it: it stops holding messages on that page (fail open, D30), gives the keyboard back to the chat box, and the self-check says "This page removed Clotr's warnings" (red ! badge) | e2e HP1 (stuck before the fix), HP3 |
| S22 | Found while testing S21: since the storage lock (S20) a chat tab still starting up could miss a settings change (made in the popup meanwhile) until it was hidden and shown again | Changes are announced to every tab, not only those already registered | e2e SET1; EG1 caught it |
| S23 | Can a hostile page plant fake entries in your history by filling and emptying its own chat box with no user action? | Not in the test: a page that filled its box with a detail and emptied it by script, with no Enter or click from you, left nothing recorded as *sent* | e2e HP2 (kept as a regression test) |
| S24 | **A page could probe your vault.** It could put guesses ("Emma? Liam?") in its own chat box by script, fire a fake input event or Enter, and watch whether Clotr's warning appeared; vault names only warn when they're yours, so that revealed them. The reply check (D63) was a second way: after one real send, the page could add guess after guess as "reply" text for 90 seconds | Clotr reacts only to events from the person (or a site's script right after a real key or click, via the browser's user-activation signal; where a browser can't tell, as before). The reply is checked once per message sent, after it has been quiet for 3 seconds | e2e SEC2, SEC3, RP5 |
| S9 | Clotr's pages could have connected out if a future change tried | Strict CSP: `connect-src 'self'`, `object-src 'none'`, … | rule + e2e CSP1 (proven to fail without it) |

Checked on real sites (logged out, fake data): ChatGPT, Gemini and Grok send nothing typed before Send (`tools/draft-leak-monitor.js`, with a positive control).

- **Full report (0.9.37–0.9.40).** Reads history only; fingerprints are used for counting and never shown (e2e DSH2); every value is set as text, never markup; the export is a file the user asks for, without the fingerprint secret, so its fingerprints can't be matched against guesses (DSH3); retention is validated in the background (only 90/365/730 days). The share card holds counts only.

## Bandage and the live line (0.9.95-0.9.98, reviewed 2026-09-29)
- **Cover names while typing.** The label ↔ detail map exists only in the page's memory, keyed by a salted fingerprint;
  nothing new is stored. Events record only that a detail was covered (`via: "bandage"`) with its fingerprint. Keys and
  passwords are never covered, so they always keep their warning. If a chat box refuses the edit, the detail falls back
  to the normal warning (D30). The per-site on/off setting is set only by a message from that site's own tab.
- **Hover to peek.** The AI's page is never changed: labels are found with live Ranges, and Clotr's hotspots and bubble
  live in closed shadow roots. The page can see that a Clotr element appeared, never what it shows. The bubble shows the
  person their own detail on purpose (D93): these are personal details, not keys, which stay masked everywhere. A page
  that plants a fake label gets a hotspot but learns nothing. "Copy with real names" writes to the clipboard only on a
  click. e2e BN8 checks the reply's HTML stays exactly as the site wrote it.
- **Reading replies for labels.** With Bandage on, the reply window (D63) also looks for Clotr's own labels, for 90
  seconds after a send; nothing from a reply is kept.
- **The live line (developer copies only).** The unpacked build reloads when `local-update.txt` changes; it's
  git-ignored and packaging takes only tracked files, so it can't ship. Only someone who can already write to the
  extension's folder can trigger a reload.
- **Backups** carry the Bandage setting, checked as host → true/false on load.

## The small-team pack (0.9.101, reviewed 2026-09-29)
- **No new permissions** (the manifest changes only its version); `storage.managed_schema` gains the preset, `orgName`
  and format fields, all typed and capped.
- **The "policy applied" page** (`policy.html/js`) reads the managed policy only; it writes nothing (e2e PA2 checks
  `storage.local` before and after), makes no request beyond the extension's own files (PA2), and builds every field
  with `textContent`. The office's watch words appear only after the person ticks the box; the fingerprint is a hash of
  the policy, not of anything typed.
- **The floor** (`Clotr.stricter`, D115): block over warn over count; an unknown response counts as warn. A person's
  own "OK to share" entry, or a site set to "Just count", stays saved but can't lower a required response while the
  policy holds (e2e TM3). Warnings still never stop a message on their own (D30).
- **Watch formats** (`EMP-#####`): at most 20 formats of at most 40 characters, read by the vault's existing format
  matcher (covered by the ReDoS fuzz); a format is never hashed as a literal phrase.
- No blocking issues.

## The release candidate (1.0.0-1.0.9, reviewed 2026-09-30)
Scope: everything in `extension/` that changed since the small-team pack's review (586 lines), the public export
and the website's split. Method: the diff line by line, a search for every API that sends, stores, runs code or acts on
the page, and the ReDoS and timing sweep on hostile input (50,000 characters of letters, digits, number words,
misspellings, brackets, zero-width characters, key and email look-alikes).

| # | Finding | Impact | Fix | Test |
|---|---------|--------|-----|------|
| S25 | **Reading a long run of digits was quadratic**: for every digit added to a run, the list-marker check ("1.", "2)") walked the whole run first; 40,000 digits took about a second (older than 1.0; 0.9.101 did the same) | A huge numeric paste froze the chat page for a second or more | The cheap tests first (at most 3 digits, a "." or ")" gap); the worst case of the sweep went from 958 ms to 130 ms (1.0.9) | Unit test: four times the digits take about four times as long |

- **No new permissions** since 0.9.101: the manifest changed its name and version only.
- **Report a problem** (`report.js`, D119, D120) opens GitHub's issue forms with `noopener`. The address carries only
  the form, Clotr's version, the browser, and the AI site's name if the person ticked "Include this site": never typed
  text, a stored value or a fingerprint. The false-alarm link names only the kind of detail. A warning that reports are
  public comes before any choice.
- **Leave it in and send** (D121) acts only after the person's own click (or Enter) on Clotr's dialog, which lives in a
  closed shadow root the page can't reach, and only through what they used: their button or form, or for Enter the
  site's send button near the chat box, else Enter again. The page can't start it. Allowed details stay in memory for
  that one message; nothing is stored.
- **The reply window** (1.0.8) stays open up to 90 seconds to place cover-name hotspots in Clotr's own layer; it reads
  only text the page shows, and the vault's reply check still runs once per message (S24).
- **The edit check** (1.0.7) ignores zero-width characters when it compares the chat box with Clotr's text; it changes
  no detection.
- **Moving to a new computer** says what a file holds and what came back in counts only ("3 vault items, a PIN"),
  never a detail or the PIN.
- **Names and addresses** (1.0.6): the report address points at github.com/BilliamBaSH/clotr, and the Firefox add-on ID
  is clotr@billiambash. The public repo has to carry that name before Clotr goes public, so the address in the
  extension never points at someone else's repo.
- **The public export** (D124, Q46) holds the extension, its tests and build tools, and the docs about the extension;
  a --strict word check fails it on funding, prices, planning or AI-tooling words; pictures are only the README's.
- No blocking issues.

## Accepted limits
- **A hostile AI site can defeat Clotr on its own pages**: remove the warning (Clotr then says so and stops holding messages there, S21), imitate Clotr's warning, or cover its buttons so a click lands elsewhere. Planting fake *sent* entries by scripting its chat box doesn't work (S23). Clotr's warnings never ask you to type anything, so an imitation can't collect details. It can't learn anything it doesn't already receive, since it is the site the text is going to, with two narrow exceptions that need you to act: text it adds to your chat box while you type is checked with yours (you would see it in your box), and a reply is checked once per message you send, so it can test one guess per message against your vault (S24). Mitigation would need browser support that doesn't exist for extensions.
- **Fingerprints of short values are guessable** by someone with full access to this browser profile (D22), disclosed on "What Clotr stores".
- **Update tooling trusts `main`.** `tools/auto-update.ps1` / `.sh` fast-forward a clone of `main`, and an unpacked install reloads itself: whoever can push to `main` can ship code to that computer within the hour. Recommended (a GitHub setting only the owner can change): protect `main` (require a PR and green CI; no force pushes). See D44.

## Automated from now on
`npm test`: ReDoS fuzz of every pattern, performance budgets, false-alarm corpus, no network calls / innerHTML / remote code, manifest scope. `npm run test:e2e`: nothing typed is ever stored (Z1), fail-open behavior (FO1–FO4), accessibility (A11Y1).
