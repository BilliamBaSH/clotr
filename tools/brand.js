// Clotr's brand, drawn in code (D80): the mark (a C with a plaster across its mouth), the app tile in its three
// states, and the mind map used on the README header, social card and store art. Shared by make-icons.js and
// make-brand.js; everything renders through a headless browser (renderPng), so no image tools are needed.
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

const COLORS = {
  orange: "#FF6700", // signal orange: the mark and the tile (not for text: 2.9:1 on white)
  orangeText: "#B84A0C", // orange as text on light backgrounds (5:1)
  tileTop: "#FF8A3D",
  tileBottom: "#E85500",
  grayTop: "#8B919C",
  grayBottom: "#5E646E",
  ink: "#0B0B0B",
  ink2: "#534E49",
  // The warm refresh (D135): warm slate lines, warm paper and dots, a peach halo.
  slate: "#9C958E",
  faint: "#D9D1C9",
  paper: "#FBF8F5",
  dot: "#E8E0D8",
  peach: "#FFE8D6",
  white: "#FFFFFF",
};

let uid = 0;
const nextId = (p) => `${p}${uid++}`;

// The mark in a 128-unit box: a C (open to the right, square-cut ends) and a plaster across its mouth.
// A thin gap is cut around the plaster so it never merges into the C.
function mark(o = {}) {
  const {
    c = COLORS.orange,
    plaster = COLORS.ink,
    pad = COLORS.orange,
    key = COLORS.white,
    W = 24,
    R = 38,
    GAP = 54,
    CX = 52,
    CY = 64,
    pw = 20,
    pl = 50,
    px = 84,
    angle = -18,
    showPad = true,
    keyW = 3.5,
    noPlaster = false,
  } = o;
  const pt = (a) =>
    [CX + R * Math.cos((a * Math.PI) / 180), CY + R * Math.sin((a * Math.PI) / 180)].map((n) => +n.toFixed(2));
  const [x1, y1] = pt(GAP),
    [x2, y2] = pt(360 - GAP);
  const cPath = `<path d="M${x1} ${y1} A${R} ${R} 0 1 1 ${x2} ${y2}" fill="none" stroke="${c}" stroke-width="${W}"/>`;
  if (noPlaster) return cPath;
  const strip = (col, g) =>
    `<rect x="${px - pw / 2 - g}" y="${CY - pl / 2 - g}" width="${pw + 2 * g}" height="${pl + 2 * g}" rx="${pw / 2 + g}" fill="${col}"/>`;
  const rot = (inner) => `<g transform="rotate(${angle} ${px} ${CY})">${inner}</g>`;
  const id = nextId("cut");
  const padRect = showPad
    ? `<rect x="${px - pw / 2 + 5}" y="${CY - 8}" width="${pw - 10}" height="16" rx="3" fill="${pad}"/>`
    : "";
  return (
    `<mask id="${id}" maskUnits="userSpaceOnUse" x="-64" y="-64" width="256" height="256"><rect x="-64" y="-64" width="256" height="256" fill="#fff"/>${rot(strip("#000", keyW + 2.5))}</mask>` +
    `<g mask="url(#${id})">${cPath}</g>` +
    rot((key ? strip(key, keyW) : "") + strip(plaster, 0) + padRect)
  );
}

// Heavier drawing for 16 and 32 px, where the pad and thin edges blur away.
const SMALL = { W: 30, R: 36, GAP: 56, pw: 26, pl: 56, px: 86, showPad: false };

// The app tile (B4): shaded orange with a white C and black plaster. States for the toolbar icon:
//   on   = protecting this site
//   spot = gray tile, orange plaster: "this page looks like an AI chat" (click to protect)
//   off  = gray tile, the C alone
function tile(state = "on", { size = 128, small = size <= 32, shadow = !small, shape = "square" } = {}) {
  const g = nextId("tg"),
    f = nextId("ts");
  const [top, bottom] = state === "on" ? [COLORS.tileTop, COLORS.tileBottom] : [COLORS.grayTop, COLORS.grayBottom];
  const geo = small ? SMALL : {};
  const inner =
    state === "off"
      ? mark({ ...geo, c: COLORS.white, noPlaster: true })
      : state === "spot"
        ? mark({ ...geo, c: COLORS.white, plaster: COLORS.orange, pad: COLORS.white, key: null })
        : mark({ ...geo, c: COLORS.white, plaster: COLORS.ink, pad: COLORS.orange, key: null });
  const scale = shape === "circle" ? 0.58 : small ? 0.68 : 0.64;
  const content = `<g transform="translate(64 64) scale(${scale}) translate(-${small ? 55 : 53} -64)">${inner}</g>`;
  const bg =
    shape === "circle"
      ? `<circle cx="64" cy="64" r="63" fill="url(#${g})"/>`
      : `<rect x="${small ? 2 : 1}" y="${small ? 2 : 1}" width="${small ? 124 : 126}" height="${small ? 124 : 126}" rx="${small ? 26 : 28.5}" fill="url(#${g})"/>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 128 128"><defs>` +
    `<linearGradient id="${g}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient>` +
    (shadow
      ? `<filter id="${f}" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="3" stdDeviation="3" flood-color="${state === "on" ? "#7A2A00" : "#1E2127"}" flood-opacity="0.45"/></filter>`
      : "") +
    `</defs>${bg}${shadow ? `<g filter="url(#${f})">${content}</g>` : content}</svg>`
  );
}

// A small plaster laid across a line, as in the mark: black strip, orange pad, thin white edge.
function plasterAt(x, y, angle, s = 1) {
  const pw = 14 * s,
    pl = 34 * s;
  return (
    `<g transform="translate(${x} ${y}) rotate(${angle})"><g class="mm-p">` +
    `<rect x="${-pw / 2 - 3}" y="${-pl / 2 - 3}" width="${pw + 6}" height="${pl + 6}" rx="${pw / 2 + 3}" fill="${COLORS.white}"/>` +
    `<rect x="${-pw / 2}" y="${-pl / 2}" width="${pw}" height="${pl}" rx="${pw / 2}" fill="${COLORS.ink}"/>` +
    `<rect x="${-pw / 2 + 3.5 * s}" y="${-5.5 * s}" width="${pw - 7 * s}" height="${11 * s}" rx="${2 * s}" fill="${COLORS.orange}"/></g></g>`
  );
}

// The mind map: you in the middle, branches to the places you type (AI chats, email, chat apps: D135), and on
// each branch the details Clotr stopped (a plaster across the twig; past it the line fades to dashes and the
// detail stays gray). Drawn in an 860×480 box; place it with transform.
const MAP = [
  {
    site: "AI chats",
    at: [440, 96],
    leaves: [
      ["Bank account", 44],
      ["Password", 110],
    ],
  },
  {
    site: "Email",
    at: [480, 250],
    leaves: [
      ["Home address", 210],
      ["Card number", 276],
    ],
  },
  {
    site: "Discord &amp; Slack",
    at: [430, 400],
    leaves: [
      ["Phone number", 370],
      ["Date of birth", 436],
    ],
  },
];
function mindMap({ labels = true } = {}) {
  const you = [96, 250];
  let lines = "",
    nodes = "",
    text = "";
  const t = (x, y, s, size, weight, fill, anchor = "start", cls = "") =>
    `<text class="${cls}" x="${x}" y="${y}" font-family="Atkinson Hyperlegible" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${s}</text>`;
  for (const b of MAP) {
    const [ax, ay] = b.at;
    lines += `<path class="mm-b" d="M${you[0]} ${you[1]} C${you[0] + 170} ${you[1]} ${ax - 190} ${ay} ${ax - 26} ${ay}" fill="none" stroke="${COLORS.slate}" stroke-width="4" stroke-linecap="round"/>`;
    nodes += `<circle class="mm-halo" cx="${ax}" cy="${ay}" r="32" fill="${COLORS.peach}"/>`;
    nodes += `<circle class="mm-ring" cx="${ax}" cy="${ay}" r="22" fill="${COLORS.white}" stroke="${COLORS.orange}" stroke-width="4"/>`;
    if (labels) text += t(ax, ay - 36, b.site, 20, 700, COLORS.ink, "middle", "mm-site");
    for (const [label, ly] of b.leaves) {
      const sx = ax + 24,
        lx = 690;
      const mx = sx + 0.58 * (lx - sx),
        my = ay + 0.58 * (ly - ay);
      // First half solid up to the plaster, second half faded.
      lines += `<path class="mm-t" d="M${sx} ${ay} C${sx + 60} ${ay} ${mx - 50} ${my} ${mx} ${my}" fill="none" stroke="${COLORS.slate}" stroke-width="3" stroke-linecap="round"/>`;
      lines += `<path class="mm-f" d="M${mx} ${my} C${mx + 50} ${my} ${lx - 60} ${ly} ${lx} ${ly}" fill="none" stroke="${COLORS.faint}" stroke-width="3" stroke-linecap="round" stroke-dasharray="2 8"/>`;
      nodes += `<circle class="mm-leafdot" cx="${lx}" cy="${ly}" r="7" fill="${COLORS.faint}"/>`;
      const slope = (Math.atan2(ly - ay, lx - sx) * 180) / Math.PI;
      nodes += plasterAt(mx, my, slope - 15, 1); // across the line, tilted like the mark
      if (labels) text += t(lx + 16, ly + 7, label, 19, 400, COLORS.ink2, "start", "mm-leaf");
    }
  }
  nodes += `<circle class="mm-youdot" cx="${you[0]}" cy="${you[1]}" r="40" fill="${COLORS.ink}"/>`;
  text += t(you[0], you[1] + 8, "You", 24, 700, COLORS.white, "middle", "mm-you");
  return lines + nodes + text;
}

const dotGrid = (id, color = COLORS.dot) =>
  `<pattern id="${id}" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="12" cy="12" r="1.4" fill="${color}"/></pattern>`;

// Atkinson Hyperlegible, embedded so renders never fetch anything.
function fontCss() {
  const f = (w) =>
    fs.readFileSync(path.join(ROOT, "extension", "fonts", `atkinson-hyperlegible-${w}.woff2`)).toString("base64");
  return ["400", "700"]
    .map(
      (w) =>
        `@font-face{font-family:"Atkinson Hyperlegible";src:url(data:font/woff2;base64,${f(w)}) format("woff2");font-weight:${w}}`,
    )
    .join("");
}

const BROWSERS = [
  "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe",
  `${process.env.LOCALAPPDATA}/BraveSoftware/Brave-Browser/Application/brave.exe`,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

// Renders [{ file, svg, w, h, transparent }] to PNGs in one browser session.
async function renderPng(jobs) {
  const puppeteer = require("puppeteer-core");
  const executablePath = process.env.CLOTR_BROWSER || BROWSERS.find((p) => fs.existsSync(p));
  if (!executablePath) throw new Error("No Brave/Chrome found (set CLOTR_BROWSER)");
  const browser = await puppeteer.launch({ executablePath, headless: true, pipe: true });
  try {
    const tab = await browser.newPage();
    const css = fontCss();
    for (const j of jobs) {
      await tab.setViewport({ width: j.w, height: j.h, deviceScaleFactor: 1 });
      await tab.setContent(
        `<!doctype html><html><head><meta charset="utf-8"><style>${css}html,body{margin:0;background:transparent}svg{display:block}</style></head><body>${j.svg}</body></html>`,
        { waitUntil: "load" },
      );
      await tab.evaluate("document.fonts.ready"); // runs in the page
      fs.mkdirSync(path.dirname(j.file), { recursive: true });
      await tab.screenshot({
        path: j.file,
        omitBackground: !!j.transparent,
        clip: { x: 0, y: 0, width: j.w, height: j.h },
      });
      console.log(path.relative(ROOT, j.file).replace(/\\/g, "/"), `(${j.w}×${j.h})`);
    }
  } finally {
    await browser.close();
  }
}

module.exports = { ROOT, COLORS, mark, tile, mindMap, plasterAt, dotGrid, renderPng, nextId, fontCss };
