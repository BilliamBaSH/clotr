// Clotr — moving to a new computer (pre-release Batch 5): one file, encrypted with a password the person chooses.
// It holds settings, the vault's fingerprints and formats, the salt and the PIN's hash: never history, never a value.
// Encrypted on this computer with Web Crypto (PBKDF2-SHA-256, 600,000 rounds, then AES-GCM 256); nothing is sent.
// Classic script: adds globalThis.Clotr.Backup (Clotr's pages, the background, and the unit tests).
(() => {
  "use strict";

  const C = (globalThis.Clotr = globalThis.Clotr || {});
  const FORMAT = "clotr-backup";
  const VERSION = 1;
  const ITERATIONS = 600000;
  // What moves. Not history (events, mentions, spotted), not bookkeeping, not sites you added yourself: the
  // browser has to approve those again on the new computer.
  const KEYS = [
    "responses",
    "paused",
    "siteModes",
    "guided",
    "advanced",
    "replyCheck",
    "keepDays",
    "largeText",
    "lock",
    "salt",
    "vault",
    "bandage",
  ];

  const toB64 = (bytes) => {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const fromB64 = (text) => Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));

  async function keyFor(password, salt, iterations, usage) {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
      "deriveKey",
    ]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      [usage],
    );
  }

  // The stored settings to carry, from a chrome.storage.local snapshot.
  function pick(storage) {
    const out = {};
    for (const k of KEYS) if (storage[k] !== undefined) out[k] = storage[k];
    return out;
  }

  // The file's text: nothing in it is readable without the password.
  async function seal(settings, password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(JSON.stringify({ v: VERSION, made: new Date().toISOString(), settings }));
    const key = await keyFor(password, salt, ITERATIONS, "encrypt");
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
    return JSON.stringify({
      format: FORMAT,
      v: VERSION,
      kdf: { name: "PBKDF2", hash: "SHA-256", iterations: ITERATIONS, salt: toB64(salt) },
      cipher: { name: "AES-GCM", iv: toB64(iv) },
      data: toB64(data),
    });
  }

  // The settings back from a file. Throws "not-a-backup" or "wrong-password" (AES-GCM also catches a changed file).
  async function open(text, password) {
    let file;
    try {
      file = JSON.parse(text);
    } catch {
      throw new Error("not-a-backup");
    }
    const it = file?.kdf?.iterations;
    if (file?.format !== FORMAT || file.v !== VERSION || typeof file.data !== "string" || !file.cipher?.iv)
      throw new Error("not-a-backup");
    if (!Number.isInteger(it) || it < 100000 || it > 10000000) throw new Error("not-a-backup");
    let plain;
    try {
      const key = await keyFor(password, fromB64(file.kdf.salt), it, "decrypt");
      plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(file.cipher.iv) }, key, fromB64(file.data));
    } catch {
      throw new Error("wrong-password");
    }
    const payload = JSON.parse(new TextDecoder().decode(plain));
    return payload && typeof payload.settings === "object" ? payload.settings : {};
  }

  // Only known keys with sane values. The vault's entries are cleaned again by the background (cleanVaultEntry).
  function clean(s) {
    const out = {};
    const obj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
    const kind = (k) => /^[a-z_]{2,40}$/.test(k);
    const host = (h) => /^[a-z0-9.-]{1,253}(:\d{1,5})?$/.test(h);
    const keep = (o, ok) => Object.fromEntries(Object.entries(o).filter(([k, v]) => ok(k, v)));
    if (!obj(s)) return out;
    if (obj(s.responses)) out.responses = keep(s.responses, (k, v) => kind(k) && ["block", "warn", "log"].includes(v));
    if (obj(s.paused)) out.paused = keep(s.paused, (h, v) => host(h) && v === true);
    if (obj(s.siteModes)) out.siteModes = keep(s.siteModes, (h, v) => host(h) && ["block", "log"].includes(v));
    if (obj(s.bandage)) out.bandage = keep(s.bandage, (h, v) => host(h) && typeof v === "boolean");
    if (obj(s.guided)) out.guided = keep(s.guided, (k, v) => kind(k) && Number.isFinite(v));
    for (const k of ["advanced", "replyCheck", "largeText"]) if (typeof s[k] === "boolean") out[k] = s[k];
    if ([90, 365, 730].includes(s.keepDays)) out.keepDays = s.keepDays;
    const lock = s.lock;
    if (
      obj(lock) &&
      /^[0-9a-f]{32}$/.test(lock.salt) &&
      /^[0-9a-f]{64}$/.test(lock.hash) &&
      Number.isInteger(lock.iterations) &&
      lock.iterations >= 1000 &&
      lock.iterations <= 10000000
    )
      out.lock = { salt: lock.salt, iterations: lock.iterations, hash: lock.hash };
    if (typeof s.salt === "string" && /^[0-9a-f]{32}$/.test(s.salt)) out.salt = s.salt;
    if (Array.isArray(s.vault)) out.vault = s.vault.slice(0, 5000);
    return out;
  }

  C.Backup = { FORMAT, KEYS, ITERATIONS, pick, seal, open, clean };
})();
