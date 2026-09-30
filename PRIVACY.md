# Privacy Policy for Clotr

Last updated: 2026-09-30 (Report a problem)

Clotr is a browser extension that warns you before you send sensitive information (passwords, keys and personal
details) to AI chat websites. This policy explains exactly what it handles. In short: **everything stays on your
computer, nothing is sent anywhere, and what you type is never stored.**

## What Clotr reads
While you use a supported AI chat website (or one you added), Clotr reads, **on your computer**:
- the text you type or paste into its message box, to look for sensitive information;
- files you attach there (text, PDF, Word, Excel and PowerPoint), to look for the same;
- if you added details to your vault: for 90 seconds after you send a message, the new text of the AI's reply on
  that page, only to notice whether it mentions one of your own details that you didn't type there (then Clotr shows
  you a note). The text of the reply is never stored: only that a reply on that website mentioned a kind of detail
  of yours (for example "Phone Number"), with the same one-way fingerprint as your vault entry. You can switch this
  off (toolbar button → Settings → *Check the AI's replies for my details*).
- if you turn on **Bandage** (cover names) for a site: the same 90-second window after you send, but only to find its
  own labels (like `[Phone 1]`) in the AI's reply and lay small "hotspots" over them so you can point at one to see
  the real detail. The label-to-detail map lives only in that tab's memory while the page is open; it is never
  stored, and the real detail is never written into the AI's page.

It does not read other websites. If your organization's IT set a policy for Clotr through the browser, Clotr reads
that policy (required settings and watch words); nothing goes back to them. Settings has a page showing what that
policy sets ("See what's applied"), for your own records or an insurer's checklist; the page reads and shows the
policy on your screen and, if you choose, prints it — it never sends or stores anything.

## What Clotr stores (on your computer only)
Clotr stores the following in your browser's extension storage, on this computer:
- **Your settings**: how Clotr should respond to each kind of data (warn, ask before sending, or just count),
  sites where you paused it, AI sites you added, display preferences (such as larger warnings), and whether
  **Bandage** (cover names) is on or off for each AI site.
- **Your vault** (only what you choose to add): one-way fingerprints of your details (for example your phone
  number), or just the *format* of an ID number (like `AB-######`). The details themselves are not stored.
- **A history of detections**, kept for 1 year by default (you can choose 3 months or 2 years), up to 10,000 records: the time, the AI website, the kind of data found (for example
  "Phone Number"), what you chose (hidden, sent, or just counted, marked `via: "bandage"` when it was covered with a
  label instead), and a salted one-way fingerprint so the dashboard can tell "the same item again". **The detected
  text itself is never stored.**
- **Replies that mentioned your details** (if the reply check is on): the time, the AI website, the kind of detail
  and its fingerprint; never the reply's text. Kept and deleted together with the history.
- **Names of AI websites you opened Clotr's toolbar button on** that looked like an AI chat but that Clotr doesn't
  protect (for example `chat.example.ai`): the website's name only, no pages or times, at most 200, deleted with the
  history. They appear as "blind spots" in the full report.
- **A random secret number** created on your computer, used to make the fingerprints.
- Small bookkeeping: how often you kept a warning recently, which first-time tips you've seen, and the last update.

You can see every stored record in the extension: toolbar button → Settings → History → *See exactly what's stored*.

## What Clotr sends
**Nothing.** Clotr makes no network requests: it has no servers, no analytics, no telemetry, no advertising and
no third-party services. It does not send your text, its findings or your settings to its developer or to anyone
else, including the AI websites (it only warns you *before* you send something yourself).

**Report a problem** (on every Clotr page) and *Wrong? Report a false alarm* (in a warning) only open a page on
GitHub, in a new tab, where you can write a public report if you choose. The page's address carries only the kind of
report, Clotr's version, your browser's name, the kind of detail for a false alarm (for example "Phone Number"), and
the AI website's name if you tick *Include this site*: never what you typed, a stored detail or a fingerprint. Clotr
itself sends nothing; whatever you write there, GitHub publishes, so never paste the real detail.

## Sharing and sale
Clotr does not share, sell or transfer any data, because it doesn't collect any off your computer.

## Retention and your controls
- If someone sets a PIN (Settings → *Helping someone set this up?*), only a salted one-way hash of it is stored, never the PIN.
- History is kept for 1 year by default (3 months or 2 years in the full report), up to 10,000 records, and can be cleared any time (Settings → History → *Clear history*, or the full report → *Delete my history*).
- Vault items can be removed one by one on the vault page.
- **Moving to a new computer** (What Clotr stores → *Move to a new computer*): only when you ask, Clotr makes one file
  with your settings, your vault's fingerprints, its secret number and the PIN's hash (never your history, never what
  you typed), encrypted on your computer with a password you choose (AES-256). Your browser saves it where you say;
  Clotr sends it nowhere. Loading it on another computer replaces Clotr's settings and vault there.
- Removing the extension deletes all of its stored data from your browser.

## Known limits
Someone with full access to your computer's browser profile could read Clotr's storage. It contains no typed
text, but fingerprints of short details (like phone numbers) could be matched by trying every possibility.

## Changes
If this policy changes, the new version will be published here with a new date, and the extension's
"what's new" note will mention it.

## Contact
Questions: write to the contact email on Clotr's Chrome Web Store page, or open an issue at
https://github.com/BilliamBaSH/clotr/issues.
