// E2E checks: Stress (only with --stress: npm run test:stress; slow, run before releases). Run in order by ../run.js with one shared env (helpers from ../lib.js).
"use strict";

module.exports = async function (env) {
  const {
    ALL_GUIDED,
    KEY,
    OUT,
    TYPED_VALUES,
    argv,
    check,
    clickDialogButton,
    ctx,
    docxXml,
    expect,
    fs,
    makeZip,
    openExtPage,
    openPopup,
    openSite,
    path,
    pressEnter,
    readNotice,
    resetState,
    sentMessages,
    sleep,
    store,
    typeText,
    waitFor,
    withSite,
  } = env;
  if (argv.includes("--stress")) {
    await check(
      "STS1",
      "Stress: a 2 MB paste with a key buried in the middle is caught, and the page stays responsive",
      () =>
        withSite(ctx, "chatgpt", async (page) => {
          await resetState(ctx, {});
          const filler = "The quarterly numbers look fine and nothing here is private at all. ".repeat(15000); // ~1 MB
          const text = `${filler}my key ${KEY} ${filler}`;
          const t0 = Date.now();
          await typeText(page, text);
          const notice = await waitFor(() => readNotice(page), 15000);
          const caughtMs = Date.now() - t0;
          expect(notice && /AWS Access Key/.test(notice.text), `not caught (${caughtMs} ms)`);
          const t1 = Date.now();
          await page.evaluate(() => 1 + 1);
          const pingMs = Date.now() - t1;
          expect(pingMs < 1000, `page unresponsive: ${pingMs} ms to answer`);
          return `${(text.length / 1e6).toFixed(1)} MB caught in ${caughtMs} ms; page answered in ${pingMs} ms`;
        }),
    );

    await check("STS2", "Stress: 12 chat tabs hiding a key at once lose no history records", async () => {
      await resetState(ctx, {});
      const pages = [];
      for (let i = 0; i < 12; i++) pages.push(await openSite(ctx, "chatgpt"));
      try {
        await Promise.all(
          pages.map(async (page, i) => {
            await typeText(page, `tab ${i} key AKIA${String(i).padStart(4, "0")}HPQ7XZ2R6TWL`);
            const n = await waitFor(() => readNotice(page), 8000);
            expect(n, `tab ${i}: no notice`);
          }),
        );
        await Promise.all(pages.map((page) => clickDialogButton(page, "Hide it", readNotice)));
        const events =
          (await waitFor(async () => {
            const ev = await store.events(ctx);
            return ev.length >= 12 ? ev : null;
          }, 8000)) || (await store.events(ctx));
        expect(
          events.length === 12 && events.every((e) => e.action === "redacted"),
          `records: ${events.length} (${[...new Set(events.map((e) => e.action))]})`,
        );
      } finally {
        for (const p of pages) await p.close();
        await store.set(ctx, { events: [] });
      }
    });

    await check(
      "STS3",
      "Stress: history at its 10,000-record cap: popup and full report open fast, new records still append",
      async () => {
        const now = Date.now();
        const many = Array.from({ length: 10000 }, (_, i) => ({
          t: now - (10000 - i) * 60000,
          site: ["chatgpt.com", "claude.ai", "gemini.google.com"][i % 3],
          type: "email",
          name: "Email Address",
          severity: "low",
          action: ["allowed", "redacted", "suppressed"][i % 3],
          fp: (i % 4096).toString(16).padStart(16, "0"),
        }));
        await store.set(ctx, { events: many });
        try {
          let t0 = Date.now();
          const popup = await openPopup(ctx);
          await popup.waitForSelector("#hero-value");
          const popupMs = Date.now() - t0;
          await popup.close();
          t0 = Date.now();
          const dash = await openExtPage(ctx, "dashboard.html");
          await dash.waitForFunction(() => document.querySelectorAll("#map [data-service]").length > 0, {
            timeout: 10000,
          });
          const dashMs = Date.now() - t0;
          await dash.close();
          await ctx.worker.evaluate(() =>
            enqueue(() =>
              appendEvents([
                {
                  t: Date.now(),
                  site: "chatgpt.com",
                  type: "email",
                  name: "Email Address",
                  severity: "low",
                  action: "allowed",
                  fp: "ffffffffffffffff",
                },
              ]),
            ),
          );
          const after = await store.events(ctx);
          expect(
            after.length === 10000 && after.at(-1).fp === "ffffffffffffffff",
            `after append: ${after.length} records, newest ${after.at(-1)?.fp}`,
          );
          expect(popupMs < 3000 && dashMs < 4000, `popup ${popupMs} ms, full report ${dashMs} ms`);
          return `popup ${popupMs} ms, full report ${dashMs} ms`;
        } finally {
          await store.set(ctx, { events: [] });
        }
      },
    );

    await check(
      "STS4",
      "Stress: 300 single keystrokes: no errors, the scan waits for the pause, the warning appears once",
      () =>
        withSite(ctx, "chatgpt", async (page) => {
          await resetState(ctx, {});
          await page.evaluate(`${page.site.editor}.focus()`);
          const text = `my key ${KEY} `.repeat(12).slice(0, 300);
          TYPED_VALUES.add(text);
          await page.keyboard.type(text, { delay: 5 });
          const n = await waitFor(() => readNotice(page), 5000);
          expect(n && /AWS Access Key/.test(n.text), "no warning after typing");
          const warnings = page.logs.filter((l) => l.includes("[Clotr] warning about")).length;
          expect(warnings <= 3, `the scan ran ${warnings} times while typing (debounce broken)`);
          return `${warnings} scan(s) for 300 keystrokes`;
        }),
    );

    await check("STS5", "Stress: a vault with 1,000 entries keeps checks fast", () =>
      withSite(ctx, "chatgpt", async (page) => {
        const vault = Array.from({ length: 1000 }, (_, i) => ({
          kind: "word",
          type: "watch_list",
          fp: i.toString(16).padStart(16, "0"),
          words: 1 + (i % 4),
          mode: "protect",
          added: Date.now(),
        }));
        await store.set(ctx, { events: [], responses: {}, vault, guided: ALL_GUIDED });
        try {
          const t0 = Date.now();
          await typeText(page, `a normal message about the weather and my key ${KEY}`);
          const n = await waitFor(() => readNotice(page), 5000);
          const ms = Date.now() - t0;
          expect(n, "no warning");
          expect(ms < 3000, `${ms} ms to warn with 1,000 vault entries`);
          return `${ms} ms to warn`;
        } finally {
          await store.set(ctx, { vault: [] });
        }
      }),
    );
    await check(
      "STS6",
      "Stress: 60 attached files at once (text, Word, spreadsheets): one notice, the first 50 checked, the chat stays responsive",
      () =>
        withSite(ctx, "chatgpt", async (page) => {
          await resetState(ctx, {});
          const dir = path.join(OUT, "sts6");
          fs.mkdirSync(dir, { recursive: true });
          const files = [];
          const filler = "Agenda item and minutes, nothing private here. ".repeat(4000); // ~190 KB each
          for (let i = 0; i < 60; i++) {
            const risky = i % 10 === 3 ? `mail p${i}@gmail.com` : "";
            if (risky) TYPED_VALUES.add(risky);
            const kind = i % 3;
            const file = path.join(dir, `doc${i}.${["txt", "docx", "xlsx"][kind]}`);
            if (kind === 0) fs.writeFileSync(file, `${filler}\n${risky}\n`);
            else if (kind === 1) makeZip(file, [["word/document.xml", docxXml([filler, risky])]]);
            else
              makeZip(file, [["xl/sharedStrings.xml", `<sst><si><t>${filler}</t></si><si><t>${risky}</t></si></sst>`]]);
            files.push(file);
          }
          const t0 = Date.now();
          await (await page.$("#attach")).uploadFile(...files);
          const notice = await waitFor(async () => {
            const n = await readNotice(page);
            return n && /files you attached/.test(n.text) ? n : null;
          }, 20000);
          const ms = Date.now() - t0;
          const t1 = Date.now();
          await page.evaluate(() => 1 + 1);
          const pingMs = Date.now() - t1;
          fs.rmSync(dir, { recursive: true });
          // Files 3, 13, 23, 33, 43 are within the first 50; 53 isn't checked (MAX_FILES).
          expect(
            notice && /5 files you attached/.test(notice.text) && /and 2 more/.test(notice.text),
            `notice: ${notice?.text}`,
          );
          expect(
            page.logs.some((l) => l.includes("checking the first 50 of 60")),
            "no log about the 50-file cap",
          );
          expect(pingMs < 1000, `page unresponsive: ${pingMs} ms`);
          return `60 files (~11 MB) checked in ${ms} ms; page answered in ${pingMs} ms`;
        }),
    );

    await check(
      "STS7",
      "Stress: a day-long tab (500 warned messages, AI replies after each): heap steady, one notice at a time, every record kept",
      () =>
        withSite(ctx, "chatgpt", async (page) => {
          await resetState(ctx, {});
          page.cdp ??= await page.createCDPSession();
          const heap = async () => {
            await page.cdp.send("HeapProfiler.collectGarbage");
            return (await page.metrics()).JSHeapUsedSize;
          };
          const round = async (i) => {
            await typeText(page, `note ${i}: reach me at 937-555-${String(1000 + i).slice(-4)}`);
            await waitFor(() => readNotice(page), 3000);
            await pressEnter(page);
            await page.evaluate((n) => window.__reply(`Sure, here is a long answer number ${n}. `.repeat(20)), i);
          };
          for (let i = 0; i < 50; i++) await round(i); // warm up
          const before = await heap();
          for (let i = 50; i < 500; i++) await round(i);
          await sleep(500);
          const grew = (await heap()) - before;
          const hosts = await page.evaluate(() => document.querySelectorAll("clotr-notice, clotr-guard").length);
          const sent = (await sentMessages(page)).length;
          const events =
            (await waitFor(async () => {
              const ev = await store.events(ctx);
              return ev.length >= 500 ? ev : null;
            }, 8000)) || (await store.events(ctx));
          const errors = page.logs.filter((l) => /\[Clotr\].*(error|failed)/i.test(l));
          expect(sent === 500, `sent ${sent} of 500`);
          expect(events.length === 500, `records: ${events.length} of 500`);
          expect(hosts <= 1, `${hosts} Clotr elements left in the page`);
          expect(grew < 5 * 1024 * 1024, `heap grew ${(grew / 1024 / 1024).toFixed(1)} MB over 450 messages`);
          expect(!errors.length, `errors: ${errors.slice(0, 3).join(" | ")}`);
          return `heap +${(grew / 1024 / 1024).toFixed(2)} MB over 450 messages`;
        }),
    );
  }
};
