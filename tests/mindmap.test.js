// The mind map of everything you could be leaking (D75): its model and its layout, without a browser.
// Run from the repo root: npm test
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../extension/patterns.js"); // pattern names for kinds (English here)
require("../extension/insights.js");
require("../extension/mindmap.js");
const { exposureModel, buildMindMapTree } = globalThis.ClotrInsights;
const { layoutRadial, mindMapRows } = globalThis.ClotrMindMap; // layoutList is read in its own test

const ev = (site, type, action, fp = "", severity = "medium") => ({
  t: 1,
  site,
  type,
  name: type,
  severity,
  action,
  fp,
});
const EVENTS = [
  ev("chatgpt.com", "phone_number", "allowed", "a000000000000001"),
  ev("chatgpt.com", "phone_number", "allowed", "a000000000000001"),
  ev("chatgpt.com", "email", "suppressed", "a000000000000002", "low"),
  ev("claude.ai", "aws_access_key", "redacted", "a000000000000003", "high"),
  ev("claude.ai", "credit_card", "allowed", "a000000000000004", "high"),
];
const MENTIONS = [ev("gemini.google.com", "my_name", "mentioned", "b000000000000001", "high")];
const VAULT = [
  { kind: "value", type: "phone_number", fp: "a000000000000001", mode: "protect" }, // was sent
  { kind: "value", type: "street_address", fp: "c000000000000001", mode: "protect" }, // never sent
  { kind: "value", type: "street_address", fp: "c000000000000002", mode: "protect" }, // never sent
  { kind: "value", type: "email", fp: "c000000000000003", mode: "allow" }, // fine to share: not "at risk"
  { kind: "word", type: "my_name", fp: "b000000000000001" }, // brought up in a reply
  { kind: "word", type: "family_name", fp: "c000000000000004" }, // never sent
];
const model = () => exposureModel({ events: EVENTS, mentions: MENTIONS, vault: VAULT, blind: ["chat.newtool.ai"] });
const branch = (tree, key) => tree.children.find((b) => b.key === key);

test("model: what each AI has counts sent, just counted and reply mentions; near misses count hidden", () => {
  const m = model();
  const has = Object.fromEntries(m.has.bySite.map((s) => [s.key, s.count]));
  assert.deepEqual(has, { "chatgpt.com": 3, "claude.ai": 1, "gemini.google.com": 1 });
  assert.equal(m.has.bySite.find((s) => s.key === "claude.ai").severity, "high");
  assert.deepEqual(
    m.near.bySite.map((s) => [s.key, s.count]),
    [["claude.ai", 1]],
  );
  assert.deepEqual(
    m.mentioned.bySite.map((s) => s.key),
    ["gemini.google.com"],
  );
});

test("model: not shared yet = vault details no AI has seen (fine-to-share and sent ones excluded)", () => {
  const open = Object.fromEntries(model().open.map((o) => [o.key, o.count]));
  assert.deepEqual(open, { street_address: 2, family_name: 1 });
});

test("tree: four branches in both views, even with no history", () => {
  for (const view of ["service", "kind"]) {
    const empty = buildMindMapTree(exposureModel({}), { view });
    assert.deepEqual(
      empty.children.map((b) => b.key),
      ["has", "near", "open", "blind"],
    );
    const cantSee = branch(empty, "blind").children.find((c) => c.type === "cant-see");
    assert.equal(cantSee.children.length, 3, "desktop apps, phone apps, browser side panels");
  }
});

test("tree: the toggle regroups by AI service or by kind", () => {
  const byService = buildMindMapTree(model(), { view: "service" });
  const has = branch(byService, "has");
  assert.deepEqual(
    has.children.map((c) => [c.type, c.key]),
    [
      ["service", "chatgpt.com"],
      ["service", "claude.ai"],
      ["service", "gemini.google.com"],
    ],
  );
  const chatgpt = has.children[0];
  assert.deepEqual(
    chatgpt.children.map((l) => [l.label, l.count]),
    [
      ["Phone Number", 2],
      ["Email Address", 1],
    ],
  );
  assert.equal(has.children[2].mentioned, 1, "gemini's reply brought up your name");

  const byKind = buildMindMapTree(model(), { view: "kind" });
  const phone = branch(byKind, "has").children.find((c) => c.key === "phone_number");
  assert.equal(phone.type, "kind");
  assert.deepEqual(
    phone.children.map((l) => [l.label, l.count]),
    [["chatgpt.com", 2]],
  );
});

test("tree: a crowded branch collapses into +N more", () => {
  const events = Array.from({ length: 12 }, (_, i) =>
    ev(`ai${String(i).padStart(2, "0")}.example`, "email", "allowed"),
  );
  const has = branch(buildMindMapTree(exposureModel({ events }), { max: 8 }), "has");
  assert.equal(has.children.length, 8);
  const more = has.children.at(-1);
  assert.equal(more.type, "more");
  assert.equal(more.label, "+5 more");
  assert.equal(more.count, 5);
  assert.equal(more.branch, "has", "drawn in its branch's style (it broke the by-kind view)");
});

test("tree, compact (popup): only branches with something, no leaves, no can't-see branch", () => {
  const tree = buildMindMapTree(exposureModel({ events: EVENTS }), { compact: true });
  assert.deepEqual(
    tree.children.map((b) => b.key),
    ["has", "near"],
  );
  for (const b of tree.children) for (const c of b.children) assert.equal(c.children.length, 0);
});

test("never a value: the tree holds kinds, sites and counts only", () => {
  const text = JSON.stringify(buildMindMapTree(model()), (k, v) => (v instanceof Map ? [...v] : v));
  for (const fp of ["a000000000000001", "c000000000000001", "b000000000000001"]) assert.ok(!text.includes(fp));
});

test("layout: every node gets a finite slice; children split their parent's slice in order", () => {
  const tree = layoutRadial(buildMindMapTree(model()));
  const check = (n) => {
    assert.ok(Number.isFinite(n.angle) && n.a1 > n.a0, `${n.id} has a slice`);
    let a = n.a0;
    for (const c of n.children) {
      assert.equal(c.depth, n.depth + 1);
      assert.ok(Math.abs(c.a0 - a) < 1e-9, `${c.id} starts where its sibling ended`);
      assert.ok(c.a1 <= n.a1 + 1e-9, `${c.id} stays inside ${n.id}`);
      a = c.a1;
      check(c);
    }
    if (n.children.length) assert.ok(Math.abs(a - n.a1) < 1e-9, `${n.id}'s children fill its slice`);
  };
  check(tree);
  assert.ok(Math.abs(tree.a1 - tree.a0 - 2 * Math.PI) < 1e-9, "the whole circle");
});

test("layout: a busy branch gets a wider slice than an empty one", () => {
  const tree = layoutRadial(buildMindMapTree(model()));
  const span = (key) => branch(tree, key).a1 - branch(tree, key).a0;
  assert.ok(span("has") > span("near"));
});

test("table view: one row per service, kind, spotted site and the can't-see entry", () => {
  const rows = mindMapRows(buildMindMapTree(model()));
  const blind = rows.filter((r) => r.branch === "Blind spots");
  assert.deepEqual(
    blind.map((r) => r.what),
    ["chat.newtool.ai", "Clotr can't see"],
  );
  assert.match(blind[1].detail, /AI apps on your computer/);
  assert.ok(rows.some((r) => r.branch === "Not shared yet" && r.count === "2"));
});

test("layout: every branch around You gets at least its minimum share of the circle", () => {
  const tree = layoutRadial(buildMindMapTree(model()));
  for (const b of tree.children) assert.ok(b.a1 - b.a0 >= 0.14 * 2 * Math.PI - 1e-9, `${b.key} is squeezed`);
});

test("outline layout (narrow windows): one row per node, children indented under their parent", () => {
  const { layoutList } = globalThis.ClotrMindMap;
  const tree = layoutList(buildMindMapTree(model(), { leaves: false }));
  assert.equal(tree.layout, "list");
  const ys = [];
  const check = (n) => {
    ys.push(n.y);
    for (const c of n.children) {
      assert.ok(c.x > n.x && c.y > n.y, `${c.id} sits below and to the right of ${n.id}`);
      check(c);
    }
  };
  check(tree);
  assert.equal(new Set(ys).size, ys.length, "no two nodes share a row");
});

test("blind spots: spotted AI sites Clotr doesn't protect at all (a protected section of a site counts as protected)", () => {
  const { unprotectedHosts } = globalThis.ClotrInsights;
  const covered = ["https://chatgpt.com/*", "https://huggingface.co/chat/*", "https://huggingface.co/spaces/x/*"];
  assert.deepEqual(
    unprotectedHosts({ "chat.newtool.ai": true, "chatgpt.com": true, "huggingface.co": true }, covered),
    ["chat.newtool.ai"],
  );
  assert.deepEqual(unprotectedHosts({}, covered), []);
  assert.deepEqual(unprotectedHosts(null, covered), []);
});
