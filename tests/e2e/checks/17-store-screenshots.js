// E2E checks: Store / README screenshots (only with --store): 1280×800, neutral demo chat, fake data. Run in order by ../run.js with one shared env (helpers from ../lib.js).
"use strict";

module.exports = async function (env) {
  const {
    KEY,
    ROOT,
    argv,
    check,
    clickDialogButton,
    ctx,
    expect,
    fs,
    openExtPage,
    openPopup,
    path,
    readNotice,
    readUI,
    resetState,
    seedEvents,
    sleep,
    store,
    typeText,
    waitFor,
    waitForDialog,
    waitForNotice,
    withSite,
  } = env;
  if (argv.includes("--store"))
    await check(
      "SS1",
      "Store screenshots: warning, hidden, ask-before-sending, Bandage, dashboard, welcome (docs/store/)",
      async () => {
        const dir = path.join(ROOT, "docs", "store");
        fs.mkdirSync(dir, { recursive: true });
        const W = { width: 1280, height: 800 };
        const frame = async (name, caption, sub, pngBase64, imgWidth) => {
          const page = await ctx.browser.newPage();
          await page.setViewport(W);
          await page.setContent(`<!doctype html><html><body style="margin:0;width:1280px;height:800px;display:flex;align-items:center;gap:56px;padding:0 72px;box-sizing:border-box;background:linear-gradient(135deg,#fbeee4,#f6f3ef);font-family:system-ui,'Segoe UI',sans-serif;color:#1d2330">
        <div style="flex:1"><div style="font-size:44px;font-weight:700;line-height:1.15">${caption}</div><div style="font-size:21px;margin-top:18px;color:#4a5160;line-height:1.5">${sub}</div></div>
        <img src="data:image/png;base64,${pngBase64}" style="width:${imgWidth}px;border-radius:14px;box-shadow:0 18px 50px rgba(20,30,60,.22)"></body></html>`);
          await page.screenshot({ path: path.join(dir, name) });
          await page.close();
        };
        await withSite(ctx, "demo", async (page) => {
          await page.setViewport(W);
          await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
          await resetState(ctx, {});
          await typeText(
            page,
            "The heater has been broken since Monday. You can reach me at 937-555-0123 or jane.doe@gmail.com. My unit is at 123 Oak Street, Springfield.",
          );
          expect(await waitForNotice(page), "no notice");
          await sleep(300);
          await page.screenshot({ path: path.join(dir, "1-warning.png") });
          await clickDialogButton(page, "Hide it", readNotice);
          await sleep(300);
          await page.screenshot({ path: path.join(dir, "2-covered.png") });
        });
        await withSite(ctx, "demo", async (page) => {
          await page.setViewport(W);
          await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
          await resetState(ctx); // Ask before sending for keys
          await typeText(page, `Why does my deploy fail? aws configure: ${KEY}`);
          expect(await waitForDialog(page), "no dialog");
          await sleep(300);
          await page.screenshot({ path: path.join(dir, "3-ask-before-sending.png") });
        });
        // Bandage (D93): cover names in the message, the real detail on hover in the answer.
        await withSite(ctx, "demo", async (page) => {
          await page.setViewport(W);
          await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
          await resetState(ctx, {});
          await store.set(ctx, { bandage: { "poe.com": true } });
          await sleep(300);
          await typeText(
            page,
            "The heater has been broken since Monday. Reach me at 937-555-0123. I live at 123 Oak Street.",
          );
          const covered = await waitFor(async () => {
            const t = await page.$eval("#prompt", (b) => b.value);
            return t.includes("[Phone 1]") && t.includes("[Address 1]") ? t : null;
          }, 5000);
          expect(covered, "not covered");
          await page.keyboard.press("Enter");
          await sleep(400);
          await page.evaluate(() =>
            window.__reply(
              'Here\'s a draft: "Hi, the heater at [Address 1] has been broken since Monday. Could someone take a look this week? You can reach me at [Phone 1]. Thanks!"',
            ),
          );
          expect(await waitFor(() => readUI(page, "CLOTR-SPOTS"), 5000), "no hotspots");
          const at = await page.evaluate((label) => {
            const t = [...document.querySelectorAll(".msg.ai")].pop().firstChild;
            const r = document.createRange();
            r.setStart(t, t.nodeValue.indexOf(label));
            r.setEnd(t, t.nodeValue.indexOf(label) + label.length);
            const b = r.getBoundingClientRect();
            return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
          }, "[Phone 1]");
          await page.mouse.move(at.x, at.y);
          expect(await waitFor(() => readUI(page, "CLOTR-PEEK"), 3000), "no bubble");
          await sleep(300);
          await page.screenshot({ path: path.join(dir, "6-bandage.png") });
          await store.set(ctx, { bandage: {} });
        });
        await store.set(ctx, { events: seedEvents() });
        const popup = await openPopup(ctx);
        await popup.setViewport({ width: 380, height: 720 });
        await popup.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
        await sleep(300);
        const dash = await popup.screenshot({ encoding: "base64" });
        await popup.close();
        await frame(
          "4-dashboard.png",
          "See what you almost shared",
          "What Clotr caught, on which AI tool, and what you chose. Counted on your computer; it never keeps what you typed.",
          dash,
          340,
        );
        const welcome = await openExtPage(ctx, "vault.html?welcome=1");
        await welcome.setViewport({ width: 700, height: 800 });
        await welcome.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
        await welcome.type("#try", `my key ${KEY}`);
        await sleep(600);
        const wel = await welcome.screenshot({ encoding: "base64" });
        await welcome.close();
        await frame(
          "5-welcome.png",
          "Try it in ten seconds",
          "A practice box on the welcome page shows exactly what a warning looks like. Nothing leaves your computer.",
          wel,
          560,
        );
        await store.set(ctx, { events: [] });
      },
    );
};
