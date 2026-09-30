// Clotr — "Organization policy applied here" (team-pack item 4): a self-attestation page for an admin or an
// insurer's checklist. Reads the managed policy, this extension's version and the browser; writes and sends
// nothing, ever (design section 3.6). Never says "prevents", "certified" or "compliant" (section 5).
"use strict";

const { msg, PATTERNS } = globalThis.Clotr;
const Sites = globalThis.ClotrSites;
const $ = (id) => document.getElementById(id);

const PRESET_NAMES = {
  keys_never: msg("pa_presetKeysNever", "Keys never"),
  client_names: msg("pa_presetClientNames", "Client names"),
  clinic: msg("pa_presetClinic", "Clinic"),
};

// navigator.userAgentData when a browser offers it (skipping the generic "Not.A;Brand" and
// "Chromium" entries for a more specific one); the UA string otherwise.
function browserInfo() {
  const uad = navigator.userAgentData;
  if (uad?.brands?.length) {
    const filtered = uad.brands.filter((b) => !/not.a.brand/i.test(b.brand) && b.brand !== "Chromium");
    const pick = filtered[0] || uad.brands[0];
    if (pick) return `${pick.brand} ${pick.version}`;
  }
  const ua = navigator.userAgent;
  for (const name of ["Edg", "Firefox", "Chrome"]) {
    const m = ua.match(new RegExp(`${name}/(\\d+)`));
    if (m) return `${name === "Edg" ? "Edge" : name} ${m[1]}`;
  }
  return ua;
}

function patternName(id) {
  return PATTERNS.find((p) => p.id === id)?.name || id;
}

function fpGroups(fp) {
  return (fp.match(/.{1,4}/g) || [fp]).join("-");
}

async function render() {
  const raw = (await chrome.storage.managed?.get(null).catch(() => ({}))) || {};
  const policy = Sites.mergePolicy(raw);
  const active = Sites.hasPolicy(policy);
  $("pa-none").hidden = active;
  $("pa-policy").hidden = !active;
  if (!active) return;

  $("pa-org").textContent = policy.orgName || "";
  const manifest = chrome.runtime.getManifest();
  const dateStr = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  $("pa-version").textContent = `Clotr ${manifest.version_name || manifest.version} — ${dateStr} — ${browserInfo()}`;

  let presetLabel = msg("pa_custom", "Custom");
  if (policy.preset && PRESET_NAMES[policy.preset]) {
    const bare = Sites.mergePolicy({ preset: policy.preset });
    presetLabel =
      Sites.policyFingerprint(policy) === Sites.policyFingerprint(bare)
        ? PRESET_NAMES[policy.preset]
        : msg("pa_presetWithChanges", "$1 with organization changes", PRESET_NAMES[policy.preset]);
  }
  $("pa-preset").textContent = presetLabel;
  $("pa-fingerprint").textContent = fpGroups(Sites.policyFingerprint(policy));

  const byResponse = { block: [], warn: [], log: [] };
  for (const [id, value] of Object.entries(policy.requiredResponses || {})) {
    if (byResponse[value]) byResponse[value].push(patternName(id));
  }
  const words = Sites.policyWords(policy);
  const shapes = Sites.policyShapes(policy);
  const items = [
    [msg("pa_countBlock", "Ask before sending"), byResponse.block],
    [msg("pa_countWarn", "Warn"), byResponse.warn],
    [msg("pa_countLog", "Just count"), byResponse.log],
    [msg("pa_countWatchWords", "Watch words"), [String(words.length)]],
    [msg("pa_countWatchFormats", "Watch formats"), [String(shapes.length)]],
    [
      msg("pa_pausingAllowed", "Pausing allowed"),
      [policy.allowPause === false ? msg("pa_no", "No") : msg("pa_yes", "Yes")],
    ],
    [
      msg("pa_settingsLocked", "Settings locked"),
      [policy.lockSettings === true ? msg("pa_yes", "Yes") : msg("pa_no", "No")],
    ],
    [
      msg("pa_largerWarnings", "Larger warnings"),
      [policy.largeText === true ? msg("pa_yes", "Yes") : msg("pa_no", "No")],
    ],
  ];
  $("pa-counts").replaceChildren(
    ...items.map(([label, list]) => {
      const li = document.createElement("li");
      const b = document.createElement("b");
      b.textContent = `${label}: `;
      li.append(b, document.createTextNode(list.length ? list.join(", ") : msg("pa_none2", "none")));
      return li;
    }),
  );

  $("pa-show-words").checked = false;
  $("pa-words").hidden = true;
  $("pa-words").textContent = [...words, ...shapes].join(", ");
}

$("pa-show-words").addEventListener("change", (e) => {
  $("pa-words").hidden = !e.target.checked;
});
$("pa-print").addEventListener("click", () => window.print());

document.title = msg("pa_title", "Organization policy applied here");
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "managed") render();
});
render();
