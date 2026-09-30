// Clotr — helping someone set Clotr up (D61): the pieces the popup's Settings and the guided setup page share.
// Classic script (loaded after patterns.js and detector.js); adds globalThis.Clotr.Helper.
// The PIN is kept only as a salted PBKDF2 hash. It guards against accidental changes; whoever can remove the
// extension can reset it (both pages say so). Unlocking lasts 10 minutes, shared through session storage.
(() => {
  const C = (globalThis.Clotr = globalThis.Clotr || {});
  const PERSONAL_IDS = C.PATTERNS.filter((p) => p.group === "personal").map((p) => p.id);
  const UNLOCK_MS = 10 * 60 * 1000;
  const PIN_ITERATIONS = 150000;

  const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  async function pinHash(pin, saltHex, iterations) {
    const salt = Uint8Array.from(saltHex.match(/../g), (h) => parseInt(h, 16));
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
    return toHex(
      new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256)),
    );
  }
  const validPin = (pin) => /^\d{4,8}$/.test(pin);
  async function makeLock(pin) {
    const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
    return { salt, iterations: PIN_ITERATIONS, hash: await pinHash(pin, salt, PIN_ITERATIONS) };
  }
  const pinMatches = async (pin, lock) =>
    Boolean(lock && validPin(pin)) && (await pinHash(pin, lock.salt, lock.iterations)) === lock.hash;

  // Until when the settings are open after a correct PIN (or after setting one), across Clotr's pages.
  async function unlockedUntil() {
    return (await chrome.storage.session.get("unlockedUntil").catch(() => ({}))).unlockedUntil || 0;
  }
  async function markUnlocked() {
    const until = Date.now() + UNLOCK_MS;
    await chrome.storage.session.set({ unlockedUntil: until }).catch(() => {});
    return until;
  }

  // One control for a whole group: "default" clears the group's overrides (overrides only, so a kind set back to
  // its default follows future default changes).
  async function setGroupResponse(ids, value) {
    const { responses = {} } = await chrome.storage.local.get("responses");
    for (const id of ids) {
      if (value === "default" || value === C.defaultResponse(id)) delete responses[id];
      else responses[id] = value;
    }
    await chrome.storage.local.set({ responses });
  }
  const asksBeforePersonal = (responses = {}) => PERSONAL_IDS.every((id) => responses[id] === "block");
  const setAskBeforePersonal = (on) => setGroupResponse(PERSONAL_IDS, on ? "block" : "default");

  C.Helper = {
    PERSONAL_IDS,
    UNLOCK_MS,
    PIN_ITERATIONS,
    pinHash,
    validPin,
    makeLock,
    pinMatches,
    unlockedUntil,
    markUnlocked,
    setGroupResponse,
    asksBeforePersonal,
    setAskBeforePersonal,
  };
})();
