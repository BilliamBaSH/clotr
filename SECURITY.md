# Security

Clotr handles the most sensitive thing people type: what they almost sent. Its design keeps that on their computer.

## What Clotr guarantees
- **No network access.** The extension makes no requests; its own pages run under a policy that blocks connections
  (`connect-src 'self'`), and automated checks fail the build if network code appears.
- **Nothing typed is stored.** Only metadata and salted one-way fingerprints are kept, locally.
- **Only AI chat sites.** It runs on the built-in AI sites and on sites the user adds one by one.
- **Storage is locked to Clotr's own pages.** The part running inside AI pages gets only what it needs, by message.
- **Reproducible releases.** `npm run package` rebuilds any release byte for byte; compare with the published SHA-256.

The full review, with every issue found and fixed and the accepted limits, is in
[docs/security-review.md](docs/security-review.md).

## Reporting a vulnerability
Please don't open a public issue for a security problem. Use GitHub's
[**Report a vulnerability**](https://github.com/BilliamBaSH/clotr/security/advisories/new) form
(Security tab → Advisories), which only the maintainer can see, so it can be fixed before it's public. Include the browser and version, Clotr's version (in
`chrome://extensions`) and the steps. Never include real personal data or real keys.

**What happens next:** you get a reply within 7 days. A confirmed problem is fixed in the next release (sooner if
it exposes what people type), and you're credited in the advisory unless you'd rather not be.

**Supported versions:** only the latest release. Store installs update on their own; a downloaded copy should be
replaced with the newest one from Releases.

## Known limits
- A hostile AI site controls its own page: it can hide Clotr's warnings (Clotr then says so and stops holding
  messages there), imitate them, or cover their buttons. It can't learn anything it wasn't about to receive.
- Fingerprints of short values (a phone number) could be guessed by someone with full access to the browser profile.
