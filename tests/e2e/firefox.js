// Firefox smoke test (M8): the Firefox build (npm run package -- --firefox) installs as a
// temporary add-on, starts on an AI chat, warns about a key, and never blocks sending.
// Usage: node tests/e2e/firefox.js --browser <path to firefox.exe>
// (a portable Firefox: npx @puppeteer/browsers install firefox@stable --path <dir>)
// Firefox automation can't look inside Clotr's closed shadow roots, so this checks the
// warning's host element and saves a screenshot of what the user sees.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const puppeteer = require("puppeteer-core");

const ROOT = path.resolve(__dirname, "..", "..");
const OUT = path.join(__dirname, "output");
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
};
const FIREFOX = arg("--browser") || process.env.CLOTR_FIREFOX;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!FIREFOX) throw new Error("pass --browser <firefox.exe>");
  execFileSync(process.execPath, [path.join(ROOT, "tools", "package.js"), "--firefox"], { stdio: "ignore" });
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, "ai-privacy-guard", "manifest.json"), "utf8"));
  const zip = path.join(ROOT, "dist", `clotr-${version}-firefox.zip`);
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-ff-"));
  const tar =
    process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "unzip";
  execFileSync(tar, process.platform === "win32" ? ["-xf", zip, "-C", ext] : ["-q", zip, "-d", ext]);

  const browser = await puppeteer.launch({ browser: "firefox", executablePath: FIREFOX, headless: true });
  const results = [];
  const check = async (id, name, fn) => {
    try {
      await fn();
      results.push(`  ${id} ${name} … PASS`);
    } catch (err) {
      results.push(`  ${id} ${name} … FAIL\n       → ${err.message}`);
    }
  };
  try {
    console.log(`Clotr Firefox smoke test\n  browser: ${await browser.version()}\n  build:   ${path.basename(zip)}\n`);
    await browser.installExtension(ext);
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (req.url().startsWith("https://chatgpt.com/")) {
        return req.respond({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: fs.readFileSync(path.join(__dirname, "pages", "textarea-chat.html")),
        });
      }
      return req.abort();
    });
    await page.goto("https://chatgpt.com/", { waitUntil: "load" });
    await sleep(1500);

    await check("FF1", "Clotr starts on an AI chat and warns about a key (Firefox)", async () => {
      await page.focus("#prompt-textarea");
      await page.keyboard.type("my key is AKIA4HPQ7XZ2R6TWLJ3N ");
      // Poll: a cold Firefox start can take longer than the usual ~0.4 s scan.
      let host = false;
      for (let t = 0; t < 5000 && !host; t += 250) {
        await sleep(250);
        host = await page.evaluate(() => Boolean(document.querySelector("clotr-notice")));
      }
      await page.screenshot({ path: path.join(OUT, "firefox-notice.png") });
      if (!host) throw new Error("no warning appeared");
    });
    await check("FF1b", "Hide it replaces the key in the chat box (Firefox)", async () => {
      // By keyboard, so it doesn't depend on fonts or layout: Tab until focus enters Clotr's
      // warning ("Leave it in"), Tab once more to "Hide it", then Enter.
      let inside = false;
      for (let i = 0; i < 8 && !inside; i++) {
        await page.keyboard.press("Tab");
        inside = await page.evaluate(() => document.activeElement?.tagName === "CLOTR-NOTICE");
      }
      if (!inside) throw new Error("couldn't reach the warning with Tab");
      await page.keyboard.press("Tab");
      await sleep(800); // Enter is ignored for 0.6 s after focus lands in a warning (D36/D41): wait past it
      await page.keyboard.press("Enter");
      await sleep(500);
      const text = await page.$eval("#prompt-textarea", (t) => t.value);
      if (!text.includes("[REDACTED AWS ACCESS KEY]") || text.includes("AKIA4HPQ"))
        throw new Error(`box: ${JSON.stringify(text)}`);
    });
    await check("FF2", "Warn never blocks: Enter sends (Firefox)", async () => {
      await page.focus("#prompt-textarea");
      await page.keyboard.type("call me at 937-555-0123 ");
      await sleep(2000);
      await page.keyboard.press("Enter");
      await sleep(500);
      const sent = await page.evaluate(() => window.__sent.length);
      if (sent !== 1) throw new Error(`sent ${sent} messages`);
    });
    await check("FF3", "An ordinary site stays untouched (Firefox)", async () => {
      const other = await browser.newPage();
      await other.goto("about:blank");
      const host = await other.evaluate(() => Boolean(document.querySelector("clotr-notice")));
      await other.close();
      if (host) throw new Error("Clotr UI on a non-AI page");
    });
  } finally {
    await browser.close();
    fs.rmSync(ext, { recursive: true, force: true });
  }
  console.log(results.join("\n"));
  const failed = results.filter((r) => r.includes("FAIL")).length;
  console.log(`\n${results.length - failed}/${results.length} passed.`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
