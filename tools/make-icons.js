// Generates the extension's PNG icons from the brand tile (tools/brand.js, D80): `npm run icons`
//   icon-on    shaded orange tile, white C, black plaster: protecting this site
//   icon-off   gray tile, the C alone: default / not active on this site
//   icon-spot  gray tile, orange plaster: "this page looks like an AI chat"
// 16 and 32 px use the heavier small-size drawing; 48 and 128 px the full one with its shadow.
"use strict";

const path = require("path");
const { ROOT, tile, renderPng } = require("./brand");

const OUT = path.join(ROOT, "extension", "icons");
const SIZES = [16, 32, 48, 128];

const jobs = [];
for (const state of ["on", "off", "spot"]) {
  for (const size of SIZES) {
    jobs.push({
      file: path.join(OUT, `icon-${state}-${size}.png`),
      svg: tile(state, { size }),
      w: size,
      h: size,
      transparent: true,
    });
  }
}

renderPng(jobs).catch((e) => {
  console.error(e);
  process.exit(1);
});
