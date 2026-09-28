// Release zips (tools/package.js, D55): reproducible, readable, and exactly what ships.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { build, crc32 } = require("../tools/package.js");

const EXT = path.join(__dirname, "..", "ai-privacy-guard");

// Read a stored-only zip back: [name, bytes] per entry, checking each CRC.
function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end > 0, "no end-of-directory record");
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    assert.strictEqual(buf.readUInt32LE(p), 0x02014b50, "bad central directory entry");
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    assert.strictEqual(method, 0, `${name}: not stored`);
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(dataStart, dataStart + size);
    assert.strictEqual(crc32(data), crc, `${name}: CRC mismatch`);
    out.push([name, data]);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "clotr-pkg-test-"));

test("release zip is byte-identical when built twice, and its checksum is recorded", () => {
  const a = build({ outDir: tmp() });
  const b = build({ outDir: tmp() });
  assert.strictEqual(a.sha256, b.sha256);
  assert.ok(fs.readFileSync(a.out).equals(fs.readFileSync(b.out)));
  const sums = fs.readFileSync(path.join(path.dirname(a.out), "SHA256SUMS.txt"), "utf8");
  assert.strictEqual(sums, `${a.sha256}  ${path.basename(a.out)}\n`);
  assert.strictEqual(crypto.createHash("sha256").update(fs.readFileSync(a.out)).digest("hex"), a.sha256);
});

test("release zip holds exactly the shipped files, sorted, manifest at the root, LF text", () => {
  const r = build({ outDir: tmp() });
  const entries = unzip(fs.readFileSync(r.out));
  const names = entries.map(([n]) => n);
  assert.deepStrictEqual(names, [...names].sort());
  assert.ok(names.includes("manifest.json") && names.includes("content.js") && names.includes("dashboard.html"));
  assert.ok(!names.some((n) => n.startsWith("bravelogs/") || n.endsWith(".log") || n.includes("\\")), names.join());
  for (const [name, data] of entries) {
    const disk = fs.readFileSync(path.join(EXT, ...name.split("/")));
    if (/\.(js|json|html|css|md|txt|svg)$/.test(name)) {
      assert.ok(!data.includes("\r\n"), `${name}: CRLF`);
      assert.strictEqual(data.toString("utf8"), disk.toString("utf8").replace(/\r\n/g, "\n"), `${name} differs`);
    } else {
      assert.ok(data.equals(disk), `${name} differs`);
    }
  }
});

test("Firefox zip gets the Firefox manifest; checksums of both builds sit side by side", () => {
  const dir = tmp();
  const chrome = build({ outDir: dir });
  const ff = build({ firefox: true, outDir: dir });
  const m = JSON.parse(
    unzip(fs.readFileSync(ff.out))
      .find(([n]) => n === "manifest.json")[1]
      .toString("utf8"),
  );
  assert.deepStrictEqual(m.background, { scripts: ["patterns.js", "detector.js", "sites.js", "background.js"] });
  assert.ok(!m.storage, "Chrome's managed_schema key stays out of the Firefox manifest");
  assert.ok(!m.permissions.includes("declarativeContent"));
  assert.strictEqual(m.browser_specific_settings.gecko.id, "clotr-ai-privacy-guard@billiambash");
  const sums = fs.readFileSync(path.join(dir, "SHA256SUMS.txt"), "utf8").trim().split("\n");
  assert.deepStrictEqual(
    sums.sort(),
    [`${chrome.sha256}  ${path.basename(chrome.out)}`, `${ff.sha256}  ${path.basename(ff.out)}`].sort(),
  );
  build({ outDir: dir }); // rebuilding replaces its line instead of adding another
  assert.strictEqual(fs.readFileSync(path.join(dir, "SHA256SUMS.txt"), "utf8").trim().split("\n").length, 2);
});

test("a file git doesn't track (personal notes, a saved chat) never ships", () => {
  const stray = path.join(EXT, "zz-private-notes.txt");
  fs.writeFileSync(stray, "my phone 937-555-0147\n");
  try {
    const r = build({ outDir: tmp() });
    assert.ok(!r.files.includes("zz-private-notes.txt"), "untracked file was packaged");
    assert.ok(!fs.readFileSync(r.out).includes("937-555-0147"), "its contents are in the zip");
  } finally {
    fs.rmSync(stray, { force: true });
  }
});
