# Rolling Clotr out to a team (managed policy)

IT admins can install Clotr for everyone and set rules through the browser's enterprise policy. Clotr still runs
entirely on each computer: the policy only tells it how to respond. Nothing is reported back to anyone.

A policy is a **floor, never a ceiling**: if someone already chose a stricter response for themselves than the
policy asks, their stricter choice stays (a required *Warn* can never turn someone's own *Ask before sending* into
something looser). Nothing about any of this is reported to the admin either way (see "Limits", below).

## What you can set
| Setting | Type | What it does |
|---|---|---|
| `preset` | string: `"keys_never"` \| `"client_names"` \| `"clinic"` | A ready-made policy (below) instead of writing out `requiredResponses` by hand. Your other settings are added on top; an explicit `requiredResponses` entry beats the preset's for that kind. |
| `orgName` | string, up to 80 characters | Shown to your people in Clotr's Settings and on the printed policy page (below). |
| `requiredResponses` | object: kind → `"block"` \| `"warn"` \| `"log"` | A floor for those kinds. `block` = *Ask before sending*. Kind names are the ids in `extension/patterns.js` (e.g. `aws_access_key`, `github_token`, `password`, `phone_number`, `us_ssn`). |
| `watchWords` | array of strings | Words or phrases (up to 4 words each, 200 at most) to warn about, such as project code names or client names. A word with `#` for a digit and `@` for a letter (at least 4 marks, no digits — e.g. `EMP-#####`) is watched as a **format** instead of a literal phrase, so any employee number in that shape is caught, not just ones you list. Clotr turns plain words into one-way fingerprints on each computer before its checker ever sees them; formats travel as typed (they aren't secret). |
| `lockSettings` | boolean | People can see but not change Clotr's settings or vault. |
| `allowPause` | boolean | `false` removes the per-site Pause. |
| `largeText` | boolean | Larger warnings for everyone. |

## Ready-made presets
Instead of writing out every kind by hand, one word sets a whole policy. Each is the same as pasting the
`requiredResponses` shown below it — an admin can start from the preset and adjust individual kinds afterwards.

**Dev shops — every credential kind must ask before sending** (Stripe publishable keys and internal addresses
included, D117):
```json
{ "preset": "keys_never" }
```
is the same as:
```json
{
  "requiredResponses": {
    "private_key": "block",
    "aws_access_key": "block",
    "github_token": "block",
    "stripe_secret_key": "block",
    "anthropic_key": "block",
    "openai_key": "block",
    "google_api_key": "block",
    "slack_token": "block",
    "crypto_secret": "block",
    "service_token": "block",
    "connection_string": "block",
    "jwt": "block",
    "internal_ip": "block",
    "internal_host": "block",
    "password": "block",
    "stripe_publishable_key": "block"
  },
  "allowPause": false
}
```

**Law, accounting, agencies — client and matter details must ask; every personal-detail kind is at least a warn**
(add client names as `watchWords`):
```json
{ "preset": "client_names" }
```
is the same as:
```json
{
  "requiredResponses": {
    "watch_list": "block",
    "us_ssn": "warn",
    "credit_card": "warn",
    "street_address": "warn",
    "bank_account": "warn",
    "national_id": "warn",
    "medical_record": "warn",
    "public_ip": "warn",
    "medicare_id": "warn",
    "passport": "warn",
    "drivers_license": "warn",
    "insurance_id": "warn",
    "date_of_birth": "warn",
    "phone_number": "warn",
    "my_name": "warn",
    "family_name": "warn",
    "employer": "warn",
    "my_id": "warn",
    "email": "warn"
  },
  "allowPause": false
}
```

**A clinic — patient and staff identifiers must ask** (settings aren't locked, so staff can still add their own
names to the vault):
```json
{ "preset": "clinic" }
```
is the same as:
```json
{
  "requiredResponses": {
    "medical_record": "block",
    "medicare_id": "block",
    "insurance_id": "block",
    "us_ssn": "block",
    "date_of_birth": "block",
    "my_name": "block",
    "family_name": "block"
  },
  "largeText": true,
  "allowPause": false
}
```

## Example policy
```json
{
  "orgName": "Acme Corp",
  "requiredResponses": { "aws_access_key": "block", "github_token": "block", "password": "block", "private_key": "block" },
  "watchWords": ["project falcon", "acme internal"],
  "lockSettings": true,
  "allowPause": false
}
```

## Checking what's applied: the policy page
Clotr's Settings shows "Managed by your organization" (naming it, when `orgName` is set) with a **See what's
applied** button that opens an on-screen, printable page: the organization, Clotr's version and date, the preset
(or "Custom", or "$1 with organization changes" once an admin adjusts a preset), a **policy fingerprint** — a short
code that's the same on every computer running the exact same policy, so you can compare it with a test machine
instead of reading a long JSON file aloud — and counts of kinds by response, watch words and watch formats. It's an
unsigned self-attestation the person makes on their own computer: useful for an insurer's checklist or your own
file, not audit evidence, and never worded as "prevents", "certified" or "compliant". Nothing on the page is sent
or saved anywhere; it only reads the policy already on that computer.

## Where to put it
- **Chrome / Edge / Brave on Windows (Group Policy or registry):** force-install the extension, then set its policy
  under `Software\Policies\<Google\Chrome | Microsoft\Edge | BraveSoftware\Brave>\3rdparty\extensions\<extension id>\policy`.
- **macOS:** a configuration profile for the browser's `3rdparty` → `extensions` → `<extension id>` → `policy` key.
- **Linux:** `/etc/opt/chrome/policies/managed/clotr.json` with
  `{ "3rdparty": { "extensions": { "<extension id>": { …policy… } } } }`.
- **Firefox:** `policies.json` → `"3rdparty": { "Extensions": { "clotr@billiambash": { …policy… } } }`.

After a change, open `chrome://policy` (or `edge://policy`, `brave://policy`) and click *Reload policies*. In Clotr's
popup, Settings shows "Managed by your organization" when a policy is active.

## Every browser on one computer (a family member's PC, too)
Forcing the install puts Clotr in each browser for every account on the computer, turned on, with no *Remove*
button. It needs Clotr's store listing: browsers on computers that aren't company-managed only force-install from
their own store, so this works once Clotr is in the Chrome Web Store (and Edge Add-ons for Edge). Replace
`<chrome id>` / `<edge id>` with the listing's extension ID. On Windows, in PowerShell run as administrator:

```powershell
$cws  = "<chrome id>;https://clients2.google.com/service/update2/crx"
$edge = "<edge id>;https://edge.microsoft.com/extensionwebstorebase/v1/crx"
foreach ($p in @{ "Google\Chrome" = $cws; "BraveSoftware\Brave" = $cws; "Microsoft\Edge" = $edge }.GetEnumerator()) {
  $key = "HKLM:\Software\Policies\$($p.Key)\ExtensionInstallForcelist"
  New-Item -Path $key -Force | Out-Null
  Set-ItemProperty -Path $key -Name "1" -Value $p.Value   # "1": the first entry; use the next free number if the list exists
}
```

Restart the browsers (or *Reload policies* on `chrome://policy`). To undo, delete the `ExtensionInstallForcelist`
entries. On macOS the same `ExtensionInstallForcelist` goes in a configuration profile; Firefox uses `policies.json`
→ `"ExtensionSettings": { "clotr@billiambash": { "installation_mode": "force_installed", "install_url": "<AMO download URL>" } }`.
Add the policy above to also set larger warnings or lock the settings (helper mode can do the same without a policy).

Apps outside the browser (the ChatGPT desktop or phone apps) aren't covered by any browser extension.

## Limits
- A person with admin rights on their own computer can remove policies; this is about good defaults, not surveillance.
- Clotr never reports what it finds to anyone. There is no admin dashboard, by design.
