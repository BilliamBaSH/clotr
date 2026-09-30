// E2E checks: First-time tips and "Why am I seeing this?" (D21, D43). Run in order by ../run.js with one shared env (helpers from ../lib.js).
"use strict";

module.exports = async function (env) {
  const {
    DIALOG_WAIT,
    check,
    clearEditor,
    clickDialogButton,
    ctx,
    evalInClotr,
    expect,
    openPopup,
    readNotice,
    resetState,
    shot,
    sleep,
    store,
    typeText,
    waitFor,
    waitForNotice,
    withSite,
  } = env;
  await check(
    "GD1",
    'First time a kind of data shows up, the notice asks how to treat it; "Just count it" sets Log only; shown once',
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await store.set(ctx, { guided: {} });
        await typeText(page, "call me at 937-555-0123");
        const n = await waitForNotice(page);
        expect(n?.text.includes("How should Clotr handle a Phone Number from now on?"), `notice: ${n?.text}`);
        await typeText(page, " soon"); // the notice is rebuilt as you type: the tip stays
        await sleep(DIALOG_WAIT);
        expect((await readNotice(page))?.text.includes("How should Clotr handle"), "the tip vanished while typing");
        await shot(page, "notice-first-time.png");
        await clickDialogButton(page, "Just count it", readNotice);
        const stored = () => store.get(ctx, ["responses", "guided"]);
        const after =
          (await waitFor(async () => {
            const s = await stored();
            return s.responses?.phone_number ? s : null;
          }, 2000)) || (await stored());
        expect(
          after.responses?.phone_number === "log" && after.guided?.phone_number,
          `stored: ${JSON.stringify(after)}`,
        );
        expect((await readNotice(page))?.text.includes("will just count a Phone Number"), "no confirmation");
        await clearEditor(page);
        await typeText(page, "and email ann.lee@example.com");
        const next = await waitForNotice(page);
        expect(next?.text.includes("How should Clotr handle an Email Address"), `second kind: ${next?.text}`);
        await clickDialogButton(page, "Leave it in", readNotice);
        await clearEditor(page);
        await typeText(page, "again ann.lee@example.com");
        const again = await waitForNotice(page);
        expect(again && !again.text.includes("How should Clotr handle"), `tip showed twice: ${again?.text}`);
      }),
  );

  await check("GD2", 'First-time tip: "It\'s fine to share" saves this phone as OK to share (fingerprint only)', () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      await store.set(ctx, { guided: {} });
      await typeText(page, "call me at 937-555-0199");
      expect(await waitForNotice(page), "no notice");
      await clickDialogButton(page, "It's fine to share", readNotice);
      const vault = await waitFor(
        async () =>
          ((await store.get(ctx, "vault")).vault || []).length ? (await store.get(ctx, "vault")).vault : null,
        2000,
      );
      expect(
        vault?.length === 1 &&
          vault[0].mode === "allow" &&
          vault[0].type === "phone_number" &&
          /^[0-9a-f]{16}$/.test(vault[0].fp),
        `vault: ${JSON.stringify(vault)}`,
      );
    }),
  );

  await check(
    "GD3",
    '"Why am I seeing this?" explains in plain words; Settings → Show first-time tips again',
    async () => {
      await withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await typeText(page, "call me at 937-555-0123");
        expect(await waitForNotice(page), "no notice");
        await clickDialogButton(page, "Why am I seeing this?", readNotice);
        const n = await readNotice(page);
        expect(n.text.includes("Nothing has left your computer yet"), `why: ${n.text}`);
      });
      const popup = await openPopup(ctx);
      await popup.click("#tab-settings");
      await popup.click("#tips-again");
      await sleep(300);
      await popup.close();
      const { guided } = await store.get(ctx, "guided");
      expect(!guided, `tips not reset: ${JSON.stringify(guided)}`);
    },
  );

  await check(
    "GD4",
    '"Why am I seeing this?" for a password, code or card adds that real support never asks for it (not for a phone number)',
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await typeText(page, "the AnyDesk code is 123 456 789");
        expect(await waitForNotice(page), "no notice");
        await clickDialogButton(page, "Why am I seeing this?", readNotice);
        const n = await readNotice(page);
        expect(/help line will ever ask/.test(n.text), `why: ${n.text}`);
        await withSite(ctx, "chatgpt", async (other) => {
          await typeText(other, "call me at 937-555-0123");
          expect(await waitForNotice(other), "no notice");
          await clickDialogButton(other, "Why am I seeing this?", readNotice);
          const p = await readNotice(other);
          expect(!/help line will ever ask/.test(p.text), `phone why mentions scams: ${p.text}`);
        });
      }),
  );

  await check(
    "RPT1",
    '"Report a false alarm" opens a prefilled issue with only the kind of data (never the value or the site)',
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await typeText(page, "call me at 937-555-0123");
        expect(await waitForNotice(page), "no notice");
        await evalInClotr(
          page,
          "globalThis.__opened = []; window.open = (u) => { globalThis.__opened.push(u); return null; }, true",
        );
        await clickDialogButton(page, "Why am I seeing this?", readNotice);
        await clickDialogButton(page, "Wrong? Report a false alarm", readNotice);
        const [url] = await evalInClotr(page, "globalThis.__opened");
        expect(
          url?.startsWith("https://github.com/BilliamBaSH/clotr/issues/new?template=false-alarm.yml"),
          `url: ${url}`,
        );
        const decoded = decodeURIComponent(url || "");
        expect(decoded.includes("False alarm: Phone Number"), `title: ${decoded}`);
        expect(!/555|0123|chatgpt/.test(decoded), `the report carries the value or the site: ${decoded}`);
      }),
  );
};
