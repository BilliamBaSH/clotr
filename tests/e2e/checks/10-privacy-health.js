// E2E checks: Z. Privacy & health. Run in order by ../run.js with one shared env (helpers from ../lib.js).
"use strict";

module.exports = async function (env) {
  const {
    KEY,
    OUT,
    TYPED_VALUES,
    check,
    clickDialogButton,
    clickSend,
    ctx,
    editorText,
    expect,
    openExtPage,
    openPopup,
    path,
    pressEnter,
    readNotice,
    resetState,
    sentMessages,
    sleep,
    store,
    typeText,
    waitFor,
    waitForDialog,
    waitForNotice,
    withSite,
  } = env;
  await check("Z1", "Nothing typed during the run is stored anywhere by Clotr", async () => {
    const all = JSON.stringify(await store.get(ctx, null));
    const session = JSON.stringify(await ctx.worker.evaluate(() => chrome.storage.session.get(null)));
    const leaked = [...TYPED_VALUES]
      .flatMap((v) => [v, ...(v.match(/AKIA[0-9A-Z]{16}|\d{3}-\d{3}-\d{4}|\S+ at gmail dot com/g) || [])])
      .filter((v) => v.length >= 8 && (all.includes(v) || session.includes(v)));
    expect(!leaked.length, `found in storage: ${leaked.join(", ")}`);
    return `${TYPED_VALUES.size} inputs checked against ${all.length + session.length} bytes of storage`;
  });

  await check(
    "UN1",
    "A key with a hidden zero-width space and a phone with no-break spaces are caught; Hide it leaves nothing behind",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        const key = "AKIA4HPQ\u200b7XZ2R6TWLJ3N";
        await typeText(page, `key ${key} or call 937\u00a0555\u00a00123`);
        const n = await waitForNotice(page);
        expect(n?.text.includes("AWS Access Key") && n.text.includes("Phone Number"), `notice: ${n?.text}`);
        await clickDialogButton(page, "Hide it", readNotice);
        const text = await editorText(page);
        expect(
          !text.includes("AKIA4HPQ") && !text.includes("0123") && !/\u200b/.test(text),
          `after Hide it: ${JSON.stringify(text)}`,
        );
      }),
  );

  await check(
    "FS1",
    "Fast send (paste, then Enter at once): the message goes, then a 'Just sent' notice says what went and offers to ask first next time",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await typeText(page, "call me at 937-555-0123");
        await pressEnter(page); // before the 400 ms pause: the warning was never visible
        await sleep(300);
        expect((await sentMessages(page)).length === 1, "the message didn't send (Warn must never hold it)");
        const n = await waitFor(() => readNotice(page), 2000);
        expect(n?.text.includes("Just sent to this AI") && n.text.includes("Phone Number"), `notice: ${n?.text}`);
        await clickDialogButton(page, "Ask me first next time", readNotice);
        const responses = await waitFor(
          async () => ((await store.get(ctx, "responses")).responses?.phone_number === "block" ? true : null),
          2000,
        );
        expect(responses, "the choice wasn't saved");
      }),
  );

  await check(
    "FS3",
    "Fast send the site ignores (Gemini did): no false 'Just sent', nothing recorded as sent, the warning shows instead",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await page.evaluate(() => {
          window.__ignoreNextSend = true;
        });
        await typeText(page, "call me at 937-555-0123");
        await pressEnter(page);
        await sleep(2000);
        expect((await sentMessages(page)).length === 0, "the page was supposed to ignore this Enter");
        const n = await readNotice(page);
        expect(n && !n.text.includes("Just sent") && n.text.includes("Phone Number"), `notice: ${n?.text}`);
        const sentEvents = (await store.events(ctx)).filter((e) => e.action === "allowed");
        expect(!sentEvents.length, `recorded as sent: ${JSON.stringify(sentEvents)}`);
      }),
  );

  await check(
    "EG1",
    "A site with its own early Enter handler can't send before Clotr: Ask before sending holds the key",
    async () => {
      await resetState(ctx); // Ask before sending for keys, set before the page opens
      return withSite(ctx, "eager", async (page) => {
        await typeText(page, `key ${KEY}`);
        await pressEnter(page); // at once: the site's own handler would send
        await sleep(400);
        expect((await sentMessages(page)).length === 0, "the site's early Enter handler sent a held key");
        expect(await waitForDialog(page), "no dialog");
      });
    },
  );

  await check("EG2", "A site that sends on Enter key-up can't slip past Ask before sending", async () => {
    await resetState(ctx); // Ask before sending for keys, set before the page opens
    return withSite(ctx, "keyup", async (page) => {
      await typeText(page, `key ${KEY}`);
      await pressEnter(page);
      await sleep(400);
      expect((await sentMessages(page)).length === 0, "sent on key-up despite Ask before sending");
      expect(await waitForDialog(page), "no dialog");
    });
  });

  await check(
    "MOB1",
    "Phone-sized screen (360×740, Firefox for Android): the warning fits and doesn't cover the chat box",
    () =>
      withSite(ctx, "demo", async (page) => {
        await page.setViewport({ width: 360, height: 740 }); // (isMobile would reload the page mid-test)
        await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
        await resetState(ctx, {});
        await typeText(page, "call me at 937-555-0123 or jane.doe@gmail.com");
        expect(await waitForNotice(page), "no notice");
        page.cdp ??= await page.createCDPSession();
        const box = async () => {
          const { root } = await page.cdp.send("DOM.getDocument", { depth: -1, pierce: true });
          let hit = null;
          (function walk(n) {
            if (hit) return;
            const cls = (n.attributes || []).join(" ");
            if (n.nodeName === "DIV" && / notice\b/.test(` ${cls}`)) hit = n;
            for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) walk(c);
          })(root);
          if (!hit) return null;
          const q = (await page.cdp.send("DOM.getBoxModel", { nodeId: hit.nodeId })).model.border;
          return {
            left: Math.min(q[0], q[6]),
            right: Math.max(q[2], q[4]),
            top: Math.min(q[1], q[3]),
            bottom: Math.max(q[5], q[7]),
          };
        };
        const n = await box();
        await page.screenshot({ path: path.join(OUT, "mobile-notice.png") });
        const input = await page.$eval("#prompt", (t) => {
          const r = t.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom };
        });
        expect(n && n.left >= 0 && n.right <= 360, `notice outside the screen: ${JSON.stringify(n)}`);
        expect(
          n.bottom <= input.top,
          `the notice covers the chat box: notice ${JSON.stringify(n)}, box ${JSON.stringify(input)}`,
        );
      }),
  );

  await check(
    "UB1",
    "Unlabeled icon send button + Ask before sending: clicking it right after pasting a key is held for your answer",
    async () => {
      await resetState(ctx); // Ask before sending for keys, set before the page opens
      return withSite(ctx, "iconsend", async (page) => {
        await typeText(page, `key ${KEY}`);
        await clickSend(page); // before the 400 ms pause
        await sleep(400);
        expect((await sentMessages(page)).length === 0, "the unlabeled send button sent a held message");
        expect(await waitForDialog(page), "no dialog");
      });
    },
  );

  await check(
    "UB2",
    "Unlabeled icon send button + Warn: the message goes, then 'Just sent' (confirmed by the box emptying)",
    () =>
      withSite(ctx, "iconsend", async (page) => {
        await resetState(ctx, {});
        await typeText(page, "call me at 937-555-0123");
        await clickSend(page);
        await sleep(300);
        expect((await sentMessages(page)).length === 1, "didn't send (Warn must never hold)");
        const n = await waitFor(() => readNotice(page), 2500);
        expect(n?.text.includes("Just sent"), `notice: ${n?.text}`);
      }),
  );

  await check(
    "UB3b",
    "Ask before sending: the chat box's model picker still opens while a key waits for an answer",
    () =>
      withSite(ctx, "iconsend", async (page) => {
        await resetState(ctx);
        await typeText(page, `key ${KEY}`);
        const opened = await page.evaluate(
          () =>
            new Promise((resolve) => {
              const b = document.getElementById("mode");
              b.addEventListener("click", () => resolve(true), { once: true });
              b.click();
              setTimeout(() => resolve(false), 300);
            }),
        );
        expect(opened, "Clotr held a click on the model picker");
      }),
  );

  await check("UB3", "Other buttons in the chat box (Attach) are never counted as a send", () =>
    withSite(ctx, "iconsend", async (page) => {
      await resetState(ctx, {});
      await typeText(page, "call me at 937-555-0123");
      await page.evaluate(() => document.getElementById("attach").click());
      await sleep(2000);
      expect((await sentMessages(page)).length === 0, "attach sent the message");
      const n = await readNotice(page);
      expect(!n?.text.includes("Just sent"), `false 'Just sent': ${n?.text}`);
      expect(!(await store.events(ctx)).some((e) => e.action === "allowed"), "an Attach click was recorded as a send");
    }),
  );

  await check("FS2", "No 'Just sent' notice when the warning was on screen and you chose to send", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      await typeText(page, "call me at 937-555-0123");
      expect(await waitForNotice(page), "no warning");
      await sleep(1600); // time to read it
      await pressEnter(page);
      await sleep(600);
      expect((await sentMessages(page)).length === 1, "didn't send");
      const n = await readNotice(page);
      expect(!n || !n.text.includes("Just sent"), `nagged after an informed send: ${n?.text}`);
    }),
  );

  await check("PP1", "Popup away from an AI chat says where Clotr works (the built-in list by name)", async () => {
    const popup = await openPopup(ctx);
    const line = await popup.$eval("#site", (n) => n.innerText);
    await popup.close();
    expect(/works on ChatGPT, Claude, Gemini and \d+ more AI chats/.test(line), `site card: ${JSON.stringify(line)}`);
  });

  await check(
    "CSP1",
    "Clotr's pages run under the strict policy with no violations (popup tabs, welcome, vault, What Clotr stores)",
    async () => {
      const pages = [];
      const popup = await openPopup(ctx);
      pages.push(["popup", popup]);
      for (const f of ["vault.html?welcome=1", "vault.html", "stored.html", "dashboard.html", "policy.html"])
        pages.push([f, await openExtPage(ctx, f)]);
      const violations = [];
      try {
        for (const [name, page] of pages) {
          const csp = await page.evaluate(
            () =>
              new Promise((resolve) => {
                const seen = [];
                document.addEventListener("securitypolicyviolation", (e) =>
                  seen.push(`${e.violatedDirective} ${e.blockedURI}`),
                );
                // Exercise the page, then collect.
                for (const t of document.querySelectorAll('[role="tab"], #tab-overview, #tab-activity, #tab-settings'))
                  t.click?.();
                setTimeout(() => resolve(seen), 800);
              }),
          );
          violations.push(...csp.map((v) => `${name}: ${v}`));
        }
        const header = await popup.evaluate(() =>
          fetch(location.href)
            .then(() => "fetch self ok")
            .catch((e) => String(e)),
        );
        expect(header === "fetch self ok", `own files must stay readable: ${header}`);
        const outside = await popup.evaluate(() =>
          fetch("https://chatgpt.com/robots.txt")
            .then(() => "reached chatgpt.com")
            .catch(() => "blocked"),
        ); // a host Clotr has permission for: only the policy stops it
        expect(outside === "blocked", `a page could connect out: ${outside}`);
      } finally {
        for (const [, page] of pages) await page.close();
      }
      expect(!violations.length, violations.slice(0, 5).join(" | "));
    },
  );
};
