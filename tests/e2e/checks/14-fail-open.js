// E2E checks: Fail open (D30): a broken Clotr never holds or loses a message. Run in order by ../run.js with one shared env (helpers from ../lib.js).
"use strict";

module.exports = async function (env) {
  const {
    DIALOG_WAIT,
    KEY,
    KEY2,
    ORPHAN_CLOTR,
    OUT,
    check,
    clickDialogButton,
    clickSend,
    ctx,
    editorText,
    evalInClotr,
    expect,
    expectNoDialog,
    path,
    pressEnter,
    readDialog,
    readNotice,
    readReloadPrompt,
    resetState,
    sentMessages,
    sleep,
    typeText,
    waitFor,
    waitForDialog,
    waitForNotice,
    withSite,
  } = env;
  await check("FO1", "If detection itself breaks, Enter and the send button still send", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx); // the user chose Block for keys
      const before = ctx.problems.length;
      // Break a built-in that every scan uses, in Clotr's world only. (Pushing a failing pattern into
      // Clotr.PATTERNS raced the fresh install: the background starts Clotr again in tabs already open, and the
      // second copy of patterns.js publishes a new array that the running detector never reads.)
      await evalInClotr(
        page,
        `String.prototype.match = function () { throw new Error("test: detection broke"); }, true`,
      );
      await typeText(page, `key ${KEY}`);
      await expectNoDialog(page, "detection was broken");
      await pressEnter(page);
      await sleep(300);
      expect((await sentMessages(page)).length === 1, "Enter didn't send");
      await typeText(page, `again ${KEY2}`);
      await clickSend(page);
      await sleep(300);
      expect((await sentMessages(page)).length === 2, "the send button didn't send");
      expect(
        page.logs.some((l) => l.includes("handler error")),
        "the failure wasn't logged",
      );
      ctx.problems.length = before; // these errors were caused on purpose
    }),
  );

  await check(
    "FO2",
    "Orphaned Clotr (left behind by an update reload): its dialog still closes; it keeps warning but never holds a message",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx); // the user chose Block for keys
        const before = ctx.problems.length;
        await typeText(page, `key ${KEY}`);
        const dialog = await waitForDialog(page);
        expect(dialog, "no dialog");
        await evalInClotr(page, ORPHAN_CLOTR);
        await clickDialogButton(page, "More choices"); // "stop warning me" needs storage, which is gone
        await clickDialogButton(page, "Leave it in, and stop warning me about: AWS Access Key");
        expect(!(await readDialog(page)), "the dialog couldn't be closed");
        // Keys are now Log only (the tick above, kept in memory); a new key would stay quiet.
        await typeText(page, " call me at 937-555-0123");
        await sleep(DIALOG_WAIT);
        expect(!(await readDialog(page)), "an orphaned Clotr opened a dialog (it must only warn)");
        const notice = await readNotice(page);
        expect(
          notice?.text.includes("Phone Number") && notice.text.includes("Reload this page"),
          `notice: ${notice?.text}`,
        );
        await pressEnter(page);
        await sleep(300);
        expect((await sentMessages(page)).length === 1, "an orphaned Clotr held the message");
        expect(!page.logs.some((l) => l.includes("could not record")), "tried to record while orphaned");
        ctx.problems.length = before;
      }),
  );

  await check("FO4", "Orphaned Clotr turns Block into a warning: notice with the reload hint, Enter sends", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx); // Block for keys
      const before = ctx.problems.length;
      await evalInClotr(page, ORPHAN_CLOTR);
      await typeText(page, `key ${KEY}`);
      const notice = await waitForNotice(page);
      expect(!(await readDialog(page)), "an orphaned Clotr opened a dialog");
      expect(
        notice?.text.includes("AWS Access Key") && notice.text.includes("Reload this page"),
        `notice: ${notice?.text}`,
      );
      expect(await waitFor(() => readReloadPrompt(page), DIALOG_WAIT), "no reload prompt");
      await clickDialogButton(page, "Later", readReloadPrompt);
      await clickDialogButton(page, "Hide it", readNotice);
      const text = await editorText(page);
      expect(text.includes("[REDACTED AWS ACCESS KEY]"), `Redact didn't work while orphaned: "${text}"`);
      await pressEnter(page);
      await sleep(300);
      expect((await sentMessages(page)).length === 1, "didn't send");
      ctx.problems.length = before;
    }),
  );

  await check(
    "FO5",
    "Orphaned and not replaced: a greyed-out prompt asks to reload; Later/Esc goes back, Enter reloads (D37)",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        const before = ctx.problems.length;
        await evalInClotr(page, ORPHAN_CLOTR);
        await typeText(page, "call me at 937-555-0123");
        const prompt = await waitFor(() => readReloadPrompt(page), DIALOG_WAIT);
        expect(prompt?.text.includes("Clotr was updated"), `prompt: ${prompt?.text}`);
        expect(
          prompt.buttons.map((b) => b.text).join("/") === "Later/Copy my message and reload",
          `buttons: ${prompt.buttons.map((b) => b.text)}`,
        );
        await page.screenshot({ path: path.join(OUT, "reload-prompt.png") });
        await page.keyboard.press("Escape");
        await sleep(200);
        expect(!(await readReloadPrompt(page)), "Esc didn't close the prompt");
        expect((await readNotice(page))?.text.includes("Reload this page"), "the old copy stopped warning after Later");
        await typeText(page, " and 937-555-0199");
        await sleep(DIALOG_WAIT);
        expect(!(await readReloadPrompt(page)), "asked again after Later");
        await pressEnter(page);
        await sleep(300);
        expect((await sentMessages(page)).length === 1, "the prompt held the message");
        ctx.problems.length = before;
      })
        .then(() =>
          withSite(ctx, "chatgpt", async (page) => {
            const before = ctx.problems.length;
            await evalInClotr(page, ORPHAN_CLOTR);
            await typeText(page, "call me at 937-555-0123");
            expect(await waitFor(() => readReloadPrompt(page), DIALOG_WAIT), "no prompt");
            await page.keyboard.press("Enter"); // too soon after it appeared: a habit press does nothing
            await sleep(100);
            expect(await readReloadPrompt(page), "an Enter right after the prompt appeared chose for the user");
            await sleep(700);
            const reloaded = page.waitForNavigation({ timeout: 5000 }).then(
              () => true,
              () => false,
            );
            await page.keyboard.press("Enter");
            expect(await reloaded, "Enter didn't reload the page");
            ctx.problems.length = before;
          }),
        )
        .then(() =>
          withSite(ctx, "chatgpt", async (page) => {
            // If the message can't be copied, Clotr doesn't reload: the user's text is never lost.
            const before = ctx.problems.length;
            await evalInClotr(page, ORPHAN_CLOTR);
            await evalInClotr(page, `navigator.clipboard.writeText = () => Promise.reject(new Error("denied")), true`);
            await typeText(page, "call me at 937-555-0123");
            expect(await waitFor(() => readReloadPrompt(page), DIALOG_WAIT), "no prompt");
            let navigated = false;
            page.once("framenavigated", () => {
              navigated = true;
            });
            await clickDialogButton(page, "Copy my message and reload", readReloadPrompt);
            await sleep(500);
            const prompt = await readReloadPrompt(page);
            expect(
              !navigated && prompt?.text.includes("couldn't copy"),
              `navigated: ${navigated}, prompt: ${prompt?.text}`,
            );
            expect(
              prompt.buttons.some((b) => b.text === "Reload anyway"),
              "no Reload anyway",
            );
            ctx.problems.length = before;
          }),
        ),
  );

  await check("FO3", "A dialog open when the update lands: Enter closes it and sends", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx);
      const before = ctx.problems.length;
      await typeText(page, `key ${KEY}`);
      expect(await waitForDialog(page), "no dialog");
      await evalInClotr(page, ORPHAN_CLOTR);
      await pressEnter(page);
      await sleep(300);
      expect((await sentMessages(page)).length === 1, "an orphaned dialog held the message");
      expect(!(await readDialog(page)), "the orphaned dialog stayed open");
      ctx.problems.length = before;
    }),
  );
};
