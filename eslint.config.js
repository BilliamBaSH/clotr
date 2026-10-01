// Lint (npm run lint): catches mistakes such as undefined names and unused code. Formatting is
// Prettier's job (npm run format); the project's hard rules are checked in tests/rules.test.js.
"use strict";
const js = require("@eslint/js");
const globals = require("globals");

// Names the browser suites use inside pages and the extension's background worker (page.evaluate,
// worker.evaluate): they exist there, not in Node.
const insideExtension = Object.fromEntries(
  [
    "appendEvents",
    "axe",
    "checkForLocalUpdate",
    "cleanVaultEntry",
    "ClotrSites",
    "enqueue",
    "ensureSalt",
    "handleCommand",
    "migrateOffToLog",
    "migrateSuppressed",
    "migrateToVault",
    "runMigrations",
    "settingsFor",
    "syncUserSites",
  ].map((name) => [name, "readonly"]),
);

module.exports = [
  { ignores: ["node_modules/", "dist/", "tests/e2e/output/"] },
  js.configs.recommended,
  {
    rules: {
      // The detector matches control and invisible characters on purpose (D51).
      "no-control-regex": "off",
      // A top-level name in a page script may reuse one the browser also defines.
      "no-redeclare": ["error", { builtinGlobals: false }],
    },
  },
  {
    // The extension: classic scripts that share code through globalThis.Clotr (no import/export).
    files: ["extension/**/*.js", "tests/e2e/pages/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: { ...globals.browser, ...globals.webextensions, ...globals.serviceworker },
    },
  },
  {
    // Tests and dev tools run in Node.
    files: ["tests/**/*.js", "tools/**/*.js", "*.js"],
    ignores: ["tests/e2e/pages/**"],
    languageOptions: { sourceType: "commonjs", globals: { ...globals.node } },
  },
  {
    // …and the browser-driving ones also run code inside pages and the extension.
    files: ["tests/e2e/*.js", "tests/e2e/checks/*.js", "tools/site-check.js", "tools/draft-leak-monitor.js"],
    languageOptions: { globals: { ...globals.browser, ...globals.webextensions, ...insideExtension } },
  },
];
