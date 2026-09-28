// Which pages a user-added AI site covers. Run from the repo root: npm test
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

// sites.js reads the built-in list from the manifest and grants from chrome.permissions.
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "ai-privacy-guard", "manifest.json"), "utf8"));
let granted = [];
let stored = {};
globalThis.chrome = {
  runtime: { getManifest: () => manifest },
  permissions: { getAll: async () => ({ origins: granted }) },
  storage: { local: { get: async (k) => ({ [k]: stored[k] }) } },
};
require("../ai-privacy-guard/sites.js");
const Sites = globalThis.ClotrSites;

test("Protect this site: a whole AI site gets the whole host", () => {
  assert.equal(Sites.protectScope("https://chat.newtool.ai/c/123?x=1"), "https://chat.newtool.ai/*");
  assert.equal(Sites.protectScope("https://duck.ai/"), "https://duck.ai/*");
});

test("Protect this site on a shared host (huggingface.co) covers only that section, never the whole site", () => {
  // Regression: the user protected a Hugging Face page and got all of huggingface.co (2026-09-24).
  assert.equal(
    Sites.protectScope("https://huggingface.co/spaces/owner/my-app?logs=1"),
    "https://huggingface.co/spaces/owner/my-app/*",
  );
  assert.equal(
    Sites.protectScope("https://huggingface.co/meta-llama/Llama-3-8B"),
    "https://huggingface.co/meta-llama/Llama-3-8B/*",
  );
  assert.equal(
    Sites.protectScope("https://huggingface.co/deepseek-ai/DeepSeek-V3/discussions/12"),
    "https://huggingface.co/deepseek-ai/DeepSeek-V3/discussions/*",
  );
  assert.equal(Sites.protectScope("https://huggingface.co/"), "https://huggingface.co/");
  assert.notEqual(Sites.protectScope("https://huggingface.co/spaces/a/b"), "https://huggingface.co/*");
});

test("the permission asked for is always just that one host", () => {
  assert.equal(Sites.permissionFor("https://huggingface.co/spaces/owner/my-app/*"), "https://huggingface.co/*");
  assert.equal(Sites.permissionFor("https://chat.newtool.ai/*"), "https://chat.newtool.ai/*");
});

test("where Clotr runs for user-added sites: the chosen sections, or the whole host for older grants", async () => {
  granted = ["https://huggingface.co/*", "https://chat.newtool.ai/*", "https://chatgpt.com/*"];
  stored = { siteScopes: { "https://huggingface.co/*": ["https://huggingface.co/spaces/owner/my-app/*"] } };
  assert.deepEqual(await Sites.userSitePatterns(), [
    "https://chat.newtool.ai/*",
    "https://huggingface.co/spaces/owner/my-app/*",
  ]);
  stored = {}; // a grant from before v0.9.3: no recorded section
  assert.deepEqual(await Sites.userSitePatterns(), ["https://chat.newtool.ai/*", "https://huggingface.co/*"]);
});

test("a whole-host grant on a shared host is flagged as wider than needed", () => {
  assert.equal(Sites.isWiderThanNeeded("https://huggingface.co/*"), true);
  assert.equal(Sites.isWiderThanNeeded("https://huggingface.co/spaces/owner/my-app/*"), false);
  assert.equal(Sites.isWiderThanNeeded("https://chat.newtool.ai/*"), false);
});

test("AI sites that moved stay protected at their new address (M2 real-site check)", () => {
  // 2026-09-24: lmarena.ai now redirects to arena.ai, where Clotr wasn't running.
  const hosts = manifest.content_scripts.flatMap((c) => c.matches);
  // Copilot's canonical address is now copilot.com (copilot.microsoft.com still works).
  for (const moved of ["https://arena.ai/*", "https://copilot.com/*", "https://www.copilot.com/*"])
    assert.ok(hosts.includes(moved), `${moved} isn't protected`);
});

test("Self-check wording: the popup says plainly whether Clotr can see the chat box here", () => {
  const h = Sites.healthText;
  assert.match(h({ running: false }).text, /isn't running in this tab.*reload/i);
  assert.equal(h({ running: false }).level, "warn");
  assert.match(h({ running: true, paused: true }).text, /paused/i);
  assert.match(h({ running: true, editor: true }).text, /watching the chat box/i);
  assert.equal(h({ running: true, editor: true }).level, "on");
  assert.match(h({ running: true, editor: false }).text, /no chat box on this page yet/i);
  const failed = h({ running: true, editor: true, editFailed: true });
  assert.equal(failed.level, "warn");
  assert.match(failed.text, /couldn't edit the chat box.*by hand/i);
});

test("Self-check wording: a page that removes Clotr's warnings is called out", () => {
  const r = Sites.healthText({ running: true, editor: true, uiRemoved: true });
  assert.equal(r.level, "warn");
  assert.match(r.text, /this page removed Clotr's warnings/i);
});

test("Team policy: required responses win, settings/pause locks apply, bad values are ignored", () => {
  const user = { responses: { email: "log", aws_access_key: "warn" }, paused: true, largeText: false };
  const policy = {
    requiredResponses: { aws_access_key: "block", phone_number: "block", email: "nonsense", "bad id!": "block" },
    lockSettings: true,
    allowPause: false,
    largeText: true,
  };
  const eff = Sites.applyPolicy(user, policy);
  assert.equal(eff.responses.aws_access_key, "block");
  assert.equal(eff.responses.phone_number, "block");
  assert.equal(eff.responses.email, "log", "an invalid policy value keeps the user's choice");
  assert.ok(!("bad id!" in eff.responses));
  assert.equal(eff.paused, false, "pausing not allowed by policy");
  assert.equal(eff.locked, true);
  assert.equal(eff.largeText, true);
  const none = Sites.applyPolicy(user, {});
  assert.deepEqual(none.responses, user.responses);
  assert.equal(none.paused, true);
  assert.equal(none.locked, false);
});

test("Team policy: watch words are cleaned (trimmed, lowercased, up to 4 words, capped), junk dropped", () => {
  const words = Sites.policyWords({
    watchWords: ["  Project   Falcon ", "ACME-internal", "", 42, "one two three four five", "x".repeat(300)],
  });
  assert.deepEqual(words, ["project falcon", "acme-internal"]);
  assert.deepEqual(Sites.policyWords({}), []);
  assert.equal(Sites.policyWords({ watchWords: Array.from({ length: 500 }, (_, i) => `word${i}`) }).length, 200);
});
