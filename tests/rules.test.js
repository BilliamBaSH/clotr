// Project-rule checks (the hard rules every change must keep). Static scans of the shipped extension,
// so a rule break fails `npm test` instead of waiting for a review or a real site.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const EXT = path.join(__dirname, "..", "extension");
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
const scripts = fs.readdirSync(EXT).filter((f) => f.endsWith(".js"));
const htmls = fs.readdirSync(EXT).filter((f) => f.endsWith(".html"));

// Source without comments, so rules explained in comments don't trip the scan.
function code(file) {
  return fs
    .readFileSync(path.join(EXT, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

function offenders(re, files = scripts) {
  return files.flatMap((f) =>
    code(f)
      .split("\n")
      .map((line, i) => (re.test(line) ? `${f}:${i + 1}: ${line.trim()}` : null))
      .filter(Boolean),
  );
}

test("every script parses as a classic script (no import/export)", () => {
  for (const f of scripts) {
    assert.doesNotThrow(() => new vm.Script(fs.readFileSync(path.join(EXT, f), "utf8"), { filename: f }), f);
  }
  assert.deepEqual(offenders(/^\s*(import|export)\s/), []);
  assert.notEqual(manifest.background?.type, "module", "background must stay a classic service worker");
});

test("manifest: MV3, valid version, files exist", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  const files = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...manifest.content_scripts.flatMap((c) => c.js),
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
  ];
  for (const f of files) assert.ok(fs.existsSync(path.join(EXT, f)), `missing ${f}`);
});

test("scope: only specific https AI-site origins, never broad patterns", () => {
  const broad = (p) => p === "<all_urls>" || /^(\*|https?):\/\/\*(\/|\.)/.test(p);
  const matches = manifest.content_scripts.flatMap((c) => c.matches);
  for (const m of matches) {
    assert.match(m, /^https:\/\/[a-z0-9.-]+\.[a-z]+\/.*$/, `content script match: ${m}`);
    assert.ok(!broad(m), `broad content script match: ${m}`);
  }
  for (const p of manifest.host_permissions || []) assert.ok(!broad(p), `broad host permission: ${p}`);
  // Per-site opt-in is requested at runtime from this optional set; nothing broad is granted up front.
  assert.deepEqual(manifest.optional_host_permissions, ["https://*/*"]);
  assert.ok(!(manifest.permissions || []).some(broad), "broad pattern in permissions");
});

// D134: email and chat apps are never built in. Each one runs Clotr only after the user switches it on and the
// browser grants that one site, so the install prompt never mentions them.
test("scope: everyday sites (email, chat apps) are specific https hosts and never built in", () => {
  globalThis.chrome ??= {};
  require("../extension/sites.js");
  const { EVERYDAY_SITES } = globalThis.ClotrSites;
  assert.ok(EVERYDAY_SITES.length >= 4, "the everyday list is there");
  const builtIn = new Set(
    [...manifest.content_scripts.flatMap((c) => c.matches), ...(manifest.host_permissions || [])].map(
      (p) => new URL(p.replace(/\*$/, "")).hostname,
    ),
  );
  for (const s of EVERYDAY_SITES) {
    assert.ok(s.name && ["email", "chat"].includes(s.kind), `${s.name}: a name and a kind`);
    for (const m of s.matches) {
      assert.match(m, /^https:\/\/[a-z0-9.-]+\.[a-z]+\/\*$/, `${s.name}: ${m} is one whole https host`);
      assert.ok(!builtIn.has(new URL(m.replace(/\*$/, "")).hostname), `${s.name}: ${m} is built in`);
    }
  }
});

test("no innerHTML-style HTML injection (Trusted Types)", () => {
  assert.deepEqual(offenders(/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write\(/), []);
});

test("100% local: no network calls, no remote code", () => {
  assert.deepEqual(offenders(/XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts\(\s*["'`]http/), []);
  // fetch is only allowed for the extension's own files.
  assert.deepEqual(offenders(/fetch\((?!\s*chrome\.runtime\.getURL\()/), []);
  assert.deepEqual(offenders(/<script[^>]+src=["']https?:/i, htmls), []);
  assert.deepEqual(offenders(/<link[^>]+href=["']https?:/i, htmls), []);
  // No code made from strings (release review 2026-09-30): the CSP forbids it on Clotr's pages, but content
  // scripts run under each AI site's own policy.
  assert.deepEqual(offenders(/\beval\s*\(|\bnew\s+Function\s*\(|\bset(Timeout|Interval)\(\s*["'`]/), []);
});

// Security (release review 2026-09-30): Clotr's scripts inside AI pages share the page with the site's code, so the
// messages that remove or loosen a protected detail, or replace every setting, are taken only from Clotr's own pages.
test("vault edits and backups are accepted only from Clotr's own pages", () => {
  const bg = code("background.js");
  assert.match(
    bg,
    /const fromClotrPage = \(sender\) => \(sender\.url \|\| ""\)\.startsWith\(chrome\.runtime\.getURL\(""\)\);/,
  );
  for (const type of ["clotr:vaultUpdate", "clotr:importBackup"]) {
    const at = bg.indexOf(`case "${type}":`);
    assert.ok(at > 0, type);
    const body = bg.slice(at, bg.indexOf("return reply(", at));
    assert.match(body, /if \(!fromClotrPage\(sender\)\) return false;/, `${type} checks the sender first`);
  }
  // And the scripts inside AI pages never send them.
  assert.deepEqual(
    offenders(
      /clotr:(vaultUpdate|importBackup)/,
      manifest.content_scripts.flatMap((c) => c.js),
    ),
    [],
  );
});

test("chrome.action.setIcon always passes a tabId", () => {
  const calls = scripts.flatMap((f) => code(f).match(/chrome\.action\.setIcon\(\{[^}]*\}/g) || []);
  for (const c of calls) assert.match(c, /tabId/, c);
});

test("user-added sites get the same scripts as built-in ones", () => {
  const listed = code("sites.js").match(/const CONTENT_JS = (\[[^\]]*\])/);
  assert.ok(listed, "CONTENT_JS not found in sites.js");
  assert.deepEqual(JSON.parse(listed[1].replace(/,\s*\]$/, "]")), manifest.content_scripts[0].js); // a formatter may add a trailing comma
  // The popup shows detection types and fingerprints: it needs the detection pair, nothing else.
  const popup = fs.readFileSync(path.join(EXT, "popup.html"), "utf8");
  for (const f of ["patterns.js", "detector.js"]) {
    assert.ok(manifest.content_scripts[0].js.includes(f), `content scripts don't include ${f}`);
    assert.ok(popup.includes(`<script src="${f}">`), `popup.html doesn't load ${f}`);
  }
});

test("built-in AI-site list (ai-sites.json) matches the manifest", () => {
  const sites = JSON.parse(fs.readFileSync(path.join(EXT, "ai-sites.json"), "utf8"));
  const names = sites.map((s) => s.name);
  assert.equal(new Set(names).size, names.length, "duplicate tool names");
  for (const s of sites) {
    assert.ok(typeof s.name === "string" && s.name.trim(), `site without a name: ${JSON.stringify(s)}`);
    assert.ok(Array.isArray(s.matches) && s.matches.length, `${s.name}: no matches`);
  }
  assert.deepEqual(
    sites.flatMap((s) => s.matches),
    manifest.content_scripts[0].matches,
    "out of sync: run `npm run sites` after editing ai-sites.json",
  );
  // Host access to the same sites lets an update start the new version in open tabs (D39).
  assert.deepEqual(
    manifest.host_permissions,
    manifest.content_scripts[0].matches,
    "host_permissions out of sync: run `npm run sites`",
  );
});

test("every pattern belongs to a Settings group", () => {
  require("../extension/patterns.js");
  for (const p of globalThis.Clotr.PATTERNS)
    assert.ok(["credentials", "personal", "custom"].includes(p.group), `${p.id}: group ${p.group}`);
});

test("changelog.json has notes for the current version", () => {
  const log = JSON.parse(fs.readFileSync(path.join(EXT, "changelog.json"), "utf8"));
  const minor = manifest.version.split(".").slice(0, 2).join(".");
  assert.ok(Array.isArray(log[minor]) && log[minor].length, `add a "${minor}" entry to extension/changelog.json`);
  // Every interface language gets the notes too (D65): the same number of notes, in the same order.
  for (const lang of fs.readdirSync(path.join(EXT, "_locales")).filter((l) => l !== "en")) {
    const notes = log.translations?.[lang]?.[minor];
    assert.ok(
      Array.isArray(notes) && notes.length === log[minor].length,
      `add translations.${lang}["${minor}"] (${log[minor].length} notes) to changelog.json`,
    );
  }
});

// Windows PowerShell 5.1 writes UTF-8 with a byte-order mark. The extension's own JSON
// reads (the self-update check fetches manifest.json) fail on one.
test("extension JSON files have no byte-order mark", () => {
  for (const f of fs.readdirSync(EXT).filter((n) => n.endsWith(".json"))) {
    assert.notEqual(fs.readFileSync(path.join(EXT, f))[0], 0xef, `${f} starts with a BOM`);
  }
});

// The 0.x builds were alphas and showed "-alpha" in brave://extensions and the store (M6); from 1.0.0, the public
// release, version_name is the plain version. It must follow every version bump.
test("manifest version_name follows the version (-alpha before 1.0)", () => {
  const major = Number(manifest.version.split(".")[0]);
  assert.equal(manifest.version_name, major >= 1 ? manifest.version : `${manifest.version}-alpha`);
});

// The same code ships to Firefox (desktop and Android) via `npm run package -- --firefox`.
// Chrome-only APIs must be guarded so the background keeps running there (M7).
test("background works in Firefox: Chrome-only APIs are guarded", () => {
  const bg = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
  assert.match(
    bg,
    /typeof importScripts === "function"/,
    "importScripts must be optional (Firefox background scripts)",
  );
  assert.match(bg, /if \(!chrome\.declarativeContent\) return;/, "declarativeContent doesn't exist in Firefox");
  assert.match(bg, /chrome\.commands\?\.onCommand/, "commands don't exist on Firefox for Android");
  assert.doesNotMatch(bg.replace(/chrome\.commands\?\./g, ""), /chrome\.commands\./, "unguarded chrome.commands");
});

// Security (M8): no raw invisible or bidirectional-control characters in shipped files. They can
// make code read differently from what it does ("Trojan Source"); write them as \u escapes.
test("no invisible or bidi-control characters in shipped files", () => {
  const bad = [];
  for (const f of fs.readdirSync(EXT).filter((n) => /\.(js|html|css|json)$/.test(n))) {
    const text = fs.readFileSync(path.join(EXT, f), "utf8");
    const m = text.match(/\p{Cf}/u);
    if (m)
      bad.push(
        `${f}: U+${m[0].codePointAt(0).toString(16).toUpperCase().padStart(4, "0")} at line ${text.slice(0, m.index).split("\n").length}`,
      );
  }
  assert.deepEqual(bad, []);
});

// Security (M8): logs end up in bug reports. A log line may name kinds of data (ids), never
// a detected value, the draft, or a file name.
test("console output never includes detected values, drafts or file names", () => {
  const bad = [];
  for (const f of ["content.js", "vault.js", "popup.js", "background.js", "stored.js"]) {
    const text = fs.readFileSync(path.join(EXT, f), "utf8");
    for (const m of text.matchAll(/console\.(log|info|warn|error|debug)\(/g)) {
      // The whole call, even when it spans several lines: up to its closing parenthesis, skipping strings.
      let depth = 0;
      let end = m.index;
      for (let i = m.index + m[0].length - 1, quote = null; i < text.length; i++) {
        const c = text[i];
        if (quote) {
          if (c === "\\") i++;
          else if (c === quote) quote = null;
        } else if (c === '"' || c === "'" || c === "`") quote = c;
        else if (c === "(") depth++;
        else if (c === ")" && --depth === 0) {
          end = i + 1;
          break;
        }
      }
      const call = text.slice(m.index, end);
      if (
        /\.matches\b(?!\.length)|\bgetText\(|\bdraft\b|\bvalue\b|\.name\b(?!\.match)|\btext\b(?!\s*\))/.test(
          call.replace(/"[^"]*"|`[^`]*`/g, ""),
        )
      )
        bad.push(`${f}:${text.slice(0, m.index).split("\n").length}: ${call.replace(/\s+/g, " ").slice(0, 100)}`);
    }
  }
  assert.deepEqual(bad, []);
});

// Security (M8): Clotr's own pages (popup, vault, What Clotr stores) run under a strict policy:
// they can load only the extension's own files and can't connect anywhere else.
test("extension pages have a strict content security policy", () => {
  const csp = manifest.content_security_policy?.extension_pages || "";
  for (const d of [
    "default-src 'self'",
    "script-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ]) {
    assert.ok(csp.includes(d), `missing ${d} in ${JSON.stringify(csp)}`);
  }
  assert.doesNotMatch(csp, /unsafe-eval|unsafe-inline|https?:|\*/, "no unsafe sources or remote hosts");
});

// Security (M8): CI runs with a read-only token, and third-party actions are pinned to exact
// commits so a moved tag can't change what runs.
test("CI: read-only token and actions pinned to commits", () => {
  // Every workflow: read-only by default, actions pinned to commits, no stored checkout credentials.
  const dir = path.join(__dirname, "..", ".github", "workflows");
  const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  assert.ok(files.includes("test.yml"));
  for (const f of files) {
    const wf = fs.readFileSync(path.join(dir, f), "utf8");
    assert.match(wf, /^permissions:\s*\n\s+contents: read/m, `${f}: default permissions must be read-only`);
    const uses = [...wf.matchAll(/uses:\s*([^\s#]+)/g)].map((m) => m[1]);
    for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, `${f}: ${u} is not pinned to a commit`);
    if (/actions\/checkout@/.test(wf))
      assert.match(wf, /persist-credentials: false/, `${f}: checkout keeps credentials`);
  }
});

// Security (M8): Clotr must register its Enter/click listeners before the page's own scripts,
// or a site's early handler can send before Ask before sending holds the message.
test("Clotr starts at document_start (built-in and user-added sites)", () => {
  for (const cs of manifest.content_scripts) assert.equal(cs.run_at, "document_start");
  const bg = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
  assert.match(bg, /runAt:\s*"document_start"/);
  assert.doesNotMatch(bg, /runAt:\s*"document_(idle|end)"/);
});

// No stray control characters (like a backspace from a mistyped "\b") in any source file,
// shipped or not: they're invisible and silently change what regexes and strings mean.
test("no control characters in source files (extension, tests, tools)", () => {
  const dirs = [EXT, __dirname, path.join(__dirname, "e2e"), path.join(__dirname, "..", "tools")];
  const bad = [];
  for (const dir of dirs) {
    for (const f of fs.readdirSync(dir).filter((n) => /\.(js|html|css|json|ps1|sh)$/.test(n))) {
      const text = fs.readFileSync(path.join(dir, f), "utf8");
      const m = text.match(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/);
      if (m)
        bad.push(
          `${path.relative(path.join(__dirname, ".."), path.join(dir, f))}: U+${m[0].charCodeAt(0).toString(16).padStart(4, "0")} at line ${text.slice(0, m.index).split("\n").length}`,
        );
    }
  }
  assert.deepEqual(bad, []);
});

test("content scripts never touch storage directly; the background locks it to Clotr's own pages (S20)", () => {
  const contentFiles = manifest.content_scripts.flatMap((c) => c.js);
  assert.deepEqual(offenders(/chrome\.storage/, contentFiles), []);
  assert.match(
    code("background.js"),
    /chrome\.storage\.local\s*\.setAccessLevel\?\.\(\{ accessLevel: "TRUSTED_CONTEXTS" \}\)/,
  );
});

// Translations (D65): every message the code asks for exists in Spanish, and every kind of
// data has a Spanish name. English is written in the code (and is the fallback).
test("every translated string has a Spanish message; placeholders are well formed", () => {
  const es = JSON.parse(fs.readFileSync(path.join(EXT, "_locales", "es", "messages.json"), "utf8"));
  const used = new Set(scripts.flatMap((f) => [...code(f).matchAll(/\bmsg\(\s*"([A-Za-z0-9_]+)"/g)].map((m) => m[1])));
  const missing = [...used].filter((k) => !es[k]);
  assert.deepEqual(missing, [], `no Spanish for: ${missing.join(", ")}`);
  require("../extension/patterns.js");
  for (const p of globalThis.Clotr.PATTERNS) assert.ok(es[`type_${p.id}`], `no Spanish name for ${p.id}`);
  for (const [k, v] of Object.entries(es)) {
    for (const [, name] of v.message.matchAll(/\$([A-Za-z0-9_]+)\$/g)) {
      assert.ok(v.placeholders?.[name], `${k}: $${name}$ has no placeholder`);
    }
  }
  assert.equal(manifest.default_locale, "en");
});

test("every data-i18n key in Clotr's pages, and every self-check message, has a Spanish message", () => {
  const es = JSON.parse(fs.readFileSync(path.join(EXT, "_locales", "es", "messages.json"), "utf8"));
  const keys = htmls.flatMap((f) =>
    [...fs.readFileSync(path.join(EXT, f), "utf8").matchAll(/data-i18n(?:-[a-z-]+)?="([A-Za-z0-9_]+)"/g)].map(
      (m) => `${f}: ${m[1]}`,
    ),
  );
  keys.push(...[...code("sites.js").matchAll(/key: "([A-Za-z0-9_]+)"/g)].map((m) => `sites.js: ${m[1]}`));
  const missing = keys.filter((k) => !es[k.split(": ")[1]]);
  assert.deepEqual(missing, []);
  for (const f of htmls.filter((f) => /data-i18n/.test(fs.readFileSync(path.join(EXT, f), "utf8")))) {
    assert.match(
      fs.readFileSync(path.join(EXT, f), "utf8"),
      /<script src="page-i18n\.js">/,
      `${f} uses data-i18n but doesn't load page-i18n.js`,
    );
  }
});

// Spanish nouns agree with the number ("1 enviado", "2 enviados"). Lines that combine counts which can be
// 0 or 1 use the label form ("enviados: 1") instead of a count before a plural word ("1 enviados").
test("Spanish: counts that can be 1 aren't written before a plural word", () => {
  const es = JSON.parse(fs.readFileSync(path.join(EXT, "_locales", "es", "messages.json"), "utf8"));
  const COMBINED = [
    "pp_heroSub",
    "pp_digest",
    "pp_daySummary",
    "pp_nFound",
    "db_weekLabel",
    "db_card",
    "mp_mentionedToo",
    "mp_openDetail",
    "mp_more",
  ];
  for (const key of COMBINED) {
    assert.ok(es[key], `${key} is missing`);
    assert.doesNotMatch(es[key].message, /\$p\d\$\s+\p{L}+s\b/u, `${key}: "${es[key].message}"`);
  }
});

// CHANGELOG.md is the public "what changed": it names the version being built, so it can't fall behind.
test("CHANGELOG.md has an entry for the manifest's version", () => {
  const { version_name } = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  const log = fs.readFileSync(path.join(__dirname, "..", "CHANGELOG.md"), "utf8");
  assert.ok(log.includes(`## ${version_name}`), `CHANGELOG.md has no "## ${version_name}" section`);
});

// Every e2e check has its own ID: --only and the test notes refer to them.
test("e2e check IDs are unique", () => {
  // run.js plus one file per area in e2e/checks
  const dir = path.join(__dirname, "e2e", "checks");
  const run = [path.join(__dirname, "e2e", "run.js"), ...fs.readdirSync(dir).map((f) => path.join(dir, f))]
    .map((f) => fs.readFileSync(f, "utf8"))
    .join("\n");
  const ids = [...run.matchAll(/await check\(\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length > 100, `found only ${ids.length} checks: has the check() call format changed?`);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(dup, [], `duplicate check IDs: ${dup.join(", ")}`);
});

// The website (D81) keeps the extension's promise: no script, nothing loaded from other sites, and every local
// file it points to exists. Links to other sites (<a href>) are fine; they load nothing until clicked.
const SITE = path.join(__dirname, "..", "site");
test(
  "the website runs no script and loads nothing from other sites",
  { skip: !fs.existsSync(SITE) && "the website has its own repo" },
  () => {
    const site = SITE;
    // Every page, each with the same strict policy (index.html and, since Batch 4, the printable guide).
    const pages = fs.readdirSync(site).filter((f) => f.endsWith(".html"));
    assert.ok(pages.includes("index.html") && pages.length >= 2, `pages: ${pages}`);
    for (const page of pages.filter((p) => p !== "index.html")) {
      const other = fs.readFileSync(path.join(site, page), "utf8");
      assert.doesNotMatch(other, /<script|\son[a-z]+=|javascript:/i, `${page}: no scripts or inline handlers`);
      assert.match(
        other,
        /Content-Security-Policy[^>]*default-src 'none'/,
        `${page}: a strict content security policy`,
      );
      for (const [, ref] of other.matchAll(
        /<(?:img|link|source|iframe|video|audio)\b[^>]*\s(?:src|href)="([^"]+)"/gi,
      )) {
        assert.doesNotMatch(ref, /^(https?:)?\/\//i, `${page} loads from another site: ${ref}`);
        assert.ok(fs.existsSync(path.join(site, ref.split(/[?#]/)[0])), `${page}: missing file site/${ref}`);
      }
    }
    const html = fs.readFileSync(path.join(site, "index.html"), "utf8");
    const css = fs.readFileSync(path.join(site, "style.css"), "utf8");
    assert.doesNotMatch(html, /<script|\son[a-z]+=|javascript:/i, "no scripts or inline handlers");
    assert.match(html, /Content-Security-Policy[^>]*default-src 'none'/, "a strict content security policy");
    const loads = [
      ...[...html.matchAll(/<(?:img|link|source|iframe|video|audio)\b[^>]*\s(?:src|href)="([^"]+)"/gi)].map(
        (m) => m[1],
      ),
      ...[...css.matchAll(/url\(\s*["']?([^"')]+)/g)].map((m) => m[1]),
    ];
    assert.ok(loads.length >= 8, `found only ${loads.length} loaded files: has the markup changed?`);
    for (const ref of loads) {
      assert.doesNotMatch(ref, /^(https?:)?\/\//i, `loads from another site: ${ref}`);
      assert.ok(fs.existsSync(path.join(site, ref.split(/[?#]/)[0])), `missing file: site/${ref}`);
    }
  },
);

// Your D80 answer (2026-09-29): "use the figma generated branding for everything". Signal orange #FF6700 carries
// Clotr's buttons and brand lines with near-black text on it (7:1); as text it's only 2.9:1 on white, so orange
// words keep #B84A0C. Red and amber stay for warnings.
test("brand: primary buttons are signal orange with dark text, and signal orange is never text", () => {
  const css = fs.readFileSync(path.join(EXT, "popup.css"), "utf8");
  assert.match(css, /--signal:\s*#ff6700/i, "popup.css defines --signal");
  assert.match(css, /--on-signal:\s*#0b0b0b/i, "popup.css defines --on-signal");
  const primary = /\.btn\.primary\s*\{([^}]*)\}/.exec(css)?.[1] || "";
  assert.match(primary, /background:\s*var\(--(signal|btn-primary)\)/, ".btn.primary is signal orange");
  assert.match(css, /--btn-primary:\s*var\(--signal\)/, "--btn-primary is the signal color");
  assert.match(primary, /color:\s*var\(--on-signal\)/, ".btn.primary has dark text");
  const ui = fs.readFileSync(path.join(EXT, "ui-styles.js"), "utf8");
  for (const [name, re] of [
    ["the offer in the chat", /\.offer button\.primary\s*\{([^}]*)\}/],
    ["the reload prompt", /const reload = `[\s\S]*?button\.primary\s*\{([^}]*)\}/],
  ]) {
    const rule = re.exec(ui)?.[1] || "";
    assert.match(rule, /background:\s*#ff6700/i, `${name}: signal orange button`);
    assert.match(rule, /(^|;)\s*color:\s*#0b0b0b/i, `${name}: dark text on it`);
  }
  for (const [file, text] of [
    ["popup.css", css],
    ["ui-styles.js", ui],
    ...["dashboard.css", "vault.css", "stored.css"].map((f) => [f, fs.readFileSync(path.join(EXT, f), "utf8")]),
  ]) {
    assert.doesNotMatch(text, /(^|[\s;{])color:\s*(#ff6700|var\(--signal\))/im, `${file}: signal orange used as text`);
  }
});

// "No AI inside" (D107): Clotr is rules and tests. No model file and no model runtime may ever reach the extension;
// the README, the site and the store cite this check by name.
const MODEL_FILES = /\.(onnx|safetensors|bin|gguf|pt|pth|wasm|tflite|mlmodel)$/i;
const MAX_FILE = 2 * 1024 * 1024; // a model is never small; nothing Clotr ships comes near 2 MB
const MODEL_RUNTIMES = [
  "@huggingface/transformers",
  "onnxruntime-web",
  "onnxruntime-node",
  "@xenova/transformers",
  "@mlc-ai/web-llm",
  "@tensorflow/tfjs",
];
function aiInsideOffenders(extDir, pkgFile) {
  const found = [];
  const walk = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) walk(full);
      else if (MODEL_FILES.test(d.name)) found.push(path.relative(extDir, full));
      else if (fs.statSync(full).size > MAX_FILE) found.push(`${path.relative(extDir, full)} (over 2 MB)`);
    }
  };
  walk(extDir);
  const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies };
  for (const name of MODEL_RUNTIMES) if (deps[name]) found.push(`package.json: ${name}`);
  return found;
}
test("no AI inside: no model files or model runtimes in the extension", () => {
  assert.deepEqual(aiInsideOffenders(EXT, path.join(__dirname, "..", "package.json")), []);
  // The check itself works: a planted model file and a model runtime are both caught.
  const os = require("os");
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-noai-"));
  fs.mkdirSync(path.join(fixture, "ext", "models"), { recursive: true });
  fs.writeFileSync(path.join(fixture, "ext", "models", "privacy-filter.onnx"), "fake");
  fs.writeFileSync(
    path.join(fixture, "package.json"),
    JSON.stringify({ dependencies: { "onnxruntime-web": "1.0.0" } }),
  );
  try {
    assert.deepEqual(aiInsideOffenders(path.join(fixture, "ext"), path.join(fixture, "package.json")), [
      path.join("models", "privacy-filter.onnx"),
      "package.json: onnxruntime-web",
    ]);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

// The maintainer's own line on the welcome page, in their words: short, and the same in Spanish.
test("welcome page: the no-AI line is the maintainer's wording", () => {
  const html = fs.readFileSync(path.join(EXT, "vault.html"), "utf8");
  const line = /data-i18n="vault_noteNoAi">([^<]*)</.exec(html)?.[1];
  assert.equal(line, "Clotr has absolutely NO AI, it defeats the point.");
  const es = JSON.parse(fs.readFileSync(path.join(EXT, "_locales", "es", "messages.json"), "utf8"));
  assert.equal(
    es.vault_noteNoAi.message,
    "Clotr no tiene absolutamente NADA de IA, eso iría en contra de su propósito.",
  );
});

// Their note's first sentence, in their words.
test("welcome page: the note opens with the maintainer's own sentence", () => {
  const html = fs.readFileSync(path.join(EXT, "vault.html"), "utf8");
  const body = /data-i18n="vault_noteBody">([^<]*)</.exec(html)?.[1] || "";
  assert.ok(
    body.startsWith(
      'I made Clotr after I noticed how much I was telling AI chats without a second thought, I immediately wanted a Tony Stark style "Suit of armor around the world" to exist. So, here we are.',
    ),
    body.slice(0, 160),
  );
  const es = JSON.parse(fs.readFileSync(path.join(EXT, "_locales", "es", "messages.json"), "utf8"));
  assert.ok(es.vault_noteBody.message.includes("Tony Stark"), "the Spanish note says the same");
});
