// E2E checks: E. Other chat styles. Run in order by ../run.js with one shared env (helpers from ../lib.js).
"use strict";

module.exports = async function (env) {
  const {
    KEY,
    KEY2,
    check,
    clearEditor,
    clickDialogButton,
    clickSend,
    ctx,
    editorText,
    expect,
    readNotice,
    resetState,
    sentMessages,
    sleep,
    store,
    typeText,
    waitFor,
    waitForDialog,
    withSite,
  } = env;
  const STYLES = {
    claude: "rich-text editor (Claude-style)",
    notebook: "shadow-DOM input (Gemini/NotebookLM-style)",
    perplexity: "Lexical editor that tracks the selection asynchronously (Perplexity-style)",
    copilot: "editor that keeps an invisible marker at the end (Microsoft Copilot-style)",
  };
  for (const [key, label] of Object.entries(STYLES)) {
    await check(`E-${key}`, `Detect, redact and block in a ${label}`, () =>
      withSite(ctx, key, async (page) => {
        await resetState(ctx);
        await typeText(page, `here: ${KEY}`);
        expect(await waitForDialog(page), "no dialog appeared");
        await clickDialogButton(page, "Hide it");
        const text = await editorText(page);
        expect(text.includes("[REDACTED AWS ACCESS KEY]") && !text.includes(KEY), `editor text: "${text}"`);
        await clearEditor(page);
        await typeText(page, KEY2);
        await clickSend(page);
        await sleep(300);
        expect((await sentMessages(page)).length === 0, "send button not blocked");
        expect(await waitForDialog(page), "no dialog after blocked send");
      }),
    );
  }

  // Copilot keeps an invisible marker (U+200B U+200C) at the end of its box and puts it back after Clotr's edit, so
  // the box's text differs from Clotr's only by zero-width characters: that's hidden, not "couldn't hide it here"
  // (seen on copilot.microsoft.com, 2026-09-30).
  await check("CP1", "Hide it in an editor that keeps an invisible marker counts as hidden, with no false alarm", () =>
    withSite(ctx, "copilot", async (page) => {
      await resetState(ctx);
      await typeText(page, `here: ${KEY}`);
      expect(await waitForDialog(page), "no dialog appeared");
      await clickDialogButton(page, "Hide it");
      const text = await editorText(page);
      expect(text.includes("[REDACTED AWS ACCESS KEY]") && !text.includes(KEY), `editor text: "${text}"`);
      await sleep(500);
      const notice = await readNotice(page);
      expect(!notice?.text.includes("couldn't hide"), `false alarm: ${notice?.text}`);
      const events =
        (await waitFor(async () => ((await store.events(ctx)).length ? store.events(ctx) : null), 2000)) || [];
      expect(events.length === 1 && events[0].action === "redacted", `events: ${JSON.stringify(events)}`);
    }),
  );

  // Cover names in the same editor: the swap has to land once and quickly, and the page must stay responsive
  // (on copilot.microsoft.com, 2026-09-30, covering took 8 seconds, then the tab froze).
  await check(
    "CP2",
    "Cover names in an editor that keeps an invisible marker: [Phone 1] within 3 seconds, page responsive",
    () =>
      withSite(ctx, "copilot", async (page) => {
        await resetState(ctx, {});
        await store.set(ctx, { bandage: { "copilot.microsoft.com": true } });
        await sleep(300);
        const t0 = Date.now();
        await typeText(page, "call me at 937-555-0123");
        const done = await waitFor(async () => ((await editorText(page)).includes("[Phone 1]") ? true : null), 3000);
        const text = await editorText(page);
        expect(done, `not covered after ${Date.now() - t0} ms: "${text}"`);
        expect(!text.includes("937-555-0123"), `the number is still there: "${text}"`);
        const ping = await Promise.race([page.evaluate(() => 1), sleep(2000).then(() => 0)]);
        expect(ping === 1, "the page stopped answering after the swap");
        await resetState(ctx, {});
      }),
  );
};
