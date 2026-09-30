# Contributing to Clotr

Thanks for helping people keep their private details out of AI chats.

## The rules Clotr never breaks
These are checked automatically (`npm test`); a change that breaks one won't be merged.
- **AI chat sites only.** Never all websites. New AI sites go in `extension/ai-sites.json`.
- **100% local.** No network requests of any kind from the extension.
- **Never store what someone typed.** Only the kind of thing found, the site, the time, what they chose, and a salted
  one-way fingerprint.
- **Never break the chat.** Clotr informs and offers edits; if it fails, the message still goes through.
- **No `innerHTML`**, no remote code, no `eval`. Build the page with `createElement` / `textContent`.

## Good first contributions
- **A missing AI site:** add `{ "name", "matches" }` to `extension/ai-sites.json`, then `npm run sites`.
  Check the exact address the chat lives on.
- **A missed detail or a false alarm:** add a test to `tests/patterns.test.js` that fails, then make it pass.
  Never use a real person's data or a real key; make up values of the same shape.

## Working on the code
```
npm install
npm test            # detection tests and the rule checks above
npm run format      # formats JavaScript and CSS (Prettier); npm run lint checks formatting and lint
npm run test:e2e    # a real browser (Brave, Chrome or Edge) with Clotr loaded, against local test pages
npm run package     # the release zip (reproducible) and its SHA-256
```
- `extension/` is the extension (load it unpacked in `chrome://extensions` with Developer mode on).
- How the parts fit together, what's stored and which checks guard it: [docs/architecture.md](docs/architecture.md).
- Content scripts are classic scripts sharing code through `globalThis.Clotr` (no `import`/`export`).
- Every bug fix comes with a test that failed before the fix.
- Design decisions are numbered (for example `D30`); see [docs/design-notes.md](docs/design-notes.md).

## Your contribution and the license
Clotr is licensed under the [GNU AGPL-3.0-or-later](LICENSE), and its maintainer also offers a commercial license
to companies that want to use the code in closed products; that is how the project can pay for itself. So before
your first pull request is merged, you'll be asked to agree to the [Contributor License Agreement](CLA.md) (one
click, once). You keep the copyright to your work, and the agreement promises that everything contributed stays
available under the AGPL.

## Reporting problems
Use the issue forms (*False alarm*, *Missed something*, *Bug*). Describe the shape of a value, never the value itself.
For security problems, see [SECURITY.md](SECURITY.md).
