# Design notes

Code comments refer to design decisions by number (for example `D30`). Each one in a line:

| # | Decision |
|---|---|
| D1 | Nothing blocks by default |
| D12 | Bank and ID numbers |
| D19 | Attached files only warn |
| D21 | Vault items are protected by default |
| D22 | Honest limit of "nothing readable" |
| D23 | Account/ID formats |
| D25 | Updates without breaking "100% local" |
| D30 | Clotr never breaks the chat. |
| D33 | The real-restart update test reports SKIP on Brave |
| D35 | "Protect this site" covers only the page's section on shared hosts |
| D36 | Keys typed by habit never make a choice |
| D37 | After an update, an open tab's old copy of Clotr keeps warning |
| D38 | A self-update waits while any tab shows a Clotr dialog or warning |
| D39 | No new permissions to restart Clotr in open tabs after an update. |
| D40 | Plain-language wording: |
| D41 | Keyboard shortcut Alt+Shift+C |
| D42 | Simple mode by default. |
| D43 | First-time tips, once per kind of data. |
| D44 | Protect `main` on GitHub. |
| D45 | License: your choice before the repo goes public. |
| D47 | The main button's word is "Cover it" |
| D51 | Copied-text characters don't hide leaks; look-alike letters are not mapped. |
| D52 | "Just sent" after a fast send. |
| D53 | Send buttons without a "send" label count as possible sends |
| D54 | History is kept for 1 year by default |
| D55 | Release zips are reproducible, and Clotr shows what it can reach. |
| D56 | Clotr ignores sign-in fields on AI sites. |
| D57 | "AI connection map" read as: you → each AI service your details reached |
| D58 | Self-check: Clotr says when it can't protect you. |
| D59 | Site-change check is a local dev tool, not part of Clotr. |
| D61 | Helping someone set Clotr up. |
| D62 | Team rollout through the browser's managed policy. |
| D63 | Reply check: Clotr tells you when an AI brings up your own details that you didn't type. |
| D64 | Spanish detection. |
| D65 | Spanish interface, phase 1: everything you see while chatting. |
| D71 | CI in batches. |
| D75 | The AI connection map becomes a mind map of everything you could be leaking |
| D76 | Full burnt-orange brand refresh |
| D77 | Clotr's pages use Atkinson Hyperlegible |
| D80 | A new Clotr mark and brand set. |
| D81 | Clotr's website: one page in `site/`, published by GitHub Pages from the public repo. |
| D93 | How Bandage works. |
| D98 | Clotr talks in its author's voice. |
| D99 | Hover to peek, built, without ever changing the AI's page. |
| D104 | The welcome note gets a moving hero. |
| D107 | "No AI inside" is machine-checked. |
| D115 | An office policy as a minimum, changing D62. |
| D117 | The "keys_never" team-pack preset covers every credential kind |
| D119 | "Report a problem" is one shared script, `report.js`, self-mounting into a `#report-root` placeholder on every Clotr page. |
| D120 | Reports stay public, with a warning first and the address in words. |
| D121 | "Leave it in" sends the message when the question stopped a send. |
| D124 | The public repo is just the extension. |
| D134 | Clotr on your email and chat apps, one site at a time. |
| D135 | One refreshed look for everything Clotr shows, and marketing for everyone. |
