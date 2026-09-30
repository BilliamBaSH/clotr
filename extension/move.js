// Clotr — "Move to a new computer" (pre-release Batch 5), on the "What Clotr stores" page. Saving builds an encrypted
// file here and hands it to the browser's download; loading opens it here and asks the background to write it (it
// cleans every entry again, backup.js). Nothing is sent anywhere, and history stays on the computer it's on.
// Its own scope: this page's other scripts already declare `msg` and friends at the top level.
(() => {
  "use strict";

  const { msg, Backup, Helper } = globalThis.Clotr;
  const mv = (id) => document.getElementById(id);
  const tell = (id, text, error = false) => {
    mv(id).textContent = text;
    mv(id).classList.toggle("error", error);
  };

  // What a file holds, or what came back, in the popup's words: "3 vault items (Phones: 2, Emails: 1), your choices
  // for 12 kinds of detail, cover names on 2 sites and a PIN" (a file loaded, and nothing said what).
  const VAULT_WORDS = {
    my_name: ["pp_vName", "Name"],
    family_name: ["pp_vFamily", "Family"],
    employer: ["pp_vWork", "Work"],
    street_address: ["pp_vAddresses", "Addresses"],
    phone_number: ["pp_vPhones", "Phones"],
    email: ["pp_vEmails", "Emails"],
    my_id: ["pp_vIdFormats", "ID formats"],
    watch_list: ["pp_vWatchWords", "Watch words"],
  };
  function describe(s) {
    const vault = Array.isArray(s.vault) ? s.vault : [];
    const kinds = new Map();
    for (const e of vault) {
      const w = VAULT_WORDS[e.type];
      const label = w ? msg(w[0], w[1]) : msg("mv_other", "Other");
      kinds.set(label, (kinds.get(label) || 0) + 1);
    }
    const byKind = [...kinds].map(([k, n]) => `${k}: ${n}`).join(", ");
    const parts = [
      vault.length === 1
        ? `${msg("mv_holdsVault1", "1 vault item")} (${byKind})`
        : vault.length
          ? `${msg("mv_holdsVault", "$1 vault items", vault.length)} (${byKind})`
          : msg("mv_holdsNoVault", "no vault items"),
    ];
    const choices = Object.keys(s.responses || {}).length;
    parts.push(
      choices === 1
        ? msg("mv_holdsChoices1", "your choices for 1 kind of detail")
        : msg("mv_holdsChoices", "your choices for $1 kinds of detail", choices),
    );
    const covered = Object.values(s.bandage || {}).filter(Boolean).length;
    if (covered)
      parts.push(
        covered === 1
          ? msg("mv_holdsBandage1", "cover names on 1 site")
          : msg("mv_holdsBandage", "cover names on $1 sites", covered),
      );
    if (s.lock) parts.push(msg("mv_holdsPin", "a PIN"));
    return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} ${msg("mv_and", "and")} ${parts.at(-1)}` : parts[0];
  }

  mv("mv-save").addEventListener("click", async () => {
    const pass = mv("mv-pass").value;
    if (pass.length < 8) return tell("mv-save-msg", msg("mv_tooShort", "Use at least 8 characters."), true);
    if (pass !== mv("mv-pass2").value)
      return tell("mv-save-msg", msg("mv_noMatch", "The two passwords don't match."), true);
    tell("mv-save-msg", msg("mv_working", "Working…"));
    const text = await Backup.seal(Backup.pick(await chrome.storage.local.get(Backup.KEYS)), pass);
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const link = Object.assign(document.createElement("a"), {
      href: url,
      download: `clotr-${new Date().toISOString().slice(0, 10)}.clotr`,
    });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    mv("mv-pass").value = mv("mv-pass2").value = "";
    tell(
      "mv-save-msg",
      msg(
        "mv_saved",
        "Saved. Keep the file and its password somewhere safe. Without the password nobody can open it, not even you.",
      ),
    );
  });

  mv("mv-load").addEventListener("click", async () => {
    const file = mv("mv-file").files[0];
    if (!file) return tell("mv-load-msg", msg("mv_pickFile", "Choose the file first."), true);
    // A PIN guards the settings, and loading a file replaces them: the PIN comes first (popup → Settings).
    const { lock } = await chrome.storage.local.get("lock");
    const policy = (await chrome.storage.managed?.get(null).catch(() => ({}))) || {};
    if (policy.lockSettings === true || (lock && Date.now() >= (await Helper.unlockedUntil())))
      return tell(
        "mv-load-msg",
        msg("mv_locked", "Settings are locked. Unlock them with the PIN in Clotr's popup first."),
        true,
      );
    let settings;
    try {
      settings = await Backup.open(await file.text(), mv("mv-open").value);
    } catch (err) {
      return tell(
        "mv-load-msg",
        err.message === "wrong-password"
          ? msg("mv_wrongPassword", "That password doesn't open this file.")
          : msg("mv_notABackup", "That isn't a Clotr file."),
        true,
      );
    }
    const holds = describe(settings);
    const ask = msg(
      "mv_confirmWhat",
      "The file holds $1. Replace this computer's Clotr settings, vault and PIN with it?",
      holds,
    );
    if (!confirm(ask)) return;
    const res = await chrome.runtime.sendMessage({ type: "clotr:importBackup", settings }).catch(() => null);
    mv("mv-open").value = "";
    if (!res?.ok) return tell("mv-load-msg", msg("mv_failed", "Couldn't load it."), true);
    // Read back what's on this computer now, so "Done" is checked, not assumed.
    const now = await chrome.storage.local.get(Backup.KEYS);
    tell(
      "mv-load-msg",
      msg("mv_loadedWhat", "Done. Back from the file: $1. Sites you added yourself need adding again.", describe(now)),
    );
    const see = document.createElement("a");
    see.href = "vault.html#vault-list";
    see.textContent = msg("mv_seeVault", "See your vault");
    mv("mv-load-msg").append(" ", see);
  });
})();
