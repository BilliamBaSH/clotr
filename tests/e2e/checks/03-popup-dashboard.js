// E2E checks: C. Dashboard. Run in order by ../run.js with one shared env (helpers from ../lib.js).
"use strict";

module.exports = async function (env) {
  const {
    check,
    clickDialogButton,
    ctx,
    expect,
    openPopup,
    resetState,
    seedEvents,
    shot,
    sleep,
    store,
    typeText,
    waitFor,
    waitForDialog,
    withSite,
  } = env;
  await check("C1", "Popup overview matches the history (7 days)", async () => {
    const events = seedEvents();
    await store.set(ctx, { events, responses: {}, paused: {} });
    const popup = await openPopup(ctx);
    await popup.evaluate(() => document.querySelector('.range [data-days="7"]').click());
    await sleep(200);
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    since.setDate(since.getDate() - 6);
    const inRange = events.filter((e) => e.t >= since.getTime());
    const want = inRange.filter((e) => e.action === "redacted").length;
    const got = await popup.$eval("#hero-value", (n) => n.textContent);
    expect(got === String(want), `hero shows ${got}, expected ${want}`);
    const legend = await popup.$eval("#legend", (n) => n.innerText.replace(/\s+/g, " "));
    const n = (a) => inRange.filter((e) => e.action === a).length;
    expect(
      legend.includes(`Hidden ${n("redacted")}`) &&
        legend.includes(`Sent ${n("allowed")}`) &&
        legend.includes(`Just counted ${n("suppressed")}`),
      `legend: ${legend}`,
    );
    const alerts = await popup.$eval("#alerts", (n) => n.innerText);
    expect(alerts.includes("found the same AWS Access Key 2 times"), `alerts: ${alerts}`);
    expect(alerts.includes("sent 1 high-risk"), `alerts: ${alerts}`);
    await shot(popup, "popup-overview-light.png");
    await shot(popup, "popup-overview-dark.png", "dark");
    await popup.close();
    return `hero ${got}, ${legend}`;
  });

  await check("C2", "Hovering a day column shows its tooltip", async () => {
    await store.set(ctx, { events: seedEvents() }); // fresh, so "today" is still today
    const popup = await openPopup(ctx);
    const hits = await popup.$$("#chart .hit");
    expect(hits.length === 7, `${hits.length} columns`);
    await hits[hits.length - 1].hover();
    await sleep(200);
    const tip = await popup.$eval("#tooltip", (n) => (n.hidden ? "" : n.innerText.replace(/\s+/g, " ")));
    expect(tip.includes("1 Hidden") && tip.includes("1 Sent") && tip.includes("2 found"), `tooltip: "${tip}"`);
    await shot(popup, "popup-tooltip.png");
    await popup.close();
    return tip;
  });

  await check("C3", "30-day range re-scopes the numbers", async () => {
    const popup = await openPopup(ctx);
    await popup.click('.range [data-days="30"]');
    await sleep(200);
    const got = await popup.$eval("#hero-value", (n) => n.textContent);
    const want = seedEvents().filter((e) => e.action === "redacted").length;
    expect(got === String(want), `hero shows ${got}, expected ${want}`);
    expect((await popup.$$("#chart .hit")).length === 30, "chart doesn't show 30 days");
    await shot(popup, "popup-overview-30d.png");
    await popup.click('.range [data-days="7"]');
    await popup.close();
  });

  await check("C6", "Activity tab lists every event with outcome and repeats", async () => {
    const popup = await openPopup(ctx);
    await popup.click("#tab-activity");
    const rows = await popup.$$eval("#events-body tr", (trs) => trs.map((tr) => tr.innerText.replace(/\s+/g, " ")));
    expect(rows.length === seedEvents().length, `${rows.length} rows`);
    expect(rows.filter((r) => r.includes("×2")).length === 2, "repeat marker missing");
    await shot(popup, "popup-activity.png");
    await popup.close();
  });

  await check("C8", "Per-site view: choosing an AI tool filters Overview and Activity", async () => {
    await store.set(ctx, { events: seedEvents() });
    const popup = await openPopup(ctx);
    const pick = (v) =>
      popup.evaluate((val) => {
        const sel = document.querySelector("#site-filter");
        sel.value = val;
        sel.dispatchEvent(new Event("change"));
      }, v);
    const options = await popup.$$eval("#site-filter option", (os) => os.map((o) => o.value));
    await pick("claude.ai");
    await sleep(200);
    const hero = await popup.$eval("#hero-value", (n) => n.textContent);
    const bySite = await popup.$eval("#by-site", (n) => n.innerText);
    await shot(popup, "popup-site-filter.png");
    await popup.click("#tab-activity");
    const rows = await popup.$$eval("#events-body tr", (trs) => trs.length);
    await pick("");
    await popup.close();
    expect(
      options.includes("") && options.includes("claude.ai") && options.includes("chatgpt.com"),
      `options: ${options}`,
    );
    expect(hero === "2", `hero for claude.ai: ${hero}`);
    expect(!bySite.includes("chatgpt.com"), `by-site still lists other tools: ${bySite}`);
    expect(rows === 2, `${rows} activity rows for claude.ai`);
  });

  await check(
    "C9",
    'Per-site mode: "Stricter here" on one AI tool turns its warnings into the blocking dialog',
    async () => {
      await resetState(ctx, {});
      await store.set(ctx, { events: seedEvents() });
      const popup = await openPopup(ctx);
      await popup.evaluate(() => {
        const sel = document.querySelector("#site-filter");
        sel.value = "chatgpt.com";
        sel.dispatchEvent(new Event("change"));
      });
      await sleep(200);
      const visible = await popup.$eval("#site-mode", (n) => !n.hidden);
      await popup.evaluate(() => {
        const sel = document.querySelector("#site-mode");
        sel.value = "block";
        sel.dispatchEvent(new Event("change"));
        const f = document.querySelector("#site-filter");
        f.value = "";
        f.dispatchEvent(new Event("change"));
      });
      await sleep(300);
      await popup.close();
      expect(visible, "site mode control not shown for a chosen tool");
      const { siteModes } = await store.get(ctx, "siteModes");
      expect(siteModes?.["chatgpt.com"] === "block", `siteModes: ${JSON.stringify(siteModes)}`);
      await withSite(ctx, "chatgpt", async (page) => {
        await typeText(page, "call me at 937-555-5636");
        const dialog = await waitForDialog(page);
        expect(dialog?.text.includes("Phone Number"), "phone didn't block on the stricter site");
        await clickDialogButton(page, "Leave it in");
      });
      await store.set(ctx, { siteModes: {}, events: [] });
    },
  );

  await check("C10", "Profile exposure counts different personal details each AI tool received", async () => {
    const DAY = 86400000;
    const ev = (site, type, fp, action = "allowed") => ({
      t: Date.now() - 40 * DAY,
      site,
      type,
      name: type,
      severity: "medium",
      action,
      fp,
    });
    await store.set(ctx, {
      events: [
        ev("chatgpt.com", "phone_number", "a000000000000001"),
        ev("chatgpt.com", "phone_number", "a000000000000001"), // same phone again: still one detail
        ev("chatgpt.com", "email", "a000000000000002"),
        ev("chatgpt.com", "street_address", "a000000000000003", "redacted"), // never sent
        ev("chatgpt.com", "aws_access_key", "a000000000000004"), // a key, not personal
        ev("claude.ai", "family_name", "a000000000000005"),
      ],
    });
    const popup = await openPopup(ctx);
    await popup.click('.range [data-days="7"]');
    const rows = await popup.$$eval("#exposure .hbar", (bs) => bs.map((b) => b.title));
    await shot(popup, "popup-exposure.png");
    await popup.close();
    await store.set(ctx, { events: [] });
    expect(
      JSON.stringify(rows) === JSON.stringify(["chatgpt.com: 2", "claude.ai: 1"]),
      `rows: ${JSON.stringify(rows)}`,
    );
  });

  await check("C7", "Clear history (two clicks) empties the dashboard", async () => {
    await store.set(ctx, { events: seedEvents() });
    const popup = await openPopup(ctx);
    await popup.click("#tab-settings");
    await shot(popup, "popup-settings.png");
    await popup.click("#clear");
    expect((await store.events(ctx)).length > 0, "cleared after one click");
    await popup.click("#clear");
    await sleep(300);
    expect((await store.events(ctx)).length === 0, "not cleared after two clicks");
    await popup.click("#tab-overview");
    await sleep(200);
    expect(await popup.$eval("#empty-overview", (n) => !n.hidden), "empty state not shown");
    await popup.close();
  });

  await check(
    "C11",
    "Settings: Bandage lists each AI tool that has answered, on/off; toggling one updates storage",
    async () => {
      await store.set(ctx, { bandage: { "chatgpt.com": true, "claude.ai": false } });
      const popup = await openPopup(ctx);
      await popup.click("#tab-settings");
      await sleep(200);
      const rows = await popup.$$eval("#bandage-sites li", (lis) =>
        lis.map((li) => ({ host: li.querySelector("span").textContent, on: li.querySelector("input").checked })),
      );
      expect(
        rows.length === 2 &&
          rows.some((r) => r.host === "chatgpt.com" && r.on) &&
          rows.some((r) => r.host === "claude.ai" && !r.on),
        `rows: ${JSON.stringify(rows)}`,
      );
      await popup.evaluate(() => {
        const li = [...document.querySelectorAll("#bandage-sites li")].find((n) =>
          n.textContent.includes("chatgpt.com"),
        );
        const cb = li.querySelector("input");
        cb.checked = false;
        cb.dispatchEvent(new Event("change"));
      });
      await sleep(300);
      await popup.close();
      const { bandage } = await store.get(ctx, "bandage");
      expect(bandage?.["chatgpt.com"] === false, `bandage: ${JSON.stringify(bandage)}`);
      await store.set(ctx, { bandage: {} });
    },
  );
  await check(
    "WL1",
    "Settings: Show the welcome page opens it again, with the author's note and the practice box",
    async () => {
      const popup = await openPopup(ctx);
      const before = (await ctx.browser.pages()).length;
      await popup.evaluate(() => document.getElementById("open-welcome").click());
      const opened = await waitFor(async () => {
        const pages = await ctx.browser.pages();
        return pages.length > before ? pages.find((p) => p.url().endsWith("vault.html?welcome=1")) : null;
      }, 3000);
      expect(opened, "the welcome page didn't open");
      const shown = await waitFor(
        () =>
          opened.evaluate(() =>
            !document.getElementById("welcome").hidden && document.querySelector(".author-note")
              ? {
                  note: document.querySelector(".author-note").textContent,
                  practice: Boolean(document.getElementById("try")),
                }
              : null,
          ),
        3000,
      );
      expect(shown && /Hi, I'm Alex/.test(shown.note) && shown.practice, `welcome: ${JSON.stringify(shown)}`);
      await opened.close();
      await popup.close();
    },
  );
};
