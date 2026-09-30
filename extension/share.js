// Clotr — "Share Clotr with someone" (pre-release Batch 4): the link to send, the step-by-step setup, and a
// one-page guide to print. Nothing is sent anywhere: copying uses the clipboard, printing the browser's dialog.
"use strict";

const { msg } = globalThis.Clotr;
const $ = (id) => document.getElementById(id);
// Where someone gets Clotr: the website until the store listing is public (then its store page).
const SHARE_URL = "https://clotr-app.github.io/";

$("share-url").textContent = SHARE_URL;
$("copy-link").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(SHARE_URL);
    $("copy-msg").textContent = msg("sh_copied", "Copied. Paste it into a message to them.");
  } catch {
    $("copy-msg").textContent = msg("sh_copyFailed", "Couldn't copy that. Select the link and copy it by hand.");
  }
});
$("open-helper").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("helper.html") }));
$("print").addEventListener("click", () => window.print());
