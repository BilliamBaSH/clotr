// Which pages a user-added AI site covers. Run from the repo root: npm test
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

// sites.js reads the built-in list from the manifest and grants from chrome.permissions.
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "extension", "manifest.json"), "utf8"));
let granted = [];
let stored = {};
globalThis.chrome = {
  runtime: { getManifest: () => manifest },
  permissions: { getAll: async () => ({ origins: granted }) },
  storage: { local: { get: async (k) => ({ [k]: stored[k] }) } },
};
require("../extension/sites.js");
require("../extension/patterns.js");
require("../extension/detector.js");
const Sites = globalThis.ClotrSites;
const Clotr = globalThis.Clotr;

test("Everyday sites (D134): email and chat apps are 'everyday', AI tools aren't, and your own choice wins", () => {
  assert.equal(Sites.isEveryday("mail.google.com"), true);
  assert.equal(Sites.isEveryday("discord.com"), true);
  assert.equal(Sites.isEveryday("app.slack.com"), true);
  assert.equal(Sites.isEveryday("chatgpt.com"), false);
  assert.equal(Sites.isEveryday("chat.newtool.ai"), false, "a site you added as an AI tool stays an AI tool");
  assert.equal(Sites.isEveryday("forum.example.org", { "forum.example.org": "everyday" }), true);
  assert.equal(Sites.isEveryday("discord.com", { "discord.com": "ai" }), false, "you said it's an AI tool");
  assert.equal(Sites.isEveryday(""), false);
  assert.equal(Sites.everydaySiteFor("outlook.office.com")?.name, "Outlook");
  assert.equal(Sites.everydaySiteFor("chatgpt.com"), null);
});

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

test("Team pack presets: keys_never and client_names list exactly the credentials/personal PATTERNS groups (drift guard)", () => {
  const groupIds = (group) =>
    Clotr.PATTERNS.filter((p) => p.group === group)
      .map((p) => p.id)
      .sort();
  // Every credential kind, Stripe publishable keys and internal addresses included (the maintainer's Q30 answer, D117).
  assert.deepEqual(Object.keys(Sites.PRESETS.keys_never.requiredResponses).sort(), groupIds("credentials"));
  const clientNamesIds = Object.keys(Sites.PRESETS.client_names.requiredResponses).filter((id) => id !== "watch_list");
  assert.deepEqual(clientNamesIds.sort(), groupIds("personal"));
});

test("Team pack: a preset expands to its requiredResponses; an explicit field beats the preset; an unknown preset is ignored", () => {
  const withPreset = Sites.mergePolicy({ preset: "keys_never" });
  assert.equal(withPreset.requiredResponses.github_token, "block");
  assert.equal(withPreset.allowPause, false);
  assert.equal(withPreset.preset, "keys_never");

  const overridden = Sites.mergePolicy({ preset: "keys_never", requiredResponses: { github_token: "warn" } });
  assert.equal(overridden.requiredResponses.github_token, "warn", "the admin's explicit field beats the preset");
  assert.equal(overridden.requiredResponses.aws_access_key, "block", "the rest of the preset still applies");

  const unknown = Sites.mergePolicy({ preset: "not-a-real-preset", requiredResponses: { email: "warn" } });
  assert.equal(unknown.preset, undefined, "an unknown preset is ignored, not carried through");
  assert.deepEqual(unknown.requiredResponses, { email: "warn" });

  const noProto = Sites.mergePolicy({ requiredResponses: JSON.parse('{"__proto__": {"polluted": true}}') });
  assert.equal({}.polluted, undefined, "a __proto__ key in the policy never reaches Object.prototype");
  assert.ok(!("polluted" in noProto.requiredResponses));
});

test("Clotr.stricter: block is stricter than warn, warn stricter than log; an unrecognized value counts as warn", () => {
  assert.equal(Clotr.stricter("block", "warn"), "block");
  assert.equal(Clotr.stricter("warn", "block"), "block");
  assert.equal(Clotr.stricter("warn", "log"), "warn");
  assert.equal(Clotr.stricter("log", "log"), "log");
  assert.equal(Clotr.stricter("block", "block"), "block");
  assert.equal(Clotr.stricter("nonsense", "log"), "warn", "an unrecognized response is a warn, not the loosest");
});

test("Team policy floor (D115): a required response never downgrades a stricter choice the person already made", () => {
  const user = { responses: { credit_card: "block", phone_number: "log" } };
  const policy = { requiredResponses: { credit_card: "warn", phone_number: "warn" } };
  const eff = Sites.applyPolicy(user, policy);
  assert.equal(eff.responses.credit_card, "block", "the person's own block is stricter than the policy's warn");
  assert.equal(eff.responses.phone_number, "warn", "the policy's warn is stricter than the person's log");
});

test("Team pack: floorOf reports a required block so the background can keep a vault 'allow' entry from weakening it", () => {
  const policy = { requiredResponses: { phone_number: "block", credit_card: "warn" } };
  assert.equal(Sites.floorOf(policy, "phone_number"), "block");
  assert.equal(Sites.floorOf(policy, "credit_card"), null, "a required warn is not a floor for this purpose");
  assert.equal(Sites.floorOf(policy, "email"), null, "a kind with no required response");
  assert.equal(Sites.floorOf({}, "phone_number"), null, "no policy at all");
});

test("Team pack: policyFingerprint is stable, a preset equals its expanded JSON, and orgName/preset/version don't affect it", () => {
  const preset = Sites.mergePolicy({ preset: "keys_never", orgName: "Acme" });
  const expanded = Sites.mergePolicy({
    requiredResponses: Sites.PRESETS.keys_never.requiredResponses,
    allowPause: false,
  });
  assert.equal(
    Sites.policyFingerprint(preset),
    Sites.policyFingerprint(expanded),
    "a preset and its expanded JSON must print the same fingerprint",
  );
  assert.equal(Sites.policyFingerprint(preset), Sites.policyFingerprint(preset), "stable across calls");
  const differentOrgName = Sites.mergePolicy({ preset: "keys_never", orgName: "Someone Else" });
  assert.equal(Sites.policyFingerprint(preset), Sites.policyFingerprint(differentOrgName), "orgName excluded");
  const differentRequired = Sites.mergePolicy({ preset: "client_names" });
  assert.notEqual(Sites.policyFingerprint(preset), Sites.policyFingerprint(differentRequired));
  assert.match(Sites.policyFingerprint(preset), /^[0-9A-F]{16}$/);
});

test("Team pack docs: the expanded JSON block for each preset in docs/team-rollout.md matches sites.js's PRESETS exactly (drift guard)", () => {
  const doc = fs.readFileSync(path.join(__dirname, "..", "docs", "team-rollout.md"), "utf8");
  const re = /```json\s*\{\s*"preset":\s*"(\w+)"\s*\}\s*```\s*is the same as:\s*```json([\s\S]*?)```/g;
  const found = [...doc.matchAll(re)].map((m) => [m[1], JSON.parse(m[2])]);
  assert.deepEqual(
    found.map(([id]) => id).sort(),
    Object.keys(Sites.PRESETS).sort(),
    "docs/team-rollout.md should show one expanded block per preset in sites.js",
  );
  for (const [id, expanded] of found) assert.deepEqual(expanded, Sites.PRESETS[id], `preset ${id}`);
});

test("Team pack: a watch format (# digit, @ letter) needs 4+ marks and no digits, up to 40 characters", () => {
  assert.equal(Sites.isShape("EMP-#####"), true);
  assert.equal(Sites.isShape("EMP-12345"), false, "an actual example, not a format, has digits");
  assert.equal(Sites.isShape("c#"), false, "only one mark");
  assert.equal(Sites.isShape("#@#@" + "x".repeat(40)), false, "over 40 characters");
  assert.equal(Sites.isShape(42), false);
});

test("Team pack: watch formats travel separately from watch words, capped at 20", () => {
  const shapes = Sites.policyShapes({ watchWords: ["Acme Holdings", "EMP-#####", "EMP-#####", "c#"] });
  assert.deepEqual(shapes, ["EMP-#####"]);
  assert.deepEqual(Sites.policyShapes({}), []);
  const many = Array.from({ length: 30 }, (_, i) => `@@${String.fromCharCode(65 + i)}-####`);
  assert.equal(Sites.policyShapes({ watchWords: many }).length, 20);
  // A format never also shows up as a hashed literal word.
  const words = Sites.policyWords({ watchWords: ["Acme Holdings", "EMP-#####"] });
  assert.deepEqual(words, ["acme holdings"]);
});

test("Team policy: watch words are cleaned (trimmed, lowercased, up to 4 words, capped), junk dropped", () => {
  const words = Sites.policyWords({
    watchWords: ["  Project   Falcon ", "ACME-internal", "", 42, "one two three four five", "x".repeat(300)],
  });
  assert.deepEqual(words, ["project falcon", "acme-internal"]);
  assert.deepEqual(Sites.policyWords({}), []);
  assert.equal(Sites.policyWords({ watchWords: Array.from({ length: 500 }, (_, i) => `word${i}`) }).length, 200);
});
