# Privacy Policy for Clotr AI Privacy Guard

Last updated: 2026-09-26

Clotr is a browser extension that warns you before you send sensitive information (passwords, keys and personal
details) to AI chat websites. This policy explains exactly what it handles. In short: **everything stays on your
computer, nothing is sent anywhere, and what you type is never stored.**

## What Clotr reads
While you use a supported AI chat website (or one you added), Clotr reads, **on your computer**:
- the text you type or paste into its message box, to look for sensitive information;
- files you attach there (text, PDF, Word, Excel and PowerPoint), to look for the same;
- if you added details to your vault: for 90 seconds after you send a message, the new text of the AI's reply on
  that page, only to notice whether it mentions one of your own details that you didn't type there (then Clotr shows
  you a note). Nothing from a reply is stored.

It does not read other websites. If your organization's IT set a policy for Clotr through the browser, Clotr reads
that policy (required settings and watch words); nothing goes back to them.

## What Clotr stores (on your computer only)
Clotr stores the following in your browser's extension storage, on this computer:
- **Your settings**: how Clotr should respond to each kind of data (warn, ask before sending, or just count),
  sites where you paused it, AI sites you added, and display preferences (such as larger warnings).
- **Your vault** (only what you choose to add): one-way fingerprints of your details (for example your phone
  number), or just the *format* of an ID number (like `AB-######`). The details themselves are not stored.
- **A history of detections**, kept for 1 year by default (you can choose 3 months or 2 years), up to 10,000 records: the time, the AI website, the kind of data found (for example
  "Phone Number"), what you chose (hidden, sent, or just counted), and a salted one-way fingerprint so the dashboard can
  tell "the same item again". **The detected text itself is never stored.**
- **A random secret number** created on your computer, used to make the fingerprints.
- Small bookkeeping: how often you kept a warning recently, which first-time tips you've seen, and the last update.

You can see every stored record in the extension: toolbar button → Settings → History → *See exactly what's stored*.

## What Clotr sends
**Nothing.** Clotr makes no network requests: it has no servers, no analytics, no telemetry, no advertising and
no third-party services. It does not send your text, its findings or your settings to its developer or to anyone
else, including the AI websites (it only warns you *before* you send something yourself).

## Sharing and sale
Clotr does not share, sell or transfer any data, because it doesn't collect any off your computer.

## Retention and your controls
- If someone sets a PIN (Settings → *Helping someone set this up?*), only a salted one-way hash of it is stored, never the PIN.
- History is kept for 1 year by default (3 months or 2 years in the full report), up to 10,000 records, and can be cleared any time (Settings → History → *Clear history*, or the full report → *Delete my history*).
- Vault items can be removed one by one on the vault page.
- Removing the extension deletes all of its stored data from your browser.

## Known limits
Someone with full access to your computer's browser profile could read Clotr's storage. It contains no typed
text, but fingerprints of short details (like phone numbers) could be matched by trying every possibility.

## Changes
If this policy changes, the new version will be published here with a new date, and the extension's
"what's new" note will mention it.

## Contact
Questions: open an issue at https://github.com/BilliamBaSH/clotr-ai-privacy-guard/issues.
