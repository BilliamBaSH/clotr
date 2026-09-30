// E2E checks: RB. "Report a problem" on every Clotr page (#178). Run in order by
// ../run.js with one shared env (helpers from ../lib.js).
"use strict";

module.exports = async function (env) {
  const { OUT, check, ctx, expect, openExtPage, openPopup, shot, sleep, store } = env;

  const PAGES = ["vault.html", "dashboard.html", "stored.html", "helper.html", "share.html", "policy.html"];

  await check(
    "RB1",
    '"Report a problem" shows up on every Clotr page (the popup too), with its three choices and no email choice (REPORT_EMAIL unset)',
    async () => {
      const popup = await openPopup(ctx);
      try {
        const got = await popup.evaluate(() => {
          const details = document.querySelector("#report-root .report");
          return {
            hasDetails: Boolean(details),
            choices: [...(details?.querySelectorAll(".report-menu button") || [])].map((b) => b.textContent),
          };
        });
        expect(got.hasDetails, "popup: no report button");
        expect(got.choices.length === 3, `popup: choices ${JSON.stringify(got.choices)}`);
      } finally {
        await popup.close();
      }

      for (const file of PAGES) {
        const page = await openExtPage(ctx, file);
        try {
          await sleep(200);
          const got = await page.evaluate(() => {
            const details = document.querySelector("#report-root .report");
            const summary = details?.querySelector("summary")?.textContent || "";
            const choices = [...(details?.querySelectorAll(".report-menu button") || [])].map((b) => b.textContent);
            return { hasDetails: Boolean(details), summary, choices };
          });
          expect(got.hasDetails, `${file}: no report button`);
          expect(/report a problem/i.test(got.summary), `${file}: summary "${got.summary}"`);
          expect(
            got.choices.length === 3 &&
              /wrong/i.test(got.choices[0]) &&
              /missed/i.test(got.choices[1]) &&
              /false alarm/i.test(got.choices[2]),
            `${file}: choices ${JSON.stringify(got.choices)}`,
          );
        } finally {
          await page.close();
        }
      }
    },
  );

  await check(
    "RB2",
    "Each choice opens the right GitHub form with only the version and browser prefilled: never a typed value, a stored value or a fingerprint",
    async () => {
      const fp = await ctx.worker.evaluate(async () =>
        globalThis.Clotr.fingerprint(await ensureSalt(), "phone_number", "937-555-0147"),
      );
      await store.set(ctx, {
        events: [
          {
            t: Date.now(),
            site: "chatgpt.com",
            type: "phone_number",
            name: "Phone Number",
            severity: "medium",
            action: "allowed",
            fp,
          },
        ],
        vault: [{ kind: "value", type: "phone_number", fp, mode: "protect", added: Date.now() }],
      });
      const page = await openExtPage(ctx, "dashboard.html");
      try {
        const urls = await page.evaluate(() => {
          window.__opened = [];
          window.open = (u) => {
            window.__opened.push(u);
            return null;
          };
          for (const b of document.querySelectorAll("#report-root .report-menu button")) b.click();
          return window.__opened;
        });
        expect(urls.length === 3, `expected 3 opened URLs, got ${urls.length}`);
        expect(urls[0]?.includes("template=bug.yml"), `bug url: ${urls[0]}`);
        expect(urls[1]?.includes("template=missed.yml"), `missed url: ${urls[1]}`);
        expect(urls[2]?.includes("template=false-alarm.yml"), `false-alarm url: ${urls[2]}`);
        for (const url of urls) {
          const decoded = decodeURIComponent(url);
          expect(/[?&]version=/.test(url), `no version: ${url}`);
          expect(!/chatgpt|937|555|0147/i.test(decoded), `a typed/stored value or the site leaked: ${decoded}`);
          expect(!decoded.includes(fp), `the fingerprint leaked: ${decoded}`);
          expect(!/[?&]site=/.test(url), `a site with no opt-in checkbox still carried one: ${url}`);
        }
      } finally {
        await page.close();
        await store.set(ctx, { events: [], vault: [] });
      }
    },
  );

  await check(
    "RB3",
    'Popup: "Include this site" only offered on a protected AI site, off by default, adds the host only when ticked',
    async () => {
      const openPopupOn = async (url) => {
        const popup = await ctx.browser.newPage();
        popup.on("pageerror", (err) => ctx.problems.push(`popup error: ${err.message}`));
        await popup.evaluateOnNewDocument((u) => {
          chrome.tabs.query = async () => [{ id: 999, url: u }];
        }, url);
        await popup.setViewport({ width: 380, height: 700 });
        await popup.goto(`chrome-extension://${new URL(ctx.swTarget.url()).host}/popup.html`);
        await popup.waitForSelector("#hero-value");
        await sleep(400);
        return popup;
      };

      // Away from an AI tool: no checkbox to include a site at all.
      let popup = await openPopupOn("https://example.com/");
      try {
        const hidden = await popup.evaluate(() => document.querySelector("#report-root .report-site")?.hidden);
        expect(hidden !== false, `checkbox shown away from an AI tool: hidden=${hidden}`);
      } finally {
        await popup.close();
      }

      // On a protected AI site: the checkbox shows the host, unticked by default.
      popup = await openPopupOn("https://chatgpt.com/");
      try {
        const shown = await popup.evaluate(() => ({
          hidden: document.querySelector("#report-root .report-site")?.hidden,
          checked: document.querySelector("#report-root .report-site input")?.checked,
          text: document.querySelector("#report-root .report-site span")?.textContent,
        }));
        expect(shown.hidden === false, `checkbox not shown on a protected site: ${JSON.stringify(shown)}`);
        expect(shown.checked === false, `checkbox ticked by default: ${JSON.stringify(shown)}`);
        expect(/chatgpt\.com/.test(shown.text || ""), `checkbox text: ${shown.text}`);

        await popup.evaluate(() => {
          window.__opened = [];
          window.open = (u) => {
            window.__opened.push(u);
            return null;
          };
        });
        await popup.click("#report-root summary");
        await popup.click("#report-root .report-menu button");
        const withoutSite = await popup.evaluate(() => window.__opened.at(-1));
        expect(!/[?&]site=/.test(withoutSite || ""), `site included although unchecked: ${withoutSite}`);

        await popup.click("#report-root summary");
        await popup.click("#report-root .report-site input");
        await popup.click("#report-root .report-menu button");
        const withSite = await popup.evaluate(() => window.__opened.at(-1));
        expect(/[?&]site=chatgpt\.com/.test(withSite || ""), `site missing once ticked: ${withSite}`);
      } finally {
        await popup.close();
      }
    },
  );

  // D120: "an initial warning and an address on the welcome page or guide are
  // mandatory". The warning comes before any choice; the address is plain text, so it also works on paper.
  const ADDRESS = "github.com/BilliamBaSH/clotr/issues";
  await check(
    "RB4",
    "Report a problem warns first that reports are public (never paste the real detail), and shows its address in words, on screen and in the printed guide",
    async () => {
      for (const file of PAGES) {
        const page = await openExtPage(ctx, file);
        try {
          await sleep(200);
          const got = await page.evaluate(() => {
            const menu = document.querySelector("#report-root .report-menu");
            const warn = menu?.querySelector(".report-warn");
            const first = menu?.querySelector(".report-warn, button");
            return {
              warn: warn?.textContent || "",
              warnFirst: Boolean(warn) && first === warn,
              address: menu?.querySelector(".report-address")?.textContent || "",
            };
          });
          expect(/public/i.test(got.warn) && /never/i.test(got.warn), `${file}: warning "${got.warn}"`);
          expect(got.warnFirst, `${file}: the warning isn't before the choices`);
          expect(got.address.includes(ADDRESS), `${file}: address "${got.address}"`);
          if (file === "vault.html") {
            await page.click("#report-root summary");
            await shot(page, "report-menu.png");
          }
        } finally {
          await page.close();
        }
      }
      const share = await openExtPage(ctx, "share.html");
      try {
        const guide = await share.evaluate(() => document.querySelector(".guide")?.textContent || "");
        expect(guide.includes(ADDRESS), "the printed guide has no report address");
        await share.setViewport({ width: 800, height: 1200 });
        await share.emulateMediaType("print");
        await (await share.$(".guide")).screenshot({ path: `${OUT}/share-guide-print.png` });
        // The Share page promises "one page": the new line mustn't push the guide onto a second sheet.
        // (Chrome refuses a page range past the last page, so asking for page 2 fails when there's only one.)
        expect((await share.pdf({ format: "letter" })).length > 0, "the guide didn't print");
        const second = await share.pdf({ format: "letter", pageRanges: "2" }).then(
          () => true,
          () => false,
        );
        expect(!second, "the printed guide runs onto a second page");
      } finally {
        await share.close();
      }
    },
  );
};
