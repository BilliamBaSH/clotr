// Clotr — "Report a problem" button, on every Clotr page (#178). Clotr never sends
// anything itself (D30, the no-network rule, PRIVACY.md): this only opens a GitHub issue form (or,
// once REPORT_EMAIL is set, a mailto:) for the person to read and send themselves. Classic script:
// share code through globalThis.Clotr (no import/export in Clotr's own pages either, same as content
// scripts). Load it after patterns.js (for Clotr.msg) and after the page's markup.
"use strict";

(function () {
  // The address in words (shown in the menu and printed on the Share guide) and the forms built from it.
  const REPORT_ADDRESS = "github.com/BilliamBaSH/clotr/issues";
  const REPORT_URL = `https://${REPORT_ADDRESS}/new`;
  // A private path, off for now (empty hides the "Send privately by email" choice, D119).
  const REPORT_EMAIL = "";

  const msg = globalThis.Clotr?.msg || ((key, english) => english);

  function version() {
    try {
      const m = chrome.runtime.getManifest();
      return m.version_name || m.version || "";
    } catch {
      return "";
    }
  }

  // A short "browser name + version" from the user agent, and a coarse OS name: never
  // anything more specific than the bug form's own placeholder ("Brave 1.95 on Windows 11").
  function browserInfo() {
    const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
    const brave = typeof navigator !== "undefined" && Boolean(navigator.brave);
    const pick = (re) => re.exec(ua)?.[1] || "";
    let name = "";
    let ver = "";
    if (brave) {
      name = "Brave";
      ver = pick(/\bChrome\/(\S+)/);
    } else if (/\bEdg\//.test(ua)) {
      name = "Edge";
      ver = pick(/\bEdg\/(\S+)/);
    } else if (/\bOPR\//.test(ua)) {
      name = "Opera";
      ver = pick(/\bOPR\/(\S+)/);
    } else if (/\bFirefox\//.test(ua)) {
      name = "Firefox";
      ver = pick(/\bFirefox\/(\S+)/);
    } else if (/\bChrome\//.test(ua)) {
      name = "Chrome";
      ver = pick(/\bChrome\/(\S+)/);
    }
    const os = /Windows/.test(ua)
      ? "Windows"
      : /Mac OS X/.test(ua)
        ? "macOS"
        : /Android/.test(ua)
          ? "Android"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
    const nameVer = [name, ver].filter(Boolean).join(" ");
    return os ? [nameVer, os].filter(Boolean).join(" on ") : nameVer;
  }

  // Only safe facts, through the forms' own field ids (D119): never what anyone typed, never a
  // stored value, never a fingerprint. `host` is the current AI site's name, and only when the
  // person ticked "Include this site" (popup only).
  function formUrl(template, host) {
    const params = new URLSearchParams({ template });
    const v = version();
    if (v) params.set("version", v);
    const b = browserInfo();
    if (b) params.set("browser", b);
    if (host) params.set("site", host);
    return `${REPORT_URL}?${params.toString()}`;
  }

  function mailUrl(host) {
    const lines = [`Clotr version: ${version()}`, `Browser: ${browserInfo()}`];
    if (host) lines.push(`Site: ${host}`);
    lines.push("", "What happened:");
    return `mailto:${REPORT_EMAIL}?subject=${encodeURIComponent("Clotr")}&body=${encodeURIComponent(lines.join("\n"))}`;
  }

  function el(tag, props = {}) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k in node) node[k] = v;
      else node.setAttribute(k, v);
    }
    return node;
  }

  // Set once a page (the popup, popup only) knows the current AI site's host.
  let hostGetter = null;
  let siteToggle = null; // { label, checkbox, text }

  function currentHost() {
    return siteToggle && siteToggle.checkbox.checked ? hostGetter?.() || null : null;
  }

  function choiceButton(text, onOpen) {
    const b = el("button", { type: "button", className: "link", textContent: text });
    b.addEventListener("click", onOpen);
    return b;
  }

  function open(url) {
    window.open(url, "_blank", "noopener");
  }

  // Fills the placeholder element with this id. Safe to call more than once; only the first mount
  // does anything, so a page can't end up with two buttons.
  function mount(placeholderId) {
    const host = document.getElementById(placeholderId);
    if (!host || host.dataset.reportMounted) return;
    host.dataset.reportMounted = "1";

    const details = el("details", { className: "report" });
    details.append(el("summary", { textContent: msg("rpt_reportAProblem", "Report a problem") }));

    const menu = el("div", { className: "report-menu" });
    // Said before any choice (D120): the forms are public, so the real detail never goes in one.
    menu.append(
      el("p", {
        className: "report-warn",
        textContent: msg(
          "rpt_publicWarning",
          "Reports are public, on GitHub. Never paste a real password, key or personal detail: describe it instead.",
        ),
      }),
    );
    // A disclosure with plain buttons: no menu role, which would promise arrow-key handling.

    const label = el("label", { className: "toggle report-site" });
    label.hidden = true;
    const checkbox = el("input", { type: "checkbox" });
    const text = el("span", {});
    label.append(checkbox, text);
    siteToggle = { label, checkbox, text };
    menu.append(label);

    const close = () => {
      details.open = false;
    };
    menu.append(
      choiceButton(msg("rpt_somethingsWrong", "Something's wrong"), () => {
        open(formUrl("bug.yml", currentHost()));
        close();
      }),
      choiceButton(msg("rpt_itMissedSomething", "It missed something"), () => {
        open(formUrl("missed.yml", currentHost()));
        close();
      }),
      choiceButton(msg("rpt_aFalseAlarm", "A false alarm"), () => {
        open(formUrl("false-alarm.yml", currentHost()));
        close();
      }),
    );
    if (REPORT_EMAIL) {
      menu.append(
        choiceButton(msg("rpt_sendPrivatelyByEmail", "Send privately by email"), () => {
          open(mailUrl(currentHost()));
          close();
        }),
      );
    }
    // The address in words too (D120), for someone who'd rather type it or read it out to a helper.
    const address = el("p", { className: "report-address" });
    address.append(
      `${msg("rpt_orTypeAddress", "Or type this address:")} `,
      el("span", { textContent: REPORT_ADDRESS }),
    );
    menu.append(address);
    details.append(menu);
    host.append(details);
  }

  // Popup only: reveals "Include this site (<host>)" once the current AI site is known
  // (`null` hides it again, e.g. away from an AI tool).
  function setHost(host) {
    hostGetter = host ? () => host : null;
    if (!siteToggle) return;
    if (host) {
      siteToggle.text.textContent = msg("rpt_includeThisSite", "Include this site ($1)", host);
      siteToggle.label.hidden = false;
    } else {
      siteToggle.label.hidden = true;
      siteToggle.checkbox.checked = false;
    }
  }

  globalThis.Clotr = { ...(globalThis.Clotr || {}), Report: { mount, setHost, formUrl, mailUrl, REPORT_ADDRESS } };

  // Self-mounts wherever the page has left a placeholder (every page but the printable guide/policy
  // text itself); the popup also calls Report.setHost() once it knows the current AI site.
  mount("report-root");
})();
