// Copies the built-in AI-site list (extension/ai-sites.json, the file people edit)
// into manifest.json's content_scripts matches and host_permissions. Run after editing the list:
//   npm run sites
// `npm test` fails if the two differ (tests/rules.test.js).
"use strict";

const fs = require("fs");
const path = require("path");

const EXT = path.join(__dirname, "..", "extension");
const sites = JSON.parse(fs.readFileSync(path.join(EXT, "ai-sites.json"), "utf8"));
const matches = sites.flatMap((s) => s.matches);

const file = path.join(EXT, "manifest.json");
const text = fs.readFileSync(file, "utf8");
const block = /( *)("matches": \[)[^\]]*\]/;
if (!block.test(text)) throw new Error("content_scripts matches not found in manifest.json");
const list = (indent, open) =>
  `${indent}${open}\n${matches.map((m) => `${indent}  ${JSON.stringify(m)}`).join(",\n")}\n${indent}]`;
let next = text.replace(block, (_, indent, open) => list(indent, open));
// The same sites as host permissions, so an update can start the new version in open
// tabs without a reload (D39).
const hostBlock = /( *)("host_permissions": \[)[^\]]*\]/;
if (!hostBlock.test(next)) throw new Error("host_permissions not found in manifest.json");
next = next.replace(hostBlock, (_, indent, open) => list(indent, open));

fs.writeFileSync(file, next);
console.log(`manifest.json: ${matches.length} matches from ${sites.length} AI tools`);
