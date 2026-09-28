# Clotr security review (M5, 2026-09-24, v0.9.16)

Scope: everything in `ai-privacy-guard/` plus the update tooling in `tools/`. Method: code review of every
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
| S16 | Release packaging shipped every file in `ai-privacy-guard/` except logs: a personal note, saved chat or editor backup left in the folder would have gone into a public zip | Only files git tracks are packaged (warning outside a git checkout); zips are reproducible with published SHA-256 (D55) | unit test: an untracked file with a phone number never reaches the zip |
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

## Accepted limits
- **A hostile AI site can defeat Clotr on its own pages**: remove the warning (Clotr then says so and stops holding messages there, S21), imitate Clotr's warning, or cover its buttons so a click lands elsewhere. Planting fake *sent* entries by scripting its chat box doesn't work (S23). Clotr's warnings never ask you to type anything, so an imitation can't collect details. It can't learn anything it doesn't already receive, since it is the site the text is going to, with two narrow exceptions that need you to act: text it adds to your chat box while you type is checked with yours (you would see it in your box), and a reply is checked once per message you send, so it can test one guess per message against your vault (S24). Mitigation would need browser support that doesn't exist for extensions.
- **Fingerprints of short values are guessable** by someone with full access to this browser profile (D22), disclosed on "What Clotr stores".
- **Update tooling trusts `main`.** `tools/auto-update.ps1` / `.sh` fast-forward a clone of `main`, and an unpacked install reloads itself: whoever can push to `main` can ship code to that computer within the hour. Recommended (a GitHub setting only the owner can change): protect `main` (require a PR and green CI; no force pushes). See D44.

## Automated from now on
`npm test`: ReDoS fuzz of every pattern, performance budgets, false-alarm corpus, no network calls / innerHTML / remote code, manifest scope. `npm run test:e2e`: nothing typed is ever stored (Z1), fail-open behavior (FO1–FO4), accessibility (A11Y1).
