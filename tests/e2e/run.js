// End-to-end tests: drives a real browser (Brave by default) with Clotr loaded,
// the way a user would: typing into AI chats, clicking the dialog, opening the popup.
// Helpers are in ./lib.js; the checks are in ./checks, one file per area, run in order.
//
//   npm run test:e2e                     headless run, report in tests/e2e/output/
//   npm run test:e2e -- --headed         watch it happen
//   npm run test:e2e -- --only A2,F      run selected checks (ID prefixes)
//   npm run test:e2e -- --part 1/3       the first third of the sections (then 2/3, 3/3)
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
const path = require("path");
const lib = require("./lib.js");

const { OUT, ONLY, BROWSER, HEADED, launch, check, expect, writeReport } = lib;
const SECTIONS = [
  "01-protection", // A. Protection basics
  "02-toolbar", // B. Toolbar
  "03-popup-dashboard", // C. Dashboard
  "04-scope", // D. Scope & discovery
  "05-chat-styles", // E. Other chat styles
  "06-disguised-details", // F. Personal info in disguise
  "07-responses", // R. Responses
  "08-vault", // V. Your vault ("What should I protect?")
  "09-updates", // U. Updates
  "10-privacy-health", // Z. Privacy & health
  "11-report-and-map", // Full-page dashboard: "Your AI exposure report" (v1.0)
  "12-first-time-tips", // First-time tips and "Why am I seeing this?" (D21, D43)
  "13-accessibility", // Accessibility (M4): axe-core on every Clotr page, light and dark
  "14-fail-open", // Fail open (D30): a broken Clotr never holds or loses a message
  "15-performance", // Performance (M3)
  "18-bandage", // BN. Bandage: cover names while you type (D93)
  "19-report-button", // RB. "Report a problem" on every Clotr page (#178)
  "16-stress", // Stress (only with --stress: npm run test:stress; slow, run before releases)
  "17-store-screenshots", // Store / README screenshots (only with --store): 1280×800, neutral demo chat, fake data
];

// --part k/n: the k-th of n slices of the sections, each short enough for a runner that stops any one command
// after 10 minutes.
const PART = (() => {
  const i = process.argv.indexOf("--part");
  const m = /^(\d+)\/(\d+)$/.exec(i > 0 ? process.argv[i + 1] || "" : "");
  return m && +m[1] >= 1 && +m[1] <= +m[2] ? { k: +m[1], n: +m[2] } : { k: 1, n: 1 };
})();
const RUN_SECTIONS = SECTIONS.filter((_, i) => Math.floor((i * PART.n) / SECTIONS.length) === PART.k - 1);

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  // A full run starts from no screenshots, so one no check takes any more can't be mistaken for today's UI.
  if (!ONLY.length && PART.k === 1)
    for (const f of fs.readdirSync(OUT)) if (f.endsWith(".png")) fs.rmSync(path.join(OUT, f));
  console.log(`Clotr end-to-end tests\n  browser: ${BROWSER}`);
  const ctx = await launch();
  console.log(`  engine:  ${ctx.version}${HEADED ? " (headed)" : " (headless)"}\n`);

  // Every section gets the same env: the helpers, the browser, and what earlier sections share.
  const env = { ...lib, ctx };
  try {
    for (const name of RUN_SECTIONS) await require(`./checks/${name}.js`)(env);

    await check("Z2", "No Clotr errors or warnings in any console", async () => {
      expect(!ctx.problems.length, ctx.problems.slice(0, 5).join(" | "));
    });
  } finally {
    // Whatever happens, the browser closes: an open one keeps the run alive (a crash once hung it for 10 minutes).
    await ctx.browser.close().catch(() => {});
    fs.rmSync(ctx.profile, { recursive: true, force: true });
  }
  writeReport(ctx);
}

main().catch((err) => {
  console.error("\nE2E run crashed:", err);
  process.exit(2); // end now: a leftover handle must never keep a crashed run waiting
});
