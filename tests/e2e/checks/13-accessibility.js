// E2E checks: Accessibility (M4): axe-core on every Clotr page, light and dark. Run in order by ../run.js with one shared env (helpers from ../lib.js).
"use strict";

module.exports = async function (env) {
  const {
    KEY,
    auditShadow,
    check,
    ctx,
    editorText,
    expect,
    fs,
    openExtPage,
    openPopup,
    pressEnter,
    readUI,
    resetState,
    seedEvents,
    sleep,
    store,
    typeText,
    waitFor,
    waitForNotice,
    withSite,
  } = env;
  await check(
    "A11Y1",
    "No serious accessibility problems (axe-core) in the popup tabs and the welcome/vault page, light and dark",
    async () => {
      const AXE = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8"); // evaluated through DevTools: extension pages' CSP blocks script tags
      // One event marked `via: "bandage"` so the dashboard's "What Bandage kept from each AI" section renders.
      await store.set(ctx, {
        events: [
          ...seedEvents(),
          {
            t: Date.now(),
            site: "chatgpt.com",
            type: "phone_number",
            name: "Phone Number",
            severity: "medium",
            action: "redacted",
            fp: "1000000000000009",
            via: "bandage",
          },
        ],
      });
      const problems = [];
      const audit = async (page, where) => {
        for (const theme of ["light", "dark"]) {
          await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
          await sleep(150);
          if (!(await page.evaluate(() => typeof axe === "object"))) await page.evaluate(AXE);
          const found = await page.evaluate(async () =>
            (await axe.run(document, { resultTypes: ["violations"] })).violations
              .filter((v) => v.impact === "serious" || v.impact === "critical")
              .map(
                (v) =>
                  `${v.id} (${v.nodes.length}): ${v.nodes
                    .slice(0, 2)
                    .map((n) => n.target.join(" "))
                    .join(", ")}`,
              ),
          );
          problems.push(...found.map((f) => `${where}, ${theme}: ${f}`));
        }
      };
      const popup = await openPopup(ctx);
      try {
        for (const tab of ["overview", "activity", "settings"]) {
          await popup.click(`#tab-${tab}`);
          await sleep(200);
          await audit(popup, `popup ${tab}`);
        }
      } finally {
        await popup.close();
      }
      for (const file of [
        "vault.html?welcome=1",
        "vault.html",
        "stored.html",
        "dashboard.html",
        "helper.html",
        "share.html",
        "policy.html",
      ]) {
        const page = await openExtPage(ctx, file);
        try {
          await audit(page, file);
        } finally {
          await page.close();
        }
      }
      await store.set(ctx, { events: [] });
      expect(!problems.length, problems.slice(0, 8).join(" | "));
    },
  );

  await check(
    "A11Y2",
    "No serious accessibility problems (axe-core) in Clotr's own chat-page UI: the corner notice, Bandage's hover-to-peek bubble and its hotspot layer, light and dark",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await store.set(ctx, { bandage: { "chatgpt.com": true } });
        const problems = [];
        const audit = async (tag, where) => {
          for (const theme of ["light", "dark"]) {
            await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
            await sleep(150);
            const found = await auditShadow(page, tag);
            if (found) problems.push(...found.map((f) => `${where}, ${theme}: ${f}`));
          }
        };
        await typeText(page, `key ${KEY}`); // Bandage never covers keys, so this still warns (BN3)
        expect(await waitForNotice(page), "no notice");
        await audit("CLOTR-NOTICE", "corner notice");
        await resetState(ctx, {});
        await store.set(ctx, { bandage: { "chatgpt.com": true } });
        await sleep(300);
        await typeText(page, "call me at 937-555-0123");
        await waitFor(async () => ((await editorText(page)) === "call me at [Phone 1]" ? true : null), 4000);
        await pressEnter(page);
        await sleep(300);
        await page.evaluate(() => window.__reply("Sure, I'll call [Phone 1] soon."));
        const spots = await waitFor(() => readUI(page, "CLOTR-SPOTS"), 5000);
        expect(spots, "no hotspot layer appeared");
        await audit("CLOTR-SPOTS", "hotspot layer");
        const point = await page.evaluate((label) => {
          const t = [...document.querySelectorAll(".reply")].pop().firstChild;
          const r = document.createRange();
          r.setStart(t, t.nodeValue.indexOf(label));
          r.setEnd(t, t.nodeValue.indexOf(label) + label.length);
          const b = r.getBoundingClientRect();
          return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
        }, "[Phone 1]");
        await page.mouse.move(point.x, point.y);
        const peek = await waitFor(() => readUI(page, "CLOTR-PEEK"), 3000);
        expect(peek, "no peek bubble appeared");
        await audit("CLOTR-PEEK", "peek bubble");
        await resetState(ctx, {});
        expect(!problems.length, problems.slice(0, 8).join(" | "));
      }),
  );

  await check("KB1", "Keyboard: Alt+Shift+C jumps to the warning, Enter removes, Esc goes back to the message", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      const shortcut = () =>
        ctx.worker.evaluate(async () => {
          const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          handleCommand("focus-notice", tab); // what the browser calls for the shortcut
        });
      const focused = () => page.evaluate(() => document.activeElement?.tagName);
      await typeText(page, "call me at 937-555-0123");
      expect(await waitForNotice(page), "no notice");
      await shortcut();
      await sleep(200);
      expect((await focused()) === "CLOTR-NOTICE", `focus is on ${await focused()}`);
      await page.keyboard.press("Escape");
      expect((await focused()) === "TEXTAREA", `Esc left focus on ${await focused()}`);
      await shortcut();
      await sleep(200);
      await page.keyboard.press("Enter");
      await sleep(300);
      const text = await editorText(page);
      expect(text.includes("[REDACTED PHONE NUMBER]"), `Enter didn't remove it: "${text}"`);
      const manifest = await ctx.worker.evaluate(
        () => chrome.runtime.getManifest().commands?.["focus-notice"]?.suggested_key?.default,
      );
      expect(manifest === "Alt+Shift+C", `shortcut: ${manifest}`);
    }),
  );
};
