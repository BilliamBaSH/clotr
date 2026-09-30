// Builds dist/clotr-<version>.zip from extension/ for a GitHub release or a store
// upload, and records its SHA-256 in dist/SHA256SUMS.txt. Leaves out the user's saved logs
// (bravelogs/) and anything not shipped.
// Usage: npm run package              (Chrome, Brave, Edge)
//        npm run package -- --firefox  (Firefox desktop and Android: same code, Firefox manifest)
//        --out <dir>                   (somewhere other than dist/)
//
// Reproducible (D55): the same source gives a byte-identical zip on any computer, so anyone can
// rebuild a release and compare checksums. Files are sorted, timestamps fixed, text line endings
// normalized to LF, and entries stored uncompressed (compressed bytes can differ between zlib
// versions; the extension is small).
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "extension");
const SKIP = new Set(["bravelogs", ".DS_Store", "Thumbs.db", "desktop.ini"]);
const TEXT = new Set([".js", ".json", ".html", ".css", ".md", ".txt", ".svg"]);
// 1980-01-01 00:00, the earliest time a zip can hold.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

// Firefox runs background *scripts* (no service worker) and has no declarativeContent; it needs
// an add-on ID and a data-collection declaration (none).
function firefoxManifest(m) {
  m.background = { scripts: ["patterns.js", "detector.js", "backup.js", "sites.js", "background.js"] };
  delete m.storage; // managed_schema is Chrome's; Firefox reads policies.json (docs/team-rollout.md)
  m.permissions = m.permissions.filter((p) => p !== "declarativeContent");
  m.browser_specific_settings = {
    gecko: {
      id: "clotr@billiambash",
      strict_min_version: "140.0",
      data_collection_permissions: { required: ["none"] },
    },
    gecko_android: { strict_min_version: "142.0" },
  };
  return m;
}

// Files git tracks under extension/, or null outside a git checkout. Only these ship, so a
// stray personal file in the folder (notes, a saved chat, an editor backup) never reaches a release.
function trackedFiles() {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--", "extension"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return new Set(
      out
        .split(String.fromCharCode(0))
        .filter(Boolean)
        .map((f) => f.slice("extension/".length)),
    );
  } catch {
    return null;
  }
}

// Every shipped file as [zip path, bytes], sorted by path.
function collect(firefox) {
  const tracked = trackedFiles();
  if (!tracked)
    console.warn("[package] not a git checkout: packaging every file in extension/ (check it has nothing personal)");
  const entries = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      if (SKIP.has(name) || name.endsWith(".log")) continue;
      const file = path.join(dir, name);
      if (fs.statSync(file).isDirectory()) {
        walk(file);
        continue;
      }
      const rel = path.relative(EXT, file).split(path.sep).join("/");
      if (tracked && !tracked.has(rel)) continue;
      let data = fs.readFileSync(file);
      if (TEXT.has(path.extname(name).toLowerCase()))
        data = Buffer.from(data.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
      if (firefox && rel === "manifest.json")
        data = Buffer.from(`${JSON.stringify(firefoxManifest(JSON.parse(data.toString("utf8"))), null, 2)}\n`, "utf8");
      entries.push([rel, data]);
    }
  })(EXT);
  return entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// A plain zip: stored entries, UTF-8 names, no extra fields.
function zip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, data);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); // made by
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(0, 10);
    dir.writeUInt16LE(DOS_TIME, 12);
    dir.writeUInt16LE(DOS_DATE, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    // extra, comment, disk, internal attrs, external attrs: all 0
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

// Replace (or add) this zip's line in SHA256SUMS.txt, in `sha256sum` format.
function recordChecksum(outDir, fileName, hash) {
  const sums = path.join(outDir, "SHA256SUMS.txt");
  const lines = fs.existsSync(sums)
    ? fs
        .readFileSync(sums, "utf8")
        .split("\n")
        .filter((l) => l && !l.endsWith(`  ${fileName}`))
    : [];
  lines.push(`${hash}  ${fileName}`);
  fs.writeFileSync(sums, `${lines.sort((a, b) => a.slice(66).localeCompare(b.slice(66))).join("\n")}\n`);
}

// The release's software bill of materials (#166), SPDX 2.3 JSON beside the zip: the extension as one package (its
// version, license and the zip's SHA-256) containing every shipped file with its checksums. No other packages: the
// extension ships no third-party code. Reproducible like the zip: the same fixed time, sorted files, no random ids.
function sbom({ fileName, version, sha256, entries }) {
  const hash = (algo, data) => crypto.createHash(algo).update(data).digest("hex");
  const files = entries.map(([name, data], i) => ({
    fileName: `./${name}`,
    SPDXID: `SPDXRef-File-${i + 1}`,
    checksums: [
      { algorithm: "SHA1", checksumValue: hash("sha1", data) },
      { algorithm: "SHA256", checksumValue: hash("sha256", data) },
    ],
    licenseConcluded: "NOASSERTION",
    copyrightText: "NOASSERTION",
  }));
  // SPDX's package verification code: the SHA-1 of the files' SHA-1s, sorted and joined.
  const verification = hash(
    "sha1",
    files
      .map((f) => f.checksums[0].checksumValue)
      .sort()
      .join(""),
  );
  const doc = {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: fileName,
    documentNamespace: `https://github.com/BilliamBaSH/clotr/releases/${fileName}/${sha256}`,
    creationInfo: { created: "1980-01-01T00:00:00Z", creators: ["Tool: clotr-tools-package"] },
    packages: [
      {
        name: "Clotr",
        SPDXID: "SPDXRef-Package-Clotr",
        versionInfo: version,
        packageFileName: fileName,
        downloadLocation: "https://github.com/BilliamBaSH/clotr/releases",
        filesAnalyzed: true,
        packageVerificationCode: { packageVerificationCodeValue: verification },
        checksums: [{ algorithm: "SHA256", checksumValue: sha256 }],
        licenseConcluded: "AGPL-3.0-or-later",
        licenseDeclared: "AGPL-3.0-or-later",
        copyrightText: "NOASSERTION",
        primaryPackagePurpose: "APPLICATION",
        comment: "A browser extension. It ships no third-party packages and no AI model.",
      },
    ],
    files,
    relationships: [
      { spdxElementId: "SPDXRef-DOCUMENT", relationshipType: "DESCRIBES", relatedSpdxElement: "SPDXRef-Package-Clotr" },
      ...files.map((f) => ({
        spdxElementId: "SPDXRef-Package-Clotr",
        relationshipType: "CONTAINS",
        relatedSpdxElement: f.SPDXID,
      })),
    ],
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function build({ firefox = false, outDir = path.join(ROOT, "dist") } = {}) {
  const { version } = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  const entries = collect(firefox);
  // Every file the manifest names must be in the zip. A new file git doesn't track yet would be
  // left out (only tracked files ship) and the extension would break at load.
  const m = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  const needed = [
    m.background?.service_worker,
    m.action?.default_popup,
    m.storage?.managed_schema,
    ...(m.content_scripts || []).flatMap((c) => c.js),
    ...Object.values(m.icons || {}),
    ...Object.values(m.action?.default_icon || {}),
  ].filter(Boolean);
  const shipped = new Set(entries.map(([n]) => n));
  const missing = needed.filter((f) => !shipped.has(f));
  if (missing.length)
    throw new Error(
      `the manifest uses files that aren't in the zip: ${missing.join(", ")} (new files must be added to git)`,
    );
  const bytes = zip(entries);
  const fileName = `clotr-${version}${firefox ? "-firefox" : ""}.zip`;
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, fileName);
  fs.writeFileSync(out, bytes);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  recordChecksum(outDir, fileName, sha256);
  const sbomOut = path.join(outDir, fileName.replace(/\.zip$/, ".spdx.json"));
  fs.writeFileSync(sbomOut, sbom({ fileName, version, sha256, entries }));
  return { out, sbom: sbomOut, files: entries.map(([n]) => n), size: bytes.length, sha256 };
}

module.exports = { build, crc32 };

if (require.main === module) {
  const i = process.argv.indexOf("--out");
  const r = build({
    firefox: process.argv.includes("--firefox"),
    outDir: i > 0 ? path.resolve(process.argv[i + 1]) : undefined,
  });
  console.log(`${path.relative(ROOT, r.out)}: ${r.files.length} files, ${(r.size / 1024).toFixed(0)} KB`);
  console.log(`SHA-256 ${r.sha256} (also in ${path.relative(ROOT, path.join(path.dirname(r.out), "SHA256SUMS.txt"))})`);
  console.log(`Software bill of materials: ${path.relative(ROOT, r.sbom)}`);
}
