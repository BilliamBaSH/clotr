// Moving to a new computer (pre-release Batch 5): the backup file is unreadable without its password, comes back
// exactly, and can't smuggle anything into storage.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../extension/backup.js");
const { Backup } = globalThis.Clotr;

const SETTINGS = {
  responses: { phone_number: "block", email: "log" },
  paused: { "chatgpt.com": true },
  siteModes: { "claude.ai": "block" },
  guided: { phone_number: 1727600000000 },
  advanced: true,
  replyCheck: false,
  keepDays: 730,
  largeText: true,
  lock: { salt: "ab".repeat(16), iterations: 150000, hash: "cd".repeat(32) },
  salt: "0123456789abcdef0123456789abcdef",
  vault: [{ kind: "value", type: "phone_number", fp: "0123456789abcdef", mode: "protect", added: 1 }],
  bandage: { "chatgpt.com": true, "claude.ai": false },
};

test("backup: comes back exactly with the right password; the file shows nothing without it", async () => {
  const file = await Backup.seal(SETTINGS, "correct horse battery");
  for (const readable of ["0123456789abcdef", "phone_number", "chatgpt.com", "block", "cdcdcd"]) {
    assert.ok(!file.includes(readable), `readable in the file: ${readable}`);
  }
  assert.deepEqual(await Backup.open(file, "correct horse battery"), SETTINGS);
});

test("backup: a wrong password, a changed file or another file are refused", async () => {
  const file = await Backup.seal(SETTINGS, "correct horse battery");
  await assert.rejects(Backup.open(file, "correct horse batterY"), /wrong-password/);
  const parsed = JSON.parse(file);
  const bytes = Buffer.from(parsed.data, "base64");
  bytes[5] ^= 1; // one flipped bit
  await assert.rejects(
    Backup.open(JSON.stringify({ ...parsed, data: bytes.toString("base64") }), "correct horse battery"),
    /wrong-password/,
  );
  await assert.rejects(Backup.open('{"hello": 1}', "x"), /not-a-backup/);
  await assert.rejects(Backup.open("not json", "x"), /not-a-backup/);
  await assert.rejects(
    Backup.open(JSON.stringify({ ...parsed, kdf: { ...parsed.kdf, iterations: 10 } }), "x"),
    /not-a-backup/,
  );
});

test("backup: only known settings with sane values get through", () => {
  const dirty = {
    ...SETTINGS,
    events: [{ t: 1 }], // history never moves
    responses: { phone_number: "block", "bad key!": "block", email: "off" },
    paused: { "chatgpt.com": true, "evil.com/<x>": true, "claude.ai": "yes" },
    bandage: { "chatgpt.com": true, "evil.com/<x>": true, "claude.ai": "yes" },
    keepDays: 12,
    lock: { salt: "zz", iterations: 150000, hash: "cd".repeat(32) },
    salt: "not hex",
    advanced: "true",
  };
  const clean = Backup.clean(dirty);
  assert.deepEqual(clean.responses, { phone_number: "block" });
  assert.deepEqual(clean.paused, { "chatgpt.com": true });
  assert.deepEqual(clean.bandage, { "chatgpt.com": true });
  for (const k of ["events", "keepDays", "lock", "salt", "advanced"]) assert.ok(!(k in clean), `${k} got through`);
  assert.deepEqual(Backup.clean(SETTINGS), SETTINGS);
  assert.deepEqual(
    Object.keys(Backup.pick({ ...SETTINGS, events: [], spotted: {} })).sort(),
    Object.keys(SETTINGS).sort(),
  );
});
