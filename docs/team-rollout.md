# Rolling Clotr out to a team (managed policy)

IT admins can install Clotr for everyone and set rules through the browser's enterprise policy. Clotr still runs
entirely on each computer: the policy only tells it how to respond. Nothing is reported back to anyone.

## What you can set
| Setting | Type | What it does |
|---|---|---|
| `requiredResponses` | object: kind → `"block"` \| `"warn"` \| `"log"` | Overrides people's own choice for those kinds. `block` = *Ask before sending*. Kind names are the ids in `ai-privacy-guard/patterns.js` (e.g. `aws_access_key`, `github_token`, `password`, `phone_number`, `us_ssn`). |
| `watchWords` | array of strings | Words or phrases (up to 4 words each, 200 at most) to warn about, such as project code names or client names. Clotr turns them into one-way fingerprints on each computer before its checker ever sees them. |
| `lockSettings` | boolean | People can see but not change Clotr's settings or vault. |
| `allowPause` | boolean | `false` removes the per-site Pause. |
| `largeText` | boolean | Larger warnings for everyone. |

## Example policy
```json
{
  "requiredResponses": { "aws_access_key": "block", "github_token": "block", "password": "block", "private_key": "block" },
  "watchWords": ["project falcon", "acme internal"],
  "lockSettings": true,
  "allowPause": false
}
```

## Where to put it
- **Chrome / Edge / Brave on Windows (Group Policy or registry):** force-install the extension, then set its policy
  under `Software\Policies\<Google\Chrome | Microsoft\Edge | BraveSoftware\Brave>\3rdparty\extensions\<extension id>\policy`.
- **macOS:** a configuration profile for the browser's `3rdparty` → `extensions` → `<extension id>` → `policy` key.
- **Linux:** `/etc/opt/chrome/policies/managed/clotr.json` with
  `{ "3rdparty": { "extensions": { "<extension id>": { …policy… } } } }`.
- **Firefox:** `policies.json` → `"3rdparty": { "Extensions": { "clotr-ai-privacy-guard@billiambash": { …policy… } } }`.

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
→ `"ExtensionSettings": { "clotr-ai-privacy-guard@billiambash": { "installation_mode": "force_installed", "install_url": "<AMO download URL>" } }`.
Add the policy above to also set larger warnings or lock the settings (helper mode can do the same without a policy).

Apps outside the browser (the ChatGPT desktop or phone apps) aren't covered by any browser extension.

## Limits
- A person with admin rights on their own computer can remove policies; this is about good defaults, not surveillance.
- Clotr never reports what it finds to anyone. There is no admin dashboard, by design.
