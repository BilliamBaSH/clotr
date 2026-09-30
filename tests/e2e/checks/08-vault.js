// E2E checks: V. Your vault ("What should I protect?"). Run in order by ../run.js with one shared env (helpers from ../lib.js).
"use strict";

module.exports = async function (env) {
  const {
    ALL_GUIDED,
    DIALOG_WAIT,
    KEY,
    OUT,
    TYPED_VALUES,
    check,
    clearEditor,
    clickDialogButton,
    ctx,
    expect,
    expectNoUI,
    openExtPage,
    openPopup,
    path,
    pressEnter,
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
  await check("V0", 'First install opens "What should I protect?"', async () => {
    // Waits a moment: run first (--only V), the check can start before the install opened the tab.
    const t = await waitFor(() => ctx.browser.targets().find((x) => x.url().includes("/vault.html?welcome=1")), 5000);
    expect(
      t,
      `targets: ${ctx.browser
        .targets()
        .map((x) => x.url())
        .join(", ")}`,
    );
  });

  const MY = {
    my_name: "Jane Q Doe",
    family_name: "Emma",
    employer: "Initech",
    street_address: "123 Oak Street",
    phone_number: "(937) 555-5636",
    email: "jane.doe@gmail.com",
    my_id: "AB-123456",
    watch_list: "Project Falcon\nEMP-#####",
  };
  await check(
    "W1",
    "First install: welcome explains Clotr in plain words; the practice box warns and redacts, and records nothing",
    async () => {
      await resetState(ctx, {});
      const page = await openExtPage(ctx, "vault.html?welcome=1");
      try {
        const intro = await page.evaluate(() => ({
          visible: !document.getElementById("welcome").hidden,
          h1: document.querySelector("h1").textContent,
          text: document.getElementById("welcome").innerText,
        }));
        expect(intro.visible && intro.h1 === "Welcome to Clotr", `welcome: ${JSON.stringify(intro).slice(0, 200)}`);
        const pin = await page.evaluate(() => document.getElementById("pin-step")?.innerText || "");
        expect(/puzzle piece/i.test(pin) || /Clotr is pinned/.test(pin), `pin step: ${JSON.stringify(pin)}`);
        for (const fact of [
          "Only on AI chats",
          "Nothing leaves this computer",
          "never saves what you type",
          "It only warns",
          "Only in this browser",
        ]) {
          expect(intro.text.includes(fact), `missing: "${fact}"`);
        }
        TYPED_VALUES.add(KEY);
        await page.type("#try", `my key ${KEY}`);
        const shown = await waitFor(() => page.evaluate(() => document.querySelector(".try-notice")?.innerText), 3000);
        expect(shown?.includes("AWS Access Key (AKIA…3N)") && !shown.includes(KEY), `practice warning: ${shown}`);
        await shot(page, "welcome.png");
        await page.click(".try-notice .btn");
        const after = await page.$eval("#try", (t) => t.value);
        expect(after.includes("[REDACTED AWS ACCESS KEY]") && !after.includes(KEY), `after Redact: ${after}`);
        expect(!(await store.events(ctx)).length, "the practice box recorded an event");
      } finally {
        await page.close();
      }
      const plain = await openExtPage(ctx, "vault.html");
      const hidden = await plain.evaluate(() => document.getElementById("welcome").hidden);
      await plain.close();
      expect(hidden, "the welcome shows on the normal vault page too");
    },
  );

  await check(
    "V1s",
    "Vault page: typed details aren't kept by the browser (no autocomplete; fields cleared when the page is hidden)",
    async () => {
      const page = await openExtPage(ctx, "vault.html");
      try {
        const off = await page.$$eval("textarea", (ts) => ts.every((t) => t.getAttribute("autocomplete") === "off"));
        expect(off, "a vault field allows autocomplete (the browser could keep what was typed)");
        TYPED_VALUES.add("Jane Unsaved Example");
        await page.type("#f-my_name", "Jane Unsaved Example");
        await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
        const left = await page.$eval("#f-my_name", (t) => t.value);
        expect(left === "", `still in the field after pagehide: ${JSON.stringify(left)}`);
      } finally {
        await page.close();
      }
    },
  );

  await check(
    "V8",
    "Vault addresses match with or without accents, and an entry saved before still matches as typed",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        const [fresh, legacy] = await ctx.worker.evaluate(async () => {
          const salt = await ensureSalt();
          return [
            globalThis.Clotr.fingerprint(salt, "street_address", "Calle Alcalá 45"),
            globalThis.Clotr.fingerprint(salt, "street_address_accented", "Avenida Andalucía 12"),
          ];
        });
        // "Just count" for addresses, so only a vault entry ("always watch") makes a warning.
        await store.set(ctx, {
          events: [],
          guided: ALL_GUIDED,
          responses: { street_address: "log" },
          vault: [
            { kind: "value", type: "street_address", fp: fresh, mode: "protect", added: Date.now() },
            { kind: "value", type: "street_address", fp: legacy, mode: "protect", added: Date.now() },
          ],
        });
        try {
          await typeText(page, "vivo en Calle Alcala 45, Madrid");
          expect(await waitForNotice(page), "no warning for the vault address typed without accents");
          await withSite(ctx, "chatgpt", async (other) => {
            await typeText(other, "mi oficina está en Avenida Andalucía 12");
            expect(await waitForNotice(other), "no warning for an address saved by an older version");
          });
        } finally {
          await store.set(ctx, { vault: [], responses: {} });
        }
      }),
  );

  await check(
    "V1",
    "Vault page saves fingerprints only, then your details are caught however they're written",
    async () => {
      await resetState(ctx, {});
      await store.set(ctx, { vault: [] });
      const vp = await openExtPage(ctx, "vault.html");
      for (const [type, value] of Object.entries(MY)) {
        value.split("\n").forEach((v) => TYPED_VALUES.add(v));
        await vp.type(`#f-${type}`, value);
      }
      await vp.click("#save");
      const msg = await waitFor(async () => vp.$eval("#save-msg", (n) => n.textContent || null), 3000);
      const leftover = await vp.$$eval("textarea", (ts) => ts.map((t) => t.value).join(""));
      await sleep(300);
      await shot(vp, "vault-page.png");
      await vp.close();
      expect(/Saved 10 new items/.test(msg || ""), `message: ${msg}`); // AB-123456 = its format + a fingerprint (D23)
      expect(leftover === "", `text left in the form: ${leftover}`);
      const stored = JSON.stringify((await store.get(ctx, "vault")).vault);
      const plain = /jane|emma|initech|oak|5636|123456|falcon|gmail/i.exec(stored);
      expect(!plain, `readable value in storage: ${plain?.[0]}`);
      await withSite(ctx, "chatgpt", async (page) => {
        const cases = [
          [
            "hi, I'm jane q doe and my kid emma lives at one twenty three oak st",
            ["Your Name", "Family Member's Name", "Street Address"],
          ],
          ["I work at INITECH on project falcon, badge EMP-12345", ["Your Employer", "Watch List Item"]],
          ["my member number is AB-123456", ["Your Account/ID Number"]],
          ["their member number is ab-998877", ["Account/ID Number"]],
        ];
        for (const [text, names] of cases) {
          await clearEditor(page);
          await typeText(page, text);
          const n = await waitForNotice(page);
          const missing = names.filter((name) => !n?.text.includes(name));
          expect(!missing.length, `"${text}" → missing ${missing.join(", ")} (notice: ${n?.text})`);
          if (text.startsWith("their"))
            expect(
              !n.text.includes("Your Account/ID Number"),
              `someone else's ID in your format was called yours: ${n.text}`,
            );
          await clickDialogButton(page, "Leave it in", readNotice);
        }
      });
    },
  );

  // Pre-release Batch 5: "your own rules" from Settings.
  await check(
    "V9",
    'Settings → "Your own words and formats" opens the vault with "Anything else to watch for" ready to type in',
    async () => {
      const popup = await openPopup(ctx);
      try {
        await popup.click("#tab-settings");
        const before = (await ctx.browser.pages()).length;
        await popup.click("#open-watch");
        const page = await waitFor(async () => {
          const pages = await ctx.browser.pages();
          return pages.length > before ? pages.find((p) => p.url().endsWith("vault.html#watch")) : null;
        }, 3000);
        expect(page, "the vault didn't open at #watch");
        const focused = await waitFor(
          () => page.evaluate(() => (document.activeElement?.id === "f-watch_list" ? true : null)),
          2000,
        );
        expect(focused, "the watch field isn't focused");
        await page.close();
      } finally {
        await popup.close();
      }
    },
  );

  await check("V2", "A vault item still warns when its type is set to Log only", async () => {
    await store.set(ctx, { responses: { phone_number: "log" } });
    await withSite(ctx, "chatgpt", async (page) => {
      await typeText(page, "call 937.555.5636");
      const n = await waitForNotice(page);
      expect(n?.text.includes("Phone Number"), `your phone wasn't caught: ${n?.text}`);
      await clickDialogButton(page, "Leave it in", readNotice);
      await clearEditor(page);
      await typeText(page, "or 937-555-1234");
      await expectNoUI(page, "other phone numbers are Log only");
    });
  });

  await check("V3", 'Vault → "OK to share" makes your own item quiet; Remove forgets it', async () => {
    await store.set(ctx, { responses: {} });
    const vp = await openExtPage(ctx, "vault.html");
    const setPhone = (v) =>
      vp.evaluate((val) => {
        const li = [...document.querySelectorAll("#vault-list li")].find((x) => x.textContent.includes("Phone number"));
        const sel = li.querySelector("select");
        sel.value = val;
        sel.dispatchEvent(new Event("change"));
      }, v);
    await setPhone("allow");
    await sleep(300);
    await store.set(ctx, { events: [] });
    await withSite(ctx, "chatgpt", async (page) => {
      await typeText(page, "call me at nine three seven five five five five six three six");
      await expectNoUI(page, "your phone is OK to share");
    });
    const logged = await store.events(ctx);
    expect(
      logged.length === 1 && logged[0].action === "suppressed",
      `OK-to-share item should still be recorded: ${JSON.stringify(logged)}`,
    );
    const before = (await store.get(ctx, "vault")).vault.length;
    await vp.evaluate(() =>
      [...document.querySelectorAll("#vault-list li")]
        .find((x) => x.textContent.includes("Phone number"))
        .querySelector("button")
        .click(),
    );
    await sleep(300);
    await vp.close();
    expect((await store.get(ctx, "vault")).vault.length === before - 1, "entry not removed");
  });

  // Deletes `part` from the chat box the way a user would: select it, press Backspace.
  async function deleteByHand(page, part) {
    await page.evaluate(
      (sel, p) => {
        const box = eval(sel);
        const i = box.value.indexOf(p);
        box.focus();
        box.setSelectionRange(i, i + p.length);
      },
      page.site.editor,
      part,
    );
    await page.keyboard.press("Backspace");
  }

  await check(
    "L1",
    'Learning: deleting a flagged item by hand offers "Add to my vault" (not after Redact or sending)',
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        // Sending empties the box: no offer afterwards.
        await typeText(page, "call me at 937-555-1111 later");
        expect(await waitForNotice(page), "no notice");
        await sleep(1600); // an informed send (no "Just sent" follow-up)
        await pressEnter(page);
        await sleep(300);
        await typeText(page, "thanks");
        await expectNoUI(page, "after sending");
        // Redact button: no offer.
        await clearEditor(page);
        await typeText(page, "call me at 937-555-2222 later");
        await waitForNotice(page);
        await clickDialogButton(page, "Hide it", readNotice);
        await expectNoUI(page, "after Redact");
        // Deleted by hand: offer.
        await clearEditor(page);
        await typeText(page, "call me at 937-555-5636 later");
        await waitForNotice(page);
        await deleteByHand(page, "937-555-5636");
        const offer = await waitFor(async () => {
          const n = await readNotice(page);
          return n?.text.includes("Always watch") ? n : null;
        }, DIALOG_WAIT);
        expect(offer, `no offer after deleting by hand (notice: ${(await readNotice(page))?.text})`);
        await page.screenshot({ path: path.join(OUT, "offer-vault.png") });
        await clickDialogButton(page, "Add to my vault", readNotice);
        const v = await waitFor(async () => ((await store.get(ctx, "vault")).vault || []).find((e) => e.learned), 2000);
        expect(
          v?.type === "phone_number" && v.mode === "protect" && /^[0-9a-f]{16}$/.test(v.fp),
          `vault: ${JSON.stringify(v)}`,
        );
      }),
  );

  await check("L2", "Learning: keeping the same type 3 times offers to relax it to Log only", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      for (let i = 1; i <= 3; i++) {
        await clearEditor(page);
        await typeText(page, `mail me at friend${i}@gmail.com`);
        expect(await waitForNotice(page), `no notice #${i}`);
        await clickDialogButton(page, "Leave it in", readNotice);
        await sleep(300);
      }
      const offer = await waitFor(async () => {
        const n = await readNotice(page);
        return n?.text.includes("Warn less") ? n : null;
      }, DIALOG_WAIT);
      expect(offer?.text.includes("Email Address"), `offer: ${(await readNotice(page))?.text}`);
      await page.screenshot({ path: path.join(OUT, "offer-relax.png") });
      await clickDialogButton(page, "Just count it", readNotice);
      await sleep(300);
      const { responses } = await store.get(ctx, "responses");
      expect(responses?.email === "log", `responses: ${JSON.stringify(responses)}`);
    }),
  );

  await check("V4", "Upgrade: It's me and watch-list entries move into the vault", async () => {
    await store.set(ctx, {
      vault: [],
      mine: [{ type: "email", fp: "0123456789abcdef", added: 1 }],
      watch: [
        { kind: "word", fp: "fedcba9876543210", words: 2, added: 2 },
        { kind: "shape", shape: "EMP-#####", added: 3 },
      ],
    });
    await ctx.worker.evaluate(() => migrateToVault());
    const got = await store.get(ctx, ["vault", "mine", "watch"]);
    await store.set(ctx, { vault: [] });
    expect(!got.mine && !got.watch, "old keys not removed");
    const v = got.vault || [];
    expect(
      v.length === 3 && v[0].mode === "allow" && v[1].type === "watch_list" && v[2].shape === "EMP-#####",
      `vault: ${JSON.stringify(v)}`,
    );
  });

  await check(
    "MIG1",
    "Upgrade from every earlier version's saved settings: clean result, history kept, dashboard opens",
    async () => {
      const ev = (type, name, severity, action, fp) => ({
        t: Date.now() - 3600000,
        site: "chatgpt.com",
        type,
        name,
        severity,
        action,
        fp,
      });
      const EVENTS = [
        ev("aws_access_key", "AWS Access Key", "high", "redacted", "0123456789abcdef"),
        ev("email", "Email Address", "medium", "suppressed", "abcdef0123456789"),
      ];
      const SAVED = {
        "v0.4": {
          events: EVENTS,
          suppressed: { global: { email: true, phone_number: false } },
          paused: { "claude.ai": true },
        },
        "v0.5": {
          events: EVENTS,
          responses: { phone_number: "off", aws_access_key: "block" },
          mine: [{ type: "phone_number", fp: "1111111111111111", added: 1 }],
        },
        "v0.7": {
          events: EVENTS,
          responses: { email: "log" },
          mine: [{ type: "email", fp: "2222222222222222", added: 1 }],
          watch: [
            { kind: "word", fp: "3333333333333333", words: 1, added: 2 },
            { kind: "shape", shape: "EMP-#####", added: 2 },
          ],
          siteModes: { "chatgpt.com": "block" },
        },
        "v0.8": {
          events: EVENTS,
          responses: { us_ssn: "off" },
          ignores: { email: [Date.now()] },
          vault: [{ kind: "value", type: "email", fp: "4444444444444444", mode: "protect", added: 3 }],
        },
        mixed: {
          events: EVENTS,
          suppressed: { global: { email: true } },
          responses: { email: "off", phone_number: "warn" },
          mine: [{ type: "email", fp: "4444444444444444", added: 1 }],
          vault: [{ kind: "value", type: "email", fp: "4444444444444444", mode: "allow", added: 3 }],
        },
      };
      const saved = await store.get(ctx);
      try {
        for (const [version, data] of Object.entries(SAVED)) {
          await ctx.worker.evaluate(
            (d) =>
              enqueue(async () => {
                await chrome.storage.local.clear();
                await chrome.storage.local.set(d);
              }),
            { ...data, salt: saved.salt },
          );
          const problemsBefore = ctx.problems.length;
          await ctx.worker.evaluate(() => runMigrations());
          const got = await store.get(ctx);
          const bad = (why) => `${version}: ${why} (${JSON.stringify(got)})`;
          expect(!("suppressed" in got) && !("mine" in got) && !("watch" in got), bad("old keys left"));
          expect(
            Object.values(got.responses || {}).every((r) => ["block", "warn", "log"].includes(r)),
            bad("invalid response"),
          );
          expect(
            await ctx.worker.evaluate((v) => v.every((e) => cleanVaultEntry(e)), got.vault || []),
            bad("invalid vault entry"),
          );
          expect(got.events?.length === EVENTS.length, bad("history lost"));
          const popup = await openPopup(ctx);
          await sleep(500);
          await popup.close();
          expect(
            ctx.problems.length === problemsBefore,
            `${version}: ${ctx.problems.slice(problemsBefore).join(" | ")}`,
          );
        }
      } finally {
        await ctx.worker.evaluate(
          (d) =>
            enqueue(async () => {
              await chrome.storage.local.clear();
              await chrome.storage.local.set(d);
            }),
          saved,
        );
      }
    },
  );
};
