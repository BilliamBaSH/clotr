// Dev tool (not shipped): have the built-in AI sites changed in a way that affects Clotr?
// Opens every built-in site logged out, in a throwaway headless Brave/Chrome profile with Clotr
// loaded, and records for each: where it ends up (and whether Clotr covers that address), whether
// Clotr's self-check sees a chat box, and which kind of editor it uses. Compares with the saved
// baseline and lists what changed: a site that moved (lmarena.ai → arena.ai), a chat box Clotr
// can no longer see, a new editor (Kimi's async Lexical) that needs a real-site check.
//
// Usage: npm run site-check                   compare with tools/site-baseline.json
//        npm run site-check -- --update       save this run as the new baseline
//        npm run site-check -- --only grok.com,kimi
//        --browser <path>  --headed
// Report: tools/site-check-report.md (git-ignored). Exit code 1 when something needs a look.
// Nothing is typed or sent; pages are only loaded. Sites behind a bot check show as "blocked".
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const puppeteer = require("puppeteer-core");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "ai-privacy-guard");
const BASELINE = path.join(__dirname, "site-baseline.json");
const REPORT = path.join(__dirname, "site-check-report.md");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

// sites.js turns match patterns into regexes; it reads the manifest through chrome.runtime.
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
globalThis.chrome = { runtime: { getManifest: () => manifest } };
require(path.join(EXT, "sites.js"));
const Sites = globalThis.ClotrSites;
const BUILT_IN = manifest.content_scripts.flatMap((c) => c.matches);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  const candidates = [
    "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe",
    `${process.env.LOCALAPPDATA}/BraveSoftware/Brave-Browser/Application/brave.exe`,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/brave-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error("No Brave/Chrome found; pass --browser <path>");
  return found;
}

// One address per built-in site: its first match pattern, without the wildcard.
function sitesToCheck() {
  const list = JSON.parse(fs.readFileSync(path.join(EXT, "ai-sites.json"), "utf8"));
  const only = option("--only")
    ?.split(",")
    .map((s) => s.trim().toLowerCase());
  return list
    .map((s) => ({ name: s.name, url: s.matches[0].replace(/\*$/, "") }))
    .filter((s) => !only || only.some((o) => s.url.includes(o) || s.name.toLowerCase().includes(o)));
}

// Runs in the page: the first visible chat box and what kind of editor it is.
function editorKind() {
  const kind = (el) => {
    if (el.tagName === "TEXTAREA") return "textarea";
    if (el.closest("[data-lexical-editor]")) return "lexical";
    if (el.closest(".ProseMirror")) return "prosemirror";
    if (el.closest(".ql-editor")) return "quill";
    if (el.closest("[data-slate-editor]")) return "slate";
    if (el.closest(".cm-content")) return "codemirror";
    return "contenteditable";
  };
  const find = (root, depth) => {
    for (const el of root.querySelectorAll(
      'textarea, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]',
    )) {
      if (el.getClientRects().length) return el;
    }
    if (depth > 2) return null;
    for (const host of root.querySelectorAll("*")) {
      const found = host.shadowRoot && find(host.shadowRoot, depth + 1);
      if (found) return found;
    }
    return null;
  };
  const el = find(document, 0);
  const text = (document.body?.innerText || "").slice(0, 3000);
  return {
    editor: el ? kind(el) : "none",
    inShadow: Boolean(el && el.getRootNode() !== document),
    title: document.title.slice(0, 80),
    botCheck: /just a moment|verify you are human|checking your browser|attention required|access denied/i.test(
      `${document.title} ${text.slice(0, 400)}`,
    ),
    signIn: /\b(sign|log) ?in\b/i.test(text),
  };
}

async function main() {
  const browserPath = option("--browser") || findBrowser();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-sitecheck-"));
  fs.mkdirSync(path.join(profile, "Default"), { recursive: true });
  fs.writeFileSync(
    path.join(profile, "Default", "Preferences"),
    JSON.stringify({ extensions: { ui: { developer_mode: true } } }),
  );
  const browser = await puppeteer.launch({
    executablePath: browserPath,
    headless: !flag("--headed"),
    pipe: true,
    enableExtensions: [EXT],
    userDataDir: profile,
    defaultViewport: { width: 1280, height: 850 },
    args: ["--no-first-run", "--no-default-browser-check", "--enable-unsafe-extension-debugging"],
  });
  const swTarget = await browser.waitForTarget(
    (t) => t.type() === "service_worker" && t.url().endsWith("/background.js"),
    { timeout: 15000 },
  );
  const sw = await swTarget.createCDPSession();
  const inWorker = async (fn, ...a) => {
    const r = await sw.send("Runtime.evaluate", {
      expression: `(${fn})(...${JSON.stringify(a)})`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const ua = (await browser.userAgent()).replace("HeadlessChrome", "Chrome"); // look like the browser it is

  const results = [];
  for (const site of sitesToCheck()) {
    const page = await browser.newPage();
    await page.setUserAgent(ua);
    const row = { name: site.name, url: site.url };
    try {
      const response = await page.goto(site.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      row.status = response?.status() ?? 0;
      await sleep(7000); // let the app render and Clotr's self-check look (it checks every 2 s)
      const finalUrl = page.url();
      row.finalHost = new URL(finalUrl).hostname;
      row.covered = Sites.urlMatchesAny(finalUrl, BUILT_IN);
      // Logged out, some sites send you to a sign-in page elsewhere: that's not a move.
      const u = new URL(finalUrl);
      row.signInRedirect =
        !row.covered &&
        (/^(accounts|login|auth|signin|sso|id)\./.test(u.hostname) ||
          /\/(login|signin|sign-in|auth)\b/i.test(u.pathname));
      Object.assign(row, await page.evaluate(editorKind));
      row.clotrSees = await inWorker(async (url) => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((t) => t.url === url);
        const { protectedTabs = {} } = await chrome.storage.session.get("protectedTabs");
        const h = tab && protectedTabs[tab.id];
        return h ? (h.editor ? "yes" : "no chat box") : "not running";
      }, finalUrl);
    } catch (err) {
      row.error = String(err.message || err).slice(0, 120);
    }
    await page.close();
    results.push(row);
    console.log(
      `${site.name.padEnd(22)} ${row.error ? `error: ${row.error}` : `${row.finalHost} · editor ${row.editor} · Clotr ${row.clotrSees}${row.botCheck ? " · bot check" : ""}`}`,
    );
  }
  await browser.close();
  fs.rmSync(profile, { recursive: true, force: true });

  const baseline = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, "utf8")).sites : {};
  const findings = [];
  for (const r of results) {
    const was = baseline[r.url];
    if (r.error) {
      findings.push(`**${r.name}**: couldn't load (${r.error})`);
      continue;
    }
    if (!r.covered && !r.signInRedirect)
      findings.push(
        `**${r.name}** now ends up at **${r.finalHost}**, which Clotr doesn't cover: add it to ai-sites.json`,
      );
    if (r.botCheck) continue; // a bot check says nothing about the site itself
    if (r.editor !== "none" && r.clotrSees !== "yes")
      findings.push(`**${r.name}**: there's a chat box (${r.editor}) but Clotr reports "${r.clotrSees}"`);
    if (!was) continue;
    if (was.finalHost !== r.finalHost) findings.push(`**${r.name}** moved: ${was.finalHost} → ${r.finalHost}`);
    if (was.editor !== r.editor)
      findings.push(`**${r.name}** editor changed: ${was.editor} → ${r.editor} (check Cover it on the real site)`);
  }

  const lines = [
    "# Built-in AI sites: change check",
    "",
    `Run ${new Date().toISOString()} · Clotr ${manifest.version} · logged out, nothing typed`,
    "",
    findings.length ? "## Needs a look" : "## Nothing changed that needs a look",
    ...findings.map((f) => `- ${f}`),
    "",
    "| Site | Ends up at | Covered | Editor | Clotr sees the chat box | Notes |",
    "|---|---|---|---|---|---|",
    ...results.map(
      (r) =>
        `| ${r.name} | ${r.finalHost || "—"} | ${r.error ? "—" : r.covered ? "yes" : r.signInRedirect ? "sign-in page" : "**no**"} | ${r.editor || "—"}${r.inShadow ? " (shadow)" : ""} | ${r.clotrSees || "—"} | ${[r.error, r.botCheck && "bot check", r.signInRedirect && "sends you to sign in", r.editor === "none" && r.signIn && !r.signInRedirect && "sign-in page"].filter(Boolean).join("; ")} |`,
    ),
  ];
  fs.writeFileSync(REPORT, `${lines.join("\n")}\n`);
  console.log(
    `\n${findings.length ? `${findings.length} to look at` : "Nothing to look at"}. Report: ${path.relative(ROOT, REPORT)}`,
  );

  if (flag("--update")) {
    const sites = Object.fromEntries(
      results.filter((r) => !r.error && !r.botCheck).map((r) => [r.url, { finalHost: r.finalHost, editor: r.editor }]),
    );
    fs.writeFileSync(
      BASELINE,
      `${JSON.stringify({ updated: new Date().toISOString().slice(0, 10), sites }, null, 2)}\n`,
    );
    console.log(`Baseline saved: ${path.relative(ROOT, BASELINE)}`);
  }
  process.exitCode = findings.length ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 2;
});
