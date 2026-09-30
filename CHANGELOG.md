# Changelog

What changed in each version of Clotr, in plain words. Versions were `0.x-alpha` until 1.0.0, the first public release.
The extension shows the highlights of each series once after an update ("What's new").

## 1.0.10 (2026-09-30)
- **Only Clotr's own pages can loosen your vault:** removing a detail you protect, or marking it OK to share, now
  works only from Clotr's vault page, never from the part of Clotr that runs inside an AI site (found in the release
  security review). Nothing changes in what you see.

## 1.0.9 (2026-09-30)
- **No freeze on a huge paste of numbers:** a message with tens of thousands of digits in a row could stall the chat page
  for a second while Clotr read it. It now takes a fraction of that (found in the release security review).

## 1.0.8 (2026-09-30)
- **Cover names in a new chat's first answer:** on Microsoft Copilot, pointing at [Phone 1] in the first answer of a
  new chat showed nothing (later answers worked). Copilot goes quiet for a few seconds while it opens the chat's own
  page, and Clotr stopped looking at that first pause. It now keeps looking until the answer arrives.

## 1.0.7 (2026-09-30)
- **Fixed on Microsoft Copilot:** Hide it worked, but Clotr then said it "couldn't hide it here". Copilot keeps an
  invisible marker at the end of its chat box, and Clotr now ignores characters nobody can see when it checks.

## 1.0.6 (2026-09-30)
- **A new name: "Clotr: clot your data leaks".** Clotr catches passwords, keys and personal details before you send
  them; AI chats are where it works. The printed guide's title is now "a heads-up before you overshare".
- **Report a problem** now points to Clotr's new address, github.com/BilliamBaSH/clotr.

## 1.0.5 (2026-09-30)
- **Leave it in and send:** with "Ask me first", when Clotr stops a message you were sending (Enter or the send
  button) and you choose to leave it in, the message now goes right away, the way you sent it. You no longer press
  Enter a second time. When the question came up while you were still typing, "Leave it in" sends nothing, as before.
- **Fixed:** after "Leave it in", clicking a send button that submits a form could bring the question back instead
  of sending.

## 1.0.4 (2026-09-30)
- **Updates tidy up after themselves:** when a new version of Clotr takes over an open AI tab, the old copy's
  cover-name underlines and any open peek bubble now leave with it (a bubble could stay stuck over the chat).

## 1.0.3 (2026-09-30)
- **No stray underlines:** on Claude (and ChatGPT), a small dotted line could appear over empty space near your message.
  It was a cover-name hotspot for the page's hidden screen-reader copy of the message; hidden text gets none now.

## 1.0.2 (2026-09-30)
- **Moving to a new computer shows what came back:** before it replaces anything, Clotr says what the file holds
  ("1 vault item (Phones: 1) and your choices for 12 kinds of detail"), and after loading it reads back what's now on
  this computer and says the same, with a link to see your vault.

## 1.0.1 (2026-09-30)
- **The welcome note, in my words:** it opens with why I made Clotr, and the no-AI line is short: "Clotr has
  absolutely NO AI, it defeats the point." The same in Spanish.

## 1.0.0 (2026-09-29)
- **The first public release.** Everything below, from the alpha, is in it: Clotr warns you before a password, a key
  or a personal detail goes to an AI chat, however it's written, and everything stays on your computer. There is no
  AI inside Clotr, and there never will be.
- **Catches more, and fewer false alarms:** a book's ISBN or a log's request ID is no longer mistaken for a card or
  a phone number; phone numbers with misspelled digits ("nien", "sicks", "zeero") are caught, and so are addresses
  whose house number looks like a year ("2068 Oak Street").
- **"Report a problem" says it first:** reports are public, so never paste the real detail. It also shows its
  address in words, and the printed guide for someone you help now has it too. Its choices are plain buttons,
  which screen readers announce as they are.

## 0.9.102-alpha (2026-09-29)
- **A "Report a problem" button on every Clotr page:** the popup, the welcome page, the full report, What Clotr
  stores, the guided setup, Share and the policy page each have one now. It opens a ready-made GitHub form (three
  kinds to choose from) with only the Clotr version and your browser filled in; on the popup, you can also choose to
  add the current AI tool's name. Nothing you typed, nothing stored and no fingerprint ever goes in it, and Clotr
  itself still sends nothing: the button only opens a page for you to send yourself.

## 0.9.101-alpha (2026-09-29)
- **In my words, on the welcome page:** Clotr has absolutely no AI, and never will.
- **The small-team pack:** an organization's browser policy can now set a ready-made preset
  (`keys_never`, `client_names` or `clinic`) instead of listing every kind by hand, and a watched format like
  `EMP-#####` (not just fixed words). A policy is now a floor: it can ask you to be more careful, but it can never
  loosen a stricter choice you already made yourself, even through a site set to "Just count" or an "OK to share"
  vault entry. Settings now shows what an organization's policy is applying, names the organization, and has a
  **See what's applied** page: a printable, unsigned summary for your own records or an insurer's checklist. (Nothing
  is reported to your organization either way.)

## 0.9.100-alpha (2026-09-29)
- **A line from me on the welcome page:** the more you use Clotr and report what it gets wrong, the better it
  gets, for free.

## 0.9.99-alpha (2026-09-29)
- **A livelier welcome:** the note at the top of the welcome page now opens with a small map that draws itself,
  showing Clotr covering your details on the way to an AI, and says a bit more about why I'm building it.

## 0.9.98-alpha (2026-09-29)
- **Hover to peek (Bandage):** point at a cover name like `[Phone 1]` in an AI's answer (or focus it with the
  keyboard) to see the real detail in a small Clotr bubble; a "Copy with real names" button gives you the whole
  answer with the real details back. The AI's own page never gets the real detail.
- **Clotr in my own words:** the welcome page starts with a short note from me, and Clotr's explanations, tips,
  empty screens and settings are rewritten to sound like a person, in English and Spanish. The warning buttons
  didn't change.
- **Bandage in Settings and the report:** turn cover names on or off for each AI tool, right from Settings; the full
  report now shows what Bandage kept from each AI, apart from anything you hid yourself.

## 0.9.97-alpha (2026-09-29)
- **Move to a new computer:** save your settings, your vault and your PIN in one file locked with a password you
  choose, then load it on the other computer (What Clotr stores → *Move to a new computer*, or Settings). Your history
  stays where it is, and nothing is sent anywhere.
- **Your own words and formats:** Settings → *Your own words and formats* goes straight to the place for client
  names, project codenames and formats like EMP-#####.

## 0.9.96-alpha (2026-09-29)
- **Share Clotr with someone:** Settings → *Share Clotr with someone* gives you the link to send and a one-page
  guide in large type to print and leave next to their computer.
- **Spanish birth dates:** "fecha de nacimiento: 1948-03-14", "nacido el …" and "Nacimiento: …" are caught now.

## 0.9.95-alpha (2026-09-29)
- **Set it up for someone, step by step:** Settings → *Set it up step by step* walks you through their details,
  bigger warnings, asking before personal details go out, and a PIN.
- **Say it more generally:** when a message has a birth date or an address, *More choices* can turn it into
  "March 1948" or just the town, instead of hiding it completely. Anything else private is hidden as before.

## 0.9.94-alpha (2026-09-29)
- **Clotr's name:** in the stores and in your browser's extension list it's now "Clotr: clot your AI data bleed"; the
  toolbar and the popup just say "Clotr".
- **Clotr's orange, everywhere:** buttons on Clotr's own pages and in its messages inside the chat are now the signal
  orange from the icon, with dark text that's easy to read. Warnings keep their red and amber.

## 0.9.93-alpha (2026-09-28)
- **A new icon:** a C with a bandage across its opening, on an orange tile. Orange means Clotr is protecting this
  site; gray with an orange bandage means the page looks like an AI chat Clotr isn't protecting yet; plain gray means
  it's off here.

## 0.9.92-alpha (2026-09-28)
- **A mind map of everything you could be leaking**, in the full report: what each AI service already has from you,
  what Clotr stopped, what's in your vault that no AI has seen yet, and where Clotr can't see (AI tools it spotted
  but doesn't protect, desktop and phone apps, browser side panels). Group it by AI service or by kind of detail; on
  a narrow window it becomes an outline. A small version is on the popup's Overview.
- **A new look:** burnt orange, and Atkinson Hyperlegible, a typeface made for low-vision readers, on Clotr's own pages.
- **Test Clotr here:** on an AI chat, the popup's *Test Clotr here* outlines the chat box Clotr is watching, so you
  can see it's working. Nothing is typed or sent.
- **Reply check, said up front:** the welcome page says Clotr also reads the AI's replies for your own details, and
  Settings has a switch to turn that off. A reply that brings up one of your details is kept as its kind only, never
  the text.

## 0.9.91-alpha
- *Hide it* keeps working if a browser drops the old editing command it relies on.
- Chat boxes built with editors like Slate or CKEditor 5 are checked while you type, not only when you send.

## 0.9.84 to 0.9.90
- *Hide it* / *Leave it in* everywhere (was *Cover it*).
- Catches more: sign-in codes texted to you, "my password for netflix is…", misspelled passwords, locker
  combinations, emails inside pasted links, Spanish landlines. Help-line and toll-free numbers stay quiet.
- Structured data: details in JSON, YAML, XML and spreadsheet (CSV) pastes.

## 0.9.55 to 0.9.83
- Numbers read out the everyday way ("double five", Spanish pairs like "treinta y cuatro"), cards in words.
- Logins and home codes told in passing (gate, alarm and safe codes, "ATM pin 4821"), passphrases, two-factor backup
  codes, remote-access codes a fake support call asks for.
- More ID formats: UK, Australian and Mexican IDs, ITIN, EIN, green card, Medicaid, NHS, Aadhaar and more.
- "Why am I seeing this?" says real support never asks for passwords, codes or cards.
- Much faster on big pastes; hundreds of everyday messages checked so ordinary text stays quiet.

## 0.9 series (first alpha)
- In Spanish too: warnings, the popup, the welcome page and the full report follow your browser's language.
- Your AI exposure report: a full page of what each AI service has been told about you, with export and delete.
- A weekly summary at the top of the popup.
- Attached PDFs and Word, Excel and PowerPoint files are checked too.
- Helping someone? Larger warnings, a stricter setting for personal details, and a PIN.
- Clotr says when it can't help: the popup shows whether it sees the chat box.

## 0.8
- Your vault: tell Clotr your name, family, addresses, phones, emails, employer and ID formats once. It keeps only
  one-way fingerprints and catches them however they're written.
- Clotr learns, on this device only: delete a flagged item by hand and it offers to always watch for it.

## 0.7
- Watch list, per-site views and a per-site mode (stricter or quieter on one AI tool).
- Database connection strings, login tokens and internal servers are caught.

## 0.6
- Street addresses, dates of birth, bank and ID numbers, international phones, and more disguises ("fifty six", O for
  zero).
