// Clotr — translates an extension page's fixed text (D65).
// Elements carry data-i18n="key"; labels, tooltips and placeholders carry data-i18n-aria-label,
// data-i18n-title, data-i18n-placeholder. The English written in the HTML stays wherever there's
// no translation. Load it after the page's markup and before the page's own script.
(() => {
  "use strict";

  const get = (key) => {
    try {
      return chrome.i18n.getMessage(key) || "";
    } catch {
      return "";
    }
  };

  for (const el of document.querySelectorAll("[data-i18n]")) {
    const text = get(el.dataset.i18n);
    if (text) el.textContent = text;
  }
  for (const attr of ["aria-label", "title", "placeholder"]) {
    for (const el of document.querySelectorAll(`[data-i18n-${attr}]`)) {
      const text = get(el.getAttribute(`data-i18n-${attr}`));
      if (text) el.setAttribute(attr, text);
    }
  }
  // Screen readers pronounce the page in the language it's shown in.
  if (get("@@ui_locale").startsWith("es") && get("extDescription")) document.documentElement.lang = "es";
})();
