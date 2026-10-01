// E2E checks: EV. Email and chat apps (D134). Off until you switch one on; once on, Clotr warns and hides like on
// an AI chat, but the warning talks about the people who read it, and there are no cover names and no reading of
// replies. Run in order by ../run.js with one shared env (helpers from ../lib.js).
"use strict";

module.exports = async function (env) {
  const { EXT, check, clotrActive, ctx, expect, expectNoUI, fs, launch, openPopup, os, path, readNotice } = env;
  const { resetState, sleep, store, typeText, waitFor, withSite } = env;
  const PHONE = "937-555-0123";

  await check("EV1", "Email and chat apps: Clotr stays off until you switch one on", async () => {
    for (const key of ["gmail", "discord"]) {
      await withSite(ctx, key, async (page) => {
        expect(!clotrActive(page), `Clotr ran on ${key} without being switched on`);
        await typeText(page, `You can reach me at ${PHONE}`);
        await expectNoUI(page, `${key} not switched on`);
      });
    }
  });

  await check(
    "EV2",
    "Settings lists the email and chat apps, all off; the background treats them as people sites",
    async () => {
      const popup = await openPopup(ctx);
      try {
        await popup.click("#tab-settings");
        const rows = await popup.$$eval("#everyday-sites li", (lis) =>
          lis.map((li) => ({ name: li.querySelector("b")?.textContent, on: li.querySelector("button")?.textContent })),
        );
        expect(rows.length >= 8, `rows: ${JSON.stringify(rows)}`);
        for (const name of ["Gmail", "Outlook", "Discord", "Slack", "WhatsApp"])
          expect(
            rows.some((r) => r.name === name && r.on === "Turn on"),
            `${name} missing or not off: ${JSON.stringify(rows)}`,
          );
      } finally {
        await popup.close();
      }
      const s = await ctx.worker.evaluate(async () => ({
        discord: await settingsFor("https://discord.com/channels/1/2"),
        chatgpt: await settingsFor("https://chatgpt.com/"),
      }));
      expect(s.discord.everyday === true, "discord.com isn't an everyday site");
      expect(s.discord.replyCheck === false && s.discord.bandage === false, "replies or cover names on discord.com");
      expect(s.chatgpt.everyday === false && s.chatgpt.replyCheck === true, "chatgpt.com changed");
    },
  );

  // A copy whose manifest grants the two sites up front stands in for "you switched them on": the browser's
  // permission prompt can't be clicked by a script, and a granted host is a granted host either way.
  async function withGrantedCopy(fn) {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-ext-"));
    fs.cpSync(EXT, copy, { recursive: true });
    const m = JSON.parse(fs.readFileSync(path.join(copy, "manifest.json"), "utf8"));
    m.host_permissions = [...m.host_permissions, "https://mail.google.com/*", "https://discord.com/*"];
    fs.writeFileSync(path.join(copy, "manifest.json"), JSON.stringify(m, null, 2));
    const other = await launch(copy);
    try {
      await waitFor(
        () =>
          other.worker.evaluate(async () => {
            const [s] = await chrome.scripting.getRegisteredContentScripts({ ids: ["clotr-user-sites"] });
            if (!s) await syncUserSites();
            return Boolean(s);
          }),
        5000,
      );
      await resetState(other);
      await store.set(other, { bandage: {} }); // Bandage not answered anywhere: an AI chat would offer it now
      return await fn(other);
    } finally {
      await other.browser.close();
    }
  }

  await check("EV3", "Switched on: a phone number in an email or a chat app warns about the people who read it", () =>
    withGrantedCopy(async (other) => {
      const seen = [];
      for (const key of ["gmail", "discord"]) {
        await withSite(other, key, async (page) => {
          expect(clotrActive(page), `Clotr isn't running on ${key} after it was switched on`);
          await typeText(page, `You can reach me at ${PHONE}`);
          const notice = await waitFor(() => readNotice(page), 3000);
          expect(notice, `no warning on ${key}`);
          expect(/people who read it here/.test(notice.text), `${key} warning: ${notice.text}`);
          expect(!/this AI/.test(notice.text), `${key} warning mentions an AI: ${notice.text}`);
          expect(!notice.buttons.some((b) => /cover names/i.test(b.text)), `${key}: Bandage offered cover names`);
          seen.push(key);
        });
        await sleep(200);
      }
      return `warned on ${seen.join(" and ")}, no cover names`;
    }),
  );
};
