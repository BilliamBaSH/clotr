# Design notes

Code comments refer to design decisions by number (for example `D30`). Each one in a line:

| # | Decision |
|---|---|
| D1 | Nothing blocks by default |
| D4 | It's me |
| D7 | Commit email |
| D10 | Street addresses |
| D11 | Dates of birth |
| D12 | Bank and ID numbers |
| D13 | Sound-alikes and look-alikes |
| D14 | International phones |
| D15 | "Custom tracking for custom websites" |
| D16 | Watch-list words are stored only as fingerprints |
| D17 | Bulk pastes |
| D18 | Internal IPs and hostnames |
| D19 | Attached files only warn |
| D20 | "Context" = the site. |
| D21 | Vault items are protected by default |
| D22 | Honest limit of "nothing readable" |
| D23 | Account/ID formats |
| D24 | Renamed to Clotr |
| D25 | Updates without breaking "100% local" |
| D26 | The blanket swaps details while you type |
| D27 | Placeholder ↔ real value exists only in the page's memory |
| D28 | Real names are shown only in Clotr's own closed panel |
| D29 | The blanket is off by default |
| D30 | Clotr never breaks the chat. |
| D31 | Clotr runs on desktop browsers |
| D32 | Anything needing payment or account setup comes last |
| D33 | The real-restart update test (U2b) reports SKIP on Brave |
| D35 | "Protect this site" covers only the page's section on shared hosts |
| D36 | Keys typed by habit never make a choice |
| D34 | Dev tooling from Chrome's "Build with AI" page: |
| D37 | After an update, an open tab's old copy of Clotr keeps warning |
| D38 | A self-update waits while any tab shows a Clotr dialog or warning |
| D39 | No new permissions to restart Clotr in open tabs after an update. |
| D40 | Plain-language wording: |
| D41 | Keyboard shortcut Alt+Shift+C |
| D42 | Simple mode by default. |
| D43 | First-time tips, once per kind of data. |
| D44 | Protect `main` on GitHub (needs your go-ahead; it's your repo setting). |
| D45 | License: your choice before the repo goes public. |
| D46 | Going public and distribution, walked through with you at the end (D32). |
| D47 | The main button's word is "Cover it" |
| D48 | The corner notice doesn't grab your keys while you type. |
| D49 | Firefox build from the same code |
| D50 | Detection coverage beyond the alpha freeze |
| D51 | Copied-text characters don't hide leaks; look-alike letters are not mapped. |
| D52 | "Just sent" after a fast send. |
| D53 | Send buttons without a "send" label count as possible sends |
| D54 | History is kept for 1 year by default |
| D55 | Release zips are reproducible, and Clotr shows what it can reach. |
| D56 | Clotr ignores sign-in fields on AI sites. |
| D57 | "AI connection map" read as: you → each AI service your details reached |
| D58 | Self-check: Clotr says when it can't protect you. |
| D59 | Site-change check is a local dev tool, not part of Clotr. |
| D60 | The public repo is built by export, not by publishing this one. |
| D61 | Helping someone set Clotr up ("protect a parent"). |
| D62 | Team rollout through the browser's managed policy. |
| D63 | Reply check: Clotr tells you when an AI brings up your own details that you didn't type. |
| D64 | Spanish detection. |
| D65 | Spanish interface, phase 1: everything you see while chatting. |
| D66 | Several attached files: one notice for all of them; at most 50 read per drop. |
| D67 | Repo automation, the parts that need no answers: |
| D68 | Agents on your PC, protected by a local guard. |
| D69 | Your vault ignores accents. |
| D70 | Toll-free numbers aren't personal; sign-in codes are. |
| D71 | CI in batches. |
| D72 | Formatter and linter. |
| D73 | The public repo, ready to create. |
