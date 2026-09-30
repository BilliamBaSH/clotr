// E2E checks: B. Toolbar. Run in order by ../run.js with one shared env (helpers from ../lib.js).
"use strict";

module.exports = async function (env) {
  const {
    KEY,
    KEY2,
    activeBadge,
    check,
    clearEditor,
    clickDialogButton,
    ctx,
    expect,
    resetState,
    typeText,
    waitFor,
    waitForDialog,
    withSite,
  } = env;
  await check("B1", "Badge shows today's count; red after allowing a high-risk item", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx);
      await typeText(page, KEY);
      await waitForDialog(page);
      await clickDialogButton(page, "Leave it in");
      const b1 = await waitFor(async () => {
        const b = await activeBadge(ctx);
        return b.text === "1" ? b : null;
      }, 2000);
      expect(b1, `badge text: "${(await activeBadge(ctx)).text}"`);
      expect(b1.color.slice(0, 3).join() === "208,59,59", `badge color ${b1.color}`);
      await clearEditor(page);
      await typeText(page, KEY2);
      await waitForDialog(page);
      await clickDialogButton(page, "Hide it");
      const b2 = await waitFor(async () => ((await activeBadge(ctx)).text === "2" ? true : null), 2000);
      expect(b2, `badge text after 2nd: "${(await activeBadge(ctx)).text}"`);
    }),
  );

  await check("B2", "Hover tooltip summarizes today", async () => {
    const title = await ctx.worker.evaluate(() => chrome.action.getTitle({}));
    expect(
      title.includes("today: 2 found") && title.includes("1 hidden") && title.includes("1 sent"),
      `title: ${JSON.stringify(title)}`,
    );
    return title.replace(/\n/g, " / ");
  });

  await check("B3", "No badge on a non-AI site", () =>
    withSite(ctx, "ordinary", async () => {
      const b = await activeBadge(ctx);
      expect(b.text === "", `badge "${b.text}" on a non-AI site`);
    }),
  );
};
