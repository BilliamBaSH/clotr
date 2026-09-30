// E2E checks: U. Updates. Run in order by ../run.js with one shared env (helpers from ../lib.js).
"use strict";

module.exports = async function (env) {
  const {
    EXT,
    KEY,
    KEY2,
    Skip,
    check,
    clickDialogButton,
    ctx,
    expect,
    fs,
    launch,
    openPopup,
    openSite,
    os,
    path,
    pressEnter,
    resetState,
    sentMessages,
    shot,
    sleep,
    store,
    typeText,
    waitFor,
    waitForDialog,
    waitForNotice,
  } = env;
  await check("U1", 'After an update the popup shows "what\'s new" once', async () => {
    const version = await ctx.worker.evaluate(() => chrome.runtime.getManifest().version);
    await store.set(ctx, { lastUpdate: { from: "0.7.5", to: version, t: Date.now(), seen: false } });
    const popup = await openPopup(ctx);
    const card = await popup.$eval("#whats-new", (n) => (n.hidden ? null : n.innerText));
    await shot(popup, "popup-whats-new.png");
    await popup.click("#whats-new-ok");
    await sleep(300);
    await popup.close();
    const { lastUpdate } = await store.get(ctx, "lastUpdate");
    expect(card?.includes(`Updated to v${version}`) && card.split("\n").length >= 3, `card: ${card}`);
    expect(lastUpdate.seen === true, "not marked seen");
  });

  // A copy of the extension in its own browser, with its version bumped on disk.
  // `before` edits the copy's manifest before it's installed (to start from an older shape).
  async function withChangedCopy(fn, before = null) {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), "clotr-ext-"));
    fs.cpSync(EXT, copy, { recursive: true });
    const current = fs.readFileSync(path.join(copy, "manifest.json"), "utf8");
    if (before) {
      const m = JSON.parse(current);
      before(m);
      fs.writeFileSync(path.join(copy, "manifest.json"), JSON.stringify(m, null, 2));
    }
    const other = await launch(copy);
    other.restoreManifest = () => fs.writeFileSync(path.join(copy, "manifest.json"), current);
    const bump = () => {
      const file = path.join(copy, "manifest.json");
      const m = JSON.parse(fs.readFileSync(file, "utf8"));
      m.version = "9.9.9";
      fs.writeFileSync(file, JSON.stringify(m, null, 2));
    };
    try {
      return await fn(other, bump, copy);
    } finally {
      await other.browser.close();
      fs.rmSync(other.profile, { recursive: true, force: true });
      fs.rmSync(copy, { recursive: true, force: true });
    }
  }

  await check("U2", "Update check: no reload when nothing changed, exactly one when the files on disk changed", () =>
    withChangedCopy(async (other, bump) => {
      // Record reload calls instead of restarting, so this runs on every browser.
      await other.worker.evaluate(() => {
        globalThis.__reloads = 0;
        chrome.runtime.reload = () => {
          globalThis.__reloads++;
        };
      });
      const unchanged = await other.worker.evaluate(() => checkForLocalUpdate());
      expect(unchanged === false, "reported an update with nothing changed");
      bump();
      const changed = await other.worker.evaluate(() => checkForLocalUpdate());
      const reloads = await other.worker.evaluate(() => globalThis.__reloads);
      expect(changed === true && reloads === 1, `update detected: ${changed}, reloads: ${reloads}`);
    }),
  );

  await check("U2e", "Live line: a new local-update.txt from a local updater reloads Clotr once, same version", () =>
    withChangedCopy(async (other, bump, dir) => {
      await other.worker.evaluate(() => {
        globalThis.__reloads = 0;
        chrome.runtime.reload = () => {
          globalThis.__reloads++;
        };
      });
      const stamp = path.join(dir, "local-update.txt");
      expect((await other.worker.evaluate(() => checkForLocalUpdate())) === false, "reloaded with no marker");
      fs.writeFileSync(stamp, "abc123 2026-09-29T12:00:00Z\n");
      expect((await other.worker.evaluate(() => checkForLocalUpdate())) === true, "missed the new marker");
      expect((await other.worker.evaluate(() => globalThis.__reloads)) === 1, "not exactly one reload");
    }),
  );

  await check("U2c", "Update waits while a Clotr dialog is open (up to 2 hours), then reloads", () =>
    withChangedCopy(async (other, bump) => {
      await other.worker.evaluate(() => {
        globalThis.__reloads = 0;
        chrome.runtime.reload = () => {
          globalThis.__reloads++;
        };
      });
      const reloads = () => other.worker.evaluate(() => globalThis.__reloads);
      await resetState(other); // before the page opens, so it starts with these settings
      const page = await openSite(other, "chatgpt");
      try {
        await typeText(page, `key ${KEY}`);
        expect(await waitForDialog(page), "no dialog");
        bump();
        expect(
          (await other.worker.evaluate(() => checkForLocalUpdate())) === false && (await reloads()) === 0,
          "reloaded while the dialog was open",
        );
        await clickDialogButton(page, "Leave it in");
        expect(
          (await other.worker.evaluate(() => checkForLocalUpdate())) === true && (await reloads()) === 1,
          "didn't reload after the dialog was answered",
        );
        // A dialog left open for 2+ hours no longer holds the update back (D38).
        await typeText(page, ` and ${KEY2}`);
        expect(await waitForDialog(page), "no second dialog");
        await other.worker.evaluate(() => chrome.storage.session.set({ updateWaitingSince: Date.now() - 90 * 60000 }));
        expect(
          (await other.worker.evaluate(() => checkForLocalUpdate())) === false && (await reloads()) === 1,
          "gave up waiting after 90 minutes",
        );
        await other.worker.evaluate(() => chrome.storage.session.set({ updateWaitingSince: Date.now() - 121 * 60000 }));
        expect(
          (await other.worker.evaluate(() => checkForLocalUpdate())) === true && (await reloads()) === 2,
          "a long-open dialog held the update back forever",
        );
      } finally {
        await page.close();
      }
    }),
  );

  await check("U2b", "An unpacked copy really restarts into the new version (no network)", () =>
    withChangedCopy(async (other, bump) => {
      if (await other.worker.evaluate(() => typeof navigator.brave === "object")) {
        throw new Skip(
          "automated Brave drops any self-reloaded unpacked extension (even with no change); " +
            "real Brave 1.95 reloads fine (checked by hand, 2026-09-24). Runs on Chrome engines and in CI",
        );
      }
      bump();
      other.worker.evaluate(() => checkForLocalUpdate()).catch(() => {}); // the worker goes away mid-call
      const fresh = await other.browser.waitForTarget(
        (t) => t.type() === "service_worker" && t.url().endsWith("/background.js") && t !== other.swTarget,
        { timeout: 15000 },
      );
      const s = await fresh.createCDPSession();
      const { result } = await s.send("Runtime.evaluate", {
        expression: "chrome.runtime.getManifest().version",
        returnByValue: true,
      });
      expect(result.value === "9.9.9", `running version after reload: ${result.value}`);
    }),
  );

  await check("U2d", "An update that adds the built-in sites' host permissions (0.9.18) keeps Clotr running", () =>
    withChangedCopy(
      async (other, bump) => {
        if (await other.worker.evaluate(() => typeof navigator.brave === "object")) {
          throw new Skip(
            "needs a real extension reload, which automated Brave drops (D33). Runs on Chrome engines and in CI",
          );
        }
        other.restoreManifest(); // the current manifest, with host_permissions
        bump();
        other.worker.evaluate(() => checkForLocalUpdate()).catch(() => {});
        const fresh = await other.browser
          .waitForTarget(
            (t) => t.type() === "service_worker" && t.url().endsWith("/background.js") && t !== other.swTarget,
            { timeout: 15000 },
          )
          .catch(() => null);
        expect(fresh, "Clotr didn't come back after the update (disabled for new permissions?)");
        const s = await fresh.createCDPSession();
        const { result } = await s.send("Runtime.evaluate", {
          expression:
            "JSON.stringify([chrome.runtime.getManifest().version, (chrome.runtime.getManifest().host_permissions || []).length])",
          returnByValue: true,
        });
        const [version, hosts] = JSON.parse(result.value);
        expect(version === "9.9.9" && hosts > 0, `after update: version ${version}, host permissions ${hosts}`);
      },
      (m) => {
        delete m.host_permissions;
        m.version = "0.9.17";
        m.version_name = "0.9.17-alpha";
      },
    ),
  );

  await check(
    "UP1",
    "After an update, open AI tabs switch to the new version by themselves: the old copy steps aside, no reload (D39)",
    () =>
      withChangedCopy(async (other, bump) => {
        if (await other.worker.evaluate(() => typeof navigator.brave === "object")) {
          throw new Skip(
            "automated Brave drops any self-reloaded unpacked extension (D33); runs on Chrome engines and in CI",
          );
        }
        const page = await openSite(other, "chatgpt");
        try {
          await resetState(other, {}); // defaults: warnings
          await typeText(page, "hello ");
          await sleep(600);
          bump();
          other.worker.evaluate(() => checkForLocalUpdate()).catch(() => {}); // the worker goes away mid-call
          await other.browser.waitForTarget(
            (t) => t.type() === "service_worker" && t.url().endsWith("/background.js") && t !== other.swTarget,
            { timeout: 15000 },
          );
          const started = await waitFor(
            () => page.logs.filter((l) => l.includes("[Clotr] active on")).length >= 2,
            8000,
          );
          expect(
            started,
            `the new version didn't start in the open tab: ${page.logs.filter((l) => l.includes("[Clotr]")).join(" / ")}`,
          );
          // (An orphaned copy's console output doesn't reach DevTools: the notice count below shows it stepped aside.)
          await typeText(page, "call me at 937-555-0123");
          const notice = await waitForNotice(page);
          expect(notice, "no notice from the new version");
          expect(!notice.text.includes("Reload this page"), `the notice comes from the old copy: ${notice.text}`);
          const counts = await page.evaluate(() => ({
            notices: document.querySelectorAll("clotr-notice").length,
            prompts: document.querySelectorAll("clotr-reload").length,
          }));
          expect(
            counts.notices === 1 && counts.prompts === 0,
            `notices: ${counts.notices}, reload prompts: ${counts.prompts}`,
          );
          await pressEnter(page);
          await sleep(300);
          expect((await sentMessages(page)).length === 1, "didn't send");
        } finally {
          await page.close();
        }
      }),
  );
};
