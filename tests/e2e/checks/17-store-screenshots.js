// E2E checks: Store / README screenshots (only with --store). Ordinary moments in ordinary places (D135): a tax
// question in an AI chat, an email to the landlord, a group chat, a card number, Bandage, the report, the welcome
// page. Neutral, unbranded demo pages, fake data. Each store picture is 1280×800 with a caption in the refreshed look;
// the plain screenshots go to docs/store/shots/ for the README and the website. Run in order by ../run.js with one
// shared env (helpers from ../lib.js).
"use strict";

module.exports = async function (env) {
  const {
    EXT,
    ROOT,
    argv,
    check,
    clickDialogButton,
    ctx,
    expect,
    fs,
    launch,
    openExtPage,
    openPopup,
    os,
    path,
    readNotice,
    readUI,
    resetState,
    seedEvents,
    sleep,
    store,
    typeText,
    waitFor,
    waitForDialog,
    waitForNotice,
    withSite,
  } = env;
  if (!argv.includes("--store")) return;

  const dir = path.join(ROOT, "docs", "store");
  const shots = path.join(dir, "shots");
  fs.mkdirSync(shots, { recursive: true });
  const b64 = (file) => fs.readFileSync(file).toString("base64");
  const font = (w) =>
    `@font-face{font-family:Atkinson;src:url(data:font/woff2;base64,${b64(path.join(EXT, "fonts", `atkinson-hyperlegible-${w}.woff2`))}) format("woff2");font-weight:${w}}`;
  const tile = b64(path.join(ROOT, "site", "assets", "tile.svg"));

  // A store picture: the brand, a caption and one line on warm paper, the screenshot lit from the top on the right.
  const frame = async (name, caption, sub, png, width) => {
    const page = await ctx.browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${font(400)}${font(700)}
      body{margin:0;width:1280px;height:800px;box-sizing:border-box;padding:0 60px 0 72px;display:flex;align-items:center;gap:48px;
        font-family:Atkinson,system-ui,sans-serif;color:#0b0b0b;
        background:radial-gradient(55% 65% at 76% 52%,rgba(255,103,0,.14),transparent 70%),
          radial-gradient(#e8e0d8 1.4px,transparent 1.6px) 0 0/24px 24px,#fbf8f5}
      .text{flex:0 0 380px}
      .brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:24px;margin-bottom:44px}
      .brand img{width:36px;height:36px}
      h1{font-size:46px;line-height:1.1;letter-spacing:-.02em;margin:0}
      p{font-size:21px;line-height:1.5;color:#534e49;margin:20px 0 0}
      .shot{flex:1;display:flex;justify-content:center}
      .shot img{width:${width}px;border-radius:16px;
        box-shadow:0 1px 2px rgba(60,30,10,.08),0 34px 64px -26px rgba(120,60,20,.4),0 0 0 1px rgba(80,45,15,.1)}
      </style></head><body><div class="text"><div class="brand"><img src="data:image/svg+xml;base64,${tile}" alt="">Clotr</div>
      <h1>${caption}</h1><p>${sub}</p></div><div class="shot"><img src="data:image/png;base64,${png}" alt=""></div></body></html>`);
    await page.evaluate("document.fonts.ready");
    await page.screenshot({ path: path.join(dir, name) });
    await page.close();
  };
  // A page at a size where the warning stays readable once it's scaled into a store picture; sharp at 2×.
  const VIEW = { width: 1000, height: 680, deviceScaleFactor: 2 };
  const prepare = async (page) => {
    await page.setViewport(VIEW);
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  };
  const snap = async (page, name) => {
    await sleep(300);
    await page.screenshot({ path: path.join(shots, name) });
    return b64(path.join(shots, name));
  };

  // Email and chat apps run Clotr only once you switch them on (D134): a copy with the two demo sites granted.
  async function withGrantedCopy(fn) {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-ext-"));
    fs.cpSync(EXT, copy, { recursive: true });
    const m = JSON.parse(fs.readFileSync(path.join(copy, "manifest.json"), "utf8"));
    m.host_permissions = [...m.host_permissions, "https://outlook.live.com/*", "https://app.slack.com/*"];
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
      await resetState(other, {});
      return await fn(other);
    } finally {
      await other.browser.close();
    }
  }

  await check(
    "SS1",
    "Store pictures: AI chat, email, group chat, Bandage, report, ask first, welcome (docs/store/)",
    async () => {
      // 1. A tax question in an AI chat, then 8. the same message after Hide it.
      await withSite(ctx, "demo", async (page) => {
        await prepare(page);
        await resetState(ctx, {});
        await page.evaluate(() =>
          window.__setLog([
            ["me", "I'm doing my taxes and a number on my W-2 looks off. Can you help me check it?"],
            ["ai", "Of course. Tell me what's on the form and I'll walk through it with you."],
          ]),
        );
        await typeText(page, "Is this right? My Social Security number is 219-09-9999 and I made $41,200 last year.");
        expect(await waitForNotice(page), "no notice");
        const shot = await snap(page, "ai-chat.png");
        await frame(
          "1-ai-chat.png",
          "Clot your data leaks",
          "Your Social Security number in a tax question? Clotr notices before you hit send. Hide it, or leave it in: your call.",
          shot,
          740,
        );
        await clickDialogButton(page, "Hide it", readNotice);
        await frame(
          "8-hidden.png",
          "Hidden with one click",
          "The number comes out of your message before anything is sent. Nothing leaves your computer.",
          await snap(page, "hidden.png"),
          740,
        );
      });

      // 2. An email to the landlord and 3. a group chat, on sites switched on in Settings.
      await withGrantedCopy(async (other) => {
        await withSite(other, "demomail", async (page) => {
          await prepare(page);
          await typeText(
            page,
            "Hi, the heater is broken again. I'm at 123 Oak Street, Apt 4B. Call me at 937-555-0123 and I'll let you in.",
          );
          expect(await waitForNotice(page), "no notice in the email");
          await frame(
            "2-email.png",
            "Your email too",
            "Switch Clotr on for your webmail in Settings. It warns the same way before your address or phone number goes out.",
            await snap(page, "email.png"),
            740,
          );
        });
        await withSite(other, "demogroup", async (page) => {
          await prepare(page);
          await typeText(page, "just log in as me lol, the password is Sunflower2009");
          expect(await waitForNotice(page), "no notice in the group chat");
          await frame(
            "3-group-chat.png",
            "And your group chats",
            "Chat apps and group chats too, one site at a time. Clotr never reads anyone else's messages.",
            await snap(page, "group-chat.png"),
            740,
          );
        });
      });

      // 6. Ask before sending: a card number held until you choose.
      await withSite(ctx, "demo", async (page) => {
        await prepare(page);
        await resetState(ctx); // Ask before sending for the high-risk kinds
        await page.evaluate(() =>
          window.__setLog([
            ["me", "My order never arrived. Can you help me write to the store?"],
            ["ai", "Sure. What did you order, and how did you pay?"],
          ]),
        );
        await typeText(page, "A blue winter coat. I paid with my card 4111 1111 1111 1111, it expires 08/28.");
        expect(await waitForDialog(page), "no dialog");
        await frame(
          "6-ask-before-sending.png",
          "It can ask first",
          "For a card number or a password, Clotr can hold the message until you decide. You pick which kinds.",
          await snap(page, "ask-before-sending.png"),
          740,
        );
      });

      // 4. Bandage (D93): cover names in the message, the real detail on hover in the answer.
      await withSite(ctx, "demo", async (page) => {
        await prepare(page);
        await resetState(ctx, {});
        await store.set(ctx, { bandage: { "poe.com": true } });
        await sleep(300);
        await typeText(
          page,
          "The heater has been broken since Monday. Reach me at 937-555-0123. I live at 123 Oak Street.",
        );
        const covered = await waitFor(async () => {
          const t = await page.$eval("#prompt", (b) => b.value);
          return t.includes("[Phone 1]") && t.includes("[Address 1]") ? t : null;
        }, 5000);
        expect(covered, "not covered");
        await page.keyboard.press("Enter");
        await sleep(400);
        await page.evaluate(() =>
          window.__reply(
            'Here\'s a draft: "Hi, the heater at [Address 1] has been broken since Monday. Could someone take a look this week? You can reach me at [Phone 1]. Thanks!"',
          ),
        );
        expect(await waitFor(() => readUI(page, "CLOTR-SPOTS"), 5000), "no hotspots");
        const at = await page.evaluate((label) => {
          const t = [...document.querySelectorAll(".msg.ai")].pop().firstChild;
          const r = document.createRange();
          r.setStart(t, t.nodeValue.indexOf(label));
          r.setEnd(t, t.nodeValue.indexOf(label) + label.length);
          const b = r.getBoundingClientRect();
          return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
        }, "[Phone 1]");
        await page.mouse.move(at.x, at.y);
        expect(await waitFor(() => readUI(page, "CLOTR-PEEK"), 3000), "no bubble");
        await frame(
          "4-bandage.png",
          "Cover names, real answers",
          "Bandage swaps your details for labels like [Phone 1] before an AI sees them. Point at a label in the answer to see the real one.",
          await snap(page, "bandage.png"),
          740,
        );
        await store.set(ctx, { bandage: {} });
      });

      // 5. The report in the toolbar popup.
      await store.set(ctx, { events: seedEvents() });
      const popup = await openPopup(ctx);
      await popup.setViewport({ width: 380, height: 720, deviceScaleFactor: 2 });
      await popup.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
      await sleep(400);
      await popup.screenshot({ path: path.join(shots, "popup.png") });
      await popup.close();
      await frame(
        "5-dashboard.png",
        "See what you almost shared",
        "What Clotr caught, where, and what you chose. Counted on your computer; it never keeps what you typed.",
        b64(path.join(shots, "popup.png")),
        340,
      );
      await store.set(ctx, { events: [] });

      // 7. The welcome page's practice box.
      const welcome = await openExtPage(ctx, "vault.html?welcome=1");
      await welcome.setViewport({ width: 700, height: 800, deviceScaleFactor: 2 });
      await welcome.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
      await welcome.type("#try", "call me at 937-555-0123");
      await sleep(600);
      await welcome.screenshot({ path: path.join(shots, "welcome.png") });
      await welcome.close();
      await frame(
        "7-welcome.png",
        "Try it in ten seconds",
        "A practice box on the welcome page shows exactly what a warning looks like. Nothing leaves your computer.",
        b64(path.join(shots, "welcome.png")),
        560,
      );
      return "8 store pictures in docs/store/, plain shots in docs/store/shots/";
    },
  );
};
