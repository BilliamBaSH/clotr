// Clotr — styles for Clotr's warnings, dialog and reload prompt (content script).
// They live in closed shadow roots, so the page's CSS can't touch them and they can't touch the page.
// Loaded before content.js, which reads Clotr.styles.
(() => {
  "use strict";

  // The "Ask before sending" dialog (and the base for the reload prompt).
  const dialog = `
    :host { all: initial; }
    .overlay {
      position: fixed; inset: 0; z-index: 2147483647;
      display: flex; align-items: center; justify-content: center; padding: 16px;
      background: rgba(0, 0, 0, .45);
      font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    .box {
      width: min(440px, 100%); box-sizing: border-box; outline: none;
      background: #fff; color: #1a1a1a; border-top: 5px solid #d93025;
      border-radius: 10px; box-shadow: 0 12px 40px rgba(0,0,0,.35); padding: 18px 20px;
    }
    h2 { font-size: 17px; margin: 0 0 6px; }
    p { margin: 0 0 10px; }
    ul { margin: 0 0 12px; padding-left: 18px; }
    li { margin: 3px 0; }
    .sev { font-size: 11px; font-weight: 700; text-transform: uppercase; padding: 1px 5px; border-radius: 3px; margin-right: 4px; }
    .high { background: #fce8e6; color: #b3261e; }
    .medium { background: #fef3e0; color: #a05a00; }
    .low { background: #e8f0fe; color: #1a56c4; }
    code { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
    label { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; margin: 4px 0 14px; cursor: pointer; }
    input { margin-top: 3px; }
    .note { font-size: 12px; color: #555; margin-bottom: 14px; }
    .bulk { font-weight: 600; }
    .actions { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
    /* Larger warnings (settings → helping someone) */
    .box.large { width: min(560px, 100%); font-size: 18px; padding: 22px 24px; }
    .box.large h2 { font-size: 22px; }
    .box.large button { font-size: 17px; padding: 10px 18px; }
    .box.large code, .box.large .more summary { font-size: 16px; }
    .box.large button.link { font-size: 16px; padding: 2px 0; }
    button { font: inherit; cursor: pointer; border-radius: 6px; padding: 7px 14px; border: 1px solid #8a8a8a; background: #f5f5f5; color: #1a1a1a; }
    button:focus-visible { outline: 3px solid #8e3708; outline-offset: 2px; }
    button.primary { background: #d93025; border-color: #d93025; color: #fff; }
    .more { margin: 12px 0 0; font-size: 13px; }
    .more summary { cursor: pointer; color: #444; width: fit-content; }
    .more .choices { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
    button.choice { text-align: left; padding: 5px 10px; font-size: 13px; }
    .keys { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 12px; font-size: 12px; color: #555; }
    button.link { border: none; background: none; padding: 2px 0; font-size: 12px; text-decoration: underline; color: #444; }
    .shake { animation: shake .3s ease-in-out; }
    @keyframes shake { 25% { transform: translateX(-6px); } 75% { transform: translateX(6px); } }
    @media (prefers-color-scheme: dark) {
      .box { background: #2b2b2b; color: #eee; }
      .note, .keys { color: #bbb; }
      .more summary, button.link { color: #ccc; background: none; }
      button { background: #3a3a3a; border-color: #8a8a8a; color: #eee; }
      button:focus-visible { outline-color: #f08a3c; }
    }
  `;

  // The warning notice in the corner (doesn't block, doesn't take focus).
  const notice = `
    :host { all: initial; }
    .notice {
      position: fixed; right: 16px; top: 16px; z-index: 2147483647; /* top: keeps the chat box and send button clear */
      width: min(340px, calc(100vw - 32px)); box-sizing: border-box;
      background: #fff; color: #1a1a1a; border-left: 5px solid #e8a200;
      border-radius: 8px; box-shadow: 0 6px 24px rgba(0,0,0,.25); padding: 12px 14px;
      font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    b { display: block; margin-bottom: 4px; font-size: 14px; }
    .hint { font-size: 12px; color: #555; }
    .offer { border-left-color: #ff6700; }
    .offer button.primary { background: #ff6700; border-color: #ff6700; color: #0b0b0b; } /* signal orange (D80), ink text 7:1 */
    p { margin: 0 0 10px; }
    code { font-family: ui-monospace, Consolas, monospace; font-size: 12px; white-space: nowrap; }
    .actions { display: flex; gap: 8px; justify-content: flex-end; }
    button { font: inherit; cursor: pointer; border-radius: 6px; padding: 5px 12px; border: 1px solid #8a8a8a; background: #f5f5f5; color: #1a1a1a; }
    button:focus-visible { outline: 3px solid #8e3708; outline-offset: 2px; }
    button.primary { background: #b3261e; border-color: #b3261e; color: #fff; }
    .notice .actions { flex-wrap: wrap; }
    /* Larger warnings (settings → helping someone): easier to read and to hit */
    .notice.large { width: min(440px, calc(100vw - 32px)); font-size: 17px; padding: 16px 18px; }
    .notice.large b { font-size: 19px; }
    .notice.large .hint { font-size: 15px; }
    .notice.large button { font-size: 16px; padding: 9px 16px; }
    /* Everything grows, not just the headline; text links stay links (no button padding). */
    .notice.large code, .notice.large .more summary, .notice.large .why { font-size: 15px; }
    .notice.large button.link { font-size: 15px; padding: 2px 0 0; }
    .notice button { white-space: nowrap; }
    .why { font-size: 12px; color: #555; margin: 6px 0 0; }
    .why p { margin: 0 0 4px; }
    .why button.link { text-align: left; flex-basis: auto; }
    .more { margin: 8px 0 0; font-size: 12px; }
    .more summary { cursor: pointer; color: #555; width: fit-content; }
    .more .choices { display: flex; flex-direction: column; gap: 5px; margin-top: 6px; }
    button.choice { text-align: left; padding: 4px 9px; font-size: 12px; white-space: normal; }
    .tip { margin-top: 10px; padding-top: 8px; border-top: 1px solid #ddd; font-size: 12px; }
    .tip p { margin: 0 0 6px; }
    .tip b { display: inline; font-size: inherit; margin: 0; }
    .tip .choices { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
    .tip button { padding: 3px 9px; font-size: 12px; }
    .tip button.chosen { border-color: #b84a0c; box-shadow: inset 0 0 0 1px #b84a0c; }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    button.link { order: 1; flex-basis: 100%; text-align: right; border: none; background: none; padding: 2px 0 0; font-size: 12px; text-decoration: underline; color: #555; }
    @media (prefers-color-scheme: dark) {
      button.link, .more summary { color: #aaa; background: none; }
      .why { color: #bbb; }
      .tip { border-top-color: #444; }
      .tip button.chosen { border-color: #f08a3c; box-shadow: inset 0 0 0 1px #f08a3c; }
      .notice { background: #2b2b2b; color: #eee; }
      button { background: #3a3a3a; border-color: #8a8a8a; color: #eee; }
      button:focus-visible { outline-color: #f08a3c; }
    }
  `;

  // "Clotr was updated: reload this page": the dialog, in Clotr's signal orange (D80).
  const reload = `
    .box { border-top-color: #ff6700; }
    button.primary { background: #ff6700; border-color: #ff6700; color: #0b0b0b; }
  `;

  // "Test Clotr here" (popup): an orange outline over the chat box Clotr watches; never catches clicks.
  const flash = `
    :host { all: initial; }
    .ring {
      position: fixed; pointer-events: none; z-index: 2147483647; box-sizing: border-box;
      border: 3px solid #ff6700; border-radius: 10px; box-shadow: 0 0 0 6px rgba(255, 103, 0, 0.3);
      animation: clotr-flash 1.8s ease-in-out forwards;
    }
    @keyframes clotr-flash {
      0% { opacity: 0; } 12% { opacity: 1; } 35% { opacity: 0.35; } 58% { opacity: 1; } 85% { opacity: 1; } 100% { opacity: 0; }
    }
    @media (prefers-reduced-motion: reduce) {
      .ring { animation: none; }
    }
  `;

  // Bandage step 2 (D93): the small bubble that shows a label's real detail when you point at it
  // (or focus it with the keyboard) in the AI's answer.
  const peek = `
    :host { all: initial; }
    .box {
      position: fixed; z-index: 2147483647; max-width: min(320px, calc(100vw - 32px)); box-sizing: border-box;
      background: #fff; color: #1a1a1a; border-left: 5px solid #ff6700;
      border-radius: 8px; box-shadow: 0 6px 24px rgba(0,0,0,.25); padding: 10px 12px;
      font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    .value { font-weight: 600; margin-bottom: 8px; word-break: break-word; }
    button { font: inherit; cursor: pointer; border-radius: 6px; padding: 5px 10px; border: 1px solid #8a8a8a; background: #f5f5f5; color: #1a1a1a; }
    button:focus-visible { outline: 3px solid #8e3708; outline-offset: 2px; }
    .copied { font-size: 12px; color: #2a7a2a; margin-top: 6px; }
    @media (prefers-color-scheme: dark) {
      .box { background: #2b2b2b; color: #eee; }
      button { background: #3a3a3a; border-color: #8a8a8a; color: #eee; }
      button:focus-visible { outline-color: #f08a3c; }
      .copied { color: #7fd07f; }
    }
  `;

  // Bandage step 2 (D99): the invisible hotspots Clotr lays over each label in the AI's answer (the page itself is
  // never changed). A dotted orange underline says "point here"; a clear ring shows keyboard focus.
  const spots = `
    :host { all: initial; }
    .layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483646; }
    .spot {
      position: fixed; pointer-events: auto; margin: 0; padding: 0; border: 0; background: transparent;
      border-bottom: 2px dotted #ff6700; cursor: help;
    }
    .spot:focus-visible { outline: 3px solid #8e3708; outline-offset: 2px; border-radius: 3px; }
    @media (prefers-color-scheme: dark) { .spot:focus-visible { outline-color: #f08a3c; } }
  `;

  globalThis.Clotr.styles = { dialog, notice, reload, flash, peek, spots };
})();
