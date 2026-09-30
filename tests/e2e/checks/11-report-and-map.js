// E2E checks: Full-page dashboard: "Your AI exposure report" (v1.0). Run in order by ../run.js with one shared env (helpers from ../lib.js).
"use strict";

module.exports = async function (env) {
  const {
    ALL_GUIDED,
    EXT,
    KEY,
    OUT,
    TYPED_VALUES,
    check,
    clearEditor,
    ctx,
    evalInClotr,
    expect,
    fs,
    launch,
    openExtPage,
    openPopup,
    openSite,
    path,
    pressEnter,
    readNotice,
    resetState,
    seedEvents,
    sentMessages,
    shot,
    sleep,
    store,
    typeText,
    waitFor,
    waitForDialog,
    waitForNotice,
    withSite,
  } = env;
  const DAY_MS = 86400000;
  const dashEvents = () => {
    const ev = (days, site, type, name, severity, action, fp) => ({
      t: Date.now() - days * DAY_MS - 60000,
      site,
      type,
      name,
      severity,
      action,
      fp,
    });
    return [
      ev(70, "gemini.google.com", "phone_number", "Phone Number", "medium", "allowed", "aaaaaaaaaaaaaaa1"),
      ev(30, "chatgpt.com", "phone_number", "Phone Number", "medium", "allowed", "aaaaaaaaaaaaaaa1"),
      ev(9, "chatgpt.com", "phone_number", "Phone Number", "medium", "allowed", "aaaaaaaaaaaaaaa1"),
      ev(9, "chatgpt.com", "email", "Email Address", "low", "allowed", "bbbbbbbbbbbbbbb2"),
      ev(8, "chatgpt.com", "aws_access_key", "AWS Access Key", "high", "allowed", "ccccccccccccccc3"),
      ev(5, "chatgpt.com", "street_address", "Street Address", "medium", "redacted", "ddddddddddddddd4"),
      ev(3, "claude.ai", "family_name", "Family Member's Name", "high", "allowed", "eeeeeeeeeeeeeee5"),
      ev(2, "claude.ai", "credit_card", "Credit Card Number", "high", "allowed", "fffffffffffffff6"),
      ev(1, "claude.ai", "password", "Password or Secret", "high", "suppressed", "999999999999999a"),
    ];
  };

  await check(
    "DSH1",
    "Full dashboard: totals, what each AI service was told (personal details only), 12-week trend",
    async () => {
      await store.set(ctx, { events: dashEvents() });
      const page = await openExtPage(ctx, "dashboard.html");
      await page.setViewport({ width: 1100, height: 1400 });
      try {
        await sleep(400);
        const got = await page.evaluate(() => ({
          totals: document.getElementById("totals").innerText,
          exposure: [...document.querySelectorAll("#exposure [data-site]")].map(
            (n) => `${n.dataset.site}:${n.dataset.details}`,
          ),
          weeks: document.querySelectorAll("#weeks [data-week]").length,
        }));
        await shot(page, "dashboard.png");
        expect(
          /9\b/.test(got.totals) &&
            /1\s*Hidden/.test(got.totals) &&
            /7\s*Sent/.test(got.totals) &&
            /1\s*Just counted/.test(got.totals),
          `totals: ${got.totals}`,
        );
        expect(
          JSON.stringify(got.exposure) === JSON.stringify(["chatgpt.com:2", "claude.ai:2", "gemini.google.com:1"]),
          `exposure: ${JSON.stringify(got.exposure)}`,
        );
        expect(got.weeks === 12, `weeks: ${got.weeks}`);
      } finally {
        await page.close();
      }
    },
  );

  await check(
    "DSH1B",
    "Full dashboard: what Bandage kept from each AI, apart from what was hidden by hand; hidden until Bandage covers something",
    async () => {
      const ev = (site, via) => ({
        t: Date.now(),
        site,
        type: "phone_number",
        name: "Phone Number",
        severity: "medium",
        action: "redacted",
        fp: "a000000000000009",
        ...(via ? { via } : {}),
      });
      await store.set(ctx, { events: [ev("chatgpt.com", null)] }); // hand-hidden only: no Bandage section
      let page = await openExtPage(ctx, "dashboard.html");
      try {
        await sleep(400);
        const hidden = await page.evaluate(() => document.getElementById("bandage-section").hidden);
        expect(hidden, "Bandage section shown with nothing from Bandage");
      } finally {
        await page.close();
      }
      await store.set(ctx, {
        events: [ev("chatgpt.com", "bandage"), ev("chatgpt.com", "bandage"), ev("claude.ai", "bandage")],
      });
      page = await openExtPage(ctx, "dashboard.html");
      try {
        await sleep(400);
        const got = await page.evaluate(() => ({
          hidden: document.getElementById("bandage-section").hidden,
          rows: [...document.querySelectorAll("#bandage-kept [data-site]")].map(
            (n) => `${n.dataset.site}:${n.dataset.kept}`,
          ),
        }));
        expect(!got.hidden, "Bandage section not shown");
        expect(
          JSON.stringify(got.rows) === JSON.stringify(["chatgpt.com:2", "claude.ai:1"]),
          `rows: ${JSON.stringify(got.rows)}`,
        );
      } finally {
        await page.close();
        await store.set(ctx, { events: [] });
      }
    },
  );

  await check(
    "DSH2",
    "Full dashboard: riskiest moments come with what to do now; repeats are spotted; no fingerprints shown",
    async () => {
      await store.set(ctx, { events: dashEvents() });
      const page = await openExtPage(ctx, "dashboard.html");
      try {
        await sleep(400);
        const got = await page.evaluate(() => ({
          risky: document.getElementById("risky").innerText,
          repeats: document.getElementById("repeats").innerText,
          body: document.body.innerText,
        }));
        expect(/AWS Access Key/.test(got.risky) && /Credit Card Number/.test(got.risky), `risky: ${got.risky}`);
        expect(/turn it off/i.test(got.risky) && /bank/i.test(got.risky), `no advice: ${got.risky}`);
        expect(/Phone Number[^\n]*3 times[^\n]*2 AI/.test(got.repeats), `repeats: ${got.repeats}`);
        expect(!/aaaaaaaaaaaaaaa1|fffffffffffffff6/.test(got.body), "fingerprints shown on the page");
      } finally {
        await page.close();
      }
    },
  );

  await check(
    "DSH3",
    "Full dashboard: export gives the stored records (no fingerprint secret); delete history takes two clicks",
    async () => {
      await store.set(ctx, { events: dashEvents() });
      const { salt } = await store.get(ctx, "salt");
      const page = await openExtPage(ctx, "dashboard.html");
      try {
        await sleep(400);
        await page.click("#export");
        const exported = await page.evaluate(async () => {
          const a = document.getElementById("export-link");
          return a ? (await fetch(a.href)).text() : "";
        });
        const data = JSON.parse(exported || "{}");
        expect(data.events?.length === 9 && !exported.includes(salt), `export: ${exported.slice(0, 120)}`);
        await page.click("#delete-history");
        await sleep(200);
        expect((await store.events(ctx)).length === 9, "deleted after one click");
        await page.click("#delete-history");
        const left = await waitFor(async () => ((await store.events(ctx)).length === 0 ? true : null), 2000);
        expect(left, "history not deleted after the second click");
      } finally {
        await page.close();
        await store.set(ctx, { events: [] });
      }
    },
  );

  const aged = (days, fp) => ({
    t: Date.now() - days * DAY_MS,
    site: "chatgpt.com",
    type: "email",
    name: "Email Address",
    severity: "low",
    action: "allowed",
    fp,
  });

  // Class names inside one of Clotr's closed shadow roots (DevTools can pierce them).
  // Computed style of the first element inside Clotr's closed UI `tag` that `match(node)` accepts.
  async function uiStyle(page, tag, match, props) {
    page.cdp ??= await page.createCDPSession();
    await page.cdp.send("DOM.enable");
    await page.cdp.send("CSS.enable");
    const { root } = await page.cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const kids = (n) => [...(n.children || []), ...(n.shadowRoots || [])];
    let host = null,
      hit = null;
    (function find(n) {
      if (!host) {
        if (n.nodeName === tag) host = n;
        kids(n).forEach(find);
      }
    })(root);
    const attr = (n, name) => {
      const a = n.attributes || [];
      for (let i = 0; i < a.length; i += 2) if (a[i] === name) return a[i + 1];
      return "";
    };
    (function walk(n) {
      if (!n || hit) return;
      if (n !== host && match(n, attr)) {
        hit = n;
        return;
      }
      kids(n).forEach(walk);
    })(host);
    if (!hit) return null;
    const { computedStyle } = await page.cdp.send("CSS.getComputedStyleForNode", { nodeId: hit.nodeId });
    return Object.fromEntries(props.map((p) => [p, computedStyle.find((s) => s.name === p)?.value]));
  }

  async function uiClasses(page, tag) {
    page.cdp ??= await page.createCDPSession();
    const { root } = await page.cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const classes = new Set();
    let host = null;
    (function find(n) {
      if (!host) {
        if (n.nodeName === tag) host = n;
        for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) find(c);
      }
    })(root);
    (function walk(n) {
      if (!n) return;
      const a = n.attributes || [];
      for (let i = 0; i < a.length; i += 2) if (a[i] === "class") a[i + 1].split(/\s+/).forEach((c) => classes.add(c));
      for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) walk(c);
    })(host);
    return classes;
  }

  await check("PM1", 'Helping someone: "Larger warnings" makes the corner warning bigger', () =>
    withSite(ctx, "chatgpt", async (page) => {
      await store.set(ctx, { events: [], responses: {}, guided: ALL_GUIDED, largeText: true });
      try {
        await typeText(page, "call me at 937-555-0147");
        expect(await waitForNotice(page), "no notice");
        const classes = await uiClasses(page, "CLOTR-NOTICE");
        expect(classes.has("large"), `notice classes: ${[...classes].join(" ")}`);
        // Everything in it is larger, not just the headline: the masked value, More choices, the links.
        const code = await uiStyle(page, "CLOTR-NOTICE", (n) => n.nodeName === "CODE", ["font-size"]);
        const more = await uiStyle(page, "CLOTR-NOTICE", (n) => n.nodeName === "SUMMARY", ["font-size"]);
        const link = await uiStyle(
          page,
          "CLOTR-NOTICE",
          (n, attr) => n.nodeName === "BUTTON" && /\blink\b/.test(attr(n, "class")),
          ["font-size", "padding-left"],
        );
        const px = (s) => parseFloat(s?.["font-size"]);
        expect(
          px(code) >= 15 && px(more) >= 15 && px(link) >= 15,
          `small text in large mode: code ${code?.["font-size"]}, More choices ${more?.["font-size"]}, link ${link?.["font-size"]}`,
        );
        expect(link?.["padding-left"] === "0px", `a text link is padded like a button: ${link?.["padding-left"]}`);
        await shot(page, "notice-large.png");
      } finally {
        await store.set(ctx, { largeText: false });
      }
    }),
  );

  await check(
    "PM2",
    "Helping someone: settings locked with a PIN (stored only as a hash); wrong PIN refused, right PIN unlocks",
    async () => {
      await store.set(ctx, { responses: {} });
      await ctx.worker.evaluate(() =>
        Promise.all([chrome.storage.local.remove("lock"), chrome.storage.session.remove("unlockedUntil")]),
      );
      let popup = await openPopup(ctx);
      try {
        await popup.click("#tab-settings");
        await popup.type("#pin", "4827");
        await popup.click("#lock-set");
        const lock = await waitFor(async () => (await store.get(ctx, "lock")).lock, 3000);
        expect(lock?.hash && lock?.salt, `lock: ${JSON.stringify(lock)}`);
        // As a value of its own: "4827" inside a timestamp (1790234827123) or random hex is a coincidence (flaked in CI).
        expect(
          !/(?<![0-9a-f])4827(?![0-9a-f])/i.test(JSON.stringify(await store.get(ctx, null))),
          "the PIN itself was stored",
        );
        await popup.close();
        await ctx.worker.evaluate(() => chrome.storage.session.remove("unlockedUntil"));
        popup = await openPopup(ctx);
        await popup.click("#tab-settings");
        const locked = await popup.evaluate(() => ({
          unlock: !document.getElementById("unlock").hidden,
          settings: document.getElementById("settings-body").hidden,
        }));
        expect(locked.unlock && locked.settings, `settings not locked: ${JSON.stringify(locked)}`);
        await popup.type("#unlock-pin", "1111");
        await popup.click("#unlock-go");
        await sleep(1200);
        expect(
          await popup.evaluate(() => document.getElementById("settings-body").hidden),
          "wrong PIN unlocked the settings",
        );
        expect(
          /didn't match/i.test(await popup.$eval("#unlock-msg", (n) => n.textContent)),
          "no message for a wrong PIN",
        );
        await popup.$eval("#unlock-pin", (n) => {
          n.value = "";
        });
        await popup.type("#unlock-pin", "4827");
        await popup.click("#unlock-go");
        const open = await waitFor(() => popup.evaluate(() => !document.getElementById("settings-body").hidden), 3000);
        expect(open, "the right PIN didn't unlock");
        await shot(popup, "popup-helper.png");
      } finally {
        await popup.close();
        await ctx.worker.evaluate(() =>
          Promise.all([chrome.storage.local.remove("lock"), chrome.storage.session.remove("unlockedUntil")]),
        );
      }
    },
  );

  await check(
    "PM3",
    'Helping someone: "Ask before sending personal details" sets every personal kind to Ask before sending',
    async () => {
      await store.set(ctx, { responses: {} });
      const popup = await openPopup(ctx);
      try {
        await popup.click("#tab-settings");
        await popup.click("#strict-personal");
        const r = await waitFor(async () => {
          const x = (await store.get(ctx, "responses")).responses || {};
          return x.phone_number === "block" ? x : null;
        }, 3000);
        expect(
          r && r.email === "block" && r.street_address === "block" && !r.aws_access_key,
          `responses: ${JSON.stringify(r)}`,
        );
        await popup.click("#strict-personal");
        const back = await waitFor(async () => {
          const x = (await store.get(ctx, "responses")).responses || {};
          return !x.phone_number ? x : null;
        }, 3000);
        expect(back, "turning it off didn't restore Warn");
      } finally {
        await popup.close();
        await store.set(ctx, { responses: {} });
      }
    },
  );

  await check(
    "PM4",
    "Helping someone: with a PIN set, the vault page explains it's locked and can't be edited",
    async () => {
      await ctx.worker.evaluate(() =>
        Promise.all([
          chrome.storage.local.set({ lock: { salt: "00".repeat(16), iterations: 1000, hash: "ab".repeat(32) } }),
          chrome.storage.session.remove("unlockedUntil"),
        ]),
      );
      const page = await openExtPage(ctx, "vault.html");
      try {
        await sleep(500);
        const got = await page.evaluate(() => ({
          locked: !document.getElementById("vault-locked").hidden,
          form: !document.getElementById("vault-form").hidden,
        }));
        expect(got.locked && !got.form, `vault page: ${JSON.stringify(got)}`);
      } finally {
        await page.close();
        await ctx.worker.evaluate(() => chrome.storage.local.remove("lock"));
      }
    },
  );

  await check(
    "PM5",
    "Guided setup (pre-release Batch 3): the four steps set larger warnings, ask-before for personal details and a PIN; reopened, the page asks for the PIN, and the right one opens it",
    async () => {
      await resetState(ctx);
      await ctx.worker.evaluate(() =>
        Promise.all([
          chrome.storage.local.remove(["lock", "largeText", "responses"]),
          chrome.storage.session.remove("unlockedUntil"),
        ]),
      );
      let page = await openExtPage(ctx, "helper.html");
      try {
        await sleep(400);
        const steps = await page.evaluate(() => document.querySelectorAll("#steps > li").length);
        expect(steps === 4, `expected 4 steps, got ${steps}`);
        await page.click("#large-text");
        await page.click("#strict-personal");
        await page.type("#pin", "4821");
        await page.click("#lock-set");
        await sleep(600);
        const saved = await ctx.worker.evaluate(async () => {
          const s = await chrome.storage.local.get(["largeText", "responses", "lock"]);
          return {
            large: s.largeText,
            phone: s.responses?.phone_number,
            email: s.responses?.email,
            lock: Boolean(s.lock?.hash) && !JSON.stringify(s.lock).includes("4821"),
          };
        });
        expect(
          saved.large === true && saved.phone === "block" && saved.email === "block" && saved.lock,
          `settings: ${JSON.stringify(saved)}`,
        );
        await page.screenshot({ path: path.join(OUT, "helper-setup.png"), fullPage: true });
      } finally {
        await page.close();
      }
      await ctx.worker.evaluate(() => chrome.storage.session.remove("unlockedUntil"));
      page = await openExtPage(ctx, "helper.html");
      try {
        await sleep(400);
        const locked = await page.evaluate(() => ({
          unlock: !document.getElementById("unlock").hidden,
          steps: !document.getElementById("steps").hidden,
        }));
        expect(locked.unlock && !locked.steps, `reopened: ${JSON.stringify(locked)}`);
        await page.type("#unlock-pin", "1111");
        await page.click("#unlock-go");
        await sleep(400);
        const wrong = await page.evaluate(() => document.getElementById("steps").hidden);
        expect(wrong, "a wrong PIN must not open the steps");
        await page.type("#unlock-pin", "4821");
        await page.click("#unlock-go");
        await sleep(600);
        const open = await page.evaluate(() => !document.getElementById("steps").hidden);
        expect(open, "the right PIN opens the steps");
      } finally {
        await page.close();
        await ctx.worker.evaluate(() =>
          Promise.all([
            chrome.storage.local.remove(["lock", "largeText", "responses"]),
            chrome.storage.session.remove("unlockedUntil"),
          ]),
        );
      }
    },
  );

  await check(
    "SH1",
    "Share Clotr (pre-release Batch 4): the link, the step-by-step setup and a one-page guide; printed, only the guide shows, with blanks for who set it up",
    async () => {
      const page = await openExtPage(ctx, "share.html");
      try {
        await sleep(400);
        const got = await page.evaluate(() => ({
          url: document.getElementById("share-url").textContent,
          guide: document.querySelector(".guide h2")?.textContent || "",
          blanks: document.querySelectorAll(".guide-fill .blank").length,
        }));
        expect(/^https:\/\//.test(got.url) && /heads-up/.test(got.guide) && got.blanks === 2, JSON.stringify(got));
        await page.screenshot({ path: path.join(OUT, "share.png"), fullPage: true });
        await page.emulateMediaType("print");
        const printed = await page.evaluate(() => ({
          controls: [...document.querySelectorAll(".no-print")].some((el) => getComputedStyle(el).display !== "none"),
          guide: getComputedStyle(document.querySelector(".guide")).display !== "none",
          // Every word of the guide prints dark, whatever the screen theme (the title printed white on white once).
          light: [...document.querySelectorAll(".guide, .guide *")].filter((el) => {
            const [r, g, b] = getComputedStyle(el).color.match(/\d+/g).map(Number);
            return r + g + b > 150;
          }).length,
        }));
        expect(!printed.controls && printed.guide && printed.light === 0, `print layout: ${JSON.stringify(printed)}`);
        await page.screenshot({ path: path.join(OUT, "share-print.png"), fullPage: true });
        await page.emulateMediaType(null);
        // "Set it up step by step" opens the guided setup.
        const before = (await ctx.browser.pages()).length;
        await page.click("#open-helper");
        const opened = await waitFor(async () => {
          const pages = await ctx.browser.pages();
          return pages.length > before ? pages.find((p) => p.url().endsWith("helper.html")) : null;
        }, 3000);
        expect(opened, "the guided setup didn't open");
        await opened?.close();
      } finally {
        await page.close();
      }
    },
  );

  await check(
    "MV1",
    "Move to a new computer (pre-release Batch 5): the saved file brings settings, vault and salt back; a wrong password or a PIN lock refuses to load",
    async () => {
      const fp = "0123456789abcdef";
      const salt = "00112233445566778899aabbccddeeff";
      const mine = {
        responses: { phone_number: "block" },
        largeText: true,
        salt,
        vault: [{ kind: "value", type: "phone_number", fp, mode: "protect", added: 1 }],
      };
      await ctx.worker.evaluate(
        (s) => Promise.all([chrome.storage.local.set(s), chrome.storage.local.remove("lock")]),
        mine,
      );
      const file = path.join(OUT, "move-test.clotr");
      const page = await openExtPage(ctx, "stored.html#move");
      const asked = [];
      page.on("dialog", (d) => {
        asked.push(d.message());
        d.accept();
      });
      try {
        await sleep(300);
        // The button: two matching passwords, then "Saved".
        await page.type("#mv-pass", "correct horse battery");
        await page.type("#mv-pass2", "correct horse battery");
        await page.click("#mv-save");
        const saved = await waitFor(
          () =>
            page.evaluate(() => {
              const text = document.getElementById("mv-save-msg").textContent;
              return /^(Saved|Use|The two)/.test(text) ? text : null; // past "Working…"
            }),
          15000,
        );
        expect(/^Saved/.test(saved || ""), `save: ${saved}`);
        // The same file the button makes, kept to load back.
        const text = await page.evaluate(async () => {
          const { Backup } = globalThis.Clotr;
          return Backup.seal(Backup.pick(await chrome.storage.local.get(Backup.KEYS)), "correct horse battery");
        });
        expect(!text.includes(fp) && !text.includes(salt), "the file shows a fingerprint or the salt");
        fs.writeFileSync(file, text);
        // "Another computer": different settings, empty vault, another salt.
        await ctx.worker.evaluate(() =>
          chrome.storage.local.set({ responses: {}, largeText: false, vault: [], salt: "ff".repeat(16) }),
        );
        const input = await page.$("#mv-file");
        await input.uploadFile(file);
        const loadMsg = async () => {
          await page.click("#mv-load");
          return waitFor(() => page.evaluate(() => document.getElementById("mv-load-msg").textContent || null), 15000);
        };
        await page.type("#mv-open", "wrong password!");
        const wrong = await loadMsg();
        expect(/doesn't open/.test(wrong || ""), `wrong password: ${wrong}`);
        await page.evaluate(() => {
          document.getElementById("mv-open").value = "";
          document.getElementById("mv-load-msg").textContent = "";
        });
        await page.type("#mv-open", "correct horse battery");
        const loaded = await loadMsg();
        // What the file holds is said before it replaces anything, and what came back after.
        expect(
          /1 vault item \(Phones: 1\)/.test(asked.at(-1) || "") &&
            /choices for 1 kind of detail/.test(asked.at(-1) || ""),
          `confirm: ${asked.at(-1)}`,
        );
        expect(
          /^Done\. Back from the file: 1 vault item \(Phones: 1\) and your choices for 1 kind of detail/.test(
            loaded || "",
          ),
          `load: ${loaded}`,
        );
        expect(
          await page.evaluate(
            () => document.querySelector("#mv-load-msg a")?.getAttribute("href") === "vault.html#vault-list",
          ),
          "no link to see the vault",
        );
        const back = await ctx.worker.evaluate(() =>
          chrome.storage.local.get(["responses", "largeText", "vault", "salt"]),
        );
        expect(
          back.responses?.phone_number === "block" &&
            back.largeText === true &&
            back.salt === salt &&
            back.vault?.length === 1 &&
            back.vault[0].fp === fp,
          `after loading: ${JSON.stringify(back)}`,
        );
        // With a PIN lock (not unlocked), loading is refused before the file is even opened.
        await ctx.worker.evaluate(() =>
          Promise.all([
            chrome.storage.local.set({ lock: { salt: "00".repeat(16), iterations: 1000, hash: "ab".repeat(32) } }),
            chrome.storage.session.remove("unlockedUntil"),
          ]),
        );
        await page.evaluate(() => (document.getElementById("mv-load-msg").textContent = ""));
        const locked = await loadMsg();
        expect(/locked/.test(locked || ""), `with a PIN: ${locked}`);
        await page.screenshot({ path: path.join(OUT, "move.png"), fullPage: true });
      } finally {
        await page.close();
        fs.rmSync(file, { force: true });
        await ctx.worker.evaluate(() => chrome.storage.local.remove(["lock", "responses", "largeText", "vault"]));
      }
    },
  );

  await check(
    "TP1",
    "Team policy: required responses win over the user's; the admin's watch words are caught (sent to the page as fingerprints only)",
    async () => {
      // A real managed policy needs admin rights; stand in for the browser's policy store in the worker.
      await ctx.worker.evaluate(() => {
        globalThis.__realManagedGet = chrome.storage.managed.get.bind(chrome.storage.managed);
        chrome.storage.managed.get = async () => ({
          requiredResponses: { phone_number: "block" },
          watchWords: ["Project Falcon"],
        });
      });
      await resetState(ctx, { phone_number: "log" }); // the user's own choice: Just count
      try {
        await withSite(ctx, "chatgpt", async (page) => {
          await typeText(page, "the project falcon launch is next week");
          const n = await waitForNotice(page);
          expect(n && /watch/i.test(n.text), `watch word not caught: ${JSON.stringify(n)}`);
          const vaultSeen = await evalInClotr(
            page,
            "JSON.stringify(document.documentElement.outerHTML.includes('falcon'))",
          );
          expect(vaultSeen === "false", "the watch word shows up in the page's markup");
          await clearEditor(page);
          await typeText(page, "call me at 937-555-0147");
          await pressEnter(page);
          expect(await waitForDialog(page), "the policy's Ask before sending didn't hold the phone number");
          expect((await sentMessages(page)).length === 0, "sent despite the policy");
        });
      } finally {
        await ctx.worker.evaluate(() => {
          chrome.storage.managed.get = globalThis.__realManagedGet;
        });
        await resetState(ctx);
      }
    },
  );

  await check(
    "TM1",
    "Team pack preset (keys_never): a floor over the user's own choice; an explicit field beats the preset",
    async () => {
      const GITHUB_TOKEN = "ghp_7Rk2QwZ9LmX4vB8nT1cY6pJ3sH5dF0gA2eUi";
      await ctx.worker.evaluate(() => {
        globalThis.__realManagedGet = chrome.storage.managed.get.bind(chrome.storage.managed);
        chrome.storage.managed.get = async () => ({ preset: "keys_never" });
      });
      await resetState(ctx, { github_token: "log" }); // the user's own choice: Just count
      try {
        await withSite(ctx, "chatgpt", async (page) => {
          await typeText(page, GITHUB_TOKEN);
          await pressEnter(page);
          expect(await waitForDialog(page), "the preset's block didn't hold a github token the user set to Just count");
          expect((await sentMessages(page)).length === 0, "sent despite the preset");
        });
      } finally {
        await ctx.worker.evaluate(() => {
          chrome.storage.managed.get = globalThis.__realManagedGet;
        });
        await resetState(ctx);
      }

      // An explicit requiredResponses entry beats the preset (design 3.2): warn instead of the preset's block.
      await ctx.worker.evaluate(() => {
        globalThis.__realManagedGet = chrome.storage.managed.get.bind(chrome.storage.managed);
        chrome.storage.managed.get = async () => ({
          preset: "keys_never",
          requiredResponses: { github_token: "warn" },
        });
      });
      await resetState(ctx, { github_token: "log" });
      try {
        await withSite(ctx, "chatgpt", async (page) => {
          await typeText(page, GITHUB_TOKEN);
          await pressEnter(page);
          expect(!(await waitForDialog(page)), "the explicit warn should not hold the message like the preset's block");
          expect((await sentMessages(page)).length === 1, "the explicit warn should let the message send");
        });
      } finally {
        await ctx.worker.evaluate(() => {
          chrome.storage.managed.get = globalThis.__realManagedGet;
        });
        await resetState(ctx);
      }
    },
  );

  await check("TM2", "Team pack: a watch format (EMP-#####) through policy, alongside a plain watch word", async () => {
    await ctx.worker.evaluate(() => {
      globalThis.__realManagedGet = chrome.storage.managed.get.bind(chrome.storage.managed);
      chrome.storage.managed.get = async () => ({
        preset: "client_names",
        watchWords: ["Acme Holdings", "EMP-#####"],
      });
    });
    try {
      await resetState(ctx);
      await withSite(ctx, "chatgpt", async (page) => {
        await typeText(page, "please loop in Acme Holdings on this");
        await pressEnter(page);
        expect(await waitForDialog(page), "the watch word didn't ask before sending");
        expect((await sentMessages(page)).length === 0, "the watch word should hold the message");
        const vaultSeen = await evalInClotr(
          page,
          "JSON.stringify(document.documentElement.outerHTML.toLowerCase().includes('acme'))",
        );
        expect(vaultSeen === "false", "the watch word shows up in the page's markup");
      });

      await resetState(ctx);
      await withSite(ctx, "chatgpt", async (page) => {
        await typeText(page, "employee number EMP-48213 needs access");
        await pressEnter(page);
        expect(await waitForDialog(page), "the watch format didn't ask before sending");
        expect((await sentMessages(page)).length === 0, "the watch format should hold the message");
      });

      await resetState(ctx);
      await withSite(ctx, "chatgpt", async (page) => {
        await typeText(page, "employee number EMP-4821 needs access");
        await pressEnter(page);
        expect(!(await waitForDialog(page)), "a number with the wrong digit count shouldn't match the format");
        expect((await sentMessages(page)).length === 1, "a non-matching number should send");
      });
    } finally {
      await ctx.worker.evaluate(() => {
        chrome.storage.managed.get = globalThis.__realManagedGet;
      });
      await resetState(ctx);
    }
  });

  await check(
    "TM3",
    "Team pack: a required block survives the loopholes (a site set to Just count, an 'OK to share' vault entry)",
    async () => {
      const host = "chatgpt.com";
      const fp = await ctx.worker.evaluate(async () =>
        globalThis.Clotr.fingerprint(await ensureSalt(), "phone_number", "937-555-0147"),
      );
      await ctx.worker.evaluate(() => {
        globalThis.__realManagedGet = chrome.storage.managed.get.bind(chrome.storage.managed);
        chrome.storage.managed.get = async () => ({ requiredResponses: { phone_number: "block" } });
      });
      await resetState(ctx);
      await store.set(ctx, {
        siteModes: { [host]: "log" },
        vault: [{ kind: "value", type: "phone_number", mode: "allow", fp, added: Date.now() }],
      });
      try {
        await withSite(ctx, "chatgpt", async (page) => {
          await typeText(page, "call me at 937-555-0147");
          await pressEnter(page);
          expect(
            await waitForDialog(page),
            "a site set to Just count plus an 'OK to share' vault entry weakened the policy's block",
          );
          expect((await sentMessages(page)).length === 0, "sent despite the policy's required block");
        });
      } finally {
        await ctx.worker.evaluate(() => {
          chrome.storage.managed.get = globalThis.__realManagedGet;
        });
        await resetState(ctx);
      }
    },
  );

  // Opens policy.html with chrome.storage.managed.get stubbed inside that page's own context
  // (a real managed policy needs admin rights; each extension page has its own JS realm, so the
  // worker's own stub in the TM checks above doesn't reach a page that reads storage.managed itself).
  const openPolicyPage = async (policyObj) => {
    const page = await ctx.browser.newPage();
    page.on("pageerror", (err) => ctx.problems.push(`policy.html error: ${err.message}`));
    if (policyObj) {
      await page.evaluateOnNewDocument((obj) => {
        chrome.storage.managed.get = async () => obj;
      }, policyObj);
    }
    await page.setViewport({ width: 700, height: 900 });
    await page.goto(`chrome-extension://${new URL(ctx.swTarget.url()).host}/policy.html`);
    await sleep(400);
    return page;
  };

  await check(
    "PA1",
    "The organization policy page: its fields, the fingerprint's format and stability, a preset shows as its expanded JSON, watch words hidden until the checkbox, the no-policy line",
    async () => {
      const none = await openPolicyPage();
      try {
        const state = await none.evaluate(() => ({
          noneHidden: document.getElementById("pa-none").hidden,
          policyHidden: document.getElementById("pa-policy").hidden,
          noneText: document.getElementById("pa-none").textContent,
        }));
        expect(!state.noneHidden && state.policyHidden, `no-policy state: ${JSON.stringify(state)}`);
        expect(/no organization policy/i.test(state.noneText), `no-policy line: ${state.noneText}`);
      } finally {
        await none.close();
      }

      const bare = await openPolicyPage({ preset: "keys_never", orgName: "Acme Holdings" });
      try {
        const fields = await bare.evaluate(() => ({
          org: document.getElementById("pa-org").textContent,
          preset: document.getElementById("pa-preset").textContent,
          fp: document.getElementById("pa-fingerprint").textContent,
          wordsHidden: document.getElementById("pa-words").hidden,
        }));
        expect(fields.org === "Acme Holdings", `org name: ${fields.org}`);
        expect(!/with organization changes/i.test(fields.preset), `bare preset label: ${fields.preset}`);
        expect(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(fields.fp), `fingerprint format: ${fields.fp}`);
        expect(fields.wordsHidden, "watch words shown before the checkbox is checked");
        await bare.click("#pa-show-words");
        await sleep(100);
        const afterCheck = await bare.evaluate(() => document.getElementById("pa-words").hidden);
        expect(!afterCheck, "watch words stayed hidden after checking the box");
      } finally {
        await bare.close();
      }

      // A second page with the exact same policy prints the same fingerprint (stability).
      const again = await openPolicyPage({ preset: "keys_never", orgName: "Acme Holdings" });
      try {
        const fp2 = await again.evaluate(() => document.getElementById("pa-fingerprint").textContent);
        const fp1 = await bare.evaluate(() => document.getElementById("pa-fingerprint").textContent).catch(() => null);
        if (fp1) expect(fp1 === fp2, `fingerprint not stable: ${fp1} vs ${fp2}`);
      } finally {
        await again.close();
      }

      // The admin's explicit change on top of the preset shows as "Preset with organization changes".
      const changed = await openPolicyPage({
        preset: "keys_never",
        requiredResponses: { github_token: "warn" },
      });
      try {
        const preset = await changed.evaluate(() => document.getElementById("pa-preset").textContent);
        expect(/with organization changes/i.test(preset), `changed preset label: ${preset}`);
      } finally {
        await changed.close();
      }
    },
  );

  await check(
    "PA2",
    "The organization policy page prints cleanly, stays dark-mode aware, makes no outside requests, and never writes to storage",
    async () => {
      const before = await ctx.worker.evaluate(() => chrome.storage.local.get(null));
      const page = await openPolicyPage({ preset: "clinic", orgName: "Riverside Clinic" });
      try {
        await page.emulateMediaType("print");
        const printed = await page.evaluate(() => ({
          controls: [...document.querySelectorAll(".no-print")].some((el) => getComputedStyle(el).display !== "none"),
          light: [...document.querySelectorAll("body, body *")].filter((el) => {
            const c = getComputedStyle(el).color.match(/\d+/g);
            return c && c.map(Number).reduce((a, b) => a + b, 0) > 550; // near-white text would fail to print
          }).length,
        }));
        expect(!printed.controls, "print controls stayed visible when printing");
        expect(printed.light === 0, "some text stayed light (unreadable) on paper");
        await page.emulateMediaType(null);
        const outside = await page.evaluate(() =>
          fetch("https://chatgpt.com/robots.txt")
            .then(() => "reached chatgpt.com")
            .catch(() => "blocked"),
        );
        expect(outside === "blocked", `the policy page could connect out: ${outside}`);
        await page.screenshot({ path: path.join(OUT, "policy.png"), fullPage: true });
      } finally {
        await page.close();
      }
      const after = await ctx.worker.evaluate(() => chrome.storage.local.get(null));
      expect(JSON.stringify(before) === JSON.stringify(after), "the policy page changed storage.local");
    },
  );

  await check(
    "PA3",
    "The popup's managed banner without lockSettings, its 'See what's applied' button, and a disabled dropdown showing the policy's value",
    async () => {
      await resetState(ctx, { github_token: "log" });
      // The popup reads storage.managed itself (its own page, its own JS realm): stub it there,
      // not in the worker (TM's pattern doesn't reach it).
      const popup = await ctx.browser.newPage();
      popup.on("pageerror", (err) => ctx.problems.push(`popup error: ${err.message}`));
      await popup.evaluateOnNewDocument(() => {
        chrome.storage.managed.get = async () => ({ requiredResponses: { github_token: "block" } });
      });
      await popup.setViewport({ width: 380, height: 700 });
      await popup.goto(`chrome-extension://${new URL(ctx.swTarget.url()).host}/popup.html`);
      await popup.waitForSelector("#hero-value");
      await sleep(400);
      try {
        await popup.click("#tab-settings");
        await sleep(200);
        const banner = await popup.evaluate(() => ({
          hidden: document.getElementById("managed-note").hidden,
          hasUnlock: !document.getElementById("unlock").hidden,
        }));
        expect(!banner.hidden, "the banner should show without lockSettings too");
        expect(!banner.hasUnlock, "no PIN unlock section without lockSettings");
        const row = await popup.$eval('select[data-pattern="github_token"]', (s) => ({
          value: s.value,
          disabled: s.disabled,
        }));
        expect(
          row.disabled && row.value === "block",
          `the floored dropdown should be disabled and show the policy's value: ${JSON.stringify(row)}`,
        );
        const before = (await ctx.browser.pages()).length;
        await popup.click("#managed-see");
        const opened = await waitFor(async () => {
          const pages = await ctx.browser.pages();
          return pages.length > before ? pages.find((p) => p.url().endsWith("policy.html")) : null;
        }, 3000);
        expect(opened, "the policy page didn't open");
        await opened?.close();
      } finally {
        await popup.close();
        await resetState(ctx);
      }
    },
  );

  // Reply checks: your own phone number, fingerprinted with this profile's salt, as the vault page would.
  const ownPhoneVault = async () => {
    const fp = await ctx.worker.evaluate(async () =>
      globalThis.Clotr.fingerprint(await ensureSalt(), "phone_number", "937-555-0147"),
    );
    await store.set(ctx, {
      events: [],
      responses: {},
      guided: ALL_GUIDED,
      vault: [{ kind: "value", type: "phone_number", fp, mode: "protect", added: Date.now() }],
    });
  };
  const replyNote = async (page, ms = 6000) =>
    waitFor(async () => {
      const n = await readNotice(page);
      return n && /reply mentions/i.test(n.text) ? n : null;
    }, ms);

  await check(
    "RP1",
    "Reply check: the AI's reply mentions your own phone number that you didn't type here: a note says so",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await ownPhoneVault();
        try {
          await typeText(page, "hello, can you help me plan a trip?");
          await pressEnter(page);
          await sleep(300);
          await page.evaluate(() => window.__reply("Sure! I'll text the plan to (937) 555-0147 like last time."));
          const n = await replyNote(page);
          expect(
            n && /Phone Number/.test(n.text) && /memory|earlier/i.test(n.text),
            `note: ${JSON.stringify(await readNotice(page))}`,
          );
          expect(!/555-0147/.test(n.text), "the note shows the number itself");
          await shot(page, "reply-note.png");
          // Recorded for the mind map (D63, D75): kind and fingerprint in `mentions`, never the text,
          // and not in history (it wasn't found in your own message). The background stores it a moment after the
          // note shows: wait for it rather than reading once (it failed that way on a busy PC, 2026-09-30).
          await waitFor(async () => ((await store.get(ctx, "mentions")).mentions?.length ? true : null), 4000);
          const { mentions = [], events = [] } = await store.get(ctx, ["mentions", "events"]);
          expect(
            mentions.length === 1 &&
              mentions[0].type === "phone_number" &&
              mentions[0].action === "mentioned" &&
              /^[0-9a-f]{16}$/.test(mentions[0].fp),
            `mentions: ${JSON.stringify(mentions)}`,
          );
          expect(!JSON.stringify(mentions).includes("555"), "the number itself was stored");
          expect(events.length === 0, `a reply mention went into history: ${JSON.stringify(events)}`);
        } finally {
          await store.set(ctx, { vault: [], mentions: [] });
        }
      }),
  );

  await check("RP6", "Reply check switched off in Settings (D63): no note and nothing recorded", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await ownPhoneVault();
      await store.set(ctx, { replyCheck: false, mentions: [] });
      await sleep(400); // the tab hears about the change
      try {
        await typeText(page, "hello, can you help me plan a trip?");
        await pressEnter(page);
        await sleep(300);
        await page.evaluate(() => window.__reply("Sure! I'll text the plan to (937) 555-0147 like last time."));
        expect(!(await replyNote(page, 5000)), "a note although the reply check is off");
        const { mentions = [] } = await store.get(ctx, "mentions");
        expect(mentions.length === 0, `recorded although off: ${JSON.stringify(mentions)}`);
      } finally {
        await store.set(ctx, { vault: [], replyCheck: true });
      }
    }),
  );

  await check(
    "RP7",
    "Reply check switched off while a reply is on its way: that reply isn't read either (no note, nothing recorded)",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await ownPhoneVault();
        await store.set(ctx, { replyCheck: true, mentions: [] });
        try {
          await typeText(page, "hello, can you help me plan a trip?");
          await pressEnter(page); // the reply window opens
          await sleep(300);
          await store.set(ctx, { replyCheck: false }); // switched off in Settings right after sending
          await sleep(600);
          await page.evaluate(() => window.__reply("Sure! I'll text the plan to (937) 555-0147 like last time."));
          expect(!(await replyNote(page, 5000)), "a note after the reply check was switched off");
          const { mentions = [] } = await store.get(ctx, "mentions");
          expect(mentions.length === 0, `recorded after it was switched off: ${JSON.stringify(mentions)}`);
        } finally {
          await store.set(ctx, { vault: [], replyCheck: true, mentions: [] });
        }
      }),
  );

  await check("RP2", "Reply check: the AI repeating a detail you typed on this page is expected: no note", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await ownPhoneVault();
      try {
        await typeText(page, "my number is 937-555-0147");
        await sleep(700);
        await pressEnter(page);
        await sleep(300);
        await page.evaluate(() => window.__reply("Got it, I'll use 937-555-0147."));
        expect(!(await replyNote(page, 2500)), "a note for a number the user typed here");
      } finally {
        await store.set(ctx, { vault: [] });
      }
    }),
  );

  await check("RP3", "Reply check: someone else's number in a reply isn't yours: no note", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await ownPhoneVault();
      try {
        await typeText(page, "what's the museum's number?");
        await pressEnter(page);
        await sleep(300);
        await page.evaluate(() => window.__reply("You can call the museum at 212-555-0199."));
        expect(!(await replyNote(page, 2500)), "a note for a number that isn't in the vault");
      } finally {
        await store.set(ctx, { vault: [] });
      }
    }),
  );

  await check(
    "RP5",
    "Reply check: one check per message you send, once the reply is quiet, so a page can't test guess after guess (S24)",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await ownPhoneVault();
        try {
          await typeText(page, "what's the weather tomorrow?");
          await pressEnter(page);
          await sleep(300);
          await page.evaluate(() => window.__reply("Sunny, around 70 degrees."));
          await sleep(4500); // the reply went quiet: its one check is done
          await page.evaluate(() => window.__reply("Is it 937-555-0147?"));
          expect(!(await replyNote(page, 4000)), "a second check in the same reply window");
        } finally {
          await store.set(ctx, { vault: [] });
        }
      }),
  );

  await check(
    "RP4",
    "Reply check: opening an old conversation (text appears with no message sent) never triggers a note",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await ownPhoneVault();
        try {
          await page.evaluate(() => window.__reply("Earlier you said: call me at 937-555-0147"));
          expect(!(await replyNote(page, 2500)), "a note for history loaded without a send");
        } finally {
          await store.set(ctx, { vault: [] });
        }
      }),
  );

  await check(
    "ES1",
    "Spanish browser: the warning, its buttons and the kind of data are in Spanish (D65)",
    async () => {
      const es = await launch(EXT, ["--lang=es-ES", "--accept-lang=es-ES"], { LANGUAGE: "es", LANG: "es_ES.UTF-8" });
      try {
        const page = await openSite(es, "chatgpt");
        await es.worker.evaluate(() => chrome.storage.local.set({ guided: { aws_access_key: 1, phone_number: 1 } }));
        await sleep(400);
        await typeText(page, `mi clave es ${KEY}`);
        const n = await waitFor(() => readNotice(page), 5000);
        const buttons = (n?.buttons || []).map((b) => b.text);
        await shot(page, "notice-es.png");
        expect(n && /Atención/.test(n.text) && /Clave de acceso de AWS/.test(n.text), `notice: ${n?.text}`);
        expect(buttons.includes("Ocultarlo") && buttons.includes("Dejarlo"), `buttons: ${buttons.join(" | ")}`);
        await page.close();
      } finally {
        await es.browser.close();
        fs.rmSync(es.profile, { recursive: true, force: true });
      }
    },
  );

  await check("ES2", "Spanish browser: the popup's tabs, summary and settings are in Spanish (D65)", async () => {
    const es = await launch(EXT, ["--lang=es-ES", "--accept-lang=es-ES"], { LANGUAGE: "es", LANG: "es_ES.UTF-8" });
    try {
      await es.worker.evaluate(() =>
        chrome.storage.local.set({
          events: [
            {
              t: Date.now() - 60000,
              site: "chatgpt.com",
              type: "email",
              name: "Email Address",
              severity: "low",
              action: "redacted",
              fp: "aaaaaaaaaaaaaaa1",
            },
          ],
          lastUpdate: { from: "0.8.0", to: chrome.runtime.getManifest().version, t: Date.now(), seen: false },
        }),
      );
      const popup = await openPopup(es);
      await sleep(400);
      const got = await popup.evaluate(() => ({
        tabs: [...document.querySelectorAll('[role="tab"]')].map((t) => t.textContent.trim()),
        hero: document.getElementById("hero-label").textContent,
        byType: document.getElementById("by-type").textContent,
        lang: document.documentElement.lang,
        whatsNew: document.getElementById("whats-new-list").textContent,
      }));
      await popup.click("#tab-settings");
      await sleep(200);
      const settings = await popup.evaluate(() =>
        document.getElementById("panel-settings").textContent.replace(/\s+/g, " "),
      );
      await shot(popup, "popup-es.png");
      await popup.close();
      expect(got.tabs.join("|") === "Resumen|Actividad|Ajustes", `tabs: ${got.tabs}`);
      expect(
        /fuga evitada/.test(got.hero) && /Dirección de correo electrónico/.test(got.byType),
        `hero: ${got.hero}; by type: ${got.byType}`,
      );
      expect(got.lang === "es", `lang: ${got.lang}`);
      // The current series' notes from changelog.json, so the check follows every version (it had the first
      // Spanish line of 0.9 built in, and 1.0 broke it).
      const log = JSON.parse(fs.readFileSync(`${EXT}/changelog.json`, "utf8"));
      const { version } = JSON.parse(fs.readFileSync(`${EXT}/manifest.json`, "utf8"));
      const minor = version.split(".").slice(0, 2).join(".");
      expect(
        got.whatsNew.includes(log.translations.es[minor][0]) && !got.whatsNew.includes(log[minor][0]),
        `what's new isn't in Spanish: ${got.whatsNew.slice(0, 120)}`,
      );
      expect(/Cómo responde Clotr/.test(settings) && /Tu caja fuerte/.test(settings), `settings: ${settings}`);
    } finally {
      await es.browser.close();
      fs.rmSync(es.profile, { recursive: true, force: true });
    }
  });

  await check(
    "ES3",
    'Spanish browser: welcome page (with its practice box), full report and "What Clotr stores" are in Spanish (D65)',
    async () => {
      const es = await launch(EXT, ["--lang=es-ES", "--accept-lang=es-ES"], { LANGUAGE: "es", LANG: "es_ES.UTF-8" });
      try {
        const welcome = await openExtPage(es, "vault.html?welcome=1");
        await welcome.type("#try", "llámame al nueve tres siete cinco cinco cinco cero uno cuatro siete");
        await sleep(700);
        const w = await welcome.evaluate(() => ({
          title: document.getElementById("page-title").textContent,
          tryResult: document.getElementById("try-result").textContent,
          lang: document.documentElement.lang,
        }));
        await shot(welcome, "welcome-es.png");
        await welcome.close();
        await es.worker.evaluate(() =>
          chrome.storage.local.set({
            events: [
              {
                t: Date.now(),
                site: "chatgpt.com",
                type: "phone_number",
                name: "Phone Number",
                severity: "medium",
                action: "allowed",
                fp: "00000000000000aa",
              },
            ],
          }),
        );
        const dash = await openExtPage(es, "dashboard.html");
        await dash.waitForSelector("#map [data-you]", { timeout: 5000 }).catch(() => {});
        const d = await dash.evaluate(
          () => document.querySelector("h1").textContent + " | " + document.getElementById("since").textContent,
        );
        const you = await dash.evaluate(() => document.querySelector("#map [data-you]")?.textContent || "");
        await dash.setViewport({ width: 900, height: 1400 });
        await shot(dash, "dashboard-es.png");
        await dash.close();
        const stored = await openExtPage(es, "stored.html");
        await sleep(300);
        const s = await stored.evaluate(
          () =>
            document.querySelector("h1").textContent +
            " | " +
            document.getElementById("reach").textContent.replace(/\s+/g, " "),
        );
        await stored.close();
        expect(
          /bienvenida/.test(w.title) && /Número de teléfono/.test(w.tryResult) && w.lang === "es",
          `welcome: ${JSON.stringify(w)}`,
        );
        expect(/Tu informe de exposición a la IA/.test(d), `report: ${d}`);
        expect(you === "Tú", `the map's middle says "${you}", not "Tú"`);
        expect(/Qué guarda Clotr/.test(s) && /sitios de chat de IA/.test(s), `stored: ${s.slice(0, 200)}`);
      } finally {
        await es.browser.close();
        fs.rmSync(es.profile, { recursive: true, force: true });
      }
    },
  );

  // The mind map's nodes: branch/type/key:count, sorted (D75).
  // Waits for the map to stop moving (D75: it glides between drawings), then lists its nodes.
  const mindNodes = async (page, root = "#map") => {
    await page
      .waitForFunction((r) => !("moving" in (document.querySelector(r)?.dataset || {})), { timeout: 3000 }, root)
      .catch(() => {});
    return page.evaluate(
      (root) =>
        [...document.querySelectorAll(`${root} .mind-node`)]
          .filter((n) => n.dataset.nodeType !== "leaf")
          .map(
            (n) =>
              `${n.dataset.branch}/${n.dataset.nodeType}/${n.dataset.service || n.dataset.kind || ""}:${n.dataset.count}`,
          )
          .sort(),
      root,
    );
  };

  await check(
    "MAP1",
    "Mind map: you in the middle, four branches (already has, near misses, not shared yet, blind spots), counts per AI service, and a table view",
    async () => {
      await store.set(ctx, { events: dashEvents(), mentions: [], vault: [], spotted: {} });
      const page = await openExtPage(ctx, "dashboard.html");
      try {
        await sleep(400);
        const nodes = await mindNodes(page);
        const got = await page.evaluate(() => ({
          you: Boolean(document.querySelector("#map [data-you]")),
          branches: [...document.querySelectorAll('#map [data-node-type="branch"]')].map((n) => n.dataset.branch),
          rows: [...document.querySelectorAll("#map-table tbody tr")].map(
            (r) => r.cells[0].textContent + ": " + r.cells[1].textContent,
          ),
          labels: [...document.querySelectorAll('#map [data-branch="has"][data-service]')].map((n) =>
            n.getAttribute("aria-label"),
          ),
        }));
        await shot(page, "dashboard-map.png");
        await mindNodes(page); // a screenshot resizes the page, which redraws (and moves) the map
        const fit = await page.evaluate(() => {
          const svg = document.getElementById("map");
          const content = svg.getBBox(),
            vb = svg.viewBox.baseVal;
          return {
            emptyBelow: Math.round(vb.y + vb.height - (content.y + content.height)),
            emptyAbove: Math.round(content.y - vb.y),
            cutLeft: Math.round(vb.x - content.x),
            cutRight: Math.round(content.x + content.width - (vb.x + vb.width)),
          };
        });
        expect(fit.emptyBelow < 40 && fit.emptyAbove < 40, `map leaves empty space: ${JSON.stringify(fit)}`);
        expect(fit.cutLeft <= 2 && fit.cutRight <= 2, `labels cut off at the sides: ${JSON.stringify(fit)}`);
        expect(got.you, "no 'You' node");
        expect(got.branches.join(",") === "has,near,open,blind", `branches: ${got.branches}`);
        for (const want of [
          "has/branch/:3",
          "has/service/chatgpt.com:4",
          "has/service/claude.ai:3",
          "has/service/gemini.google.com:1",
          "near/branch/:1",
          "near/service/chatgpt.com:1",
          "open/branch/:0",
          "blind/branch/:0",
          "blind/cant-see/:0",
        ])
          expect(nodes.includes(want), `missing ${want} in ${JSON.stringify(nodes)}`);
        expect(
          got.rows.join(" | ") ===
            "Already has: chatgpt.com | Already has: claude.ai | Already has: gemini.google.com | Near misses: chatgpt.com | Blind spots: Clotr can't see",
          `table: ${got.rows.join(" | ")}`,
        );
        expect(
          got.labels.every((l) => / has: /.test(l) && /riskiest/i.test(l)),
          `labels: ${JSON.stringify(got.labels)}`,
        );
      } finally {
        await page.close();
      }
    },
  );

  await check(
    "MAP2",
    "Mind map: choosing an AI service (keyboard) shows which kinds it has, and a branch explains itself; never values or fingerprints",
    async () => {
      await store.set(ctx, { events: dashEvents(), mentions: [], vault: [], spotted: {} });
      const page = await openExtPage(ctx, "dashboard.html");
      try {
        await sleep(400);
        const choose = async (selector) => {
          const focused = await page.evaluate((sel) => {
            const n = document.querySelector(sel);
            n?.focus();
            return Boolean(n) && document.activeElement === n;
          }, selector);
          expect(focused, `${selector} can't take keyboard focus`);
          await page.keyboard.press("Enter");
          await sleep(200);
          return page.$eval("#map-details", (n) => n.innerText);
        };
        const has = await choose('#map [data-branch="has"][data-service="chatgpt.com"]');
        expect(
          /chatgpt\.com has/.test(has) &&
            /Phone Number ×2/.test(has) &&
            /Email Address/.test(has) &&
            /AWS Access Key/.test(has),
          `details: ${has}`,
        );
        const near = await choose('#map [data-branch="near"][data-service="chatgpt.com"]');
        expect(/stopped on chatgpt\.com: Street Address/.test(near), `near miss: ${near}`);
        const blind = await choose('#map [data-node-type="branch"][data-branch="blind"]');
        expect(/can't protect you/.test(blind), `blind spots: ${blind}`);
        expect(
          !/aaaaaaaaaaaaaaa1|ccccccccccccccc3/.test(await page.evaluate(() => document.body.innerText)),
          "fingerprints shown",
        );
      } finally {
        await page.close();
        await store.set(ctx, { events: [] });
      }
    },
  );

  await check(
    "MAP3",
    "Popup Overview: a small mind map (branches with something in them) that opens the full report",
    async () => {
      await store.set(ctx, { events: dashEvents(), mentions: [], vault: [], spotted: {} });
      const popup = await openPopup(ctx);
      try {
        const nodes = await mindNodes(popup, "#mini-map");
        await shot(popup, "popup-map.png");
        expect(
          JSON.stringify(nodes) ===
            JSON.stringify([
              "has/branch/:3",
              "has/service/chatgpt.com:4",
              "has/service/claude.ai:3",
              "has/service/gemini.google.com:1",
              "near/branch/:1",
              "near/service/chatgpt.com:1",
            ]),
          `mini map: ${JSON.stringify(nodes)}`,
        );
        await popup.click("#mini-map-open");
        const opened = await waitFor(
          async () => (await ctx.browser.pages()).find((p) => p.url().endsWith("/dashboard.html")),
          3000,
        );
        expect(opened, "full report didn't open");
        await opened?.close();
      } finally {
        await popup.close();
        await store.set(ctx, { events: [] });
      }
    },
  );

  await check(
    "MAP4",
    'Mind map: "By kind of detail" regroups every branch by kind, and the choice is remembered',
    async () => {
      await store.set(ctx, { events: dashEvents(), mentions: [], vault: [], spotted: {} });
      const page = await openExtPage(ctx, "dashboard.html");
      try {
        await sleep(400);
        await page.click('#map-view [data-view="kind"]');
        await sleep(300);
        let nodes = await mindNodes(page);
        for (const want of ["has/kind/phone_number:3", "has/kind/password:1", "near/kind/street_address:1"])
          expect(nodes.includes(want), `by kind: missing ${want} in ${JSON.stringify(nodes)}`);
        expect(!nodes.some((n) => n.startsWith("has/service/")), "services left in the by-kind view");
        await shot(page, "dashboard-map-kind.png");
        await page.reload();
        nodes = await waitFor(async () => {
          const n = await mindNodes(page);
          return n.some((x) => x.startsWith("has/")) ? n : null;
        }, 3000);
        const saved = await page.evaluate(() => localStorage.getItem("clotr.mapView"));
        expect(
          nodes?.includes("has/kind/phone_number:3"),
          `the by-kind choice wasn't remembered (saved: ${saved}; nodes: ${JSON.stringify(nodes)}; errors: ${ctx.problems.slice(-3).join(" / ")})`,
        );
        const checked = await page.$eval('#map-view [data-view="kind"]', (b) => b.getAttribute("aria-checked"));
        expect(checked === "true", `toggle state: ${checked}`);
        await page.click('#map-view [data-view="service"]');
        await sleep(300);
        expect((await mindNodes(page)).includes("has/service/chatgpt.com:4"), "couldn't switch back");
      } finally {
        await page.close();
        await store.set(ctx, { events: [] });
      }
    },
  );

  await check(
    "MAP5",
    'Mind map: vault details no AI has seen are "not shared yet"; spotted AI tools Clotr doesn\'t protect are blind spots (protected ones never are)',
    async () => {
      const vault = [
        { kind: "value", type: "phone_number", fp: "aaaaaaaaaaaaaaa1", mode: "protect", added: 1 }, // was sent
        { kind: "value", type: "street_address", fp: "ddddddddddddddd4", mode: "protect", added: 1 }, // only hidden
        { kind: "value", type: "email", fp: "1234567890abcdef", mode: "allow", added: 1 }, // fine to share
        { kind: "word", type: "my_name", fp: "fedcba0987654321", words: 2, added: 1 }, // never sent
      ];
      await store.set(ctx, {
        events: dashEvents(),
        mentions: [],
        vault,
        spotted: { "chat.newtool.ai": true, "chatgpt.com": true },
      });
      const page = await openExtPage(ctx, "dashboard.html");
      try {
        await sleep(400);
        const nodes = await mindNodes(page);
        for (const want of [
          "open/branch/:2",
          "open/kind/street_address:1",
          "open/kind/my_name:1",
          "blind/branch/:1",
          "blind/service/chat.newtool.ai:0",
        ])
          expect(nodes.includes(want), `missing ${want} in ${JSON.stringify(nodes)}`);
        expect(!nodes.includes("open/kind/phone_number:1"), "a phone number that was sent is listed as not shared");
        expect(!nodes.some((n) => n.startsWith("open/kind/email")), "a fine-to-share detail is listed as at risk");
        expect(!nodes.includes("blind/service/chatgpt.com:0"), "a protected built-in site is listed as a blind spot");
        const rows = await page.$$eval("#map-table tbody tr", (r) => r.map((x) => x.textContent));
        expect(
          rows.some((r) => /Blind spots.*Clotr can't see.*AI apps on your computer/.test(r)),
          `rows: ${rows.join(" | ")}`,
        );
        await shot(page, "dashboard-map-full.png");
        await page.setViewport({ width: 1100, height: 1000 });
        await sleep(400);
        await mindNodes(page);
        const mapBox = await page.$("#map");
        await mapBox.screenshot({ path: path.join(OUT, "dashboard-map-wide.png") });
      } finally {
        await page.close();
        await store.set(ctx, { events: [], vault: [], spotted: {} });
      }
    },
  );

  await check("DSH5", 'Full dashboard: "Keep history for" 3 months removes older records right away', async () => {
    await store.set(ctx, {
      events: [aged(400, "aaaaaaaaaaaaaaa1"), aged(100, "aaaaaaaaaaaaaaa2"), aged(1, "aaaaaaaaaaaaaaa3")],
      keepDays: 365,
    });
    const page = await openExtPage(ctx, "dashboard.html");
    try {
      await sleep(400);
      expect((await page.$eval("#keep-days", (s) => s.value)) === "365", "setting doesn't show 1 year");
      await page.select("#keep-days", "90");
      const left = await waitFor(async () => {
        const ev = await store.events(ctx);
        return ev.length === 1 ? ev : null;
      }, 3000);
      expect(left && left[0].fp === "aaaaaaaaaaaaaaa3", `events left: ${JSON.stringify(await store.events(ctx))}`);
      expect((await store.get(ctx, "keepDays")).keepDays === 90, "setting not stored");
    } finally {
      await page.close();
      await store.set(ctx, { events: [], keepDays: 365 });
    }
  });

  await check("DSH6", "History keeps 1 year by default: older records go when the next one is written", async () => {
    await ctx.worker.evaluate(() => chrome.storage.local.remove("keepDays"));
    await store.set(ctx, { events: [aged(400, "aaaaaaaaaaaaaaa1"), aged(300, "aaaaaaaaaaaaaaa2")] });
    await ctx.worker.evaluate((e) => enqueue(() => appendEvents([e])), aged(0, "aaaaaaaaaaaaaaa3"));
    const ev = await store.events(ctx);
    expect(ev.map((e) => e.fp).join() === "aaaaaaaaaaaaaaa2,aaaaaaaaaaaaaaa3", `events: ${ev.map((e) => e.fp).join()}`);
    await store.set(ctx, { events: [] });
  });

  await check(
    "WD1",
    "Popup: weekly digest compares with last week and says what to do about a risky send",
    async () => {
      const ev = (days, type, name, severity, action) => ({
        t: Date.now() - days * DAY_MS - 60000,
        site: "chatgpt.com",
        type,
        name,
        severity,
        action,
        fp: "aaaaaaaaaaaaaaa1",
      });
      await store.set(ctx, {
        events: [
          ...Array.from({ length: 5 }, () => ev(10, "email", "Email Address", "low", "redacted")),
          ev(3, "email", "Email Address", "low", "redacted"),
          ev(2, "email", "Email Address", "low", "redacted"),
          ev(1, "aws_access_key", "AWS Access Key", "high", "allowed"),
        ],
      });
      const popup = await openPopup(ctx);
      try {
        const text = await popup.$eval("#digest", (n) => (n.hidden ? "" : n.innerText));
        await shot(popup, "popup-digest.png");
        expect(
          /This week: 3 found/.test(text) && /2 hidden/.test(text) && /1 sent anyway/.test(text),
          `digest: ${text}`,
        );
        expect(/fewer than last week \(5\)/.test(text), `no comparison: ${text}`);
        expect(/AWS Access Key/.test(text) && /Turn it off/.test(text), `no advice: ${text}`);
        await popup.click("#digest-open");
        const opened = await waitFor(
          async () => (await ctx.browser.pages()).find((p) => p.url().endsWith("/dashboard.html")),
          3000,
        );
        expect(opened, "full report didn't open");
        await opened?.close();
      } finally {
        await popup.close();
        await store.set(ctx, { events: [] });
      }
    },
  );

  await check("WD2", "Popup: no digest after a quiet fortnight", async () => {
    await store.set(ctx, {
      events: [
        {
          t: Date.now() - 20 * DAY_MS,
          site: "claude.ai",
          type: "email",
          name: "Email Address",
          severity: "low",
          action: "allowed",
          fp: "aaaaaaaaaaaaaaa1",
        },
      ],
    });
    const popup = await openPopup(ctx);
    try {
      expect(await popup.$eval("#digest", (n) => n.hidden), "digest shown with nothing in two weeks");
    } finally {
      await popup.close();
      await store.set(ctx, { events: [] });
    }
  });

  await check("DSH4", "Popup → Open full report opens the dashboard", async () => {
    const popup = await openPopup(ctx);
    const before = (await ctx.browser.pages()).length;
    await popup.click("#open-dashboard");
    const opened = await waitFor(
      async () => (await ctx.browser.pages()).find((p) => p.url().endsWith("/dashboard.html")),
      3000,
    );
    await popup.close();
    expect(opened, `no dashboard tab (tabs before: ${before})`);
    await opened.close();
  });

  await check(
    "SM1",
    'Settings are simple by default; "Show advanced options" reveals per-type, per-site and built-in list',
    async () => {
      await store.set(ctx, { advanced: false, responses: {}, siteModes: {} });
      const shown = (popup) =>
        popup.evaluate(() => {
          const vis = (sel) => {
            const n = document.querySelector(sel);
            return Boolean(n && n.offsetParent !== null);
          };
          return {
            perType: vis(".resp-group details"),
            builtin: vis("details.builtin"),
            groups: vis(".resp-group .head select"),
            inUse: vis("#advanced-in-use"),
          };
        });
      let popup = await openPopup(ctx);
      await popup.click("#tab-settings");
      await sleep(200);
      const simple = await shown(popup);
      await shot(popup, "popup-settings-simple.png");
      expect(simple.groups && !simple.perType && !simple.builtin && !simple.inUse, `simple: ${JSON.stringify(simple)}`);
      await popup.click("#advanced");
      await sleep(300);
      const adv = await shown(popup);
      expect(adv.perType && adv.builtin, `advanced: ${JSON.stringify(adv)}`);
      await popup.close();
      expect((await store.get(ctx, "advanced")).advanced === true, "the choice wasn't saved");
      // A hidden per-type choice is announced in simple mode.
      await store.set(ctx, { advanced: false, responses: { email: "block" } });
      popup = await openPopup(ctx);
      await popup.click("#tab-settings");
      await sleep(200);
      const note = await shown(popup);
      await popup.close();
      await store.set(ctx, { advanced: false, responses: {} });
      expect(note.inUse, "no note about advanced settings in use");
    },
  );

  await check(
    "ST1",
    '"What Clotr stores" shows every stored record readably, hides the fingerprint secret, and lists the known limits',
    async () => {
      const events = seedEvents();
      await store.set(ctx, {
        events,
        responses: { email: "log" },
        vault: [
          { kind: "value", type: "phone_number", fp: "0123456789abcdef", mode: "allow", added: Date.now() },
          { kind: "shape", type: "my_id", shape: "@@-######", added: Date.now() },
        ],
      });
      const { salt } = await store.get(ctx, "salt");
      const page = await openExtPage(ctx, "stored.html");
      try {
        await page.click(".raw summary");
        await sleep(300);
        const got = await page.evaluate(() => ({
          text: document.body.innerText,
          historyRows: document.querySelectorAll("#history-table tbody tr").length,
          vaultRows: document.querySelectorAll("#vault-table tbody tr").length,
          raw: document.getElementById("raw").textContent,
        }));
        await shot(page, "stored.png");
        expect(
          got.historyRows === Math.min(events.length, 100) && got.vaultRows === 2,
          `rows: history ${got.historyRows}/${events.length}, vault ${got.vaultRows}`,
        );
        expect(
          got.text.includes("Email Address: Just count") || got.text.includes("Email address: Just count"),
          "the Log-only setting isn't shown",
        );
        expect(got.text.includes("@@-######") && got.text.includes("OK to share"), "vault items not shown");
        expect(JSON.parse(got.raw).events.length === events.length, "raw view isn't the stored data");
        expect(salt && !got.text.includes(salt) && !got.raw.includes(salt), "the fingerprint secret is shown");
        expect(
          got.text.includes("Known limits") && got.text.includes("can be guessed from their fingerprints"),
          "limits missing",
        );
        for (const v of TYPED_VALUES) expect(!got.text.includes(v), "a typed value appears on the page");
      } finally {
        await page.close();
        await store.set(ctx, { events: [], responses: {}, vault: [] });
      }
    },
  );

  await check(
    "OFF1",
    '"What Clotr stores" → What Clotr can reach: the live no-network policy, a reason for every permission, the AI-site count',
    async () => {
      const page = await openExtPage(ctx, "stored.html");
      try {
        await sleep(300);
        const got = await page.evaluate(() => ({
          policy: document.getElementById("policy")?.textContent || "",
          perms: [...document.querySelectorAll("#permissions [data-permission]")].map((n) => ({
            id: n.dataset.permission,
            why: n.nextElementSibling?.textContent || "",
          })),
          text: document.getElementById("reach")?.innerText || "",
        }));
        const m = await page.evaluate(() => chrome.runtime.getManifest());
        await shot(page, "reach.png");
        expect(
          got.policy === m.content_security_policy.extension_pages && got.policy.includes("connect-src 'self'"),
          `policy: ${got.policy}`,
        );
        const want = [...m.permissions, "AI sites", "Sites you add"];
        expect(
          want.every((p) => got.perms.some((g) => g.id === p && g.why.length > 20)),
          `permissions: ${JSON.stringify(got.perms)}`,
        );
        expect(
          got.text.includes(`${m.host_permissions.length} AI chat sites`),
          `site count: ${got.text.slice(0, 300)}`,
        );
        expect(/SHA256SUMS/.test(got.text), "no rebuild-and-compare instructions");
      } finally {
        await page.close();
      }
    },
  );
};
