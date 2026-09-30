// Prints one section of a big Markdown file, so coding agents read what they need instead of the whole file.
//   npm run -s doc -- NOTES.md "Waiting on you"   the section whose heading contains that text (any case)
//   npm run -s doc -- NOTES.md                    the headings, with line numbers
//   npm run -s doc -- LOG.md D45                  a table row "| D45 |" or an entry "**Q3.**" by its number
"use strict";
const fs = require("fs");

function headings(lines) {
  return lines.flatMap((l, i) => (/^#{1,6} /.test(l) ? [{ i, level: l.match(/^#+/)[0].length, text: l }] : []));
}

// The section under the first heading containing `query`: up to the next heading of the same or a higher level.
function section(text, query) {
  const lines = text.split(/\r?\n/);
  const q = query.toLowerCase();
  // A decision or question number (D45, Q3): its table row or its bold entry.
  if (/^[dq]\d+$/i.test(query)) {
    const hit = lines.filter((l) => new RegExp(`^\\| ${query} \\||^\\*\\*${query}\\.`, "i").test(l));
    if (hit.length) return hit.join("\n");
  }
  const hs = headings(lines);
  const start = hs.find((h) => h.text.toLowerCase().includes(q));
  if (!start) return null;
  const next = hs.find((h) => h.i > start.i && h.level <= start.level);
  return lines
    .slice(start.i, next ? next.i : lines.length)
    .join("\n")
    .trimEnd();
}

if (require.main === module) {
  const [file, ...rest] = process.argv.slice(2);
  if (!file) {
    console.error('usage: node tools/doc-section.js <file.md> ["heading text" | D12 | Q3]');
    process.exit(2);
  }
  const text = fs.readFileSync(file, "utf8");
  if (!rest.length) {
    for (const h of headings(text.split(/\r?\n/))) console.log(`${h.i + 1}: ${h.text}`);
  } else {
    const out = section(text, rest.join(" "));
    if (out === null) {
      console.error(`no heading containing "${rest.join(" ")}" in ${file} (run without a heading to list them)`);
      process.exit(1);
    }
    console.log(out);
  }
}

module.exports = { section, headings };
