// Attached files read as text (ai-privacy-guard/attachments.js), in Node: File and
// DecompressionStream are built in. Browser behavior (warnings on attach) is in the e2e suite.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("zlib");
const { crc32 } = require("../tools/package.js");

require("../ai-privacy-guard/patterns.js");
require("../ai-privacy-guard/detector.js");
require("../ai-privacy-guard/attachments.js");
const { readAttachment } = globalThis.Clotr;

// A minimal zip: entries [name, text, deflate?].
function zip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, text, deflate] of entries) {
    const raw = Buffer.from(text, "utf8");
    const data = deflate ? zlib.deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, data);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(deflate ? 8 : 0, 10);
    dir.writeUInt32LE(crc32(raw), 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const dirBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dirBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dirBuf, end]);
}

const docXml = (text) => `<w:document><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`;

test("Word documents: text read from stored and compressed parts; other parts ignored", async () => {
  const stored = new File(
    [
      zip([
        ["word/document.xml", docXml("call 937-555-0123"), false],
        ["docProps/app.xml", "<x>ignore me 555-0199</x>", false],
      ]),
    ],
    "a.docx",
  );
  const text = await readAttachment(stored);
  assert.match(text, /937-555-0123/);
  assert.doesNotMatch(text, /555-0199/);
  const packed = new File([zip([["word/document.xml", docXml("my key AKIA4HPQ7XZ2R6TWLJ3N"), true]])], "b.docx");
  assert.match(await readAttachment(packed), /AKIA4HPQ7XZ2R6TWLJ3N/);
});

test("text files are read; unknown kinds and broken files give null (fail open)", async () => {
  assert.equal(await readAttachment(new File(["email me: a@b.co"], "notes.txt")), "email me: a@b.co");
  assert.equal(await readAttachment(new File([new Uint8Array([1, 2, 3])], "photo.jpg", { type: "image/jpeg" })), null);
  assert.equal(await readAttachment(new File(["not a zip"], "broken.docx")), null);
  assert.equal(await readAttachment(new File(["%not a pdf"], "x.pdf")), null);
});

test("zip bomb: a part that inflates far past the cap stops at 2 MB", async () => {
  const bomb = new File(
    [zip([["word/document.xml", `<w:t>${"A".repeat(30 * 1024 * 1024)}</w:t>`, true]])],
    "bomb.docx",
  );
  const t = performance.now();
  const text = await readAttachment(bomb);
  assert.ok(text.length <= 2 * 1024 * 1024 + 1, `read ${text.length} characters`);
  assert.ok(performance.now() - t < 5000, "took too long");
});
