// End-to-end test helpers (run.js runs the checks in ./checks). The suite drives a real browser (Brave by default) with Clotr loaded,
// the way a user would: typing into AI chats, clicking the dialog, opening the popup.
//
//   npm run test:e2e                     headless run, report in tests/e2e/output/
//   npm run test:e2e -- --headed         watch it happen
//   npm run test:e2e -- --only A2,F      run selected checks (ID prefixes)
//   npm run test:e2e -- --browser "C:/path/to/chrome.exe"
//
// Also runs in Linux containers (cloud sessions, CI): falls back to the
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
const EXT = path.resolve(argValue("--ext") || path.join(ROOT, "extension"));
const HEADED = argv.includes("--headed");
// Quiet: print only failures, skips and the summary (the report still lists every check). The default when the
// output isn't a terminal (a script, an automated session, CI); --verbose prints every check.
const QUIET = argv.includes("--quiet") || (!process.stdout.isTTY && !argv.includes("--verbose"));
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
  copilot: {
    // Microsoft Copilot-style: keeps an invisible marker (U+200B U+200C) at the end of the box (CP1)
    url: "https://copilot.microsoft.com/",
    page: "marker-chat.html",
    editor: `document.querySelector("#m365-chat-editor-target-element")`,
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
  cancelling: {
    // Slate / CKEditor 5 style: cancels beforeinput and edits its own model, so no input events (BI1-BI3)
    url: "https://chat.qwen.ai/",
    page: "beforeinput-chat.html",
    editor: `document.querySelector("#msg")`,
    send: `document.querySelector("#send")`,
  },
  cancellingLexical: {
    // the same, but it learns the selection only from the async selectionchange, like Lexical (BI2)
    url: "https://aistudio.google.com/",
    page: "beforeinput-chat.html",
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
require(path.join(__dirname, "..", "..", "extension", "patterns.js"));
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
    if (["responses", "paused", "vault", "siteModes", "guided", "largeText", "bandage"].some((k) => k in obj))
      await sleep(300);
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
    // Bandage already answered "no" everywhere, so older checks see the plain warning; BN checks set their own.
    bandage: Object.fromEntries(Object.values(SITES).map((s) => [new URL(s.url).hostname, false])),
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
  // Until the background answers, a tab runs on the defaults: typing before that would test the
  // defaults, not the settings the check just stored (V3, EG2, UB1, R4 failed that way under load).
  // Pages where Clotr doesn't run never log it, so this gives up after a while.
  await sleep(300);
  await waitFor(() => page.logs.some((l) => l.startsWith("[Clotr] responses:")), 2700);
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

// Runs axe-core against Clotr's own UI inside a closed shadow root (the corner notice, the hover-to-peek bubble,
// the hotspot layer). axe-core can't discover a closed shadow root on its own (only code holding the exact
// reference `attachShadow()` returned can), so this uses CDP to get that reference, clones its content (style tag
// included) into a plain, connected element in the page's own light DOM, and audits that copy instead — close
// enough for structure and contrast, since Clotr's own shadow styles don't rely on the host page's CSS
// (A11Y for content-script UI, D93 accessibility follow-up). The clone is removed again before returning.
async function auditShadow(page, tag) {
  page.cdp ??= await page.createCDPSession();
  const AXE = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
  const { root } = await page.cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  let shadowRootNode = null;
  (function find(n) {
    if (shadowRootNode) return;
    if (n.nodeName === tag) shadowRootNode = (n.shadowRoots || [])[0];
    for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) find(c);
  })(root);
  if (!shadowRootNode) return null;
  if (!(await page.evaluate(() => typeof axe === "object"))) await page.evaluate(AXE);
  const { object } = await page.cdp.send("DOM.resolveNode", { nodeId: shadowRootNode.nodeId });
  const { result, exceptionDetails } = await page.cdp.send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: `async function() {
      const clone = document.createElement("div");
      for (const child of this.children) clone.appendChild(child.cloneNode(true));
      document.body.appendChild(clone);
      try {
        const r = await axe.run(clone, { resultTypes: ["violations"] });
        return r.violations.filter(v => v.impact === "serious" || v.impact === "critical")
          .map(v => v.id + " (" + v.nodes.length + "): " + v.nodes.slice(0, 2).map(n => n.target.join(" ")).join(", "));
      } finally {
        clone.remove();
      }
    }`,
    awaitPromise: true,
    returnByValue: true,
  });
  expect(!exceptionDetails, `axe on ${tag} failed: ${exceptionDetails?.exception?.description}`);
  return result.value;
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
  await sleep(400); // a new width redraws the mind map (D75), which then moves into place
  await popup.waitForFunction(() => !document.querySelector("svg[data-moving]"), { timeout: 2500 }).catch(() => {});
  await popup.screenshot({ path: path.join(OUT, name) });
}

// ---------- Test runner ----------

const results = [];

// Thrown by a check the current browser can't run under automation. Reported as SKIP with
// the reason (never as PASS), and only for things verified another way.
class Skip extends Error {}

async function check(id, title, fn) {
  if (ONLY.length && !ONLY.some((p) => id.startsWith(p))) return;
  const line = `  ${id.padEnd(4)} ${title} … `;
  if (!QUIET) process.stdout.write(line);
  const started = Date.now();
  const secs = () => ((Date.now() - started) / 1000).toFixed(1); // in the report: where CI minutes go
  try {
    const note = await fn();
    results.push({ id, title, ok: true, note: note || "", secs: secs() });
    if (!QUIET) console.log("PASS" + (note ? `  (${note})` : ""));
  } catch (err) {
    if (err instanceof Skip) {
      results.push({ id, title, ok: true, skipped: true, note: err.message, secs: secs() });
      console.log(`${QUIET ? line : ""}SKIP\n       → ${err.message}`);
      return;
    }
    results.push({ id, title, ok: false, note: err.message.split("\n")[0], secs: secs() });
    console.log(`${QUIET ? line : ""}FAIL\n       → ${err.message.split("\n")[0]}`);
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

module.exports = {
  ALL_GUIDED,
  BROWSER,
  DIALOG_WAIT,
  EXT,
  HEADED,
  HIGH_RISK,
  KEY,
  KEY2,
  ONLY,
  ORPHAN_CLOTR,
  OUT,
  PAGES,
  QUIET_WAIT,
  ROOT,
  SITES,
  Skip,
  TYPED_VALUES,
  USER_BLOCKS_HIGH,
  activeBadge,
  argValue,
  argv,
  auditShadow,
  check,
  chooseResponse,
  clearEditor,
  clickDialogButton,
  clickNode,
  clickSend,
  clotrActive,
  describeConsole,
  editorText,
  evalInClotr,
  expect,
  expectNoDialog,
  expectNoUI,
  findBrowser,
  focusEditor,
  fs,
  launch,
  openExtPage,
  openPopup,
  openSite,
  os,
  path,
  pressEnter,
  puppeteer,
  readDialog,
  readNotice,
  readReloadPrompt,
  readUI,
  resetState,
  results,
  seedEvents,
  sentMessages,
  shot,
  sleep,
  store,
  typeText,
  waitFor,
  waitForDialog,
  waitForNotice,
  withSite,
  writeReport,
};
