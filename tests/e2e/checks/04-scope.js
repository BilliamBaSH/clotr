// E2E checks: D. Scope & discovery. Run in order by ../run.js with one shared env (helpers from ../lib.js).
"use strict";

module.exports = async function (env) {
  const { KEY, check, clotrActive, ctx, expect, expectNoDialog, openPopup, typeText, withSite } = env;
  await check("D1", "Unknown AI tool: Clotr does NOT run until the user adds it", () =>
    withSite(ctx, "newtool", async (page) => {
      expect(!clotrActive(page), "Clotr ran on a site nobody added");
      await typeText(page, KEY);
      await expectNoDialog(page, "site not added");
    }),
  );

  await check("D2", "Page check recognizes AI chats and ignores ordinary sites", async () => {
    const popup = await openPopup(ctx);
    const src = await popup.evaluate(() => globalThis.ClotrSites.inspectPageForAIChat.toString());
    await popup.close();
    const verdicts = {};
    for (const key of ["newtool", "chatgpt", "ordinary"]) {
      verdicts[key] = await withSite(ctx, key, (page) => page.evaluate(`(${src})()`));
    }
    expect(verdicts.newtool.looksLikeAI, `new AI tool not recognized: ${JSON.stringify(verdicts.newtool)}`);
    expect(verdicts.chatgpt.looksLikeAI, `ChatGPT page not recognized: ${JSON.stringify(verdicts.chatgpt)}`);
    expect(!verdicts.ordinary.looksLikeAI, `ordinary site flagged: ${JSON.stringify(verdicts.ordinary)}`);
    return `new tool found: ${verdicts.newtool.signals.join(", ")}`;
  });

  await check("D6", "Ordinary website: Clotr stays completely off", () =>
    withSite(ctx, "ordinary", async (page) => {
      expect(!clotrActive(page), "Clotr ran on a non-AI site");
      await typeText(page, KEY);
      await expectNoDialog(page, "non-AI site");
    }),
  );
};
