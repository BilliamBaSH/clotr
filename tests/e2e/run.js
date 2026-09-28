// End-to-end tests: drives a real browser (Brave by default) with Clotr loaded,
// the way a user would: typing into AI chats, clicking the dialog, opening the popup.
//
//   npm run test:e2e                     headless run, report in tests/e2e/output/
//   npm run test:e2e -- --headed         watch it happen
//   npm run test:e2e -- --only A2,F      run selected checks (ID prefixes)
//   npm run test:e2e -- --browser "C:/path/to/chrome.exe"
//
// Also runs in Linux containers (Claude Code cloud sessions, CI): falls back to the
// Playwright Chromium and adds --no-sandbox when running as root.
//
// Safety: uses a throwaway browser profile (never your real one), and every network
// request is answered by the local fake pages in ./pages or blocked. Nothing is sent
// to any real site.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const puppeteer = require("puppeteer-core");

const ROOT = path.resolve(__dirname, "..", "..");
const PAGES = path.join(__dirname, "pages");
const OUT = path.join(__dirname, "output");

const argv = process.argv.slice(2);
const argValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const EXT = path.resolve(argValue("--ext") || path.join(ROOT, "ai-privacy-guard"));
const HEADED = argv.includes("--headed");
const ONLY = (argValue("--only") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const BROWSER = argValue("--browser") || process.env.CLOTR_BROWSER || findBrowser();

const KEY = "AKIA4HPQ7XZ2R6TWLJ3N"; // random-looking fake (the AWS docs example is ignored on purpose)
const KEY2 = "AKIAZ7Q3M9WX2KD5HB8R";
const DIALOG_WAIT = 2500; // scan runs ~0.4 s after typing stops
const QUIET_WAIT = 1200; // how long to wait before concluding "no dialog"

// Fake sites. The URLs are real so the extension treats them as the real thing,
// but the pages come from ./pages and never touch the network.
const SITES = {
  chatgpt: {
    url: "https://chatgpt.com/",
    page: "textarea-chat.html",
    editor: `document.querySelector("#prompt-textarea")`,
    send: `document.querySelector('[data-testid="send-button"]')`,
  },
  claude: {
    url: "https://claude.ai/new",
    page: "richtext-chat.html",
    editor: `document.querySelector(".ProseMirror")`,
    send: `document.querySelector("#send")`,
  },
  notebook: {
    url: "https://notebook.google.com/notebook/test",
    page: "shadow-chat.html",
    editor: `document.querySelector("chat-box").shadowRoot.querySelector("textarea")`,
    send: `document.querySelector("chat-box").shadowRoot.querySelector("button")`,
  },
  perplexity: {
    url: "https://www.perplexity.ai/",
    page: "lexical-chat.html",
    editor: `document.querySelector("#ask-input")`,
    send: `document.querySelector("#send")`,
  },
  iconsend: {
    // send button without a "send" label (DeepSeek-style)
    url: "https://chat.deepseek.com/",
    page: "iconsend-chat.html",
    editor: `document.querySelector("#chat-input")`,
    send: `document.querySelector("#send")`,
  },
  eager: {
    // the page handles Enter in its own window capture listener (registered early)
    url: "https://www.meta.ai/",
    page: "eager-chat.html",
    editor: `document.querySelector("#msg")`,
    send: `document.querySelector("#send")`,
  },
  keyup: {
    // sends on Enter key-up instead of key-down
    url: "https://pi.ai/",
    page: "keyup-chat.html",
    editor: `document.querySelector("#msg")`,
    send: `document.querySelector("#send")`,
  },
  asynced: {
    // Kimi-style editor: edits applied a moment later at its own caret (KM1, KM2)
    url: "https://www.kimi.com/",
    page: "async-lexical-chat.html",
    editor: `document.querySelector("#msg")`,
    send: `document.querySelector("#send")`,
  },
  nochat: {
    // an AI site's page without a chat box (HC2)
    url: "https://grok.com/settings",
    page: "no-chat.html",
  },
  hostile: {
    // a page that removes Clotr's UI and scripts its own chat box (HP1-HP3)
    url: "https://chat.mistral.ai/",
    page: "hostile-chat.html",
    editor: `document.querySelector("#msg")`,
    send: `document.querySelector("#send")`,
  },
  login: {
    // an AI site's sign-in page: Clotr must leave its fields alone (LG1)
    url: "https://character.ai/login",
    page: "login-form.html",
    editor: `document.querySelector("#msg")`,
    send: `document.querySelector("#send")`,
  },
  demo: {
    // neutral, unbranded chat for store/README screenshots (--store)
    url: "https://poe.com/",
    page: "demo-chat.html",
    editor: `document.querySelector("#prompt")`,
    send: `document.querySelector("#send")`,
  },
  newtool: {
    url: "https://chat.newtool.ai/",
    page: "unknown-ai-chat.html",
    editor: `document.querySelector("textarea")`,
  },
  ordinary: {
    url: "https://github.com/example/project/issues/42",
    page: "ordinary-site.html",
    editor: `document.querySelector("textarea")`,
  },
};

// Out of the box nothing blocks (design decision D1). Most checks exercise the blocking
// dialog, so they start from "the user chose Block for high-risk types".
const HIGH_RISK = [
  "private_key",
  "aws_access_key",
  "github_token",
  "stripe_secret_key",
  "anthropic_key",
  "openai_key",
  "google_api_key",
  "slack_token",
  "password",
  "us_ssn",
  "credit_card",
];
const USER_BLOCKS_HIGH = Object.fromEntries(HIGH_RISK.map((id) => [id, "block"]));

// First-time tips (D43) show once per kind of data. Checks start with them all seen, so
// notices look the same in every check; the GD checks turn them back on.
require(path.join(__dirname, "..", "..", "ai-privacy-guard", "patterns.js"));
const ALL_GUIDED = Object.fromEntries(globalThis.Clotr.PATTERNS.map((p) => [p.id, 1]));

// Every raw value typed during the run. None may ever appear in extension storage.
const TYPED_VALUES = new Set();

// ---------- Small utilities ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeout, interval = 100) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(interval);
  }
}

function expect(cond, message) {
  if (!cond) throw new Error(message);
}

function findBrowser() {
  const candidates = [
    "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe",
    `${process.env.LOCALAPPDATA}/BraveSoftware/Brave-Browser/Application/brave.exe`,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/brave-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    `${process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers"}/chromium`,
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error("No Brave/Chrome/Edge found; pass --browser <path>");
  return found;
}

async function describeConsole(msg) {
  const parts = await Promise.all(msg.args().map((a) => a.jsonValue().catch(() => String(a))));
  return parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ");
}

// ---------- Browser & extension ----------

async function launch(ext = EXT, extraArgs = [], extraEnv = null) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-e2e-"));
  // Developer mode on, as for anyone who used "Load unpacked". Chrome/Brave 153+ refuse to
  // reload an unpacked extension without it (the self-update reload, U2, depends on this).
  fs.mkdirSync(path.join(profile, "Default"), { recursive: true });
  fs.writeFileSync(
    path.join(profile, "Default", "Preferences"),
    JSON.stringify({ extensions: { ui: { developer_mode: true } } }),
  );
  const browser = await puppeteer.launch({
    executablePath: BROWSER,
    headless: !HEADED,
    pipe: true,
    enableExtensions: [ext],
    userDataDir: profile,
    ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}), // Linux Chrome takes its UI language from LANGUAGE
    defaultViewport: { width: 1000, height: 700 },
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--enable-unsafe-extension-debugging", // older Chromium builds need it for CDP extension loading
      ...extraArgs,
      ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), // containers run as root
    ],
  });
  const swTarget = await browser.waitForTarget(
    (t) => t.type() === "service_worker" && t.url().endsWith("/background.js"),
    { timeout: 15000 },
  );
  const swSession = await swTarget.createCDPSession();
  // Runs fn(...args) in the service worker. Raw CDP rather than puppeteer's WebWorker,
  // whose evaluate() hangs on some Chromium builds.
  const worker = {
    async evaluate(fn, ...args) {
      const expression = `(${fn})(...${JSON.stringify(args)})`;
      const r = await swSession.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails)
        throw new Error(`service worker: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
      return r.result.value;
    },
  };
  // The session can attach before the extension's APIs are bound ("chrome is not defined",
  // seen once in CI on U2): wait until the worker is really running.
  const ready = await waitFor(
    () => worker.evaluate(() => typeof chrome === "object" && Boolean(chrome.runtime?.id)).catch(() => false),
    10000,
  );
  if (!ready) throw new Error("the extension's service worker never became ready");
  const ctx = { browser, profile, swTarget, worker, problems: [], version: await browser.version() };

  // Background console: any error or warning is reported as a problem.
  await swSession.send("Runtime.enable");
  swSession.on("Runtime.consoleAPICalled", (e) => {
    if (e.type === "error" || e.type === "warning") {
      ctx.problems.push(`service worker ${e.type}: ${e.args.map((a) => a.value ?? a.description).join(" ")}`);
    }
  });
  swSession.on("Runtime.exceptionThrown", (e) =>
    ctx.problems.push(`service worker exception: ${e.exceptionDetails.text}`),
  );
  return ctx;
}

// Writes go through the background's write queue, after a moment for the previous check's
// last events to arrive: otherwise a late event write could read the old history, let
// this write land, then write the old events back (flakes seen in R4, K1 and C10).
const store = {
  get: (ctx, keys) => ctx.worker.evaluate((k) => chrome.storage.local.get(k), keys ?? null),
  set: async (ctx, obj) => {
    await sleep(200);
    await ctx.worker.evaluate((o) => enqueue(() => chrome.storage.local.set(o)), obj);
    // Open tabs get settings by message since the storage lock (S20): a moment for the change
    // to reach them, so a check doesn't type before its tab knows the new setting.
    if (["responses", "paused", "vault", "siteModes", "guided", "largeText"].some((k) => k in obj)) await sleep(300);
  },
  events: async (ctx) => (await store.get(ctx, "events")).events || [],
};

async function resetState(ctx, responses = USER_BLOCKS_HIGH) {
  await store.set(ctx, {
    events: [],
    responses,
    paused: {},
    vault: [],
    siteModes: {},
    ignores: {},
    relaxDeclined: {},
    guided: ALL_GUIDED,
  });
}

async function activeBadge(ctx) {
  return ctx.worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return {
      text: await chrome.action.getBadgeText({ tabId: tab.id }),
      color: await chrome.action.getBadgeBackgroundColor({ tabId: tab.id }),
    };
  });
}

// ---------- Fake site pages ----------

async function openSite(ctx, key) {
  const site = SITES[key];
  const page = await ctx.browser.newPage();
  page.site = site;
  page.logs = [];
  page.on("console", async (msg) => {
    const text = await describeConsole(msg);
    page.logs.push(text);
    if (text.includes("[Clotr]") && (msg.type() === "error" || msg.type() === "warn")) {
      ctx.problems.push(`${key} page ${msg.type()}: ${text}`);
    }
  });
  page.on("pageerror", (err) => ctx.problems.push(`${key} page error: ${err.message}`));

  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const match = Object.values(SITES).find(
      (s) => req.resourceType() === "document" && req.url().startsWith(new URL(s.url).origin + "/"),
    );
    if (match) {
      return req.respond({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: fs.readFileSync(path.join(PAGES, match.page)),
      });
    }
    return req.abort(); // favicons etc.: nothing leaves the machine
  });

  await page.goto(site.url, { waitUntil: "load" });
  await page.bringToFront();
  await sleep(600); // content script starts at document_idle
  return page;
}

const clotrActive = (page) => page.logs.some((l) => l.startsWith("[Clotr] active on"));

// Runs `expr` inside Clotr's content-script world (the page's own JS can't reach it).
async function evalInClotr(page, expr) {
  page.cdp ??= await page.createCDPSession();
  if (!page.clotrWorld) {
    const { frameTree } = await page.cdp.send("Page.getFrameTree");
    const contexts = [];
    const onCtx = (e) => contexts.push(e.context);
    page.cdp.on("Runtime.executionContextCreated", onCtx);
    await page.cdp.send("Runtime.enable"); // replays the existing contexts (only the first time per session)
    page.cdp.off("Runtime.executionContextCreated", onCtx);
    page.clotrWorld = contexts.find(
      (c) =>
        c.origin.startsWith("chrome-extension://") &&
        c.auxData?.type === "isolated" &&
        c.auxData?.frameId === frameTree.frame.id,
    );
  }
  const world = page.clotrWorld; // valid until the page navigates (checks use a fresh page)
  expect(world, "Clotr's content-script world not found");
  const { result, exceptionDetails } = await page.cdp.send("Runtime.evaluate", {
    expression: expr,
    contextId: world.id,
    returnByValue: true,
    awaitPromise: true,
  });
  expect(!exceptionDetails, `evaluating in Clotr's world failed: ${exceptionDetails?.exception?.description}`);
  return result.value;
}

// Simulates what an update reload leaves behind: this page's copy of Clotr keeps
// running, but every extension API call now throws.
const ORPHAN_CLOTR = `(() => {
  const dead = () => { throw new Error("Extension context invalidated."); };
  globalThis.chrome = { runtime: { id: undefined, sendMessage: dead, getURL: dead, onMessage: { addListener() {} } },
    storage: { local: { get: dead, set: dead }, onChanged: { addListener() {} } } };
  return true;
})()`;

async function focusEditor(page) {
  await page.evaluate(`${page.site.editor}.focus()`);
}

// Inserts text the way a paste or IME commit does.
async function typeText(page, text) {
  TYPED_VALUES.add(text);
  await focusEditor(page);
  await page.keyboard.sendCharacter(text);
}

async function clearEditor(page) {
  await focusEditor(page);
  await page.keyboard.down("Control");
  await page.keyboard.press("a");
  await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
  await sleep(600);
}

const editorText = (page) =>
  page.evaluate(`(e => e.tagName === "TEXTAREA" ? e.value : e.innerText)(${page.site.editor})`);
const sentMessages = (page) => page.evaluate(() => window.__sent.slice());

async function pressEnter(page) {
  await focusEditor(page);
  await page.keyboard.press("Enter");
}

async function clickSend(page) {
  const box = await page.evaluate(
    `(b => { const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })(${page.site.send})`,
  );
  await page.mouse.click(box.x, box.y);
}

// ---------- The Clotr dialog and warn notice (closed shadow roots, read through DevTools) ----------

const readDialog = (page) => readUI(page, "CLOTR-GUARD");
const readNotice = (page) => readUI(page, "CLOTR-NOTICE");
const readReloadPrompt = (page) => readUI(page, "CLOTR-RELOAD");

async function readUI(page, tag) {
  page.cdp ??= await page.createCDPSession();
  const { root } = await page.cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  let host = null;
  (function find(n) {
    if (host) return;
    if (n.nodeName === tag) host = n;
    for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) find(c);
  })(root);
  if (!host) return null;

  const texts = [];
  const buttons = [];
  let checkbox = null;
  const textOf = (n) => (n.nodeType === 3 ? n.nodeValue : (n.children || []).map(textOf).join(""));
  (function walk(n) {
    if (n.nodeName === "STYLE") return;
    if (n.nodeType === 3 && n.nodeValue.trim()) texts.push(n.nodeValue.trim());
    if (n.nodeName === "BUTTON" || n.nodeName === "SUMMARY") buttons.push({ text: textOf(n).trim(), nodeId: n.nodeId });
    if (n.nodeName === "INPUT") checkbox = n.nodeId;
    for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) walk(c);
  })(host);
  return { text: texts.join(" | "), buttons, checkbox };
}

async function clickNode(page, nodeId) {
  const { model } = await page.cdp.send("DOM.getBoxModel", { nodeId });
  const q = model.border;
  await page.mouse.click((q[0] + q[2] + q[4] + q[6]) / 4, (q[1] + q[3] + q[5] + q[7]) / 4);
}

const waitForDialog = (page) => waitFor(() => readDialog(page), DIALOG_WAIT);
const waitForNotice = (page) => waitFor(() => readNotice(page), DIALOG_WAIT);

async function clickDialogButton(page, label, read = readDialog) {
  const dialog = await read(page);
  const btn = dialog?.buttons.find((b) => b.text === label);
  expect(btn, `dialog button "${label}" not found (dialog: ${dialog?.text})`);
  await clickNode(page, btn.nodeId);
  await sleep(300);
}

async function expectNoDialog(page, why) {
  await sleep(QUIET_WAIT);
  const dialog = await readDialog(page);
  expect(!dialog, `${why}, but the dialog appeared: ${dialog?.text}`);
}

async function expectNoUI(page, why) {
  await expectNoDialog(page, why);
  const notice = await readNotice(page);
  expect(!notice, `${why}, but the warn notice appeared: ${notice?.text}`);
}

// Sets a pattern's response the way the user does: the popup's Settings dropdown.
async function chooseResponse(ctx, patternId, value) {
  const popup = await openPopup(ctx);
  await popup.click("#tab-settings");
  const ok = await popup.evaluate(
    (id, v) => {
      const sel = document.querySelector(`select.resp[data-pattern="${id}"]`);
      if (!sel) return false;
      sel.value = v;
      sel.dispatchEvent(new Event("change"));
      return true;
    },
    patternId,
    value,
  );
  expect(ok, `no response dropdown for ${patternId}`);
  await sleep(300);
  await popup.close();
}

// ---------- Popup ----------

// Opens popup.html in its own tab at the popup's width. (chrome.action.openPopup() is
// unreliable headless, and a scripted open wouldn't get the activeTab grant anyway, so
// the site card reads "No web page in this tab" either way. That card is checked by hand.)
async function openPopup(ctx) {
  const popup = await ctx.browser.newPage();
  popup.on("pageerror", (err) => ctx.problems.push(`popup error: ${err.message}`));
  await popup.setViewport({ width: 380, height: 700 });
  await popup.goto(`chrome-extension://${new URL(ctx.swTarget.url()).host}/popup.html`);
  await popup.waitForSelector("#hero-value");
  await sleep(400);
  return popup;
}

// Any extension page (e.g. the vault) in its own tab.
async function openExtPage(ctx, file) {
  const page = await ctx.browser.newPage();
  page.on("pageerror", (err) => ctx.problems.push(`${file} error: ${err.message}`));
  await page.setViewport({ width: 700, height: 900 });
  await page.goto(`chrome-extension://${new URL(ctx.swTarget.url()).host}/${file}`);
  await sleep(400);
  return page;
}

// Popups are small windows; size the page to its content and pick the theme explicitly.
async function shot(popup, name, theme = "light") {
  await popup.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
  const height = await popup.evaluate(() => Math.ceil(document.documentElement.scrollHeight));
  await popup.setViewport({ width: 380, height: Math.min(height, 1400) });
  await sleep(150);
  await popup.screenshot({ path: path.join(OUT, name) });
}

// ---------- Test runner ----------

const results = [];

// Thrown by a check the current browser can't run under automation. Reported as SKIP with
// the reason (never as PASS), and only for things verified another way.
class Skip extends Error {}

async function check(id, title, fn) {
  if (ONLY.length && !ONLY.some((p) => id.startsWith(p))) return;
  process.stdout.write(`  ${id.padEnd(4)} ${title} … `);
  const started = Date.now();
  const secs = () => ((Date.now() - started) / 1000).toFixed(1); // in the report: where CI minutes go
  try {
    const note = await fn();
    results.push({ id, title, ok: true, note: note || "", secs: secs() });
    console.log("PASS" + (note ? `  (${note})` : ""));
  } catch (err) {
    if (err instanceof Skip) {
      results.push({ id, title, ok: true, skipped: true, note: err.message, secs: secs() });
      console.log(`SKIP\n       → ${err.message}`);
      return;
    }
    results.push({ id, title, ok: false, note: err.message.split("\n")[0], secs: secs() });
    console.log(`FAIL\n       → ${err.message.split("\n")[0]}`);
  }
}

async function withSite(ctx, key, fn) {
  const page = await openSite(ctx, key);
  try {
    return await fn(page);
  } finally {
    await page.close();
  }
}

// Synthetic history for dashboard checks: known counts across several days.
function seedEvents() {
  const DAY = 86400000;
  const now = Date.now();
  const today = new Date(now).setHours(0, 0, 0, 0);
  // "Today" events stay today even when a run crosses midnight (C2 failed in CI at 00:00:13).
  const ev = (daysAgo, action, type, name, severity, site, fp) => ({
    t: daysAgo === 0 ? Math.max(today, now - 60000) : now - daysAgo * DAY - 60000,
    site,
    type,
    name,
    severity,
    action,
    fp,
  });
  return [
    ev(20, "redacted", "email", "Email Address", "low", "chatgpt.com", "1000000000000001"),
    ev(20, "allowed", "phone_number", "Phone Number", "medium", "chatgpt.com", "1000000000000002"),
    ev(5, "redacted", "aws_access_key", "AWS Access Key", "high", "claude.ai", "aaaaaaaaaaaaaaaa"),
    ev(4, "redacted", "aws_access_key", "AWS Access Key", "high", "claude.ai", "aaaaaaaaaaaaaaaa"),
    ev(3, "allowed", "credit_card", "Credit Card Number", "high", "chatgpt.com", "1000000000000003"),
    ev(2, "suppressed", "email", "Email Address", "low", "notebook.google.com", "1000000000000004"),
    ev(1, "redacted", "phone_number", "Phone Number", "medium", "notebook.google.com", "1000000000000005"),
    ev(0, "redacted", "us_ssn", "US Social Security Number", "high", "chatgpt.com", "1000000000000006"),
    ev(0, "allowed", "email", "Email Address", "low", "gemini.google.com", "1000000000000007"),
  ].sort((a, b) => a.t - b.t);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  // A full run starts from no screenshots, so one no check takes any more can't be mistaken for today's UI.
  if (!ONLY.length) for (const f of fs.readdirSync(OUT)) if (f.endsWith(".png")) fs.rmSync(path.join(OUT, f));
  console.log(`Clotr end-to-end tests\n  browser: ${BROWSER}`);
  const ctx = await launch();
  console.log(`  engine:  ${ctx.version}${HEADED ? " (headed)" : " (headless)"}\n`);

  // ----- A. Protection basics -----
  await check("A1", "Clotr starts on built-in AI sites (textarea, rich text, shadow DOM)", async () => {
    for (const key of ["chatgpt", "claude", "notebook"]) {
      await withSite(ctx, key, async (page) => expect(clotrActive(page), `not active on ${key}`));
    }
  });

  await check("A2", "Remove it replaces the key and records a 'redacted' event", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx);
      await typeText(page, `my key is ${KEY}`);
      const dialog = await waitForDialog(page);
      expect(dialog, "no dialog appeared");
      expect(dialog.text.includes("AWS Access Key"), `dialog doesn't name the key type: ${dialog.text}`);
      expect(!dialog.text.includes(KEY), "dialog shows the full key");
      await page.screenshot({ path: path.join(OUT, "dialog.png") });
      await clickDialogButton(page, "Hide it");
      const text = await editorText(page);
      expect(text.includes("[REDACTED AWS ACCESS KEY]") && !text.includes(KEY), `editor text: "${text}"`);
      expect(!(await readDialog(page)), "dialog still open");
      const events = await waitFor(async () => ((await store.events(ctx)).length ? store.events(ctx) : null), 2000);
      expect(events?.length === 1 && events[0].action === "redacted", `events: ${JSON.stringify(events)}`);
      expect(/^[0-9a-f]{16}$/.test(events[0].fp), "event has no fingerprint");
    }),
  );

  await check(
    "K1",
    "Keys typed by habit never choose: Space never, Enter not right away; after a moment Enter = Hide it (D36, D41)",
    () =>
      // User (2026-09-24): "a space shouldn't make a decision for the user"; then (D41) the
      // dialog takes the keys: Enter goes forward, Esc/Backspace go back.
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx);
        await typeText(page, `my key is ${KEY}`);
        expect(await waitForDialog(page), "no dialog appeared");
        for (const key of ["Space", "Enter", "Space"]) await page.keyboard.press(key);
        await sleep(300);
        expect(await readDialog(page), "Space/Enter right away closed the dialog");
        expect((await editorText(page)).includes(KEY), "Space/Enter right away changed the text");
        await sleep(500);
        await page.keyboard.press("Space");
        await sleep(200);
        expect(await readDialog(page), "Space chose");
        await page.keyboard.press("Enter");
        await sleep(300);
        expect(!(await readDialog(page)), "Enter didn't choose");
        const text = await editorText(page);
        expect(text.includes("[REDACTED AWS ACCESS KEY]") && !text.includes(KEY), `Enter should hide it: "${text}"`);
        // Recorded once the edit is confirmed (Kimi fix): wait for it like R2 and KM1 do.
        const events =
          (await waitFor(async () => {
            const ev = await store.events(ctx);
            return ev.length ? ev : null;
          }, 2000)) || [];
        expect(events.length === 1 && events[0].action === "redacted", `events: ${JSON.stringify(events)}`);
      }),
  );

  await check(
    "K2",
    "Esc goes back to the message (nothing chosen); the dialog returns on send; Tab to Leave it in + Enter picks it",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx);
        await typeText(page, `my key is ${KEY}`);
        expect(await waitForDialog(page), "no dialog appeared");
        await sleep(700);
        await page.keyboard.press("Escape");
        await sleep(200);
        expect(!(await readDialog(page)), "Esc didn't go back");
        expect((await editorText(page)).includes(KEY), "Esc changed the text");
        expect((await store.events(ctx)).length === 0, "Esc recorded a choice");
        await typeText(page, " thanks");
        await expectNoDialog(page, "still editing after going back");
        await pressEnter(page);
        await sleep(300);
        expect((await sentMessages(page)).length === 0, "sent without a choice");
        expect(await waitForDialog(page), "the dialog didn't come back on send");
        await sleep(700);
        await page.keyboard.press("Backspace");
        await sleep(200);
        expect(!(await readDialog(page)), "Backspace didn't go back");
        await pressEnter(page);
        expect(await waitForDialog(page), "no dialog on the second send");
        await sleep(700);
        await page.keyboard.press("Tab"); // → Leave it in
        await page.keyboard.press("Enter");
        await sleep(300);
        expect(!(await readDialog(page)), "Tab + Enter didn't choose");
        expect((await editorText(page)).includes(KEY), "Leave it in changed the text");
        // A send before the warning could be read is recorded once it's confirmed (~1.2 s, D52).
        const events =
          (await waitFor(async () => ((await store.events(ctx)).length ? store.events(ctx) : null), 3000)) || [];
        expect(events.length === 1 && events[0].action === "allowed", `events: ${JSON.stringify(events)}`);
      }),
  );

  await check("A3", "Keep it keeps the text and lets it send", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx);
      await typeText(page, `key ${KEY}`);
      expect(await waitForDialog(page), "no dialog appeared");
      await clickDialogButton(page, "Leave it in");
      expect((await editorText(page)).includes(KEY), "text was changed");
      await pressEnter(page);
      await sleep(300);
      const sent = await sentMessages(page);
      expect(sent.length === 1 && sent[0].includes(KEY), `sent: ${JSON.stringify(sent)}`);
      const events = await store.events(ctx);
      expect(
        events.some((e) => e.action === "allowed"),
        "no 'allowed' event",
      );
    }),
  );

  await check("A4", "Enter right after pasting is blocked (before the dialog even shows)", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx);
      await typeText(page, KEY2);
      await pressEnter(page); // immediately, no waiting
      await sleep(300);
      expect((await sentMessages(page)).length === 0, "message was sent");
      expect(await waitForDialog(page), "no dialog appeared");
    }),
  );

  await check("A4b", "Send button right after pasting is blocked", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx);
      await typeText(page, KEY2);
      await clickSend(page);
      await sleep(300);
      expect((await sentMessages(page)).length === 0, "message was sent");
      expect(await waitForDialog(page), "no dialog appeared");
    }),
  );

  await check("A5", "More choices → stop warning me about this kind: sets that type to Log only, still counts it", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx);
      await typeText(page, KEY);
      expect(await waitForDialog(page), "no dialog");
      await clickDialogButton(page, "More choices");
      await clickDialogButton(page, "Leave it in, and stop warning me about: AWS Access Key");
      expect(!(await readDialog(page)), "dialog still open");
      // Storage writes are asynchronous: wait for them instead of reading once (A5 flaked 1 in 3 full runs).
      const responses = await waitFor(
        async () => ((await store.get(ctx, "responses")).responses?.aws_access_key === "log" ? true : null),
        2000,
      );
      expect(responses, `responses: ${JSON.stringify((await store.get(ctx, "responses")).responses)}`);
      await clearEditor(page);
      await typeText(page, KEY2);
      await expectNoDialog(page, "AWS keys were silenced");
      const counted = await waitFor(
        async () => ((await store.events(ctx)).some((e) => e.action === "suppressed") ? true : null),
        2000,
      );
      expect(counted, "silenced detection not counted");
    }),
  );

  await check("A6", "Popup → Settings → set back to Block brings the dialog back", async () => {
    await chooseResponse(ctx, "aws_access_key", "block");
    const { responses } = await store.get(ctx, "responses");
    expect(responses?.aws_access_key === "block", `responses: ${JSON.stringify(responses)}`);
    await withSite(ctx, "chatgpt", async (page) => {
      await typeText(page, KEY);
      expect(await waitForDialog(page), "dialog did not come back");
    });
  });

  await check("A7", "Pause stops Clotr on that site; resume restarts it", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx);
      await store.set(ctx, { paused: { "chatgpt.com": true } });
      await sleep(300);
      await typeText(page, KEY);
      await expectNoDialog(page, "site is paused");
      await pressEnter(page);
      await sleep(300);
      expect((await sentMessages(page)).length === 1, "paused site should send normally");
      await store.set(ctx, { paused: {} });
      await sleep(300);
      await typeText(page, KEY2);
      expect(await waitForDialog(page), "no dialog after resume");
    }),
  );

  // ----- B. Toolbar -----
  await check("B1", "Badge shows today's count; red after allowing a high-risk item", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx);
      await typeText(page, KEY);
      await waitForDialog(page);
      await clickDialogButton(page, "Leave it in");
      const b1 = await waitFor(async () => {
        const b = await activeBadge(ctx);
        return b.text === "1" ? b : null;
      }, 2000);
      expect(b1, `badge text: "${(await activeBadge(ctx)).text}"`);
      expect(b1.color.slice(0, 3).join() === "208,59,59", `badge color ${b1.color}`);
      await clearEditor(page);
      await typeText(page, KEY2);
      await waitForDialog(page);
      await clickDialogButton(page, "Hide it");
      const b2 = await waitFor(async () => ((await activeBadge(ctx)).text === "2" ? true : null), 2000);
      expect(b2, `badge text after 2nd: "${(await activeBadge(ctx)).text}"`);
    }),
  );

  await check("B2", "Hover tooltip summarizes today", async () => {
    const title = await ctx.worker.evaluate(() => chrome.action.getTitle({}));
    expect(
      title.includes("today: 2 found") && title.includes("1 hidden") && title.includes("1 sent"),
      `title: ${JSON.stringify(title)}`,
    );
    return title.replace(/\n/g, " / ");
  });

  await check("B3", "No badge on a non-AI site", () =>
    withSite(ctx, "ordinary", async () => {
      const b = await activeBadge(ctx);
      expect(b.text === "", `badge "${b.text}" on a non-AI site`);
    }),
  );

  // ----- C. Dashboard -----
  await check("C1", "Popup overview matches the history (7 days)", async () => {
    const events = seedEvents();
    await store.set(ctx, { events, responses: {}, paused: {} });
    const popup = await openPopup(ctx);
    await popup.evaluate(() => document.querySelector('.range [data-days="7"]').click());
    await sleep(200);
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    since.setDate(since.getDate() - 6);
    const inRange = events.filter((e) => e.t >= since.getTime());
    const want = inRange.filter((e) => e.action === "redacted").length;
    const got = await popup.$eval("#hero-value", (n) => n.textContent);
    expect(got === String(want), `hero shows ${got}, expected ${want}`);
    const legend = await popup.$eval("#legend", (n) => n.innerText.replace(/\s+/g, " "));
    const n = (a) => inRange.filter((e) => e.action === a).length;
    expect(
      legend.includes(`Hidden ${n("redacted")}`) &&
        legend.includes(`Sent ${n("allowed")}`) &&
        legend.includes(`Just counted ${n("suppressed")}`),
      `legend: ${legend}`,
    );
    const alerts = await popup.$eval("#alerts", (n) => n.innerText);
    expect(alerts.includes("found the same AWS Access Key 2 times"), `alerts: ${alerts}`);
    expect(alerts.includes("sent 1 high-risk"), `alerts: ${alerts}`);
    await shot(popup, "popup-overview-light.png");
    await shot(popup, "popup-overview-dark.png", "dark");
    await popup.close();
    return `hero ${got}, ${legend}`;
  });

  await check("C2", "Hovering a day column shows its tooltip", async () => {
    await store.set(ctx, { events: seedEvents() }); // fresh, so "today" is still today
    const popup = await openPopup(ctx);
    const hits = await popup.$$("#chart .hit");
    expect(hits.length === 7, `${hits.length} columns`);
    await hits[hits.length - 1].hover();
    await sleep(200);
    const tip = await popup.$eval("#tooltip", (n) => (n.hidden ? "" : n.innerText.replace(/\s+/g, " ")));
    expect(tip.includes("1 Hidden") && tip.includes("1 Sent") && tip.includes("2 found"), `tooltip: "${tip}"`);
    await shot(popup, "popup-tooltip.png");
    await popup.close();
    return tip;
  });

  await check("C3", "30-day range re-scopes the numbers", async () => {
    const popup = await openPopup(ctx);
    await popup.click('.range [data-days="30"]');
    await sleep(200);
    const got = await popup.$eval("#hero-value", (n) => n.textContent);
    const want = seedEvents().filter((e) => e.action === "redacted").length;
    expect(got === String(want), `hero shows ${got}, expected ${want}`);
    expect((await popup.$$("#chart .hit")).length === 30, "chart doesn't show 30 days");
    await shot(popup, "popup-overview-30d.png");
    await popup.click('.range [data-days="7"]');
    await popup.close();
  });

  await check("C6", "Activity tab lists every event with outcome and repeats", async () => {
    const popup = await openPopup(ctx);
    await popup.click("#tab-activity");
    const rows = await popup.$$eval("#events-body tr", (trs) => trs.map((tr) => tr.innerText.replace(/\s+/g, " ")));
    expect(rows.length === seedEvents().length, `${rows.length} rows`);
    expect(rows.filter((r) => r.includes("×2")).length === 2, "repeat marker missing");
    await shot(popup, "popup-activity.png");
    await popup.close();
  });

  await check("C8", "Per-site view: choosing an AI tool filters Overview and Activity", async () => {
    await store.set(ctx, { events: seedEvents() });
    const popup = await openPopup(ctx);
    const pick = (v) =>
      popup.evaluate((val) => {
        const sel = document.querySelector("#site-filter");
        sel.value = val;
        sel.dispatchEvent(new Event("change"));
      }, v);
    const options = await popup.$$eval("#site-filter option", (os) => os.map((o) => o.value));
    await pick("claude.ai");
    await sleep(200);
    const hero = await popup.$eval("#hero-value", (n) => n.textContent);
    const bySite = await popup.$eval("#by-site", (n) => n.innerText);
    await shot(popup, "popup-site-filter.png");
    await popup.click("#tab-activity");
    const rows = await popup.$$eval("#events-body tr", (trs) => trs.length);
    await pick("");
    await popup.close();
    expect(
      options.includes("") && options.includes("claude.ai") && options.includes("chatgpt.com"),
      `options: ${options}`,
    );
    expect(hero === "2", `hero for claude.ai: ${hero}`);
    expect(!bySite.includes("chatgpt.com"), `by-site still lists other tools: ${bySite}`);
    expect(rows === 2, `${rows} activity rows for claude.ai`);
  });

  await check(
    "C9",
    'Per-site mode: "Stricter here" on one AI tool turns its warnings into the blocking dialog',
    async () => {
      await resetState(ctx, {});
      await store.set(ctx, { events: seedEvents() });
      const popup = await openPopup(ctx);
      await popup.evaluate(() => {
        const sel = document.querySelector("#site-filter");
        sel.value = "chatgpt.com";
        sel.dispatchEvent(new Event("change"));
      });
      await sleep(200);
      const visible = await popup.$eval("#site-mode", (n) => !n.hidden);
      await popup.evaluate(() => {
        const sel = document.querySelector("#site-mode");
        sel.value = "block";
        sel.dispatchEvent(new Event("change"));
        const f = document.querySelector("#site-filter");
        f.value = "";
        f.dispatchEvent(new Event("change"));
      });
      await sleep(300);
      await popup.close();
      expect(visible, "site mode control not shown for a chosen tool");
      const { siteModes } = await store.get(ctx, "siteModes");
      expect(siteModes?.["chatgpt.com"] === "block", `siteModes: ${JSON.stringify(siteModes)}`);
      await withSite(ctx, "chatgpt", async (page) => {
        await typeText(page, "call me at 937-555-5636");
        const dialog = await waitForDialog(page);
        expect(dialog?.text.includes("Phone Number"), "phone didn't block on the stricter site");
        await clickDialogButton(page, "Leave it in");
      });
      await store.set(ctx, { siteModes: {}, events: [] });
    },
  );

  await check("C10", "Profile exposure counts different personal details each AI tool received", async () => {
    const DAY = 86400000;
    const ev = (site, type, fp, action = "allowed") => ({
      t: Date.now() - 40 * DAY,
      site,
      type,
      name: type,
      severity: "medium",
      action,
      fp,
    });
    await store.set(ctx, {
      events: [
        ev("chatgpt.com", "phone_number", "a000000000000001"),
        ev("chatgpt.com", "phone_number", "a000000000000001"), // same phone again: still one detail
        ev("chatgpt.com", "email", "a000000000000002"),
        ev("chatgpt.com", "street_address", "a000000000000003", "redacted"), // never sent
        ev("chatgpt.com", "aws_access_key", "a000000000000004"), // a key, not personal
        ev("claude.ai", "family_name", "a000000000000005"),
      ],
    });
    const popup = await openPopup(ctx);
    await popup.click('.range [data-days="7"]');
    const rows = await popup.$$eval("#exposure .hbar", (bs) => bs.map((b) => b.title));
    await shot(popup, "popup-exposure.png");
    await popup.close();
    await store.set(ctx, { events: [] });
    expect(
      JSON.stringify(rows) === JSON.stringify(["chatgpt.com: 2", "claude.ai: 1"]),
      `rows: ${JSON.stringify(rows)}`,
    );
  });

  await check("C7", "Clear history (two clicks) empties the dashboard", async () => {
    await store.set(ctx, { events: seedEvents() });
    const popup = await openPopup(ctx);
    await popup.click("#tab-settings");
    await shot(popup, "popup-settings.png");
    await popup.click("#clear");
    expect((await store.events(ctx)).length > 0, "cleared after one click");
    await popup.click("#clear");
    await sleep(300);
    expect((await store.events(ctx)).length === 0, "not cleared after two clicks");
    await popup.click("#tab-overview");
    await sleep(200);
    expect(await popup.$eval("#empty-overview", (n) => !n.hidden), "empty state not shown");
    await popup.close();
  });

  // ----- D. Scope & discovery -----
  await check("D1", "Unknown AI tool: Clotr does NOT run until the user adds it", () =>
    withSite(ctx, "newtool", async (page) => {
      expect(!clotrActive(page), "Clotr ran on a site nobody added");
      await typeText(page, KEY);
      await expectNoDialog(page, "site not added");
    }),
  );

  await check("D2", "Page check recognizes AI chats and ignores ordinary sites", async () => {
    const popup = await openPopup(ctx);
    const src = await popup.evaluate(() => globalThis.ClotrSites.inspectPageForAIChat.toString());
    await popup.close();
    const verdicts = {};
    for (const key of ["newtool", "chatgpt", "ordinary"]) {
      verdicts[key] = await withSite(ctx, key, (page) => page.evaluate(`(${src})()`));
    }
    expect(verdicts.newtool.looksLikeAI, `new AI tool not recognized: ${JSON.stringify(verdicts.newtool)}`);
    expect(verdicts.chatgpt.looksLikeAI, `ChatGPT page not recognized: ${JSON.stringify(verdicts.chatgpt)}`);
    expect(!verdicts.ordinary.looksLikeAI, `ordinary site flagged: ${JSON.stringify(verdicts.ordinary)}`);
    return `new tool found: ${verdicts.newtool.signals.join(", ")}`;
  });

  await check("D6", "Ordinary website: Clotr stays completely off", () =>
    withSite(ctx, "ordinary", async (page) => {
      expect(!clotrActive(page), "Clotr ran on a non-AI site");
      await typeText(page, KEY);
      await expectNoDialog(page, "non-AI site");
    }),
  );

  // ----- E. Other chat styles -----
  const STYLES = {
    claude: "rich-text editor (Claude-style)",
    notebook: "shadow-DOM input (Gemini/NotebookLM-style)",
    perplexity: "Lexical editor that tracks the selection asynchronously (Perplexity-style)",
  };
  for (const [key, label] of Object.entries(STYLES)) {
    await check(`E-${key}`, `Detect, redact and block in a ${label}`, () =>
      withSite(ctx, key, async (page) => {
        await resetState(ctx);
        await typeText(page, `here: ${KEY}`);
        expect(await waitForDialog(page), "no dialog appeared");
        await clickDialogButton(page, "Hide it");
        const text = await editorText(page);
        expect(text.includes("[REDACTED AWS ACCESS KEY]") && !text.includes(KEY), `editor text: "${text}"`);
        await clearEditor(page);
        await typeText(page, KEY2);
        await clickSend(page);
        await sleep(300);
        expect((await sentMessages(page)).length === 0, "send button not blocked");
        expect(await waitForDialog(page), "no dialog after blocked send");
      }),
    );
  }

  // ----- F. Personal info in disguise -----
  const DISGUISED = [
    ["(937)-555-5636", "Phone Number"],
    ["937-555-5636", "Phone Number"],
    ["call 555-5636 tonight", "Phone Number"],
    ["9375555636", "Phone Number"],
    ["ninethreesevenfivefivefivefivesixthreesix", "Phone Number"],
    ["9threeseve5five5five63six", "Phone Number"],
    ["call me at nine three seven, five five five, five six three six", "Phone Number"],
    ["my social is one two three four five six seven eight nine", "US Social Security Number"],
    ["write to me at bob at gmail dot com", "Email Address"],
    ["bob(at)example(dot)org", "Email Address"],
    ["I live at 123 Main St, Springfield, IL 62704", "Street Address"],
    ["one twenty three main street apt 4", "Street Address"],
    ["I was born on the fourteenth of March nineteen forty eight", "Date of Birth"],
    ["DOB: 03-14-1948", "Date of Birth"],
    ["acct no. one two three four five six seven eight", "Bank Account or Routing Number"],
    ["Medicare number 1EG4-TE5-MK73", "Medicare Number"],
    ["call nine three seven, five fifty five, fifty six thirty six", "Phone Number"],
    ["937-555-O636", "Phone Number"],
    ["London office: +44 20 7946 0958", "Phone Number"],
    ["DATABASE_URL is postgres://admin:S3cr3tPw@db.prod.internal:5432/app", "Connection String"],
  ];
  await check("F1-7", `Disguised phone/SSN/email detected and fully redacted (${DISGUISED.length} forms)`, () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx);
      // All forms in one message, one Hide it (one wait instead of one per form): a form that wasn't
      // detected, or not fully hidden, leaves its digits or number words behind. Detection of each form
      // on its own is in the unit tests.
      await typeText(page, DISGUISED.map(([input]) => input).join("\n"));
      const ui = await waitFor(
        async () => ((await readDialog(page)) ? "dialog" : (await readNotice(page)) ? "notice" : null),
        DIALOG_WAIT,
      );
      expect(ui, "nothing shown for the disguised details");
      await clickDialogButton(page, "Hide it", ui === "notice" ? readNotice : readDialog);
      const after = await editorText(page);
      const covered = (after.match(/\[REDACTED/g) || []).length;
      // Forms holding the same value share one label ("937-555-5636" is inside "(937)-555-5636").
      expect(
        covered >= DISGUISED.length - 2 && !/\d{3}|five|three|gmail|example/i.test(after),
        `after Hide it (${covered} hidden): "${after.replace(/\n/g, " / ")}"`,
      );
    }),
  );

  const ORDINARY = [
    "someone phoned at noon",
    "I have 2 cats and 3 dogs",
    "I work at google dot com",
    "the invoice was $4,250,000",
    "sixty seven people from Ohio",
    "meet me on 2026-09-23 at 10:30",
    "my password is incorrect, how do I reset it?",
    "reset your password: click the link",
    "a 5 star place to eat",
    "it's a 5 minutes drive from here",
    "I walked down Main Street",
    "the meeting is 3/14/2026",
    "my birthday is coming up soon",
    "I have 2 accounts at the bank",
    "the license is MIT",
    "I want to go for a walk at 5 to 6",
    "we won 2 to 1 and ate for free",
    "the score went from +3 to +7",
    "version 10.2.3 and build 10.0.19041.1",
    "the local news and internal memo",
  ];
  // Each sentence is also in tests/corpus/normal-messages.txt (checked one by one in the unit tests);
  // here they go through the real chat box together, which takes one wait instead of twenty.
  await check("F8", `Ordinary sentences don't trigger the dialog (${ORDINARY.length} sentences)`, () =>
    withSite(ctx, "chatgpt", async (page) => {
      await typeText(page, ORDINARY.join("\n"));
      await sleep(QUIET_WAIT);
      const dialog = await readDialog(page);
      const notice = await readNotice(page);
      expect(!dialog && !notice, `alarm: ${(dialog || notice)?.text}`);
    }),
  );

  // ----- R. Responses -----
  await check("R0", "Out of the box nothing blocks: a key shows the notice and Enter sends", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      await typeText(page, `key ${KEY}`);
      const notice = await waitForNotice(page);
      expect(
        notice?.text.includes("AWS Access Key"),
        `notice: ${notice?.text} LOGS: ${page.logs.slice(-6).join(" || ")}`,
      );
      expect(!(await readDialog(page)), "the blocking dialog appeared by default");
      await pressEnter(page);
      await sleep(300);
      expect((await sentMessages(page)).length === 1, "message not sent");
      // A send before the warning could be read is recorded once it's confirmed (~1.2 s, D52).
      const events =
        (await waitFor(async () => ((await store.events(ctx)).length ? store.events(ctx) : null), 3000)) || [];
      expect(events.length === 1 && events[0].action === "allowed", `events: ${JSON.stringify(events)}`);
    }),
  );

  await check("R0b", "Notice → More choices → stop warning me about this kind sets that type to Log only", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      await typeText(page, "call me at 937-555-5636");
      expect(await waitForNotice(page), "no notice");
      await clickDialogButton(page, "More choices", readNotice);
      await clickDialogButton(page, "Leave it in, and stop warning me about: Phone Number", readNotice);
      expect(!(await readNotice(page)), "notice still open");
      const { responses } = await store.get(ctx, "responses");
      expect(responses?.phone_number === "log", `responses: ${JSON.stringify(responses)}`);
      await clearEditor(page);
      await typeText(page, "or 937-555-1234");
      await expectNoUI(page, "phone numbers are now Log only");
    }),
  );

  await check(
    "MC1",
    "More choices: 'don't warn me about this one again' (vault: fine to share) and 'always watch for this one' (vault: protect)",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await typeText(page, "call me at 937-555-5636");
        expect(await waitForNotice(page), "no notice");
        await page.screenshot({ path: path.join(OUT, "notice-more-closed.png") });
        await clickDialogButton(page, "More choices", readNotice);
        await page.screenshot({ path: path.join(OUT, "notice-more-open.png") });
        await clickDialogButton(page, "Leave it in, and don't warn me about this one again", readNotice);
        expect(!(await readNotice(page)), "notice still open");
        // The vault write goes through the background's queue: wait for it.
        let vault = await waitFor(async () => {
          const v = (await store.get(ctx, "vault")).vault;
          return v?.length ? v : null;
        }, 3000);
        expect(
          vault?.length === 1 &&
            vault[0].mode === "allow" &&
            vault[0].type === "phone_number" &&
            /^[0-9a-f]{16}$/.test(vault[0].fp),
          `vault: ${JSON.stringify(vault)}`,
        );
        expect(!JSON.stringify(vault).includes("5636"), "the number itself was stored");
        await clearEditor(page);
        await typeText(page, "again 937-555-5636");
        await expectNoUI(page, "this number is fine to share now");
        await clearEditor(page);
        await store.set(ctx, { responses: { aws_access_key: "block" } });
        await typeText(page, `key ${KEY2}`);
        expect(await waitForDialog(page), "no dialog");
        await clickDialogButton(page, "More choices");
        await page.screenshot({ path: path.join(OUT, "dialog-more-open.png") });
        await clickDialogButton(page, "Hide it, and always watch for this one, however it's written");
        expect((await editorText(page)).includes("[REDACTED AWS ACCESS KEY]"), "not hidden");
        vault = await waitFor(async () => {
          const v = (await store.get(ctx, "vault")).vault || [];
          return v.some((e) => e.type === "aws_access_key") ? v : null;
        }, 3000);
        expect(
          vault?.some((e) => e.type === "aws_access_key" && e.mode === "protect"),
          `vault: ${JSON.stringify(vault)}`,
        );
      }),
  );

  const PHONE = "call me at 937-555-5636";
  await check("R1", "Warn (phone, default): notice shows, sending isn't blocked, counts as allowed", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx);
      await typeText(page, PHONE);
      const notice = await waitForNotice(page);
      expect(
        notice?.text.includes("Phone Number"),
        `notice: ${notice?.text} LOGS: ${page.logs.slice(-6).join(" || ")}`,
      );
      expect(!notice.text.includes("937-555-5636"), "notice shows the full number");
      expect(!(await readDialog(page)), "a warn-level item opened the blocking dialog");
      await page.screenshot({ path: path.join(OUT, "notice.png") });
      await sleep(1600); // read it, then send anyway (an informed send: no "Just sent" follow-up, FS2)
      await pressEnter(page);
      await sleep(300);
      const sent = await sentMessages(page);
      expect(sent.length === 1, `sent: ${JSON.stringify(sent)}`);
      expect(!(await readNotice(page)), "notice still open after sending");
      const events = await waitFor(async () => ((await store.events(ctx)).length ? store.events(ctx) : null), 2000);
      expect(events?.length === 1 && events[0].action === "allowed", `events: ${JSON.stringify(events)}`);
    }),
  );

  await check("R1b", "Keep it lasts for that message only: the next message warns again", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      await typeText(page, PHONE);
      expect(await waitForNotice(page), "no notice");
      await clickDialogButton(page, "Leave it in", readNotice);
      await typeText(page, " and more words");
      await expectNoUI(page, "same value, same message, already kept");
      await pressEnter(page);
      await sleep(300);
      expect((await sentMessages(page)).length === 1, "first message not sent");
      await typeText(page, `again: ${PHONE}`);
      const again = await waitForNotice(page);
      expect(again?.text.includes("Phone Number"), "the next message didn't warn again");
    }),
  );

  await check("R2", "Warn notice → Remove it replaces the number and records 'redacted'", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx);
      await typeText(page, PHONE);
      expect(await waitForNotice(page), "no notice");
      await clickDialogButton(page, "Hide it", readNotice);
      const text = await editorText(page);
      expect(text.includes("[REDACTED PHONE NUMBER]") && !text.includes("5636"), `editor text: "${text}"`);
      expect(!(await readNotice(page)), "notice still open");
      const events = await waitFor(async () => ((await store.events(ctx)).length ? store.events(ctx) : null), 2000);
      expect(events?.[0]?.action === "redacted", `events: ${JSON.stringify(events)}`);
    }),
  );

  await check(
    "KM1",
    "Hide it works in an editor that applies edits a moment later at its own caret (Kimi); counted only once hidden",
    () =>
      withSite(ctx, "asynced", async (page) => {
        await resetState(ctx, {}); // default Warn: a notice while typing
        await typeText(page, `my key ${KEY} ok`);
        expect(await waitForNotice(page), "no notice");
        await clickDialogButton(page, "Hide it", readNotice);
        const text =
          (await waitFor(async () => {
            const t = await editorText(page);
            return t.includes("[REDACTED") ? t : null;
          }, 3000)) || (await editorText(page));
        await sleep(500); // a late duplicate edit would show up by now
        const final = await editorText(page);
        expect(
          final.trim() === "my key [REDACTED AWS ACCESS KEY] ok",
          `editor text: "${final}" (first seen: "${text}")`,
        );
        await sleep(1200); // past the scan delay
        const after = await readNotice(page);
        expect(!after, `a notice after hiding (Clotr's own edit mistaken for the user's): ${after?.text}`);
        const events = await waitFor(async () => ((await store.events(ctx)).length ? store.events(ctx) : null), 2000);
        expect(events?.length === 1 && events[0].action === "redacted", `events: ${JSON.stringify(events)}`);
      }),
  );

  await check(
    "KM2",
    "A chat box that refuses Clotr's edit: the user is told to delete it by hand, and nothing is counted as hidden",
    () =>
      withSite(ctx, "asynced", async (page) => {
        await resetState(ctx, {}); // default Warn: a notice while typing
        await typeText(page, `my key ${KEY} ok`);
        expect(await waitForNotice(page), "no notice");
        await page.evaluate(() => {
          window.__rejectEdits = true;
        });
        await clickDialogButton(page, "Hide it", readNotice);
        const told = await waitFor(async () => {
          const n = await readNotice(page);
          return n && /couldn't hide/i.test(n.text) ? n : null;
        }, 3000);
        expect(
          told && /AWS Access Key/.test(told.text) && /delete it by hand/i.test(told.text),
          `notice: ${JSON.stringify(await readNotice(page))}`,
        );
        expect(
          !(await store.events(ctx)).some((e) => e.action === "redacted"),
          "recorded as hidden although the key is still there",
        );
        // This check causes Clotr's "couldn't edit" warning on purpose; Z2 still catches any other.
        ctx.problems = ctx.problems.filter(
          (p) => !p.startsWith("asynced page warn: [Clotr] couldn't edit this chat box"),
        );
      }),
  );

  // The self-check state the background keeps for the active tab (what the popup's site card reads).
  const tabHealth = () =>
    ctx.worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const { protectedTabs = {} } = await chrome.storage.session.get("protectedTabs");
      return protectedTabs[tab.id] || null;
    });

  await check(
    "HC1",
    "Self-check: on a chat page Clotr reports that it sees the chat box, before anything is typed",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await page.bringToFront();
        const h = await waitFor(async () => {
          const x = await tabHealth();
          return x?.editor ? x : null;
        }, 5000);
        expect(h?.editor === true && !h.editFailed, `health: ${JSON.stringify(await tabHealth())}`);
      }),
  );

  await check(
    "HC2",
    "Self-check: an AI site's page without a chat box is reported as such (running, no chat box yet)",
    () =>
      withSite(ctx, "nochat", async (page) => {
        await page.bringToFront();
        const h = await waitFor(async () => await tabHealth(), 3000);
        await sleep(1500);
        const after = await tabHealth();
        expect(h && after && after.editor === false, `health: ${JSON.stringify(after)}`);
      }),
  );

  await check(
    "SEC1",
    "Storage is locked to Clotr's own pages: the part running inside an AI page can't read history, the salt or other sites' settings",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await store.set(ctx, { events: seedEvents() });
        await sleep(500);
        const got = await evalInClotr(
          page,
          `(async () => {
        try {
          const all = await chrome.storage.local.get(null);
          return "readable: " + Object.keys(all).join(",");
        } catch (e) {
          return "denied";
        }
      })()`,
        );
        expect(got === "denied", `from inside the page: ${got}`);
        await store.set(ctx, { events: [] });
      }),
  );

  await check("SET1", "A setting changed while a chat tab is still starting up reaches that tab", () =>
    withSite(ctx, "chatgpt", async (page) => {
      // Straight after the page opens, before its Clotr has registered with the background.
      await ctx.worker.evaluate(() =>
        enqueue(() => chrome.storage.local.set({ responses: { aws_access_key: "block" }, guided: {} })),
      );
      await sleep(1000);
      await typeText(page, `key ${KEY}`);
      await pressEnter(page);
      expect(await waitForDialog(page), "the tab kept its old settings: the key wasn't held");
      expect((await sentMessages(page)).length === 0, "sent despite Ask before sending");
    }),
  );

  await check("HP1", "Hostile page removes Clotr's dialog: the user is never stuck (Enter still sends, D30)", () =>
    withSite(ctx, "hostile", async (page) => {
      await resetState(ctx); // Ask before sending for keys
      await page.evaluate(() => window.__removeClotr());
      await typeText(page, `key ${KEY}`);
      await sleep(600);
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press("Enter");
        await sleep(700);
      }
      const sent = await page.evaluate(() => window.__sent.length);
      expect(sent === 1, `the message never went: the user is stuck (sent ${sent})`);
    }),
  );

  await check(
    "HP2",
    "Hostile page scripts its box (fills in a detail, empties it) with no user action: nothing is recorded as sent",
    () =>
      withSite(ctx, "hostile", async (page) => {
        await resetState(ctx, {});
        await page.evaluate(() => window.__fakeSend("my ssn is 219-09-9999"));
        await sleep(2500);
        const events = await store.events(ctx);
        expect(!events.some((e) => e.action === "allowed"), `fake send recorded: ${JSON.stringify(events)}`);
      }),
  );

  await check(
    "HP3",
    "Hostile page removes the warning notice: Clotr notes it can't show warnings on this tab (self-check)",
    () =>
      withSite(ctx, "hostile", async (page) => {
        await resetState(ctx, {});
        await page.bringToFront();
        await page.evaluate(() => window.__removeClotr());
        await typeText(page, `key ${KEY}`);
        const h = await waitFor(async () => {
          const x = await tabHealth();
          return x?.uiRemoved ? x : null;
        }, 4000);
        expect(h, `health: ${JSON.stringify(await tabHealth())}`);
      }),
  );

  await check(
    "SEC2",
    "A page can't probe what Clotr knows: guesses it puts in its own chat box by script get no reaction (S24)",
    () =>
      withSite(ctx, "hostile", async (page) => {
        await resetState(ctx, {});
        const reacted = await page.evaluate((k) => window.__probe(`is it Emma? Liam? key ${k}`), KEY);
        expect(!reacted, "Clotr reacted to text the page typed by script");
        // Real typing still warns (the page's text is checked once the user types).
        await typeText(page, " qx-sec2");
        const n = await waitFor(() => readNotice(page), 3000);
        expect(n && /AWS Access Key/.test(n.text), "no warning after real typing");
      }),
  );

  await check("SEC3", "A page can't trigger Ask before sending with a scripted Enter (S24)", () =>
    withSite(ctx, "hostile", async (page) => {
      await resetState(ctx, { responses: { aws_access_key: "block" } });
      const reacted = await page.evaluate((k) => window.__probe(`key ${k}`, { enter: true }), KEY);
      expect(!reacted, "a scripted Enter opened Clotr's dialog");
    }),
  );

  await check(
    "HC4",
    "Self-check survives in-page navigation (a single-page app changing its URL, as grok.com does after loading)",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await page.bringToFront();
        expect(await waitFor(async () => (await tabHealth())?.editor, 5000), "no health before navigating");
        await page.evaluate(() => {
          history.pushState({}, "", "/c/abc123");
        });
        await sleep(1500);
        await page.evaluate(() => {
          history.pushState({}, "", "/c/def456");
        });
        await sleep(2500);
        const h = await tabHealth();
        expect(h?.editor === true, `health after in-page navigation: ${JSON.stringify(h)}`);
      }),
  );

  await check(
    "HC3",
    "Self-check: a failed Hide it marks the tab (red ! badge, tooltip says why); a later successful Hide it clears it",
    () =>
      withSite(ctx, "asynced", async (page) => {
        await resetState(ctx, {});
        await page.bringToFront();
        await typeText(page, `my key ${KEY} ok`);
        expect(await waitForNotice(page), "no notice");
        await page.evaluate(() => {
          window.__rejectEdits = true;
        });
        await clickDialogButton(page, "Hide it", readNotice);
        const h = await waitFor(async () => {
          const x = await tabHealth();
          return x?.editFailed ? x : null;
        }, 4000);
        expect(h, `health: ${JSON.stringify(await tabHealth())}`);
        const badge = await activeBadge(ctx);
        expect(badge.text === "!", `badge: ${JSON.stringify(badge)}`);
        const title = await ctx.worker.evaluate(async () => {
          const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          return chrome.action.getTitle({ tabId: tab.id });
        });
        expect(/couldn't edit the chat box/i.test(title), `title: ${title}`);
        ctx.problems = ctx.problems.filter(
          (p) => !p.startsWith("asynced page warn: [Clotr] couldn't edit this chat box"),
        );
        // The user fixes it; next time Hide it works again.
        await page.evaluate(() => {
          window.__rejectEdits = false;
        });
        await clickDialogButton(page, "OK, I'll delete it", readNotice).catch(() => {});
        await clearEditor(page);
        await typeText(page, `again ${KEY2}`);
        expect(await waitForNotice(page), "no notice the second time");
        await clickDialogButton(page, "Hide it", readNotice);
        const cleared = await waitFor(async () => {
          const x = await tabHealth();
          return x && !x.editFailed ? x : null;
        }, 4000);
        expect(cleared, `still marked: ${JSON.stringify(await tabHealth())}`);
        expect((await activeBadge(ctx)).text !== "!", "badge still shows !");
      }),
  );

  await check("N1", "Notice with several items: every item stays inside the notice (wraps between items)", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {}); // defaults: everything warns
      await typeText(page, `key ${KEY} phone 937-555-0123 mail ann.lee@example-company.com`);
      expect(await waitForNotice(page), "no notice");
      const { root } = await page.cdp.send("DOM.getDocument", { depth: -1, pierce: true });
      let box = null;
      const codes = [];
      (function walk(n) {
        const cls = (n.attributes || []).join(" ");
        if (n.nodeName === "DIV" && / notice\b/.test(` ${cls}`) && !box) box = n;
        if (n.nodeName === "CODE") codes.push(n);
        for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) walk(c);
      })(root);
      expect(box && codes.length, `notice box ${!!box}, items ${codes.length}`);
      const right = async (n) => {
        const q = (await page.cdp.send("DOM.getBoxModel", { nodeId: n.nodeId })).model.border;
        return Math.max(q[0], q[2], q[4], q[6]);
      };
      const edge = await right(box);
      for (const c of codes) {
        const r = await right(c);
        expect(r <= edge, `an item ends at x=${Math.round(r)}, past the notice edge at x=${Math.round(edge)}`);
      }
    }),
  );

  await check("R3", "Block + warn together: one dialog lists both, Redact removes both", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx);
      await typeText(page, `${KEY} and ${PHONE}`);
      const dialog = await waitForDialog(page);
      expect(
        dialog?.text.includes("AWS Access Key") && dialog.text.includes("Phone Number"),
        `dialog: ${dialog?.text}`,
      );
      expect(!(await readNotice(page)), "notice shown alongside the dialog");
      await clickDialogButton(page, "Hide it");
      const text = await editorText(page);
      expect(!text.includes(KEY) && !text.includes("5636"), `editor text: "${text}"`);
    }),
  );

  await check(
    "R4",
    "Log only: no interruption, but every detection is still recorded (nothing is silently dropped)",
    async () => {
      await resetState(ctx);
      await chooseResponse(ctx, "phone_number", "log");
      await chooseResponse(ctx, "email", "log");
      await withSite(ctx, "chatgpt", async (page) => {
        await typeText(page, `${PHONE} or bob@example.com`);
        await expectNoUI(page, "phone and email are log-only");
        await pressEnter(page);
        await sleep(300);
        expect((await sentMessages(page)).length === 1, "message not sent");
      });
      const events = await store.events(ctx);
      const types = events
        .map((e) => `${e.type}:${e.action}`)
        .sort()
        .join(",");
      expect(types === "email:suppressed,phone_number:suppressed", `events: ${types}`);
      await chooseResponse(ctx, "phone_number", "warn");
      await chooseResponse(ctx, "email", "warn");
      const { responses } = await store.get(ctx, "responses");
      expect(
        !("phone_number" in responses) && !("email" in responses),
        `defaults not restored: ${JSON.stringify(responses)}`,
      );
    },
  );

  await check("R5", "Settings list every data type with its response", async () => {
    await store.set(ctx, { responses: { email: "off" } }); // a setting saved by an older version
    const popup = await openPopup(ctx);
    await popup.click("#tab-settings");
    const rows = await popup.$$eval("select.resp[data-pattern]", (sels) =>
      sels.map((s) => [s.dataset.pattern, s.value, s.classList.contains("changed")]),
    );
    const offOptions = await popup.$$eval("select.resp option", (os) => os.filter((o) => o.value === "off").length);
    const patternCount = await popup.evaluate(() => globalThis.Clotr.PATTERNS.length);
    await shot(popup, "popup-responses.png");
    await popup.close();
    await store.set(ctx, { responses: {} });
    const byId = Object.fromEntries(rows.map(([id, v, changed]) => [id, { v, changed }]));
    expect(rows.length === patternCount, `${rows.length} rows for ${patternCount} patterns`);
    expect(byId.aws_access_key?.v === "warn" && byId.phone_number?.v === "warn", `defaults: ${JSON.stringify(byId)}`);
    expect(
      byId.email?.v === "log" && byId.email.changed,
      `old "off" should read as Log only: ${JSON.stringify(byId.email)}`,
    );
    expect(offOptions === 0, `${offOptions} "Off" options left (everything is logged, D21)`);
  });

  await check(
    "G1",
    "Settings groups: Personal info → Log only sets every personal type; Default restores them",
    async () => {
      await resetState(ctx, {});
      const popup = await openPopup(ctx);
      await popup.click("#tab-settings");
      const pick = (v) =>
        popup.evaluate((val) => {
          const sel = document.querySelector('select[data-group="personal"]');
          sel.value = val;
          sel.dispatchEvent(new Event("change"));
        }, v);
      const initial = await popup.$eval('select[data-group="credentials"]', (s) => s.value);
      await pick("log");
      await sleep(300);
      const off = (await store.get(ctx, "responses")).responses || {};
      await popup.evaluate(() => (document.querySelector('details[data-group="personal"]').open = true));
      await sleep(100);
      await shot(popup, "popup-groups.png");
      await pick("default");
      await sleep(300);
      const after = (await store.get(ctx, "responses")).responses || {};
      await popup.close();
      expect(initial === "default", `credentials group starts at ${initial}`);
      expect(
        ["us_ssn", "credit_card", "phone_number", "email", "street_address"].every((id) => off[id] === "log") &&
          Object.values(off).every((v) => v === "log"),
        `after Log only: ${JSON.stringify(off)}`,
      );
      expect(!Object.keys(after).length, `after Default: ${JSON.stringify(after)}`);
    },
  );

  await check(
    "S2",
    "A site added on huggingface.co runs Clotr only in the chosen section, not the whole site",
    async () => {
      // Regression (2026-09-24): protecting one Hugging Face page covered all of huggingface.co.
      // The permission prompt can't be clicked in a test, so the grant is simulated in the worker;
      // what's checked is the registration that decides where Clotr runs.
      const matches = await ctx.worker.evaluate(async () => {
        const realGetAll = chrome.permissions.getAll;
        chrome.permissions.getAll = async () => ({ origins: ["https://huggingface.co/*"] });
        const scope = ClotrSites.protectScope("https://huggingface.co/spaces/owner/my-app?x=1");
        await chrome.storage.local.set({ siteScopes: { "https://huggingface.co/*": [scope] } });
        await enqueue(syncUserSites); // through the worker's queue, like every real caller
        const [reg] = await chrome.scripting.getRegisteredContentScripts({ ids: [ClotrSites.USER_SCRIPT_ID] });
        chrome.permissions.getAll = realGetAll;
        await chrome.storage.local.set({ siteScopes: {} });
        await enqueue(syncUserSites);
        return reg?.matches;
      });
      expect(
        JSON.stringify(matches) === JSON.stringify(["https://huggingface.co/spaces/owner/my-app/*"]),
        `registered on: ${JSON.stringify(matches)}`,
      );
    },
  );

  await check("S1", "Settings → Built-in AI tools lists tools by name (from ai-sites.json)", async () => {
    const popup = await openPopup(ctx);
    await popup.click("#tab-settings");
    const got = await popup.evaluate(() => ({
      count: document.querySelector("#builtin-count").textContent,
      items: [...document.querySelectorAll("#builtin-sites li")].map((li) => li.textContent),
    }));
    await popup.close();
    expect(got.count === "18" && got.items.length === 18, `count ${got.count}, ${got.items.length} items`);
    expect(got.items.includes("ChatGPT — chatgpt.com, chat.openai.com"), `items: ${got.items.slice(0, 3).join(" | ")}`);
  });

  await check("R6c", "Upgrade: a user-site registration under the old name (ChainSec) is removed", async () => {
    await ctx.worker.evaluate(() =>
      chrome.scripting.registerContentScripts([
        {
          id: "chainsec-user-sites",
          matches: ["https://chatgpt.com/*"],
          js: ["patterns.js"],
          persistAcrossSessions: false,
        },
      ]),
    );
    await ctx.worker.evaluate(() => syncUserSites());
    const left = await ctx.worker.evaluate(() =>
      chrome.scripting.getRegisteredContentScripts({ ids: ["chainsec-user-sites"] }),
    );
    expect(left.length === 0, `old registration still there: ${JSON.stringify(left)}`);
  });

  await check("R6", "Upgrade: old 'don't warn again' and 'Off' settings become Log only", async () => {
    await store.set(ctx, {
      suppressed: { global: { email: true, aws_access_key: true } },
      responses: { aws_access_key: "off" },
    });
    await ctx.worker.evaluate(() => migrateSuppressed());
    await ctx.worker.evaluate(() => migrateOffToLog());
    const got = await store.get(ctx, ["suppressed", "responses"]);
    await store.set(ctx, { responses: {} });
    expect(!got.suppressed, "old key not removed");
    expect(
      got.responses?.email === "log" && got.responses?.aws_access_key === "log",
      `responses (old "off" → Log only): ${JSON.stringify(got.responses)}`,
    );
  });

  await check(
    "LG1",
    "Sign-in fields on an AI site are never watched (shown password, username, one-time code, sign-up form); its chat box is",
    () =>
      withSite(ctx, "login", async (page) => {
        await resetState(ctx);
        const typeInto = async (sel, text) => {
          TYPED_VALUES.add(text);
          await page.focus(sel);
          await page.keyboard.sendCharacter(text);
        };
        await page.click("#show"); // "show password" makes it a text field
        await typeInto("#pass", KEY);
        await typeInto("#user", "grandma.jones@example.com");
        await typeInto("#otp", "937-555-0147");
        await typeInto("#new-user", "grandma.jones@example.com");
        await typeInto("#new-pass", KEY2);
        await page.keyboard.press("Enter");
        await expectNoUI(page, "typing into sign-in fields");
        expect(
          !(await store.events(ctx)).length,
          `sign-in fields were recorded: ${JSON.stringify(await store.events(ctx))}`,
        );
        await typeText(page, `here is the key ${KEY}`);
        expect(
          (await waitForNotice(page)) || (await waitForDialog(page)),
          "the chat box on the same page isn't protected",
        );
      }),
  );

  await check("P1", "Documentation example keys and placeholders don't trigger", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx);
      await typeText(
        page,
        "aws configure → AKIAIOSFODNN7EXAMPLE, OPENAI_API_KEY=sk-your-api-key-here-1234567890, pip install sk-learn-is-a-great-library",
      );
      await expectNoUI(page, "only example keys/placeholders");
      expect(!(await store.events(ctx)).length, "placeholder was counted");
    }),
  );

  await check("P2", '"my password is …" blocks; Redact removes only the password', () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx);
      await typeText(page, "my password is Fluffy123 can you remember it");
      const dialog = await waitForDialog(page);
      expect(dialog?.text.includes("Password or Secret"), `dialog: ${dialog?.text}`);
      expect(!dialog.text.includes("Fluffy123"), "dialog shows the password");
      await clickDialogButton(page, "Hide it");
      const text = await editorText(page);
      expect(text === "my password is [REDACTED PASSWORD OR SECRET] can you remember it", `editor text: "${text}"`);
    }),
  );

  await check("R7", "Bulk paste: the notice summarizes counts instead of listing every value", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      const rows = Array.from(
        { length: 30 },
        (_, i) => `user${i},user${i}@example${i}.com,937-555-${String(1000 + i)}`,
      );
      await typeText(page, ["name,email,phone", ...rows].join("\n"));
      const notice = await waitForNotice(page);
      await page.screenshot({ path: path.join(OUT, "notice-bulk.png") });
      expect(
        /Large paste: 31 lines/.test(notice?.text || ""),
        `notice: ${notice?.text} LOGS: ${page.logs.slice(-6).join(" || ")}`,
      );
      expect(/Email Address ×30/.test(notice.text) && /Phone Number ×30/.test(notice.text), `notice: ${notice.text}`);
      expect(!/@example/.test(notice.text), "notice lists values");
      await clickDialogButton(page, "Hide it", readNotice);
      const text = await editorText(page);
      expect(!/@example|937-555-1/.test(text), `not all redacted: ${text.slice(0, 120)}`);
    }),
  );

  await check("R8", "Attached text file: its contents are scanned and the notice names the file", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      const file = path.join(OUT, "customers.csv");
      const rows = ["name,email", "Ann,ann.lee@gmail.com", "Bo,bo.chan@yahoo.com", "Cy,cy.diaz@outlook.com"];
      rows.forEach((r) => TYPED_VALUES.add(r));
      fs.writeFileSync(file, rows.join("\n"));
      const input = await page.$("#attach");
      await input.uploadFile(file);
      const notice = await waitForNotice(page);
      await page.screenshot({ path: path.join(OUT, "notice-file.png") });
      fs.rmSync(file);
      expect(
        /customers\.csv/.test(notice?.text || "") && /Email Address ×3/.test(notice.text),
        `notice: ${notice?.text} LOGS: ${page.logs.slice(-6).join(" || ")}`,
      );
      expect(!notice.buttons.some((b) => b.text === "Hide it"), "offers Remove it for a file");
      await clickDialogButton(page, "OK", readNotice);
      const events = await waitFor(
        async () => ((await store.events(ctx)).length === 3 ? store.events(ctx) : null),
        2000,
      );
      expect(
        events?.every((e) => e.action === "allowed" && e.type === "email"),
        `events: ${JSON.stringify(await store.events(ctx))}`,
      );
    }),
  );

  // Office documents are zip files of XML. A minimal zip writer for test fixtures (stored or deflated).
  function makeZip(file, entries) {
    const zlib = require("zlib");
    const parts = [];
    const central = [];
    let offset = 0;
    for (const [name, content, deflate = true] of entries) {
      const data = Buffer.from(content);
      const body = deflate ? zlib.deflateRawSync(data) : data;
      const nameBuf = Buffer.from(name);
      const crc = zlib.crc32(data);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(deflate ? 8 : 0, 8);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt16LE(20, 4);
      cd.writeUInt16LE(20, 6);
      cd.writeUInt16LE(deflate ? 8 : 0, 10);
      cd.writeUInt32LE(crc, 16);
      cd.writeUInt32LE(body.length, 20);
      cd.writeUInt32LE(data.length, 24);
      cd.writeUInt16LE(nameBuf.length, 28);
      cd.writeUInt32LE(offset, 42);
      parts.push(local, nameBuf, body);
      central.push(cd, nameBuf);
      offset += 30 + nameBuf.length + body.length;
    }
    const cdBuf = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cdBuf.length, 12);
    end.writeUInt32LE(offset, 16);
    fs.writeFileSync(file, Buffer.concat([...parts, cdBuf, end]));
  }
  const docxXml = (paras) =>
    `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${paras.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`;

  await check("R8d", "Attached Word document: the text inside is scanned (key and phone found)", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      const file = path.join(OUT, "resume.docx");
      makeZip(file, [
        ["[Content_Types].xml", "<Types/>"],
        ["word/document.xml", docxXml(["Jane Example", `deploy key ${KEY}`, "Call me: 937-555-0123"])],
      ]);
      await (await page.$("#attach")).uploadFile(file);
      const notice = await waitForNotice(page);
      fs.rmSync(file);
      expect(
        /resume\.docx/.test(notice?.text || "") &&
          /AWS Access Key/.test(notice.text) &&
          /Phone Number/.test(notice.text),
        `notice: ${notice?.text} LOGS: ${page.logs.slice(-4).join(" || ")}`,
      );
    }),
  );

  await check(
    "R8m",
    "Several attached files at once: one notice names every file with personal data, and each is recorded once",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        const dir = path.join(OUT, "many");
        fs.mkdirSync(dir, { recursive: true });
        const files = [];
        for (let i = 0; i < 8; i++) {
          const file = path.join(dir, `notes${i}.txt`);
          const risky =
            i === 1
              ? "mail ann.lee@gmail.com"
              : i === 4
                ? "call 937-555-0144"
                : i === 6
                  ? `key ${KEY}`
                  : "nothing private here";
          TYPED_VALUES.add(risky);
          fs.writeFileSync(file, `meeting notes ${i}\n${risky}\n`);
          files.push(file);
        }
        await (await page.$("#attach")).uploadFile(...files);
        await sleep(800);
        const notice = await waitForNotice(page);
        fs.rmSync(dir, { recursive: true });
        const text = notice?.text || "";
        expect(
          /notes1\.txt/.test(text) && /notes4\.txt/.test(text) && /notes6\.txt/.test(text),
          `notice doesn't name all three files: ${text}`,
        );
        expect(
          /Email Address/.test(text) && /Phone Number/.test(text) && /AWS Access Key/.test(text),
          `notice doesn't list all kinds: ${text}`,
        );
        await clickDialogButton(page, "OK", readNotice);
        const events =
          (await waitFor(async () => {
            const ev = await store.events(ctx);
            return ev.length >= 3 ? ev : null;
          }, 3000)) || (await store.events(ctx));
        expect(
          events.length === 3 && events.every((e) => e.action === "allowed"),
          `records: ${JSON.stringify(events.map((e) => [e.type, e.action]))}`,
        );
      }),
  );

  await check("R8x", "Attached spreadsheet (.xlsx): cell text is scanned", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      const file = path.join(OUT, "customers.xlsx");
      makeZip(file, [
        [
          "xl/sharedStrings.xml",
          `<sst><si><t>Ann</t></si><si><t>ann.lee@gmail.com</t></si><si><t>bo.chan@yahoo.com</t></si></sst>`,
        ],
        ["xl/worksheets/sheet1.xml", "<worksheet/>"],
      ]);
      await (await page.$("#attach")).uploadFile(file);
      const notice = await waitForNotice(page);
      fs.rmSync(file);
      expect(
        /customers\.xlsx/.test(notice?.text || "") && /Email Address/.test(notice.text),
        `notice: ${notice?.text}`,
      );
    }),
  );

  await check(
    "R8p",
    "Attached PDF (a real one, printed by the browser: compressed, embedded fonts): its text is checked",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        const file = path.join(OUT, "statement.pdf");
        const printer = await ctx.browser.newPage();
        await printer.setRequestInterception(true);
        printer.on("request", (req) => req.abort());
        await printer.setContent(`<html><body style="font-family:Arial"><h1>Account statement</h1>
        <p>Customer: Jane Example</p><p>Phone: 937-555-0123</p><p>Email: jane.example@gmail.com</p>
        <p>Deploy key ${KEY}</p></body></html>`);
        fs.writeFileSync(file, await printer.pdf({ format: "A4" }));
        await printer.close();
        await (await page.$("#attach")).uploadFile(file);
        const notice = await waitForNotice(page);
        fs.rmSync(file);
        expect(
          /statement\.pdf/.test(notice?.text || "") &&
            /Phone Number/.test(notice.text) &&
            /AWS Access Key/.test(notice.text) &&
            /Email Address/.test(notice.text),
          `notice: ${notice?.text} LOGS: ${page.logs.slice(-3).join(" || ")}`,
        );
      }),
  );

  await check(
    "R8q",
    "PDF bomb (a tiny file whose stream inflates to 60 MB): capped, no hang, the chat keeps working",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        const file = path.join(OUT, "bomb.pdf");
        const zlib = require("zlib");
        const body = zlib.deflateSync(Buffer.from(`BT (${"A".repeat(60 * 1024 * 1024)}) Tj ET`));
        const NL = String.fromCharCode(10);
        fs.writeFileSync(
          file,
          Buffer.concat([
            Buffer.from(
              ["%PDF-1.4", `1 0 obj << /Length ${body.length} /Filter /FlateDecode >>`, "stream", ""].join(NL),
            ),
            body,
            Buffer.from(["", "endstream", "endobj", "%%EOF"].join(NL)),
          ]),
        );
        const t0 = Date.now();
        await (await page.$("#attach")).uploadFile(file);
        await sleep(2500);
        fs.rmSync(file);
        const alive = await page.evaluate(() => 1 + 1).catch(() => 0);
        expect(alive === 2 && Date.now() - t0 < 8000, `page responsive: ${alive}, ${Date.now() - t0} ms`);
        await typeText(page, "call me at 937-555-0123");
        expect(await waitForNotice(page), "Clotr stopped working after the PDF bomb");
      }),
  );

  await check(
    "R8r",
    "Hostile PDF built to make the parser crawl (200k unclosed dictionaries): no hang, chat keeps working",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        const file = path.join(OUT, "crawl.pdf");
        fs.writeFileSync(file, "%PDF-1.4 " + "<< /A <x ".repeat(200000) + ">> endobj stream");
        const t0 = Date.now();
        await (await page.$("#attach")).uploadFile(file);
        await sleep(1500);
        fs.rmSync(file);
        const ms = await page.evaluate(() => {
          const s = performance.now();
          return new Promise((r) => setTimeout(() => r(performance.now() - s), 0));
        });
        expect(
          ms < 500 && Date.now() - t0 < 6000,
          `page stalled: event loop ${Math.round(ms)} ms, total ${Date.now() - t0} ms`,
        );
        await typeText(page, "call me at 937-555-0123");
        expect(await waitForNotice(page), "Clotr stopped working after the hostile PDF");
      }),
  );

  await check("R8s", "Hostile PDF with hundreds of streams that never end (18 MB): no hang, chat keeps working", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      const file = path.join(OUT, "endless.pdf");
      const NL = String.fromCharCode(10);
      fs.writeFileSync(file, "%PDF-1.4 " + ("<< /A 1 >> stream" + NL + "x".repeat(45000) + " ").repeat(400));
      const t0 = Date.now();
      await (await page.$("#attach")).uploadFile(file);
      await sleep(2000);
      fs.rmSync(file);
      const lag = await page.evaluate(() => {
        const s = performance.now();
        return new Promise((r) => setTimeout(() => r(performance.now() - s), 0));
      });
      expect(
        lag < 500 && Date.now() - t0 < 8000,
        `page stalled: event loop ${Math.round(lag)} ms, total ${Date.now() - t0} ms`,
      );
      await typeText(page, "call me at 937-555-0123");
      expect(await waitForNotice(page), "Clotr stopped working after the hostile PDF");
    }),
  );

  await check(
    "R8z",
    "Zip bomb in a .docx (60 MB of text from a tiny file): read is capped, no hang, the chat keeps working",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        const file = path.join(OUT, "bomb.docx");
        makeZip(file, [["word/document.xml", docxXml(["A".repeat(60 * 1024 * 1024)])]]);
        const t0 = Date.now();
        await (await page.$("#attach")).uploadFile(file);
        await sleep(2500);
        fs.rmSync(file);
        const alive = await page.evaluate(() => 1 + 1).catch(() => 0);
        expect(alive === 2 && Date.now() - t0 < 8000, `page responsive: ${alive}, ${Date.now() - t0} ms`);
        await typeText(page, "call me at 937-555-0123");
        expect(await waitForNotice(page), "Clotr stopped working after the zip bomb");
      }),
  );

  // ----- V. Your vault ("What should I protect?") -----
  await check("V0", 'First install opens "What should I protect?"', async () => {
    // Waits a moment: run first (--only V), the check can start before the install opened the tab.
    const t = await waitFor(() => ctx.browser.targets().find((x) => x.url().includes("/vault.html?welcome=1")), 5000);
    expect(
      t,
      `targets: ${ctx.browser
        .targets()
        .map((x) => x.url())
        .join(", ")}`,
    );
  });

  const MY = {
    my_name: "Jane Q Doe",
    family_name: "Emma",
    employer: "Initech",
    street_address: "123 Oak Street",
    phone_number: "(937) 555-5636",
    email: "jane.doe@gmail.com",
    my_id: "AB-123456",
    watch_list: "Project Falcon\nEMP-#####",
  };
  await check(
    "W1",
    "First install: welcome explains Clotr in plain words; the practice box warns and redacts, and records nothing",
    async () => {
      await resetState(ctx, {});
      const page = await openExtPage(ctx, "vault.html?welcome=1");
      try {
        const intro = await page.evaluate(() => ({
          visible: !document.getElementById("welcome").hidden,
          h1: document.querySelector("h1").textContent,
          text: document.getElementById("welcome").innerText,
        }));
        expect(intro.visible && intro.h1 === "Welcome to Clotr", `welcome: ${JSON.stringify(intro).slice(0, 200)}`);
        const pin = await page.evaluate(() => document.getElementById("pin-step")?.innerText || "");
        expect(/puzzle piece/i.test(pin) || /Clotr is pinned/.test(pin), `pin step: ${JSON.stringify(pin)}`);
        for (const fact of [
          "Only on AI chats",
          "Nothing leaves this computer",
          "never saves what you type",
          "It only warns",
          "Only in this browser",
        ]) {
          expect(intro.text.includes(fact), `missing: "${fact}"`);
        }
        TYPED_VALUES.add(KEY);
        await page.type("#try", `my key ${KEY}`);
        const shown = await waitFor(() => page.evaluate(() => document.querySelector(".try-notice")?.innerText), 3000);
        expect(shown?.includes("AWS Access Key (AKIA…3N)") && !shown.includes(KEY), `practice warning: ${shown}`);
        await shot(page, "welcome.png");
        await page.click(".try-notice .btn");
        const after = await page.$eval("#try", (t) => t.value);
        expect(after.includes("[REDACTED AWS ACCESS KEY]") && !after.includes(KEY), `after Redact: ${after}`);
        expect(!(await store.events(ctx)).length, "the practice box recorded an event");
      } finally {
        await page.close();
      }
      const plain = await openExtPage(ctx, "vault.html");
      const hidden = await plain.evaluate(() => document.getElementById("welcome").hidden);
      await plain.close();
      expect(hidden, "the welcome shows on the normal vault page too");
    },
  );

  await check(
    "V1s",
    "Vault page: typed details aren't kept by the browser (no autocomplete; fields cleared when the page is hidden)",
    async () => {
      const page = await openExtPage(ctx, "vault.html");
      try {
        const off = await page.$$eval("textarea", (ts) => ts.every((t) => t.getAttribute("autocomplete") === "off"));
        expect(off, "a vault field allows autocomplete (the browser could keep what was typed)");
        TYPED_VALUES.add("Jane Unsaved Example");
        await page.type("#f-my_name", "Jane Unsaved Example");
        await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
        const left = await page.$eval("#f-my_name", (t) => t.value);
        expect(left === "", `still in the field after pagehide: ${JSON.stringify(left)}`);
      } finally {
        await page.close();
      }
    },
  );

  await check(
    "V8",
    "Vault addresses match with or without accents, and an entry saved before still matches as typed",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        const [fresh, legacy] = await ctx.worker.evaluate(async () => {
          const salt = await ensureSalt();
          return [
            globalThis.Clotr.fingerprint(salt, "street_address", "Calle Alcalá 45"),
            globalThis.Clotr.fingerprint(salt, "street_address_accented", "Avenida Andalucía 12"),
          ];
        });
        // "Just count" for addresses, so only a vault entry ("always watch") makes a warning.
        await store.set(ctx, {
          events: [],
          guided: ALL_GUIDED,
          responses: { street_address: "log" },
          vault: [
            { kind: "value", type: "street_address", fp: fresh, mode: "protect", added: Date.now() },
            { kind: "value", type: "street_address", fp: legacy, mode: "protect", added: Date.now() },
          ],
        });
        try {
          await typeText(page, "vivo en Calle Alcala 45, Madrid");
          expect(await waitForNotice(page), "no warning for the vault address typed without accents");
          await withSite(ctx, "chatgpt", async (other) => {
            await typeText(other, "mi oficina está en Avenida Andalucía 12");
            expect(await waitForNotice(other), "no warning for an address saved by an older version");
          });
        } finally {
          await store.set(ctx, { vault: [], responses: {} });
        }
      }),
  );

  await check(
    "V1",
    "Vault page saves fingerprints only, then your details are caught however they're written",
    async () => {
      await resetState(ctx, {});
      await store.set(ctx, { vault: [] });
      const vp = await openExtPage(ctx, "vault.html");
      for (const [type, value] of Object.entries(MY)) {
        value.split("\n").forEach((v) => TYPED_VALUES.add(v));
        await vp.type(`#f-${type}`, value);
      }
      await vp.click("#save");
      const msg = await waitFor(async () => vp.$eval("#save-msg", (n) => n.textContent || null), 3000);
      const leftover = await vp.$$eval("textarea", (ts) => ts.map((t) => t.value).join(""));
      await sleep(300);
      await shot(vp, "vault-page.png");
      await vp.close();
      expect(/Saved 10 new items/.test(msg || ""), `message: ${msg}`); // AB-123456 = its format + a fingerprint (D23)
      expect(leftover === "", `text left in the form: ${leftover}`);
      const stored = JSON.stringify((await store.get(ctx, "vault")).vault);
      const plain = /jane|emma|initech|oak|5636|123456|falcon|gmail/i.exec(stored);
      expect(!plain, `readable value in storage: ${plain?.[0]}`);
      await withSite(ctx, "chatgpt", async (page) => {
        const cases = [
          [
            "hi, I'm jane q doe and my kid emma lives at one twenty three oak st",
            ["Your Name", "Family Member's Name", "Street Address"],
          ],
          ["I work at INITECH on project falcon, badge EMP-12345", ["Your Employer", "Watch List Item"]],
          ["my member number is AB-123456", ["Your Account/ID Number"]],
          ["their member number is ab-998877", ["Account/ID Number"]],
        ];
        for (const [text, names] of cases) {
          await clearEditor(page);
          await typeText(page, text);
          const n = await waitForNotice(page);
          const missing = names.filter((name) => !n?.text.includes(name));
          expect(!missing.length, `"${text}" → missing ${missing.join(", ")} (notice: ${n?.text})`);
          if (text.startsWith("their"))
            expect(
              !n.text.includes("Your Account/ID Number"),
              `someone else's ID in your format was called yours: ${n.text}`,
            );
          await clickDialogButton(page, "Leave it in", readNotice);
        }
      });
    },
  );

  await check("V2", "A vault item still warns when its type is set to Log only", async () => {
    await store.set(ctx, { responses: { phone_number: "log" } });
    await withSite(ctx, "chatgpt", async (page) => {
      await typeText(page, "call 937.555.5636");
      const n = await waitForNotice(page);
      expect(n?.text.includes("Phone Number"), `your phone wasn't caught: ${n?.text}`);
      await clickDialogButton(page, "Leave it in", readNotice);
      await clearEditor(page);
      await typeText(page, "or 937-555-1234");
      await expectNoUI(page, "other phone numbers are Log only");
    });
  });

  await check("V3", 'Vault → "OK to share" makes your own item quiet; Remove forgets it', async () => {
    await store.set(ctx, { responses: {} });
    const vp = await openExtPage(ctx, "vault.html");
    const setPhone = (v) =>
      vp.evaluate((val) => {
        const li = [...document.querySelectorAll("#vault-list li")].find((x) => x.textContent.includes("Phone number"));
        const sel = li.querySelector("select");
        sel.value = val;
        sel.dispatchEvent(new Event("change"));
      }, v);
    await setPhone("allow");
    await sleep(300);
    await store.set(ctx, { events: [] });
    await withSite(ctx, "chatgpt", async (page) => {
      await typeText(page, "call me at nine three seven five five five five six three six");
      await expectNoUI(page, "your phone is OK to share");
    });
    const logged = await store.events(ctx);
    expect(
      logged.length === 1 && logged[0].action === "suppressed",
      `OK-to-share item should still be recorded: ${JSON.stringify(logged)}`,
    );
    const before = (await store.get(ctx, "vault")).vault.length;
    await vp.evaluate(() =>
      [...document.querySelectorAll("#vault-list li")]
        .find((x) => x.textContent.includes("Phone number"))
        .querySelector("button")
        .click(),
    );
    await sleep(300);
    await vp.close();
    expect((await store.get(ctx, "vault")).vault.length === before - 1, "entry not removed");
  });

  // Deletes `part` from the chat box the way a user would: select it, press Backspace.
  async function deleteByHand(page, part) {
    await page.evaluate(
      (sel, p) => {
        const box = eval(sel);
        const i = box.value.indexOf(p);
        box.focus();
        box.setSelectionRange(i, i + p.length);
      },
      page.site.editor,
      part,
    );
    await page.keyboard.press("Backspace");
  }

  await check(
    "L1",
    'Learning: deleting a flagged item by hand offers "Add to my vault" (not after Redact or sending)',
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        // Sending empties the box: no offer afterwards.
        await typeText(page, "call me at 937-555-1111 later");
        expect(await waitForNotice(page), "no notice");
        await sleep(1600); // an informed send (no "Just sent" follow-up)
        await pressEnter(page);
        await sleep(300);
        await typeText(page, "thanks");
        await expectNoUI(page, "after sending");
        // Redact button: no offer.
        await clearEditor(page);
        await typeText(page, "call me at 937-555-2222 later");
        await waitForNotice(page);
        await clickDialogButton(page, "Hide it", readNotice);
        await expectNoUI(page, "after Redact");
        // Deleted by hand: offer.
        await clearEditor(page);
        await typeText(page, "call me at 937-555-5636 later");
        await waitForNotice(page);
        await deleteByHand(page, "937-555-5636");
        const offer = await waitFor(async () => {
          const n = await readNotice(page);
          return n?.text.includes("Always watch") ? n : null;
        }, DIALOG_WAIT);
        expect(offer, `no offer after deleting by hand (notice: ${(await readNotice(page))?.text})`);
        await page.screenshot({ path: path.join(OUT, "offer-vault.png") });
        await clickDialogButton(page, "Add to my vault", readNotice);
        const v = await waitFor(async () => ((await store.get(ctx, "vault")).vault || []).find((e) => e.learned), 2000);
        expect(
          v?.type === "phone_number" && v.mode === "protect" && /^[0-9a-f]{16}$/.test(v.fp),
          `vault: ${JSON.stringify(v)}`,
        );
      }),
  );

  await check("L2", "Learning: keeping the same type 3 times offers to relax it to Log only", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      for (let i = 1; i <= 3; i++) {
        await clearEditor(page);
        await typeText(page, `mail me at friend${i}@gmail.com`);
        expect(await waitForNotice(page), `no notice #${i}`);
        await clickDialogButton(page, "Leave it in", readNotice);
        await sleep(300);
      }
      const offer = await waitFor(async () => {
        const n = await readNotice(page);
        return n?.text.includes("Warn less") ? n : null;
      }, DIALOG_WAIT);
      expect(offer?.text.includes("Email Address"), `offer: ${(await readNotice(page))?.text}`);
      await page.screenshot({ path: path.join(OUT, "offer-relax.png") });
      await clickDialogButton(page, "Just count it", readNotice);
      await sleep(300);
      const { responses } = await store.get(ctx, "responses");
      expect(responses?.email === "log", `responses: ${JSON.stringify(responses)}`);
    }),
  );

  await check("V4", "Upgrade: It's me and watch-list entries move into the vault", async () => {
    await store.set(ctx, {
      vault: [],
      mine: [{ type: "email", fp: "0123456789abcdef", added: 1 }],
      watch: [
        { kind: "word", fp: "fedcba9876543210", words: 2, added: 2 },
        { kind: "shape", shape: "EMP-#####", added: 3 },
      ],
    });
    await ctx.worker.evaluate(() => migrateToVault());
    const got = await store.get(ctx, ["vault", "mine", "watch"]);
    await store.set(ctx, { vault: [] });
    expect(!got.mine && !got.watch, "old keys not removed");
    const v = got.vault || [];
    expect(
      v.length === 3 && v[0].mode === "allow" && v[1].type === "watch_list" && v[2].shape === "EMP-#####",
      `vault: ${JSON.stringify(v)}`,
    );
  });

  await check(
    "MIG1",
    "Upgrade from every earlier version's saved settings: clean result, history kept, dashboard opens",
    async () => {
      const ev = (type, name, severity, action, fp) => ({
        t: Date.now() - 3600000,
        site: "chatgpt.com",
        type,
        name,
        severity,
        action,
        fp,
      });
      const EVENTS = [
        ev("aws_access_key", "AWS Access Key", "high", "redacted", "0123456789abcdef"),
        ev("email", "Email Address", "medium", "suppressed", "abcdef0123456789"),
      ];
      const SAVED = {
        "v0.4": {
          events: EVENTS,
          suppressed: { global: { email: true, phone_number: false } },
          paused: { "claude.ai": true },
        },
        "v0.5": {
          events: EVENTS,
          responses: { phone_number: "off", aws_access_key: "block" },
          mine: [{ type: "phone_number", fp: "1111111111111111", added: 1 }],
        },
        "v0.7": {
          events: EVENTS,
          responses: { email: "log" },
          mine: [{ type: "email", fp: "2222222222222222", added: 1 }],
          watch: [
            { kind: "word", fp: "3333333333333333", words: 1, added: 2 },
            { kind: "shape", shape: "EMP-#####", added: 2 },
          ],
          siteModes: { "chatgpt.com": "block" },
        },
        "v0.8": {
          events: EVENTS,
          responses: { us_ssn: "off" },
          ignores: { email: [Date.now()] },
          vault: [{ kind: "value", type: "email", fp: "4444444444444444", mode: "protect", added: 3 }],
        },
        mixed: {
          events: EVENTS,
          suppressed: { global: { email: true } },
          responses: { email: "off", phone_number: "warn" },
          mine: [{ type: "email", fp: "4444444444444444", added: 1 }],
          vault: [{ kind: "value", type: "email", fp: "4444444444444444", mode: "allow", added: 3 }],
        },
      };
      const saved = await store.get(ctx);
      try {
        for (const [version, data] of Object.entries(SAVED)) {
          await ctx.worker.evaluate(
            (d) =>
              enqueue(async () => {
                await chrome.storage.local.clear();
                await chrome.storage.local.set(d);
              }),
            { ...data, salt: saved.salt },
          );
          const problemsBefore = ctx.problems.length;
          await ctx.worker.evaluate(() => runMigrations());
          const got = await store.get(ctx);
          const bad = (why) => `${version}: ${why} (${JSON.stringify(got)})`;
          expect(!("suppressed" in got) && !("mine" in got) && !("watch" in got), bad("old keys left"));
          expect(
            Object.values(got.responses || {}).every((r) => ["block", "warn", "log"].includes(r)),
            bad("invalid response"),
          );
          expect(
            await ctx.worker.evaluate((v) => v.every((e) => cleanVaultEntry(e)), got.vault || []),
            bad("invalid vault entry"),
          );
          expect(got.events?.length === EVENTS.length, bad("history lost"));
          const popup = await openPopup(ctx);
          await sleep(500);
          await popup.close();
          expect(
            ctx.problems.length === problemsBefore,
            `${version}: ${ctx.problems.slice(problemsBefore).join(" | ")}`,
          );
        }
      } finally {
        await ctx.worker.evaluate(
          (d) =>
            enqueue(async () => {
              await chrome.storage.local.clear();
              await chrome.storage.local.set(d);
            }),
          saved,
        );
      }
    },
  );

  // ----- U. Updates -----
  await check("U1", 'After an update the popup shows "what\'s new" once', async () => {
    const version = await ctx.worker.evaluate(() => chrome.runtime.getManifest().version);
    await store.set(ctx, { lastUpdate: { from: "0.7.5", to: version, t: Date.now(), seen: false } });
    const popup = await openPopup(ctx);
    const card = await popup.$eval("#whats-new", (n) => (n.hidden ? null : n.innerText));
    await shot(popup, "popup-whats-new.png");
    await popup.click("#whats-new-ok");
    await sleep(300);
    await popup.close();
    const { lastUpdate } = await store.get(ctx, "lastUpdate");
    expect(card?.includes(`Updated to v${version}`) && card.split("\n").length >= 3, `card: ${card}`);
    expect(lastUpdate.seen === true, "not marked seen");
  });

  // A copy of the extension in its own browser, with its version bumped on disk.
  // `before` edits the copy's manifest before it's installed (to start from an older shape).
  async function withChangedCopy(fn, before = null) {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-ext-"));
    fs.cpSync(EXT, copy, { recursive: true });
    const current = fs.readFileSync(path.join(copy, "manifest.json"), "utf8");
    if (before) {
      const m = JSON.parse(current);
      before(m);
      fs.writeFileSync(path.join(copy, "manifest.json"), JSON.stringify(m, null, 2));
    }
    const other = await launch(copy);
    other.restoreManifest = () => fs.writeFileSync(path.join(copy, "manifest.json"), current);
    const bump = () => {
      const file = path.join(copy, "manifest.json");
      const m = JSON.parse(fs.readFileSync(file, "utf8"));
      m.version = "9.9.9";
      fs.writeFileSync(file, JSON.stringify(m, null, 2));
    };
    try {
      return await fn(other, bump);
    } finally {
      await other.browser.close();
      fs.rmSync(other.profile, { recursive: true, force: true });
      fs.rmSync(copy, { recursive: true, force: true });
    }
  }

  await check("U2", "Update check: no reload when nothing changed, exactly one when the files on disk changed", () =>
    withChangedCopy(async (other, bump) => {
      // Record reload calls instead of restarting, so this runs on every browser.
      await other.worker.evaluate(() => {
        globalThis.__reloads = 0;
        chrome.runtime.reload = () => {
          globalThis.__reloads++;
        };
      });
      const unchanged = await other.worker.evaluate(() => checkForLocalUpdate());
      expect(unchanged === false, "reported an update with nothing changed");
      bump();
      const changed = await other.worker.evaluate(() => checkForLocalUpdate());
      const reloads = await other.worker.evaluate(() => globalThis.__reloads);
      expect(changed === true && reloads === 1, `update detected: ${changed}, reloads: ${reloads}`);
    }),
  );

  await check("U2c", "Update waits while a Clotr dialog is open (up to 2 hours), then reloads", () =>
    withChangedCopy(async (other, bump) => {
      await other.worker.evaluate(() => {
        globalThis.__reloads = 0;
        chrome.runtime.reload = () => {
          globalThis.__reloads++;
        };
      });
      const reloads = () => other.worker.evaluate(() => globalThis.__reloads);
      await resetState(other); // before the page opens, so it starts with these settings
      const page = await openSite(other, "chatgpt");
      try {
        await typeText(page, `key ${KEY}`);
        expect(await waitForDialog(page), "no dialog");
        bump();
        expect(
          (await other.worker.evaluate(() => checkForLocalUpdate())) === false && (await reloads()) === 0,
          "reloaded while the dialog was open",
        );
        await clickDialogButton(page, "Leave it in");
        expect(
          (await other.worker.evaluate(() => checkForLocalUpdate())) === true && (await reloads()) === 1,
          "didn't reload after the dialog was answered",
        );
        // A dialog left open for 2+ hours no longer holds the update back (D38).
        await typeText(page, ` and ${KEY2}`);
        expect(await waitForDialog(page), "no second dialog");
        await other.worker.evaluate(() => chrome.storage.session.set({ updateWaitingSince: Date.now() - 90 * 60000 }));
        expect(
          (await other.worker.evaluate(() => checkForLocalUpdate())) === false && (await reloads()) === 1,
          "gave up waiting after 90 minutes",
        );
        await other.worker.evaluate(() => chrome.storage.session.set({ updateWaitingSince: Date.now() - 121 * 60000 }));
        expect(
          (await other.worker.evaluate(() => checkForLocalUpdate())) === true && (await reloads()) === 2,
          "a long-open dialog held the update back forever",
        );
      } finally {
        await page.close();
      }
    }),
  );

  await check("U2b", "An unpacked copy really restarts into the new version (no network)", () =>
    withChangedCopy(async (other, bump) => {
      if (await other.worker.evaluate(() => typeof navigator.brave === "object")) {
        throw new Skip(
          "automated Brave drops any self-reloaded unpacked extension (even with no change); " +
            "real Brave 1.95 reloads fine (checked by hand, 2026-09-24). Runs on Chrome engines and in CI",
        );
      }
      bump();
      other.worker.evaluate(() => checkForLocalUpdate()).catch(() => {}); // the worker goes away mid-call
      const fresh = await other.browser.waitForTarget(
        (t) => t.type() === "service_worker" && t.url().endsWith("/background.js") && t !== other.swTarget,
        { timeout: 15000 },
      );
      const s = await fresh.createCDPSession();
      const { result } = await s.send("Runtime.evaluate", {
        expression: "chrome.runtime.getManifest().version",
        returnByValue: true,
      });
      expect(result.value === "9.9.9", `running version after reload: ${result.value}`);
    }),
  );

  await check("U2d", "An update that adds the built-in sites' host permissions (0.9.18) keeps Clotr running", () =>
    withChangedCopy(
      async (other, bump) => {
        if (await other.worker.evaluate(() => typeof navigator.brave === "object")) {
          throw new Skip(
            "needs a real extension reload, which automated Brave drops (D33). Runs on Chrome engines and in CI",
          );
        }
        other.restoreManifest(); // the current manifest, with host_permissions
        bump();
        other.worker.evaluate(() => checkForLocalUpdate()).catch(() => {});
        const fresh = await other.browser
          .waitForTarget(
            (t) => t.type() === "service_worker" && t.url().endsWith("/background.js") && t !== other.swTarget,
            { timeout: 15000 },
          )
          .catch(() => null);
        expect(fresh, "Clotr didn't come back after the update (disabled for new permissions?)");
        const s = await fresh.createCDPSession();
        const { result } = await s.send("Runtime.evaluate", {
          expression:
            "JSON.stringify([chrome.runtime.getManifest().version, (chrome.runtime.getManifest().host_permissions || []).length])",
          returnByValue: true,
        });
        const [version, hosts] = JSON.parse(result.value);
        expect(version === "9.9.9" && hosts > 0, `after update: version ${version}, host permissions ${hosts}`);
      },
      (m) => {
        delete m.host_permissions;
        m.version = "0.9.17";
        m.version_name = "0.9.17-alpha";
      },
    ),
  );

  await check(
    "UP1",
    "After an update, open AI tabs switch to the new version by themselves: the old copy steps aside, no reload (D39)",
    () =>
      withChangedCopy(async (other, bump) => {
        if (await other.worker.evaluate(() => typeof navigator.brave === "object")) {
          throw new Skip(
            "automated Brave drops any self-reloaded unpacked extension (D33); runs on Chrome engines and in CI",
          );
        }
        const page = await openSite(other, "chatgpt");
        try {
          await resetState(other, {}); // defaults: warnings
          await typeText(page, "hello ");
          await sleep(600);
          bump();
          other.worker.evaluate(() => checkForLocalUpdate()).catch(() => {}); // the worker goes away mid-call
          await other.browser.waitForTarget(
            (t) => t.type() === "service_worker" && t.url().endsWith("/background.js") && t !== other.swTarget,
            { timeout: 15000 },
          );
          const started = await waitFor(
            () => page.logs.filter((l) => l.includes("[Clotr] active on")).length >= 2,
            8000,
          );
          expect(
            started,
            `the new version didn't start in the open tab: ${page.logs.filter((l) => l.includes("[Clotr]")).join(" / ")}`,
          );
          // (An orphaned copy's console output doesn't reach DevTools: the notice count below shows it stepped aside.)
          await typeText(page, "call me at 937-555-0123");
          const notice = await waitForNotice(page);
          expect(notice, "no notice from the new version");
          expect(!notice.text.includes("Reload this page"), `the notice comes from the old copy: ${notice.text}`);
          const counts = await page.evaluate(() => ({
            notices: document.querySelectorAll("clotr-notice").length,
            prompts: document.querySelectorAll("clotr-reload").length,
          }));
          expect(
            counts.notices === 1 && counts.prompts === 0,
            `notices: ${counts.notices}, reload prompts: ${counts.prompts}`,
          );
          await pressEnter(page);
          await sleep(300);
          expect((await sentMessages(page)).length === 1, "didn't send");
        } finally {
          await page.close();
        }
      }),
  );

  // ----- Z. Privacy & health -----
  await check("Z1", "Nothing typed during the run is stored anywhere by Clotr", async () => {
    const all = JSON.stringify(await store.get(ctx, null));
    const session = JSON.stringify(await ctx.worker.evaluate(() => chrome.storage.session.get(null)));
    const leaked = [...TYPED_VALUES]
      .flatMap((v) => [v, ...(v.match(/AKIA[0-9A-Z]{16}|\d{3}-\d{3}-\d{4}|\S+ at gmail dot com/g) || [])])
      .filter((v) => v.length >= 8 && (all.includes(v) || session.includes(v)));
    expect(!leaked.length, `found in storage: ${leaked.join(", ")}`);
    return `${TYPED_VALUES.size} inputs checked against ${all.length + session.length} bytes of storage`;
  });

  await check(
    "UN1",
    "A key with a hidden zero-width space and a phone with no-break spaces are caught; Hide it leaves nothing behind",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        const key = "AKIA4HPQ\u200b7XZ2R6TWLJ3N";
        await typeText(page, `key ${key} or call 937\u00a0555\u00a00123`);
        const n = await waitForNotice(page);
        expect(n?.text.includes("AWS Access Key") && n.text.includes("Phone Number"), `notice: ${n?.text}`);
        await clickDialogButton(page, "Hide it", readNotice);
        const text = await editorText(page);
        expect(
          !text.includes("AKIA4HPQ") && !text.includes("0123") && !/\u200b/.test(text),
          `after Hide it: ${JSON.stringify(text)}`,
        );
      }),
  );

  await check(
    "FS1",
    "Fast send (paste, then Enter at once): the message goes, then a 'Just sent' notice says what went and offers to ask first next time",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await typeText(page, "call me at 937-555-0123");
        await pressEnter(page); // before the 400 ms pause: the warning was never visible
        await sleep(300);
        expect((await sentMessages(page)).length === 1, "the message didn't send (Warn must never hold it)");
        const n = await waitFor(() => readNotice(page), 2000);
        expect(n?.text.includes("Just sent to this AI") && n.text.includes("Phone Number"), `notice: ${n?.text}`);
        await clickDialogButton(page, "Ask me first next time", readNotice);
        const responses = await waitFor(
          async () => ((await store.get(ctx, "responses")).responses?.phone_number === "block" ? true : null),
          2000,
        );
        expect(responses, "the choice wasn't saved");
      }),
  );

  await check(
    "FS3",
    "Fast send the site ignores (Gemini did): no false 'Just sent', nothing recorded as sent, the warning shows instead",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await page.evaluate(() => {
          window.__ignoreNextSend = true;
        });
        await typeText(page, "call me at 937-555-0123");
        await pressEnter(page);
        await sleep(2000);
        expect((await sentMessages(page)).length === 0, "the page was supposed to ignore this Enter");
        const n = await readNotice(page);
        expect(n && !n.text.includes("Just sent") && n.text.includes("Phone Number"), `notice: ${n?.text}`);
        const sentEvents = (await store.events(ctx)).filter((e) => e.action === "allowed");
        expect(!sentEvents.length, `recorded as sent: ${JSON.stringify(sentEvents)}`);
      }),
  );

  await check(
    "EG1",
    "A site with its own early Enter handler can't send before Clotr: Ask before sending holds the key",
    async () => {
      await resetState(ctx); // Ask before sending for keys, set before the page opens
      return withSite(ctx, "eager", async (page) => {
        await typeText(page, `key ${KEY}`);
        await pressEnter(page); // at once: the site's own handler would send
        await sleep(400);
        expect((await sentMessages(page)).length === 0, "the site's early Enter handler sent a held key");
        expect(await waitForDialog(page), "no dialog");
      });
    },
  );

  await check("EG2", "A site that sends on Enter key-up can't slip past Ask before sending", async () => {
    await resetState(ctx); // Ask before sending for keys, set before the page opens
    return withSite(ctx, "keyup", async (page) => {
      await typeText(page, `key ${KEY}`);
      await pressEnter(page);
      await sleep(400);
      expect((await sentMessages(page)).length === 0, "sent on key-up despite Ask before sending");
      expect(await waitForDialog(page), "no dialog");
    });
  });

  await check(
    "MOB1",
    "Phone-sized screen (360×740, Firefox for Android): the warning fits and doesn't cover the chat box",
    () =>
      withSite(ctx, "demo", async (page) => {
        await page.setViewport({ width: 360, height: 740 }); // (isMobile would reload the page mid-test)
        await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
        await resetState(ctx, {});
        await typeText(page, "call me at 937-555-0123 or jane.doe@gmail.com");
        expect(await waitForNotice(page), "no notice");
        page.cdp ??= await page.createCDPSession();
        const box = async () => {
          const { root } = await page.cdp.send("DOM.getDocument", { depth: -1, pierce: true });
          let hit = null;
          (function walk(n) {
            if (hit) return;
            const cls = (n.attributes || []).join(" ");
            if (n.nodeName === "DIV" && / notice\b/.test(` ${cls}`)) hit = n;
            for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) walk(c);
          })(root);
          if (!hit) return null;
          const q = (await page.cdp.send("DOM.getBoxModel", { nodeId: hit.nodeId })).model.border;
          return {
            left: Math.min(q[0], q[6]),
            right: Math.max(q[2], q[4]),
            top: Math.min(q[1], q[3]),
            bottom: Math.max(q[5], q[7]),
          };
        };
        const n = await box();
        await page.screenshot({ path: path.join(OUT, "mobile-notice.png") });
        const input = await page.$eval("#prompt", (t) => {
          const r = t.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom };
        });
        expect(n && n.left >= 0 && n.right <= 360, `notice outside the screen: ${JSON.stringify(n)}`);
        expect(
          n.bottom <= input.top,
          `the notice covers the chat box: notice ${JSON.stringify(n)}, box ${JSON.stringify(input)}`,
        );
      }),
  );

  await check(
    "UB1",
    "Unlabeled icon send button + Ask before sending: clicking it right after pasting a key is held for your answer",
    async () => {
      await resetState(ctx); // Ask before sending for keys, set before the page opens
      return withSite(ctx, "iconsend", async (page) => {
        await typeText(page, `key ${KEY}`);
        await clickSend(page); // before the 400 ms pause
        await sleep(400);
        expect((await sentMessages(page)).length === 0, "the unlabeled send button sent a held message");
        expect(await waitForDialog(page), "no dialog");
      });
    },
  );

  await check(
    "UB2",
    "Unlabeled icon send button + Warn: the message goes, then 'Just sent' (confirmed by the box emptying)",
    () =>
      withSite(ctx, "iconsend", async (page) => {
        await resetState(ctx, {});
        await typeText(page, "call me at 937-555-0123");
        await clickSend(page);
        await sleep(300);
        expect((await sentMessages(page)).length === 1, "didn't send (Warn must never hold)");
        const n = await waitFor(() => readNotice(page), 2500);
        expect(n?.text.includes("Just sent"), `notice: ${n?.text}`);
      }),
  );

  await check(
    "UB3b",
    "Ask before sending: the chat box's model picker still opens while a key waits for an answer",
    () =>
      withSite(ctx, "iconsend", async (page) => {
        await resetState(ctx);
        await typeText(page, `key ${KEY}`);
        const opened = await page.evaluate(
          () =>
            new Promise((resolve) => {
              const b = document.getElementById("mode");
              b.addEventListener("click", () => resolve(true), { once: true });
              b.click();
              setTimeout(() => resolve(false), 300);
            }),
        );
        expect(opened, "Clotr held a click on the model picker");
      }),
  );

  await check("UB3", "Other buttons in the chat box (Attach) are never counted as a send", () =>
    withSite(ctx, "iconsend", async (page) => {
      await resetState(ctx, {});
      await typeText(page, "call me at 937-555-0123");
      await page.evaluate(() => document.getElementById("attach").click());
      await sleep(2000);
      expect((await sentMessages(page)).length === 0, "attach sent the message");
      const n = await readNotice(page);
      expect(!n?.text.includes("Just sent"), `false 'Just sent': ${n?.text}`);
      expect(!(await store.events(ctx)).some((e) => e.action === "allowed"), "an Attach click was recorded as a send");
    }),
  );

  await check("FS2", "No 'Just sent' notice when the warning was on screen and you chose to send", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      await typeText(page, "call me at 937-555-0123");
      expect(await waitForNotice(page), "no warning");
      await sleep(1600); // time to read it
      await pressEnter(page);
      await sleep(600);
      expect((await sentMessages(page)).length === 1, "didn't send");
      const n = await readNotice(page);
      expect(!n || !n.text.includes("Just sent"), `nagged after an informed send: ${n?.text}`);
    }),
  );

  await check("PP1", "Popup away from an AI chat says where Clotr works (the built-in list by name)", async () => {
    const popup = await openPopup(ctx);
    const line = await popup.$eval("#site", (n) => n.innerText);
    await popup.close();
    expect(/works on ChatGPT, Claude, Gemini and \d+ more AI chats/.test(line), `site card: ${JSON.stringify(line)}`);
  });

  await check(
    "CSP1",
    "Clotr's pages run under the strict policy with no violations (popup tabs, welcome, vault, What Clotr stores)",
    async () => {
      const pages = [];
      const popup = await openPopup(ctx);
      pages.push(["popup", popup]);
      for (const f of ["vault.html?welcome=1", "vault.html", "stored.html", "dashboard.html"])
        pages.push([f, await openExtPage(ctx, f)]);
      const violations = [];
      try {
        for (const [name, page] of pages) {
          const csp = await page.evaluate(
            () =>
              new Promise((resolve) => {
                const seen = [];
                document.addEventListener("securitypolicyviolation", (e) =>
                  seen.push(`${e.violatedDirective} ${e.blockedURI}`),
                );
                // Exercise the page, then collect.
                for (const t of document.querySelectorAll('[role="tab"], #tab-overview, #tab-activity, #tab-settings'))
                  t.click?.();
                setTimeout(() => resolve(seen), 800);
              }),
          );
          violations.push(...csp.map((v) => `${name}: ${v}`));
        }
        const header = await popup.evaluate(() =>
          fetch(location.href)
            .then(() => "fetch self ok")
            .catch((e) => String(e)),
        );
        expect(header === "fetch self ok", `own files must stay readable: ${header}`);
        const outside = await popup.evaluate(() =>
          fetch("https://chatgpt.com/robots.txt")
            .then(() => "reached chatgpt.com")
            .catch(() => "blocked"),
        ); // a host Clotr has permission for: only the policy stops it
        expect(outside === "blocked", `a page could connect out: ${outside}`);
      } finally {
        for (const [, page] of pages) await page.close();
      }
      expect(!violations.length, violations.slice(0, 5).join(" | "));
    },
  );

  // ----- Full-page dashboard: "Your AI exposure report" (v1.0) -----
  const DAY_MS = 86400000;
  const dashEvents = () => {
    const ev = (days, site, type, name, severity, action, fp) => ({
      t: Date.now() - days * DAY_MS - 60000,
      site,
      type,
      name,
      severity,
      action,
      fp,
    });
    return [
      ev(70, "gemini.google.com", "phone_number", "Phone Number", "medium", "allowed", "aaaaaaaaaaaaaaa1"),
      ev(30, "chatgpt.com", "phone_number", "Phone Number", "medium", "allowed", "aaaaaaaaaaaaaaa1"),
      ev(9, "chatgpt.com", "phone_number", "Phone Number", "medium", "allowed", "aaaaaaaaaaaaaaa1"),
      ev(9, "chatgpt.com", "email", "Email Address", "low", "allowed", "bbbbbbbbbbbbbbb2"),
      ev(8, "chatgpt.com", "aws_access_key", "AWS Access Key", "high", "allowed", "ccccccccccccccc3"),
      ev(5, "chatgpt.com", "street_address", "Street Address", "medium", "redacted", "ddddddddddddddd4"),
      ev(3, "claude.ai", "family_name", "Family Member's Name", "high", "allowed", "eeeeeeeeeeeeeee5"),
      ev(2, "claude.ai", "credit_card", "Credit Card Number", "high", "allowed", "fffffffffffffff6"),
      ev(1, "claude.ai", "password", "Password or Secret", "high", "suppressed", "999999999999999a"),
    ];
  };

  await check(
    "DSH1",
    "Full dashboard: totals, what each AI service was told (personal details only), 12-week trend",
    async () => {
      await store.set(ctx, { events: dashEvents() });
      const page = await openExtPage(ctx, "dashboard.html");
      await page.setViewport({ width: 1100, height: 1400 });
      try {
        await sleep(400);
        const got = await page.evaluate(() => ({
          totals: document.getElementById("totals").innerText,
          exposure: [...document.querySelectorAll("#exposure [data-site]")].map(
            (n) => `${n.dataset.site}:${n.dataset.details}`,
          ),
          weeks: document.querySelectorAll("#weeks [data-week]").length,
        }));
        await shot(page, "dashboard.png");
        expect(
          /9\b/.test(got.totals) &&
            /1\s*Hidden/.test(got.totals) &&
            /7\s*Sent/.test(got.totals) &&
            /1\s*Just counted/.test(got.totals),
          `totals: ${got.totals}`,
        );
        expect(
          JSON.stringify(got.exposure) === JSON.stringify(["chatgpt.com:2", "claude.ai:2", "gemini.google.com:1"]),
          `exposure: ${JSON.stringify(got.exposure)}`,
        );
        expect(got.weeks === 12, `weeks: ${got.weeks}`);
      } finally {
        await page.close();
      }
    },
  );

  await check(
    "DSH2",
    "Full dashboard: riskiest moments come with what to do now; repeats are spotted; no fingerprints shown",
    async () => {
      await store.set(ctx, { events: dashEvents() });
      const page = await openExtPage(ctx, "dashboard.html");
      try {
        await sleep(400);
        const got = await page.evaluate(() => ({
          risky: document.getElementById("risky").innerText,
          repeats: document.getElementById("repeats").innerText,
          body: document.body.innerText,
        }));
        expect(/AWS Access Key/.test(got.risky) && /Credit Card Number/.test(got.risky), `risky: ${got.risky}`);
        expect(/deactivate/i.test(got.risky) && /bank/i.test(got.risky), `no advice: ${got.risky}`);
        expect(/Phone Number[^\n]*3 times[^\n]*2 AI/.test(got.repeats), `repeats: ${got.repeats}`);
        expect(!/aaaaaaaaaaaaaaa1|fffffffffffffff6/.test(got.body), "fingerprints shown on the page");
      } finally {
        await page.close();
      }
    },
  );

  await check(
    "DSH3",
    "Full dashboard: export gives the stored records (no fingerprint secret); delete history takes two clicks",
    async () => {
      await store.set(ctx, { events: dashEvents() });
      const { salt } = await store.get(ctx, "salt");
      const page = await openExtPage(ctx, "dashboard.html");
      try {
        await sleep(400);
        await page.click("#export");
        const exported = await page.evaluate(async () => {
          const a = document.getElementById("export-link");
          return a ? (await fetch(a.href)).text() : "";
        });
        const data = JSON.parse(exported || "{}");
        expect(data.events?.length === 9 && !exported.includes(salt), `export: ${exported.slice(0, 120)}`);
        await page.click("#delete-history");
        await sleep(200);
        expect((await store.events(ctx)).length === 9, "deleted after one click");
        await page.click("#delete-history");
        const left = await waitFor(async () => ((await store.events(ctx)).length === 0 ? true : null), 2000);
        expect(left, "history not deleted after the second click");
      } finally {
        await page.close();
        await store.set(ctx, { events: [] });
      }
    },
  );

  const aged = (days, fp) => ({
    t: Date.now() - days * DAY_MS,
    site: "chatgpt.com",
    type: "email",
    name: "Email Address",
    severity: "low",
    action: "allowed",
    fp,
  });

  // Class names inside one of Clotr's closed shadow roots (DevTools can pierce them).
  // Computed style of the first element inside Clotr's closed UI `tag` that `match(node)` accepts.
  async function uiStyle(page, tag, match, props) {
    page.cdp ??= await page.createCDPSession();
    await page.cdp.send("DOM.enable");
    await page.cdp.send("CSS.enable");
    const { root } = await page.cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const kids = (n) => [...(n.children || []), ...(n.shadowRoots || [])];
    let host = null,
      hit = null;
    (function find(n) {
      if (!host) {
        if (n.nodeName === tag) host = n;
        kids(n).forEach(find);
      }
    })(root);
    const attr = (n, name) => {
      const a = n.attributes || [];
      for (let i = 0; i < a.length; i += 2) if (a[i] === name) return a[i + 1];
      return "";
    };
    (function walk(n) {
      if (!n || hit) return;
      if (n !== host && match(n, attr)) {
        hit = n;
        return;
      }
      kids(n).forEach(walk);
    })(host);
    if (!hit) return null;
    const { computedStyle } = await page.cdp.send("CSS.getComputedStyleForNode", { nodeId: hit.nodeId });
    return Object.fromEntries(props.map((p) => [p, computedStyle.find((s) => s.name === p)?.value]));
  }

  async function uiClasses(page, tag) {
    page.cdp ??= await page.createCDPSession();
    const { root } = await page.cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const classes = new Set();
    let host = null;
    (function find(n) {
      if (!host) {
        if (n.nodeName === tag) host = n;
        for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) find(c);
      }
    })(root);
    (function walk(n) {
      if (!n) return;
      const a = n.attributes || [];
      for (let i = 0; i < a.length; i += 2) if (a[i] === "class") a[i + 1].split(/\s+/).forEach((c) => classes.add(c));
      for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) walk(c);
    })(host);
    return classes;
  }

  await check("PM1", 'Helping someone: "Larger warnings" makes the corner warning bigger', () =>
    withSite(ctx, "chatgpt", async (page) => {
      await store.set(ctx, { events: [], responses: {}, guided: ALL_GUIDED, largeText: true });
      try {
        await typeText(page, "call me at 937-555-0147");
        expect(await waitForNotice(page), "no notice");
        const classes = await uiClasses(page, "CLOTR-NOTICE");
        expect(classes.has("large"), `notice classes: ${[...classes].join(" ")}`);
        // Everything in it is larger, not just the headline: the masked value, More choices, the links.
        const code = await uiStyle(page, "CLOTR-NOTICE", (n) => n.nodeName === "CODE", ["font-size"]);
        const more = await uiStyle(page, "CLOTR-NOTICE", (n) => n.nodeName === "SUMMARY", ["font-size"]);
        const link = await uiStyle(
          page,
          "CLOTR-NOTICE",
          (n, attr) => n.nodeName === "BUTTON" && /\blink\b/.test(attr(n, "class")),
          ["font-size", "padding-left"],
        );
        const px = (s) => parseFloat(s?.["font-size"]);
        expect(
          px(code) >= 15 && px(more) >= 15 && px(link) >= 15,
          `small text in large mode: code ${code?.["font-size"]}, More choices ${more?.["font-size"]}, link ${link?.["font-size"]}`,
        );
        expect(link?.["padding-left"] === "0px", `a text link is padded like a button: ${link?.["padding-left"]}`);
        await shot(page, "notice-large.png");
      } finally {
        await store.set(ctx, { largeText: false });
      }
    }),
  );

  await check(
    "PM2",
    "Helping someone: settings locked with a PIN (stored only as a hash); wrong PIN refused, right PIN unlocks",
    async () => {
      await store.set(ctx, { responses: {} });
      await ctx.worker.evaluate(() =>
        Promise.all([chrome.storage.local.remove("lock"), chrome.storage.session.remove("unlockedUntil")]),
      );
      let popup = await openPopup(ctx);
      try {
        await popup.click("#tab-settings");
        await popup.type("#pin", "4827");
        await popup.click("#lock-set");
        const lock = await waitFor(async () => (await store.get(ctx, "lock")).lock, 3000);
        expect(lock?.hash && lock?.salt, `lock: ${JSON.stringify(lock)}`);
        // As a value of its own: "4827" inside a timestamp (1790234827123) or random hex is a coincidence (flaked in CI).
        expect(
          !/(?<![0-9a-f])4827(?![0-9a-f])/i.test(JSON.stringify(await store.get(ctx, null))),
          "the PIN itself was stored",
        );
        await popup.close();
        await ctx.worker.evaluate(() => chrome.storage.session.remove("unlockedUntil"));
        popup = await openPopup(ctx);
        await popup.click("#tab-settings");
        const locked = await popup.evaluate(() => ({
          unlock: !document.getElementById("unlock").hidden,
          settings: document.getElementById("settings-body").hidden,
        }));
        expect(locked.unlock && locked.settings, `settings not locked: ${JSON.stringify(locked)}`);
        await popup.type("#unlock-pin", "1111");
        await popup.click("#unlock-go");
        await sleep(1200);
        expect(
          await popup.evaluate(() => document.getElementById("settings-body").hidden),
          "wrong PIN unlocked the settings",
        );
        expect(
          /didn't match/i.test(await popup.$eval("#unlock-msg", (n) => n.textContent)),
          "no message for a wrong PIN",
        );
        await popup.$eval("#unlock-pin", (n) => {
          n.value = "";
        });
        await popup.type("#unlock-pin", "4827");
        await popup.click("#unlock-go");
        const open = await waitFor(() => popup.evaluate(() => !document.getElementById("settings-body").hidden), 3000);
        expect(open, "the right PIN didn't unlock");
        await shot(popup, "popup-helper.png");
      } finally {
        await popup.close();
        await ctx.worker.evaluate(() =>
          Promise.all([chrome.storage.local.remove("lock"), chrome.storage.session.remove("unlockedUntil")]),
        );
      }
    },
  );

  await check(
    "PM3",
    'Helping someone: "Ask before sending personal details" sets every personal kind to Ask before sending',
    async () => {
      await store.set(ctx, { responses: {} });
      const popup = await openPopup(ctx);
      try {
        await popup.click("#tab-settings");
        await popup.click("#strict-personal");
        const r = await waitFor(async () => {
          const x = (await store.get(ctx, "responses")).responses || {};
          return x.phone_number === "block" ? x : null;
        }, 3000);
        expect(
          r && r.email === "block" && r.street_address === "block" && !r.aws_access_key,
          `responses: ${JSON.stringify(r)}`,
        );
        await popup.click("#strict-personal");
        const back = await waitFor(async () => {
          const x = (await store.get(ctx, "responses")).responses || {};
          return !x.phone_number ? x : null;
        }, 3000);
        expect(back, "turning it off didn't restore Warn");
      } finally {
        await popup.close();
        await store.set(ctx, { responses: {} });
      }
    },
  );

  await check(
    "PM4",
    "Helping someone: with a PIN set, the vault page explains it's locked and can't be edited",
    async () => {
      await ctx.worker.evaluate(() =>
        Promise.all([
          chrome.storage.local.set({ lock: { salt: "00".repeat(16), iterations: 1000, hash: "ab".repeat(32) } }),
          chrome.storage.session.remove("unlockedUntil"),
        ]),
      );
      const page = await openExtPage(ctx, "vault.html");
      try {
        await sleep(500);
        const got = await page.evaluate(() => ({
          locked: !document.getElementById("vault-locked").hidden,
          form: !document.getElementById("vault-form").hidden,
        }));
        expect(got.locked && !got.form, `vault page: ${JSON.stringify(got)}`);
      } finally {
        await page.close();
        await ctx.worker.evaluate(() => chrome.storage.local.remove("lock"));
      }
    },
  );

  await check(
    "TP1",
    "Team policy: required responses win over the user's; the admin's watch words are caught (sent to the page as fingerprints only)",
    async () => {
      // A real managed policy needs admin rights; stand in for the browser's policy store in the worker.
      await ctx.worker.evaluate(() => {
        globalThis.__realManagedGet = chrome.storage.managed.get.bind(chrome.storage.managed);
        chrome.storage.managed.get = async () => ({
          requiredResponses: { phone_number: "block" },
          watchWords: ["Project Falcon"],
        });
      });
      await resetState(ctx, { phone_number: "log" }); // the user's own choice: Just count
      try {
        await withSite(ctx, "chatgpt", async (page) => {
          await typeText(page, "the project falcon launch is next week");
          const n = await waitForNotice(page);
          expect(n && /watch/i.test(n.text), `watch word not caught: ${JSON.stringify(n)}`);
          const vaultSeen = await evalInClotr(
            page,
            "JSON.stringify(document.documentElement.outerHTML.includes('falcon'))",
          );
          expect(vaultSeen === "false", "the watch word shows up in the page's markup");
          await clearEditor(page);
          await typeText(page, "call me at 937-555-0147");
          await pressEnter(page);
          expect(await waitForDialog(page), "the policy's Ask before sending didn't hold the phone number");
          expect((await sentMessages(page)).length === 0, "sent despite the policy");
        });
      } finally {
        await ctx.worker.evaluate(() => {
          chrome.storage.managed.get = globalThis.__realManagedGet;
        });
        await resetState(ctx);
      }
    },
  );

  // Reply checks: your own phone number, fingerprinted with this profile's salt, as the vault page would.
  const ownPhoneVault = async () => {
    const fp = await ctx.worker.evaluate(async () =>
      globalThis.Clotr.fingerprint(await ensureSalt(), "phone_number", "937-555-0147"),
    );
    await store.set(ctx, {
      events: [],
      responses: {},
      guided: ALL_GUIDED,
      vault: [{ kind: "value", type: "phone_number", fp, mode: "protect", added: Date.now() }],
    });
  };
  const replyNote = async (page, ms = 6000) =>
    waitFor(async () => {
      const n = await readNotice(page);
      return n && /reply mentions/i.test(n.text) ? n : null;
    }, ms);

  await check(
    "RP1",
    "Reply check: the AI's reply mentions your own phone number that you didn't type here: a note says so",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await ownPhoneVault();
        try {
          await typeText(page, "hello, can you help me plan a trip?");
          await pressEnter(page);
          await sleep(300);
          await page.evaluate(() => window.__reply("Sure! I'll text the plan to (937) 555-0147 like last time."));
          const n = await replyNote(page);
          expect(
            n && /Phone Number/.test(n.text) && /memory|earlier/i.test(n.text),
            `note: ${JSON.stringify(await readNotice(page))}`,
          );
          expect(!/555-0147/.test(n.text), "the note shows the number itself");
          await shot(page, "reply-note.png");
        } finally {
          await store.set(ctx, { vault: [] });
        }
      }),
  );

  await check("RP2", "Reply check: the AI repeating a detail you typed on this page is expected: no note", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await ownPhoneVault();
      try {
        await typeText(page, "my number is 937-555-0147");
        await sleep(700);
        await pressEnter(page);
        await sleep(300);
        await page.evaluate(() => window.__reply("Got it, I'll use 937-555-0147."));
        expect(!(await replyNote(page, 2500)), "a note for a number the user typed here");
      } finally {
        await store.set(ctx, { vault: [] });
      }
    }),
  );

  await check("RP3", "Reply check: someone else's number in a reply isn't yours: no note", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await ownPhoneVault();
      try {
        await typeText(page, "what's the museum's number?");
        await pressEnter(page);
        await sleep(300);
        await page.evaluate(() => window.__reply("You can call the museum at 212-555-0199."));
        expect(!(await replyNote(page, 2500)), "a note for a number that isn't in the vault");
      } finally {
        await store.set(ctx, { vault: [] });
      }
    }),
  );

  await check(
    "RP5",
    "Reply check: one check per message you send, once the reply is quiet, so a page can't test guess after guess (S24)",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await ownPhoneVault();
        try {
          await typeText(page, "what's the weather tomorrow?");
          await pressEnter(page);
          await sleep(300);
          await page.evaluate(() => window.__reply("Sunny, around 70 degrees."));
          await sleep(4500); // the reply went quiet: its one check is done
          await page.evaluate(() => window.__reply("Is it 937-555-0147?"));
          expect(!(await replyNote(page, 4000)), "a second check in the same reply window");
        } finally {
          await store.set(ctx, { vault: [] });
        }
      }),
  );

  await check(
    "RP4",
    "Reply check: opening an old conversation (text appears with no message sent) never triggers a note",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await ownPhoneVault();
        try {
          await page.evaluate(() => window.__reply("Earlier you said: call me at 937-555-0147"));
          expect(!(await replyNote(page, 2500)), "a note for history loaded without a send");
        } finally {
          await store.set(ctx, { vault: [] });
        }
      }),
  );

  await check(
    "ES1",
    "Spanish browser: the warning, its buttons and the kind of data are in Spanish (D65)",
    async () => {
      const es = await launch(EXT, ["--lang=es-ES", "--accept-lang=es-ES"], { LANGUAGE: "es", LANG: "es_ES.UTF-8" });
      try {
        const page = await openSite(es, "chatgpt");
        await es.worker.evaluate(() => chrome.storage.local.set({ guided: { aws_access_key: 1, phone_number: 1 } }));
        await sleep(400);
        await typeText(page, `mi clave es ${KEY}`);
        const n = await waitFor(() => readNotice(page), 5000);
        const buttons = (n?.buttons || []).map((b) => b.text);
        await shot(page, "notice-es.png");
        expect(n && /Atención/.test(n.text) && /Clave de acceso de AWS/.test(n.text), `notice: ${n?.text}`);
        expect(buttons.includes("Ocultarlo") && buttons.includes("Dejarlo"), `buttons: ${buttons.join(" | ")}`);
        await page.close();
      } finally {
        await es.browser.close();
        fs.rmSync(es.profile, { recursive: true, force: true });
      }
    },
  );

  await check("ES2", "Spanish browser: the popup's tabs, summary and settings are in Spanish (D65)", async () => {
    const es = await launch(EXT, ["--lang=es-ES", "--accept-lang=es-ES"], { LANGUAGE: "es", LANG: "es_ES.UTF-8" });
    try {
      await es.worker.evaluate(() =>
        chrome.storage.local.set({
          events: [
            {
              t: Date.now() - 60000,
              site: "chatgpt.com",
              type: "email",
              name: "Email Address",
              severity: "low",
              action: "redacted",
              fp: "aaaaaaaaaaaaaaa1",
            },
          ],
          lastUpdate: { from: "0.8.0", to: chrome.runtime.getManifest().version, t: Date.now(), seen: false },
        }),
      );
      const popup = await openPopup(es);
      await sleep(400);
      const got = await popup.evaluate(() => ({
        tabs: [...document.querySelectorAll('[role="tab"]')].map((t) => t.textContent.trim()),
        hero: document.getElementById("hero-label").textContent,
        byType: document.getElementById("by-type").textContent,
        lang: document.documentElement.lang,
        whatsNew: document.getElementById("whats-new-list").textContent,
      }));
      await popup.click("#tab-settings");
      await sleep(200);
      const settings = await popup.evaluate(() =>
        document.getElementById("panel-settings").textContent.replace(/\s+/g, " "),
      );
      await shot(popup, "popup-es.png");
      await popup.close();
      expect(got.tabs.join("|") === "Resumen|Actividad|Ajustes", `tabs: ${got.tabs}`);
      expect(
        /fuga evitada/.test(got.hero) && /Dirección de correo electrónico/.test(got.byType),
        `hero: ${got.hero}; by type: ${got.byType}`,
      );
      expect(got.lang === "es", `lang: ${got.lang}`);
      expect(/También en español/.test(got.whatsNew), `what's new isn't in Spanish: ${got.whatsNew.slice(0, 120)}`);
      expect(/Cómo responde Clotr/.test(settings) && /Tu caja fuerte/.test(settings), `settings: ${settings}`);
    } finally {
      await es.browser.close();
      fs.rmSync(es.profile, { recursive: true, force: true });
    }
  });

  await check(
    "ES3",
    'Spanish browser: welcome page (with its practice box), full report and "What Clotr stores" are in Spanish (D65)',
    async () => {
      const es = await launch(EXT, ["--lang=es-ES", "--accept-lang=es-ES"], { LANGUAGE: "es", LANG: "es_ES.UTF-8" });
      try {
        const welcome = await openExtPage(es, "vault.html?welcome=1");
        await welcome.type("#try", "llámame al nueve tres siete cinco cinco cinco cero uno cuatro siete");
        await sleep(700);
        const w = await welcome.evaluate(() => ({
          title: document.getElementById("page-title").textContent,
          tryResult: document.getElementById("try-result").textContent,
          lang: document.documentElement.lang,
        }));
        await shot(welcome, "welcome-es.png");
        await welcome.close();
        await es.worker.evaluate(() =>
          chrome.storage.local.set({
            events: [
              {
                t: Date.now(),
                site: "chatgpt.com",
                type: "phone_number",
                name: "Phone Number",
                severity: "medium",
                action: "allowed",
                fp: "00000000000000aa",
              },
            ],
          }),
        );
        const dash = await openExtPage(es, "dashboard.html");
        await dash.waitForSelector("#map [data-you]", { timeout: 5000 }).catch(() => {});
        const d = await dash.evaluate(
          () => document.querySelector("h1").textContent + " | " + document.getElementById("since").textContent,
        );
        const you = await dash.evaluate(() => document.querySelector("#map [data-you]")?.textContent || "");
        await dash.setViewport({ width: 900, height: 1400 });
        await shot(dash, "dashboard-es.png");
        await dash.close();
        const stored = await openExtPage(es, "stored.html");
        await sleep(300);
        const s = await stored.evaluate(
          () =>
            document.querySelector("h1").textContent +
            " | " +
            document.getElementById("reach").textContent.replace(/\s+/g, " "),
        );
        await stored.close();
        expect(
          /bienvenida/.test(w.title) && /Número de teléfono/.test(w.tryResult) && w.lang === "es",
          `welcome: ${JSON.stringify(w)}`,
        );
        expect(/Tu informe de exposición a la IA/.test(d), `report: ${d}`);
        expect(you === "Tú", `the map's middle says "${you}", not "Tú"`);
        expect(/Qué guarda Clotr/.test(s) && /sitios de chat de IA/.test(s), `stored: ${s.slice(0, 200)}`);
      } finally {
        await es.browser.close();
        fs.rmSync(es.profile, { recursive: true, force: true });
      }
    },
  );

  await check(
    "MAP1",
    "AI connection map: you → each AI service, with what was sent and what Clotr stopped, riskiest kind, and a table view",
    async () => {
      await store.set(ctx, { events: dashEvents() });
      const page = await openExtPage(ctx, "dashboard.html");
      try {
        await sleep(400);
        const got = await page.evaluate(() => ({
          nodes: [...document.querySelectorAll("#map [data-service]")]
            .map((n) => `${n.dataset.service}:${n.dataset.sent}:${n.dataset.stopped}:${n.dataset.risk}`)
            .sort(),
          you: Boolean(document.querySelector("#map [data-you]")),
          rows: document.querySelectorAll("#map-table tbody tr").length,
          labels: [...document.querySelectorAll("#map [data-service]")].map((n) => n.getAttribute("aria-label")),
        }));
        await shot(page, "dashboard-map.png");
        const fit = await page.evaluate(() => {
          const svg = document.getElementById("map");
          const box = svg.getBoundingClientRect(),
            content = svg.getBBox(),
            vb = svg.viewBox.baseVal;
          return {
            emptyBelow: Math.round(vb.y + vb.height - (content.y + content.height)),
            emptyAbove: Math.round(content.y - vb.y),
            px: Math.round(box.height),
          };
        });
        expect(fit.emptyBelow < 30 && fit.emptyAbove < 30, `map leaves empty space: ${JSON.stringify(fit)}`);
        expect(got.you, "no 'You' node");
        expect(
          JSON.stringify(got.nodes) ===
            JSON.stringify(["chatgpt.com:4:1:high", "claude.ai:2:0:high", "gemini.google.com:1:0:medium"]),
          `nodes: ${JSON.stringify(got.nodes)}`,
        );
        expect(got.rows === 3, `table rows: ${got.rows}`);
        expect(
          got.labels.every((l) => /sent/.test(l) && /riskiest/i.test(l)),
          `labels: ${JSON.stringify(got.labels)}`,
        );
      } finally {
        await page.close();
      }
    },
  );

  await check(
    "MAP2",
    "AI connection map: choosing a service (keyboard) shows which kinds it got and what was stopped, never values or fingerprints",
    async () => {
      await store.set(ctx, { events: dashEvents() });
      const page = await openExtPage(ctx, "dashboard.html");
      try {
        await sleep(400);
        const focused = await page.evaluate(() => {
          const n = document.querySelector('#map [data-service="chatgpt.com"]');
          n.focus();
          return document.activeElement === n;
        });
        expect(focused, "map node can't take keyboard focus");
        await page.keyboard.press("Enter");
        await sleep(200);
        const details = await page.$eval("#map-details", (n) => n.innerText);
        expect(
          /chatgpt\.com/.test(details) &&
            /Phone Number ×2/.test(details) &&
            /Email Address/.test(details) &&
            /AWS Access Key/.test(details),
          `details: ${details}`,
        );
        expect(/stopped[^\n]*Street Address/i.test(details), `stopped: ${details}`);
        expect(
          !/aaaaaaaaaaaaaaa1|ccccccccccccccc3/.test(await page.evaluate(() => document.body.innerText)),
          "fingerprints shown",
        );
      } finally {
        await page.close();
        await store.set(ctx, { events: [] });
      }
    },
  );

  await check("MAP3", "Popup Overview: a small AI connection map that opens the full report", async () => {
    await store.set(ctx, { events: dashEvents() });
    const popup = await openPopup(ctx);
    try {
      const n = await popup.$$eval("#mini-map [data-service]", (x) => x.length);
      await shot(popup, "popup-map.png");
      expect(n === 3, `mini map services: ${n}`);
      await popup.click("#mini-map-open");
      const opened = await waitFor(
        async () => (await ctx.browser.pages()).find((p) => p.url().endsWith("/dashboard.html")),
        3000,
      );
      expect(opened, "full report didn't open");
      await opened?.close();
    } finally {
      await popup.close();
      await store.set(ctx, { events: [] });
    }
  });

  await check("DSH5", 'Full dashboard: "Keep history for" 3 months removes older records right away', async () => {
    await store.set(ctx, {
      events: [aged(400, "aaaaaaaaaaaaaaa1"), aged(100, "aaaaaaaaaaaaaaa2"), aged(1, "aaaaaaaaaaaaaaa3")],
      keepDays: 365,
    });
    const page = await openExtPage(ctx, "dashboard.html");
    try {
      await sleep(400);
      expect((await page.$eval("#keep-days", (s) => s.value)) === "365", "setting doesn't show 1 year");
      await page.select("#keep-days", "90");
      const left = await waitFor(async () => {
        const ev = await store.events(ctx);
        return ev.length === 1 ? ev : null;
      }, 3000);
      expect(left && left[0].fp === "aaaaaaaaaaaaaaa3", `events left: ${JSON.stringify(await store.events(ctx))}`);
      expect((await store.get(ctx, "keepDays")).keepDays === 90, "setting not stored");
    } finally {
      await page.close();
      await store.set(ctx, { events: [], keepDays: 365 });
    }
  });

  await check("DSH6", "History keeps 1 year by default: older records go when the next one is written", async () => {
    await ctx.worker.evaluate(() => chrome.storage.local.remove("keepDays"));
    await store.set(ctx, { events: [aged(400, "aaaaaaaaaaaaaaa1"), aged(300, "aaaaaaaaaaaaaaa2")] });
    await ctx.worker.evaluate((e) => enqueue(() => appendEvents([e])), aged(0, "aaaaaaaaaaaaaaa3"));
    const ev = await store.events(ctx);
    expect(ev.map((e) => e.fp).join() === "aaaaaaaaaaaaaaa2,aaaaaaaaaaaaaaa3", `events: ${ev.map((e) => e.fp).join()}`);
    await store.set(ctx, { events: [] });
  });

  await check(
    "WD1",
    "Popup: weekly digest compares with last week and says what to do about a risky send",
    async () => {
      const ev = (days, type, name, severity, action) => ({
        t: Date.now() - days * DAY_MS - 60000,
        site: "chatgpt.com",
        type,
        name,
        severity,
        action,
        fp: "aaaaaaaaaaaaaaa1",
      });
      await store.set(ctx, {
        events: [
          ...Array.from({ length: 5 }, () => ev(10, "email", "Email Address", "low", "redacted")),
          ev(3, "email", "Email Address", "low", "redacted"),
          ev(2, "email", "Email Address", "low", "redacted"),
          ev(1, "aws_access_key", "AWS Access Key", "high", "allowed"),
        ],
      });
      const popup = await openPopup(ctx);
      try {
        const text = await popup.$eval("#digest", (n) => (n.hidden ? "" : n.innerText));
        await shot(popup, "popup-digest.png");
        expect(
          /This week: 3 found/.test(text) && /2 hidden/.test(text) && /1 sent anyway/.test(text),
          `digest: ${text}`,
        );
        expect(/fewer than last week \(5\)/.test(text), `no comparison: ${text}`);
        expect(/AWS Access Key/.test(text) && /Deactivate/.test(text), `no advice: ${text}`);
        await popup.click("#digest-open");
        const opened = await waitFor(
          async () => (await ctx.browser.pages()).find((p) => p.url().endsWith("/dashboard.html")),
          3000,
        );
        expect(opened, "full report didn't open");
        await opened?.close();
      } finally {
        await popup.close();
        await store.set(ctx, { events: [] });
      }
    },
  );

  await check("WD2", "Popup: no digest after a quiet fortnight", async () => {
    await store.set(ctx, {
      events: [
        {
          t: Date.now() - 20 * DAY_MS,
          site: "claude.ai",
          type: "email",
          name: "Email Address",
          severity: "low",
          action: "allowed",
          fp: "aaaaaaaaaaaaaaa1",
        },
      ],
    });
    const popup = await openPopup(ctx);
    try {
      expect(await popup.$eval("#digest", (n) => n.hidden), "digest shown with nothing in two weeks");
    } finally {
      await popup.close();
      await store.set(ctx, { events: [] });
    }
  });

  await check("DSH4", "Popup → Open full report opens the dashboard", async () => {
    const popup = await openPopup(ctx);
    const before = (await ctx.browser.pages()).length;
    await popup.click("#open-dashboard");
    const opened = await waitFor(
      async () => (await ctx.browser.pages()).find((p) => p.url().endsWith("/dashboard.html")),
      3000,
    );
    await popup.close();
    expect(opened, `no dashboard tab (tabs before: ${before})`);
    await opened.close();
  });

  await check(
    "SM1",
    'Settings are simple by default; "Show advanced options" reveals per-type, per-site and built-in list',
    async () => {
      await store.set(ctx, { advanced: false, responses: {}, siteModes: {} });
      const shown = (popup) =>
        popup.evaluate(() => {
          const vis = (sel) => {
            const n = document.querySelector(sel);
            return Boolean(n && n.offsetParent !== null);
          };
          return {
            perType: vis(".resp-group details"),
            builtin: vis("details.builtin"),
            groups: vis(".resp-group .head select"),
            inUse: vis("#advanced-in-use"),
          };
        });
      let popup = await openPopup(ctx);
      await popup.click("#tab-settings");
      await sleep(200);
      const simple = await shown(popup);
      await shot(popup, "popup-settings-simple.png");
      expect(simple.groups && !simple.perType && !simple.builtin && !simple.inUse, `simple: ${JSON.stringify(simple)}`);
      await popup.click("#advanced");
      await sleep(300);
      const adv = await shown(popup);
      expect(adv.perType && adv.builtin, `advanced: ${JSON.stringify(adv)}`);
      await popup.close();
      expect((await store.get(ctx, "advanced")).advanced === true, "the choice wasn't saved");
      // A hidden per-type choice is announced in simple mode.
      await store.set(ctx, { advanced: false, responses: { email: "block" } });
      popup = await openPopup(ctx);
      await popup.click("#tab-settings");
      await sleep(200);
      const note = await shown(popup);
      await popup.close();
      await store.set(ctx, { advanced: false, responses: {} });
      expect(note.inUse, "no note about advanced settings in use");
    },
  );

  await check(
    "ST1",
    '"What Clotr stores" shows every stored record readably, hides the fingerprint secret, and lists the known limits',
    async () => {
      const events = seedEvents();
      await store.set(ctx, {
        events,
        responses: { email: "log" },
        vault: [
          { kind: "value", type: "phone_number", fp: "0123456789abcdef", mode: "allow", added: Date.now() },
          { kind: "shape", type: "my_id", shape: "@@-######", added: Date.now() },
        ],
      });
      const { salt } = await store.get(ctx, "salt");
      const page = await openExtPage(ctx, "stored.html");
      try {
        await page.click(".raw summary");
        await sleep(300);
        const got = await page.evaluate(() => ({
          text: document.body.innerText,
          historyRows: document.querySelectorAll("#history-table tbody tr").length,
          vaultRows: document.querySelectorAll("#vault-table tbody tr").length,
          raw: document.getElementById("raw").textContent,
        }));
        await shot(page, "stored.png");
        expect(
          got.historyRows === Math.min(events.length, 100) && got.vaultRows === 2,
          `rows: history ${got.historyRows}/${events.length}, vault ${got.vaultRows}`,
        );
        expect(
          got.text.includes("Email Address: Just count") || got.text.includes("Email address: Just count"),
          "the Log-only setting isn't shown",
        );
        expect(got.text.includes("@@-######") && got.text.includes("OK to share"), "vault items not shown");
        expect(JSON.parse(got.raw).events.length === events.length, "raw view isn't the stored data");
        expect(salt && !got.text.includes(salt) && !got.raw.includes(salt), "the fingerprint secret is shown");
        expect(
          got.text.includes("Known limits") && got.text.includes("can be guessed from their fingerprints"),
          "limits missing",
        );
        for (const v of TYPED_VALUES) expect(!got.text.includes(v), "a typed value appears on the page");
      } finally {
        await page.close();
        await store.set(ctx, { events: [], responses: {}, vault: [] });
      }
    },
  );

  await check(
    "OFF1",
    '"What Clotr stores" → What Clotr can reach: the live no-network policy, a reason for every permission, the AI-site count',
    async () => {
      const page = await openExtPage(ctx, "stored.html");
      try {
        await sleep(300);
        const got = await page.evaluate(() => ({
          policy: document.getElementById("policy")?.textContent || "",
          perms: [...document.querySelectorAll("#permissions [data-permission]")].map((n) => ({
            id: n.dataset.permission,
            why: n.nextElementSibling?.textContent || "",
          })),
          text: document.getElementById("reach")?.innerText || "",
        }));
        const m = await page.evaluate(() => chrome.runtime.getManifest());
        await shot(page, "reach.png");
        expect(
          got.policy === m.content_security_policy.extension_pages && got.policy.includes("connect-src 'self'"),
          `policy: ${got.policy}`,
        );
        const want = [...m.permissions, "AI sites", "Sites you add"];
        expect(
          want.every((p) => got.perms.some((g) => g.id === p && g.why.length > 20)),
          `permissions: ${JSON.stringify(got.perms)}`,
        );
        expect(
          got.text.includes(`${m.host_permissions.length} AI chat sites`),
          `site count: ${got.text.slice(0, 300)}`,
        );
        expect(/SHA256SUMS/.test(got.text), "no rebuild-and-compare instructions");
      } finally {
        await page.close();
      }
    },
  );

  // ----- First-time tips and "Why am I seeing this?" (D21, D43) -----
  await check(
    "GD1",
    'First time a kind of data shows up, the notice asks how to treat it; "Just count it" sets Log only; shown once',
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await store.set(ctx, { guided: {} });
        await typeText(page, "call me at 937-555-0123");
        const n = await waitForNotice(page);
        expect(n?.text.includes("How should Clotr treat a Phone Number from now on?"), `notice: ${n?.text}`);
        await typeText(page, " soon"); // the notice is rebuilt as you type: the tip stays
        await sleep(DIALOG_WAIT);
        expect((await readNotice(page))?.text.includes("How should Clotr treat"), "the tip vanished while typing");
        await shot(page, "notice-first-time.png");
        await clickDialogButton(page, "Just count it", readNotice);
        const after = await waitFor(async () => await store.get(ctx, ["responses", "guided"]), 2000);
        expect(
          after.responses?.phone_number === "log" && after.guided?.phone_number,
          `stored: ${JSON.stringify(after)}`,
        );
        expect((await readNotice(page))?.text.includes("will just count a Phone Number"), "no confirmation");
        await clearEditor(page);
        await typeText(page, "and email ann.lee@example.com");
        const next = await waitForNotice(page);
        expect(next?.text.includes("How should Clotr treat an Email Address"), `second kind: ${next?.text}`);
        await clickDialogButton(page, "Leave it in", readNotice);
        await clearEditor(page);
        await typeText(page, "again ann.lee@example.com");
        const again = await waitForNotice(page);
        expect(again && !again.text.includes("How should Clotr treat"), `tip showed twice: ${again?.text}`);
      }),
  );

  await check("GD2", 'First-time tip: "It\'s fine to share" saves this phone as OK to share (fingerprint only)', () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      await store.set(ctx, { guided: {} });
      await typeText(page, "call me at 937-555-0199");
      expect(await waitForNotice(page), "no notice");
      await clickDialogButton(page, "It's fine to share", readNotice);
      const vault = await waitFor(
        async () =>
          ((await store.get(ctx, "vault")).vault || []).length ? (await store.get(ctx, "vault")).vault : null,
        2000,
      );
      expect(
        vault?.length === 1 &&
          vault[0].mode === "allow" &&
          vault[0].type === "phone_number" &&
          /^[0-9a-f]{16}$/.test(vault[0].fp),
        `vault: ${JSON.stringify(vault)}`,
      );
    }),
  );

  await check(
    "GD3",
    '"Why am I seeing this?" explains in plain words; Settings → Show first-time tips again',
    async () => {
      await withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await typeText(page, "call me at 937-555-0123");
        expect(await waitForNotice(page), "no notice");
        await clickDialogButton(page, "Why am I seeing this?", readNotice);
        const n = await readNotice(page);
        expect(n.text.includes("Nothing has left your computer yet"), `why: ${n.text}`);
      });
      const popup = await openPopup(ctx);
      await popup.click("#tab-settings");
      await popup.click("#tips-again");
      await sleep(300);
      await popup.close();
      const { guided } = await store.get(ctx, "guided");
      expect(!guided, `tips not reset: ${JSON.stringify(guided)}`);
    },
  );

  await check(
    "GD4",
    '"Why am I seeing this?" for a password, code or card adds that real support never asks for it (not for a phone number)',
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await typeText(page, "the AnyDesk code is 123 456 789");
        expect(await waitForNotice(page), "no notice");
        await clickDialogButton(page, "Why am I seeing this?", readNotice);
        const n = await readNotice(page);
        expect(/support line will ever ask/.test(n.text), `why: ${n.text}`);
        await withSite(ctx, "chatgpt", async (other) => {
          await typeText(other, "call me at 937-555-0123");
          expect(await waitForNotice(other), "no notice");
          await clickDialogButton(other, "Why am I seeing this?", readNotice);
          const p = await readNotice(other);
          expect(!/support line will ever ask/.test(p.text), `phone why mentions scams: ${p.text}`);
        });
      }),
  );

  await check(
    "RPT1",
    '"Report a false alarm" opens a prefilled issue with only the kind of data (never the value or the site)',
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await typeText(page, "call me at 937-555-0123");
        expect(await waitForNotice(page), "no notice");
        await evalInClotr(
          page,
          "globalThis.__opened = []; window.open = (u) => { globalThis.__opened.push(u); return null; }, true",
        );
        await clickDialogButton(page, "Why am I seeing this?", readNotice);
        await clickDialogButton(page, "Wrong? Report a false alarm", readNotice);
        const [url] = await evalInClotr(page, "globalThis.__opened");
        expect(
          url?.startsWith("https://github.com/BilliamBaSH/clotr-ai-privacy-guard/issues/new?template=false-alarm.yml"),
          `url: ${url}`,
        );
        const decoded = decodeURIComponent(url || "");
        expect(decoded.includes("False alarm: Phone Number"), `title: ${decoded}`);
        expect(!/555|0123|chatgpt/.test(decoded), `the report carries the value or the site: ${decoded}`);
      }),
  );

  // ----- Accessibility (M4): axe-core on every Clotr page, light and dark -----
  await check(
    "A11Y1",
    "No serious accessibility problems (axe-core) in the popup tabs and the welcome/vault page, light and dark",
    async () => {
      const AXE = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8"); // evaluated through DevTools: extension pages' CSP blocks script tags
      await store.set(ctx, { events: seedEvents() });
      const problems = [];
      const audit = async (page, where) => {
        for (const theme of ["light", "dark"]) {
          await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
          await sleep(150);
          if (!(await page.evaluate(() => typeof axe === "object"))) await page.evaluate(AXE);
          const found = await page.evaluate(async () =>
            (await axe.run(document, { resultTypes: ["violations"] })).violations
              .filter((v) => v.impact === "serious" || v.impact === "critical")
              .map(
                (v) =>
                  `${v.id} (${v.nodes.length}): ${v.nodes
                    .slice(0, 2)
                    .map((n) => n.target.join(" "))
                    .join(", ")}`,
              ),
          );
          problems.push(...found.map((f) => `${where}, ${theme}: ${f}`));
        }
      };
      const popup = await openPopup(ctx);
      try {
        for (const tab of ["overview", "activity", "settings"]) {
          await popup.click(`#tab-${tab}`);
          await sleep(200);
          await audit(popup, `popup ${tab}`);
        }
      } finally {
        await popup.close();
      }
      for (const file of ["vault.html?welcome=1", "vault.html", "stored.html", "dashboard.html"]) {
        const page = await openExtPage(ctx, file);
        try {
          await audit(page, file);
        } finally {
          await page.close();
        }
      }
      await store.set(ctx, { events: [] });
      expect(!problems.length, problems.slice(0, 8).join(" | "));
    },
  );

  await check("KB1", "Keyboard: Alt+Shift+C jumps to the warning, Enter removes, Esc goes back to the message", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      const shortcut = () =>
        ctx.worker.evaluate(async () => {
          const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          handleCommand("focus-notice", tab); // what the browser calls for the shortcut
        });
      const focused = () => page.evaluate(() => document.activeElement?.tagName);
      await typeText(page, "call me at 937-555-0123");
      expect(await waitForNotice(page), "no notice");
      await shortcut();
      await sleep(200);
      expect((await focused()) === "CLOTR-NOTICE", `focus is on ${await focused()}`);
      await page.keyboard.press("Escape");
      expect((await focused()) === "TEXTAREA", `Esc left focus on ${await focused()}`);
      await shortcut();
      await sleep(200);
      await page.keyboard.press("Enter");
      await sleep(300);
      const text = await editorText(page);
      expect(text.includes("[REDACTED PHONE NUMBER]"), `Enter didn't remove it: "${text}"`);
      const manifest = await ctx.worker.evaluate(
        () => chrome.runtime.getManifest().commands?.["focus-notice"]?.suggested_key?.default,
      );
      expect(manifest === "Alt+Shift+C", `shortcut: ${manifest}`);
    }),
  );

  // ----- Fail open (D30): a broken Clotr never holds or loses a message -----
  await check("FO1", "If detection itself breaks, Enter and the send button still send", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx); // the user chose Block for keys
      const before = ctx.problems.length;
      await evalInClotr(
        page,
        `globalThis.Clotr.PATTERNS.push({ id: "test_boom", name: "Boom", severity: "high",
        find() { throw new Error("test: detection broke"); } }), true`,
      );
      await typeText(page, `key ${KEY}`);
      await expectNoDialog(page, "detection was broken");
      await pressEnter(page);
      await sleep(300);
      expect((await sentMessages(page)).length === 1, "Enter didn't send");
      await typeText(page, `again ${KEY2}`);
      await clickSend(page);
      await sleep(300);
      expect((await sentMessages(page)).length === 2, "the send button didn't send");
      expect(
        page.logs.some((l) => l.includes("handler error")),
        "the failure wasn't logged",
      );
      ctx.problems.length = before; // these errors were caused on purpose
    }),
  );

  await check(
    "FO2",
    "Orphaned Clotr (left behind by an update reload): its dialog still closes; it keeps warning but never holds a message",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx); // the user chose Block for keys
        const before = ctx.problems.length;
        await typeText(page, `key ${KEY}`);
        const dialog = await waitForDialog(page);
        expect(dialog, "no dialog");
        await evalInClotr(page, ORPHAN_CLOTR);
        await clickDialogButton(page, "More choices"); // "stop warning me" needs storage, which is gone
        await clickDialogButton(page, "Leave it in, and stop warning me about: AWS Access Key");
        expect(!(await readDialog(page)), "the dialog couldn't be closed");
        // Keys are now Log only (the tick above, kept in memory); a new key would stay quiet.
        await typeText(page, " call me at 937-555-0123");
        await sleep(DIALOG_WAIT);
        expect(!(await readDialog(page)), "an orphaned Clotr opened a dialog (it must only warn)");
        const notice = await readNotice(page);
        expect(
          notice?.text.includes("Phone Number") && notice.text.includes("Reload this page"),
          `notice: ${notice?.text}`,
        );
        await pressEnter(page);
        await sleep(300);
        expect((await sentMessages(page)).length === 1, "an orphaned Clotr held the message");
        expect(!page.logs.some((l) => l.includes("could not record")), "tried to record while orphaned");
        ctx.problems.length = before;
      }),
  );

  await check("FO4", "Orphaned Clotr turns Block into a warning: notice with the reload hint, Enter sends", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx); // Block for keys
      const before = ctx.problems.length;
      await evalInClotr(page, ORPHAN_CLOTR);
      await typeText(page, `key ${KEY}`);
      const notice = await waitForNotice(page);
      expect(!(await readDialog(page)), "an orphaned Clotr opened a dialog");
      expect(
        notice?.text.includes("AWS Access Key") && notice.text.includes("Reload this page"),
        `notice: ${notice?.text}`,
      );
      expect(await waitFor(() => readReloadPrompt(page), DIALOG_WAIT), "no reload prompt");
      await clickDialogButton(page, "Later", readReloadPrompt);
      await clickDialogButton(page, "Hide it", readNotice);
      const text = await editorText(page);
      expect(text.includes("[REDACTED AWS ACCESS KEY]"), `Redact didn't work while orphaned: "${text}"`);
      await pressEnter(page);
      await sleep(300);
      expect((await sentMessages(page)).length === 1, "didn't send");
      ctx.problems.length = before;
    }),
  );

  await check(
    "FO5",
    "Orphaned and not replaced: a greyed-out prompt asks to reload; Later/Esc goes back, Enter reloads (D37)",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        const before = ctx.problems.length;
        await evalInClotr(page, ORPHAN_CLOTR);
        await typeText(page, "call me at 937-555-0123");
        const prompt = await waitFor(() => readReloadPrompt(page), DIALOG_WAIT);
        expect(prompt?.text.includes("Clotr was updated"), `prompt: ${prompt?.text}`);
        expect(
          prompt.buttons.map((b) => b.text).join("/") === "Later/Copy my message and reload",
          `buttons: ${prompt.buttons.map((b) => b.text)}`,
        );
        await page.screenshot({ path: path.join(OUT, "reload-prompt.png") });
        await page.keyboard.press("Escape");
        await sleep(200);
        expect(!(await readReloadPrompt(page)), "Esc didn't close the prompt");
        expect((await readNotice(page))?.text.includes("Reload this page"), "the old copy stopped warning after Later");
        await typeText(page, " and 937-555-0199");
        await sleep(DIALOG_WAIT);
        expect(!(await readReloadPrompt(page)), "asked again after Later");
        await pressEnter(page);
        await sleep(300);
        expect((await sentMessages(page)).length === 1, "the prompt held the message");
        ctx.problems.length = before;
      })
        .then(() =>
          withSite(ctx, "chatgpt", async (page) => {
            const before = ctx.problems.length;
            await evalInClotr(page, ORPHAN_CLOTR);
            await typeText(page, "call me at 937-555-0123");
            expect(await waitFor(() => readReloadPrompt(page), DIALOG_WAIT), "no prompt");
            await page.keyboard.press("Enter"); // too soon after it appeared: a habit press does nothing
            await sleep(100);
            expect(await readReloadPrompt(page), "an Enter right after the prompt appeared chose for the user");
            await sleep(700);
            const reloaded = page.waitForNavigation({ timeout: 5000 }).then(
              () => true,
              () => false,
            );
            await page.keyboard.press("Enter");
            expect(await reloaded, "Enter didn't reload the page");
            ctx.problems.length = before;
          }),
        )
        .then(() =>
          withSite(ctx, "chatgpt", async (page) => {
            // If the message can't be copied, Clotr doesn't reload: the user's text is never lost.
            const before = ctx.problems.length;
            await evalInClotr(page, ORPHAN_CLOTR);
            await evalInClotr(page, `navigator.clipboard.writeText = () => Promise.reject(new Error("denied")), true`);
            await typeText(page, "call me at 937-555-0123");
            expect(await waitFor(() => readReloadPrompt(page), DIALOG_WAIT), "no prompt");
            let navigated = false;
            page.once("framenavigated", () => {
              navigated = true;
            });
            await clickDialogButton(page, "Copy my message and reload", readReloadPrompt);
            await sleep(500);
            const prompt = await readReloadPrompt(page);
            expect(
              !navigated && prompt?.text.includes("couldn't copy"),
              `navigated: ${navigated}, prompt: ${prompt?.text}`,
            );
            expect(
              prompt.buttons.some((b) => b.text === "Reload anyway"),
              "no Reload anyway",
            );
            ctx.problems.length = before;
          }),
        ),
  );

  await check("FO3", "A dialog open when the update lands: Enter closes it and sends", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx);
      const before = ctx.problems.length;
      await typeText(page, `key ${KEY}`);
      expect(await waitForDialog(page), "no dialog");
      await evalInClotr(page, ORPHAN_CLOTR);
      await pressEnter(page);
      await sleep(300);
      expect((await sentMessages(page)).length === 1, "an orphaned dialog held the message");
      expect(!(await readDialog(page)), "the orphaned dialog stayed open");
      ctx.problems.length = before;
    }),
  );

  // ----- Performance (M3) -----
  await check("PERF1", "Enter responds fast after a big paste (40k characters of spelled-out numbers)", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {}); // defaults: a warning, so Enter sends
      await typeText(page, "one two three four five six seven eight nine ten ".repeat(800) + " call 937-555-0123");
      expect(await waitFor(() => readNotice(page), 8000), "no notice");
      const t0 = Date.now();
      await pressEnter(page);
      const sent = await waitFor(async () => (await sentMessages(page)).length === 1, 8000, 20);
      const ms = Date.now() - t0;
      expect(sent, "the message didn't send");
      expect(ms < 1000, `Enter took ${ms} ms to send`);
    }),
  );

  await check("MEM1", "Memory stays steady: 200 more messages barely grow the page's heap", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      page.cdp ??= await page.createCDPSession();
      const heap = async () => {
        await page.cdp.send("HeapProfiler.collectGarbage");
        return (await page.metrics()).JSHeapUsedSize;
      };
      const send = async (i) => {
        await typeText(
          page,
          `message ${i}: call 937-555-${1000 + i} or mail p${i}@example.com, key AKIA${String(i).padStart(4, "0")}HPQ7XZ2R6TWL`,
        );
        await pressEnter(page);
      };
      for (let i = 0; i < 30; i++) await send(i); // warm up
      const before = await heap();
      for (let i = 30; i < 230; i++) await send(i);
      await sleep(500);
      const grew = (await heap()) - before;
      expect((await sentMessages(page)).length === 230, `sent ${(await sentMessages(page)).length} of 230`);
      expect(grew < 3 * 1024 * 1024, `heap grew ${(grew / 1024 / 1024).toFixed(1)} MB over 200 messages`);
    }),
  );

  // ----- Stress (only with --stress: npm run test:stress; slow, run before releases) -----
  if (argv.includes("--stress")) {
    await check(
      "STS1",
      "Stress: a 2 MB paste with a key buried in the middle is caught, and the page stays responsive",
      () =>
        withSite(ctx, "chatgpt", async (page) => {
          await resetState(ctx, {});
          const filler = "The quarterly numbers look fine and nothing here is private at all. ".repeat(15000); // ~1 MB
          const text = `${filler}my key ${KEY} ${filler}`;
          const t0 = Date.now();
          await typeText(page, text);
          const notice = await waitFor(() => readNotice(page), 15000);
          const caughtMs = Date.now() - t0;
          expect(notice && /AWS Access Key/.test(notice.text), `not caught (${caughtMs} ms)`);
          const t1 = Date.now();
          await page.evaluate(() => 1 + 1);
          const pingMs = Date.now() - t1;
          expect(pingMs < 1000, `page unresponsive: ${pingMs} ms to answer`);
          return `${(text.length / 1e6).toFixed(1)} MB caught in ${caughtMs} ms; page answered in ${pingMs} ms`;
        }),
    );

    await check("STS2", "Stress: 12 chat tabs hiding a key at once lose no history records", async () => {
      await resetState(ctx, {});
      const pages = [];
      for (let i = 0; i < 12; i++) pages.push(await openSite(ctx, "chatgpt"));
      try {
        await Promise.all(
          pages.map(async (page, i) => {
            await typeText(page, `tab ${i} key AKIA${String(i).padStart(4, "0")}HPQ7XZ2R6TWL`);
            const n = await waitFor(() => readNotice(page), 8000);
            expect(n, `tab ${i}: no notice`);
          }),
        );
        await Promise.all(pages.map((page) => clickDialogButton(page, "Hide it", readNotice)));
        const events =
          (await waitFor(async () => {
            const ev = await store.events(ctx);
            return ev.length >= 12 ? ev : null;
          }, 8000)) || (await store.events(ctx));
        expect(
          events.length === 12 && events.every((e) => e.action === "redacted"),
          `records: ${events.length} (${[...new Set(events.map((e) => e.action))]})`,
        );
      } finally {
        for (const p of pages) await p.close();
        await store.set(ctx, { events: [] });
      }
    });

    await check(
      "STS3",
      "Stress: history at its 10,000-record cap: popup and full report open fast, new records still append",
      async () => {
        const now = Date.now();
        const many = Array.from({ length: 10000 }, (_, i) => ({
          t: now - (10000 - i) * 60000,
          site: ["chatgpt.com", "claude.ai", "gemini.google.com"][i % 3],
          type: "email",
          name: "Email Address",
          severity: "low",
          action: ["allowed", "redacted", "suppressed"][i % 3],
          fp: (i % 4096).toString(16).padStart(16, "0"),
        }));
        await store.set(ctx, { events: many });
        try {
          let t0 = Date.now();
          const popup = await openPopup(ctx);
          await popup.waitForSelector("#hero-value");
          const popupMs = Date.now() - t0;
          await popup.close();
          t0 = Date.now();
          const dash = await openExtPage(ctx, "dashboard.html");
          await dash.waitForFunction(() => document.querySelectorAll("#map [data-service]").length > 0, {
            timeout: 10000,
          });
          const dashMs = Date.now() - t0;
          await dash.close();
          await ctx.worker.evaluate(() =>
            enqueue(() =>
              appendEvents([
                {
                  t: Date.now(),
                  site: "chatgpt.com",
                  type: "email",
                  name: "Email Address",
                  severity: "low",
                  action: "allowed",
                  fp: "ffffffffffffffff",
                },
              ]),
            ),
          );
          const after = await store.events(ctx);
          expect(
            after.length === 10000 && after.at(-1).fp === "ffffffffffffffff",
            `after append: ${after.length} records, newest ${after.at(-1)?.fp}`,
          );
          expect(popupMs < 3000 && dashMs < 4000, `popup ${popupMs} ms, full report ${dashMs} ms`);
          return `popup ${popupMs} ms, full report ${dashMs} ms`;
        } finally {
          await store.set(ctx, { events: [] });
        }
      },
    );

    await check(
      "STS4",
      "Stress: 300 single keystrokes: no errors, the scan waits for the pause, the warning appears once",
      () =>
        withSite(ctx, "chatgpt", async (page) => {
          await resetState(ctx, {});
          await page.evaluate(`${page.site.editor}.focus()`);
          const text = `my key ${KEY} `.repeat(12).slice(0, 300);
          TYPED_VALUES.add(text);
          await page.keyboard.type(text, { delay: 5 });
          const n = await waitFor(() => readNotice(page), 5000);
          expect(n && /AWS Access Key/.test(n.text), "no warning after typing");
          const warnings = page.logs.filter((l) => l.includes("[Clotr] warning about")).length;
          expect(warnings <= 3, `the scan ran ${warnings} times while typing (debounce broken)`);
          return `${warnings} scan(s) for 300 keystrokes`;
        }),
    );

    await check("STS5", "Stress: a vault with 1,000 entries keeps checks fast", () =>
      withSite(ctx, "chatgpt", async (page) => {
        const vault = Array.from({ length: 1000 }, (_, i) => ({
          kind: "word",
          type: "watch_list",
          fp: i.toString(16).padStart(16, "0"),
          words: 1 + (i % 4),
          mode: "protect",
          added: Date.now(),
        }));
        await store.set(ctx, { events: [], responses: {}, vault, guided: ALL_GUIDED });
        try {
          const t0 = Date.now();
          await typeText(page, `a normal message about the weather and my key ${KEY}`);
          const n = await waitFor(() => readNotice(page), 5000);
          const ms = Date.now() - t0;
          expect(n, "no warning");
          expect(ms < 3000, `${ms} ms to warn with 1,000 vault entries`);
          return `${ms} ms to warn`;
        } finally {
          await store.set(ctx, { vault: [] });
        }
      }),
    );
    await check(
      "STS6",
      "Stress: 60 attached files at once (text, Word, spreadsheets): one notice, the first 50 checked, the chat stays responsive",
      () =>
        withSite(ctx, "chatgpt", async (page) => {
          await resetState(ctx, {});
          const dir = path.join(OUT, "sts6");
          fs.mkdirSync(dir, { recursive: true });
          const files = [];
          const filler = "Agenda item and minutes, nothing private here. ".repeat(4000); // ~190 KB each
          for (let i = 0; i < 60; i++) {
            const risky = i % 10 === 3 ? `mail p${i}@gmail.com` : "";
            if (risky) TYPED_VALUES.add(risky);
            const kind = i % 3;
            const file = path.join(dir, `doc${i}.${["txt", "docx", "xlsx"][kind]}`);
            if (kind === 0) fs.writeFileSync(file, `${filler}\n${risky}\n`);
            else if (kind === 1) makeZip(file, [["word/document.xml", docxXml([filler, risky])]]);
            else
              makeZip(file, [["xl/sharedStrings.xml", `<sst><si><t>${filler}</t></si><si><t>${risky}</t></si></sst>`]]);
            files.push(file);
          }
          const t0 = Date.now();
          await (await page.$("#attach")).uploadFile(...files);
          const notice = await waitFor(async () => {
            const n = await readNotice(page);
            return n && /files you attached/.test(n.text) ? n : null;
          }, 20000);
          const ms = Date.now() - t0;
          const t1 = Date.now();
          await page.evaluate(() => 1 + 1);
          const pingMs = Date.now() - t1;
          fs.rmSync(dir, { recursive: true });
          // Files 3, 13, 23, 33, 43 are within the first 50; 53 isn't checked (MAX_FILES).
          expect(
            notice && /5 files you attached/.test(notice.text) && /and 2 more/.test(notice.text),
            `notice: ${notice?.text}`,
          );
          expect(
            page.logs.some((l) => l.includes("checking the first 50 of 60")),
            "no log about the 50-file cap",
          );
          expect(pingMs < 1000, `page unresponsive: ${pingMs} ms`);
          return `60 files (~11 MB) checked in ${ms} ms; page answered in ${pingMs} ms`;
        }),
    );

    await check(
      "STS7",
      "Stress: a day-long tab (500 warned messages, AI replies after each): heap steady, one notice at a time, every record kept",
      () =>
        withSite(ctx, "chatgpt", async (page) => {
          await resetState(ctx, {});
          page.cdp ??= await page.createCDPSession();
          const heap = async () => {
            await page.cdp.send("HeapProfiler.collectGarbage");
            return (await page.metrics()).JSHeapUsedSize;
          };
          const round = async (i) => {
            await typeText(page, `note ${i}: reach me at 937-555-${String(1000 + i).slice(-4)}`);
            await waitFor(() => readNotice(page), 3000);
            await pressEnter(page);
            await page.evaluate((n) => window.__reply(`Sure, here is a long answer number ${n}. `.repeat(20)), i);
          };
          for (let i = 0; i < 50; i++) await round(i); // warm up
          const before = await heap();
          for (let i = 50; i < 500; i++) await round(i);
          await sleep(500);
          const grew = (await heap()) - before;
          const hosts = await page.evaluate(() => document.querySelectorAll("clotr-notice, clotr-guard").length);
          const sent = (await sentMessages(page)).length;
          const events =
            (await waitFor(async () => {
              const ev = await store.events(ctx);
              return ev.length >= 500 ? ev : null;
            }, 8000)) || (await store.events(ctx));
          const errors = page.logs.filter((l) => /\[Clotr\].*(error|failed)/i.test(l));
          expect(sent === 500, `sent ${sent} of 500`);
          expect(events.length === 500, `records: ${events.length} of 500`);
          expect(hosts <= 1, `${hosts} Clotr elements left in the page`);
          expect(grew < 5 * 1024 * 1024, `heap grew ${(grew / 1024 / 1024).toFixed(1)} MB over 450 messages`);
          expect(!errors.length, `errors: ${errors.slice(0, 3).join(" | ")}`);
          return `heap +${(grew / 1024 / 1024).toFixed(2)} MB over 450 messages`;
        }),
    );
  }

  // ----- Store / README screenshots (only with --store): 1280×800, neutral demo chat, fake data -----
  if (argv.includes("--store"))
    await check(
      "SS1",
      "Store screenshots: warning, hidden, ask-before-sending, dashboard, welcome (docs/store/)",
      async () => {
        const dir = path.join(ROOT, "docs", "store");
        fs.mkdirSync(dir, { recursive: true });
        const W = { width: 1280, height: 800 };
        const frame = async (name, caption, sub, pngBase64, imgWidth) => {
          const page = await ctx.browser.newPage();
          await page.setViewport(W);
          await page.setContent(`<!doctype html><html><body style="margin:0;width:1280px;height:800px;display:flex;align-items:center;gap:56px;padding:0 72px;box-sizing:border-box;background:linear-gradient(135deg,#eef2ff,#e8f7f3);font-family:system-ui,'Segoe UI',sans-serif;color:#1d2330">
        <div style="flex:1"><div style="font-size:44px;font-weight:700;line-height:1.15">${caption}</div><div style="font-size:21px;margin-top:18px;color:#4a5160;line-height:1.5">${sub}</div></div>
        <img src="data:image/png;base64,${pngBase64}" style="width:${imgWidth}px;border-radius:14px;box-shadow:0 18px 50px rgba(20,30,60,.22)"></body></html>`);
          await page.screenshot({ path: path.join(dir, name) });
          await page.close();
        };
        await withSite(ctx, "demo", async (page) => {
          await page.setViewport(W);
          await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
          await resetState(ctx, {});
          await typeText(
            page,
            "The heater has been broken since Monday. You can reach me at 937-555-0123 or jane.doe@gmail.com. My unit is at 123 Oak Street, Springfield.",
          );
          expect(await waitForNotice(page), "no notice");
          await sleep(300);
          await page.screenshot({ path: path.join(dir, "1-warning.png") });
          await clickDialogButton(page, "Hide it", readNotice);
          await sleep(300);
          await page.screenshot({ path: path.join(dir, "2-covered.png") });
        });
        await withSite(ctx, "demo", async (page) => {
          await page.setViewport(W);
          await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
          await resetState(ctx); // Ask before sending for keys
          await typeText(page, `Why does my deploy fail? aws configure: ${KEY}`);
          expect(await waitForDialog(page), "no dialog");
          await sleep(300);
          await page.screenshot({ path: path.join(dir, "3-ask-before-sending.png") });
        });
        await store.set(ctx, { events: seedEvents() });
        const popup = await openPopup(ctx);
        await popup.setViewport({ width: 380, height: 720 });
        await popup.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
        await sleep(300);
        const dash = await popup.screenshot({ encoding: "base64" });
        await popup.close();
        await frame(
          "4-dashboard.png",
          "See what you almost shared",
          "What Clotr caught, on which AI tool, and what you chose. Counted on your computer; it never keeps what you typed.",
          dash,
          340,
        );
        const welcome = await openExtPage(ctx, "vault.html?welcome=1");
        await welcome.setViewport({ width: 700, height: 800 });
        await welcome.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
        await welcome.type("#try", `my key ${KEY}`);
        await sleep(600);
        const wel = await welcome.screenshot({ encoding: "base64" });
        await welcome.close();
        await frame(
          "5-welcome.png",
          "Try it in ten seconds",
          "A practice box on the welcome page shows exactly what a warning looks like. Nothing leaves your computer.",
          wel,
          560,
        );
        await store.set(ctx, { events: [] });
      },
    );

  await check("Z2", "No Clotr errors or warnings in any console", async () => {
    expect(!ctx.problems.length, ctx.problems.slice(0, 5).join(" | "));
  });

  await ctx.browser.close();
  fs.rmSync(ctx.profile, { recursive: true, force: true });
  writeReport(ctx);
}

function writeReport(ctx) {
  const failed = results.filter((r) => !r.ok);
  const skipped = results.filter((r) => r.skipped).length;
  const skipNote = skipped ? ` (${skipped} skipped: see notes)` : "";
  const lines = [
    `# Clotr end-to-end run`,
    ``,
    `- When: ${new Date().toLocaleString()}`,
    `- Browser: ${BROWSER} (${ctx.version}, ${HEADED ? "headed" : "headless"})`,
    `- Result: **${results.length - failed.length}/${results.length} passed**${skipNote}`,
    ``,
    `| ID | Check | Result | Seconds | Notes |`,
    `|----|-------|--------|---------|-------|`,
    ...results.map(
      (r) =>
        `| ${r.id} | ${r.title} | ${r.skipped ? "SKIP" : r.ok ? "PASS" : "**FAIL**"} | ${r.secs} | ${r.note.replace(/\|/g, "\\|")} |`,
    ),
    ``,
    `Screenshots: ${fs
      .readdirSync(OUT)
      .filter((f) => f.endsWith(".png"))
      .join(", ")}`,
  ];
  fs.writeFileSync(path.join(OUT, "report.md"), lines.join("\n") + "\n");
  console.log(
    `\n${results.length - failed.length}/${results.length} passed${skipNote}. Report: ${path.relative(ROOT, path.join(OUT, "report.md"))}`,
  );
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err) => {
  console.error("\nE2E run crashed:", err);
  process.exitCode = 2;
});
