// E2E checks: R. Responses. Run in order by ../run.js with one shared env (helpers from ../lib.js).
"use strict";

module.exports = async function (env) {
  const {
    KEY,
    KEY2,
    OUT,
    TYPED_VALUES,
    activeBadge,
    check,
    chooseResponse,
    clearEditor,
    clickDialogButton,
    ctx,
    editorText,
    evalInClotr,
    expect,
    expectNoUI,
    fs,
    openPopup,
    path,
    pressEnter,
    readDialog,
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
  await check("R0", "Out of the box nothing blocks: a key shows the notice and Enter sends", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      await typeText(page, `key ${KEY}`);
      const notice = await waitForNotice(page);
      expect(
        notice?.text.includes("AWS Access Key"),
        `notice: ${notice?.text} LOGS: ${page.logs.slice(-6).join(" || ")}`,
      );
      expect(!(await readDialog(page)), "the blocking dialog appeared by default");
      await pressEnter(page);
      await sleep(300);
      expect((await sentMessages(page)).length === 1, "message not sent");
      // A send before the warning could be read is recorded once it's confirmed (~1.2 s, D52).
      const events =
        (await waitFor(async () => ((await store.events(ctx)).length ? store.events(ctx) : null), 3000)) || [];
      expect(events.length === 1 && events[0].action === "allowed", `events: ${JSON.stringify(events)}`);
    }),
  );

  await check("R0b", "Notice → More choices → stop warning me about this kind sets that type to Log only", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      await typeText(page, "call me at 937-555-5636");
      expect(await waitForNotice(page), "no notice");
      await clickDialogButton(page, "More choices", readNotice);
      await clickDialogButton(page, "Leave it in, and stop warning me about: Phone Number", readNotice);
      expect(!(await readNotice(page)), "notice still open");
      const { responses } = await store.get(ctx, "responses");
      expect(responses?.phone_number === "log", `responses: ${JSON.stringify(responses)}`);
      await clearEditor(page);
      await typeText(page, "or 937-555-1234");
      await expectNoUI(page, "phone numbers are now Log only");
    }),
  );

  // Pre-release Batch 3: "generalize instead of remove".
  await check(
    "GEN1",
    'Notice → More choices → Keep it general: the birth date becomes "March 1948", the address its town, and nothing exact is left',
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await typeText(page, "I was born on 03/14/1948 and live at 123 Oak Street, Springfield, IL 62704");
        expect(await waitForNotice(page), "no notice");
        await clickDialogButton(page, "More choices", readNotice);
        await clickDialogButton(page, 'Keep it general: "Springfield", "March 1948"', readNotice);
        // Under load, the generalized text and its "redacted" event can land after the click
        // handler's fixed wait (seen once on a busy PC, #177): wait for the actual outcome
        // instead of a fixed delay or the first recorded action.
        const text = await waitFor(
          async () => ((await editorText(page)) === "I was born on March 1948 and live at Springfield" ? true : null),
          4000,
        );
        expect(text, `chat box: "${await editorText(page)}"`);
        const redacted = await waitFor(async () => {
          const { events = [] } = await store.get(ctx, "events");
          return events.some((e) => e.action === "redacted") ? true : null;
        }, 4000);
        expect(redacted, "counted as hidden");
      }),
  );

  await check(
    "GEN2",
    'Ask-before dialog → More choices → Say "March 1948" instead, and hide the rest (the phone number)',
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, { date_of_birth: "block", phone_number: "block" });
        await typeText(page, "born 03/14/1948, call me at 937-555-0123");
        await pressEnter(page);
        expect(await waitForDialog(page), "no dialog");
        await clickDialogButton(page, "More choices");
        await clickDialogButton(page, 'Say "March 1948" instead, and hide the rest');
        const text = await editorText(page);
        expect(text === "born March 1948, call me at [REDACTED PHONE NUMBER]", `chat box: "${text}"`);
      }),
  );

  await check(
    "MC1",
    "More choices: 'don't warn me about this one again' (vault: fine to share) and 'always watch for this one' (vault: protect)",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await typeText(page, "call me at 937-555-5636");
        expect(await waitForNotice(page), "no notice");
        await page.screenshot({ path: path.join(OUT, "notice-more-closed.png") });
        await clickDialogButton(page, "More choices", readNotice);
        await page.screenshot({ path: path.join(OUT, "notice-more-open.png") });
        await clickDialogButton(page, "Leave it in, and don't warn me about this one again", readNotice);
        expect(!(await readNotice(page)), "notice still open");
        // The vault write goes through the background's queue: wait for it.
        let vault = await waitFor(async () => {
          const v = (await store.get(ctx, "vault")).vault;
          return v?.length ? v : null;
        }, 3000);
        expect(
          vault?.length === 1 &&
            vault[0].mode === "allow" &&
            vault[0].type === "phone_number" &&
            /^[0-9a-f]{16}$/.test(vault[0].fp),
          `vault: ${JSON.stringify(vault)}`,
        );
        expect(!JSON.stringify(vault).includes("5636"), "the number itself was stored");
        await clearEditor(page);
        await typeText(page, "again 937-555-5636");
        await expectNoUI(page, "this number is fine to share now");
        await clearEditor(page);
        await store.set(ctx, { responses: { aws_access_key: "block" } });
        await typeText(page, `key ${KEY2}`);
        expect(await waitForDialog(page), "no dialog");
        await clickDialogButton(page, "More choices");
        await page.screenshot({ path: path.join(OUT, "dialog-more-open.png") });
        await clickDialogButton(page, "Hide it, and always watch for this one, however it's written");
        expect((await editorText(page)).includes("[REDACTED AWS ACCESS KEY]"), "not hidden");
        vault = await waitFor(async () => {
          const v = (await store.get(ctx, "vault")).vault || [];
          return v.some((e) => e.type === "aws_access_key") ? v : null;
        }, 3000);
        expect(
          vault?.some((e) => e.type === "aws_access_key" && e.mode === "protect"),
          `vault: ${JSON.stringify(vault)}`,
        );
      }),
  );

  const PHONE = "call me at 937-555-5636";
  await check("R1", "Warn (phone, default): notice shows, sending isn't blocked, counts as allowed", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx);
      await typeText(page, PHONE);
      const notice = await waitForNotice(page);
      expect(
        notice?.text.includes("Phone Number"),
        `notice: ${notice?.text} LOGS: ${page.logs.slice(-6).join(" || ")}`,
      );
      expect(!notice.text.includes("937-555-5636"), "notice shows the full number");
      expect(!(await readDialog(page)), "a warn-level item opened the blocking dialog");
      await page.screenshot({ path: path.join(OUT, "notice.png") });
      await sleep(1600); // read it, then send anyway (an informed send: no "Just sent" follow-up, FS2)
      await pressEnter(page);
      await sleep(300);
      const sent = await sentMessages(page);
      expect(sent.length === 1, `sent: ${JSON.stringify(sent)}`);
      expect(!(await readNotice(page)), "notice still open after sending");
      const events = await waitFor(async () => ((await store.events(ctx)).length ? store.events(ctx) : null), 2000);
      expect(events?.length === 1 && events[0].action === "allowed", `events: ${JSON.stringify(events)}`);
    }),
  );

  await check("R1b", "Keep it lasts for that message only: the next message warns again", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      await typeText(page, PHONE);
      expect(await waitForNotice(page), "no notice");
      await clickDialogButton(page, "Leave it in", readNotice);
      await typeText(page, " and more words");
      await expectNoUI(page, "same value, same message, already kept");
      await pressEnter(page);
      await sleep(300);
      expect((await sentMessages(page)).length === 1, "first message not sent");
      await typeText(page, `again: ${PHONE}`);
      const again = await waitForNotice(page);
      expect(again?.text.includes("Phone Number"), "the next message didn't warn again");
    }),
  );

  await check("R2", "Warn notice → Remove it replaces the number and records 'redacted'", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx);
      await typeText(page, PHONE);
      expect(await waitForNotice(page), "no notice");
      await clickDialogButton(page, "Hide it", readNotice);
      const text = await editorText(page);
      expect(text.includes("[REDACTED PHONE NUMBER]") && !text.includes("5636"), `editor text: "${text}"`);
      expect(!(await readNotice(page)), "notice still open");
      const events = await waitFor(async () => ((await store.events(ctx)).length ? store.events(ctx) : null), 2000);
      expect(events?.[0]?.action === "redacted", `events: ${JSON.stringify(events)}`);
    }),
  );

  await check(
    "KM1",
    "Hide it works in an editor that applies edits a moment later at its own caret (Kimi); counted only once hidden",
    () =>
      withSite(ctx, "asynced", async (page) => {
        await resetState(ctx, {}); // default Warn: a notice while typing
        await typeText(page, `my key ${KEY} ok`);
        expect(await waitForNotice(page), "no notice");
        await clickDialogButton(page, "Hide it", readNotice);
        const text =
          (await waitFor(async () => {
            const t = await editorText(page);
            return t.includes("[REDACTED") ? t : null;
          }, 3000)) || (await editorText(page));
        await sleep(500); // a late duplicate edit would show up by now
        const final = await editorText(page);
        expect(
          final.trim() === "my key [REDACTED AWS ACCESS KEY] ok",
          `editor text: "${final}" (first seen: "${text}")`,
        );
        await sleep(1200); // past the scan delay
        const after = await readNotice(page);
        expect(!after, `a notice after hiding (Clotr's own edit mistaken for the user's): ${after?.text}`);
        const events = await waitFor(async () => ((await store.events(ctx)).length ? store.events(ctx) : null), 2000);
        expect(events?.length === 1 && events[0].action === "redacted", `events: ${JSON.stringify(events)}`);
      }),
  );

  // The retry for such editors selects the whole message again; once the edit lands, that selection must not stay:
  // the next keystroke would replace or wrap the message (Microsoft Copilot, 2026-09-30: "my cursor doesn't respond
  // accurately to my inputs").
  await check(
    "KM3",
    "After Hide it in an editor that applies edits a moment later, nothing stays selected and typing goes on at the end",
    () =>
      withSite(ctx, "asynced", async (page) => {
        await resetState(ctx, {});
        await typeText(page, `my key ${KEY} ok`);
        expect(await waitForNotice(page), "no notice");
        await clickDialogButton(page, "Hide it", readNotice);
        const hidden = await waitFor(async () => ((await editorText(page)).includes("[REDACTED") ? true : null), 3000);
        expect(hidden, `not hidden: "${await editorText(page)}"`);
        await sleep(500);
        const collapsed = await page.evaluate(() => getSelection().isCollapsed);
        expect(collapsed, "the message is still selected after the swap");
        await page.keyboard.sendCharacter("!");
        await sleep(600);
        const text = (await editorText(page)).trim();
        expect(text === "my key [REDACTED AWS ACCESS KEY] ok!", `after typing "!": "${text}"`);
      }),
  );

  // Makes execCommand("insertText") do nothing in Clotr's world only (a browser that dropped it).
  const DROP_INSERT_TEXT = `(() => { const real = document.execCommand.bind(document);
    document.execCommand = (cmd, ...rest) => cmd === "insertText" ? false : real(cmd, ...rest); return true; })()`;

  await check(
    "BI1",
    "An editor that cancels beforeinput and edits its own model (Slate, CKEditor 5): Clotr still warns while typing",
    () =>
      withSite(ctx, "cancelling", async (page) => {
        await resetState(ctx, {}); // default Warn: a notice while typing
        await typeText(page, `my key ${KEY} ok`);
        expect((await editorText(page)).includes(KEY), `the test page didn't take the text: ${await editorText(page)}`);
        const notice = await waitForNotice(page);
        expect(notice?.text.includes("AWS Access Key"), `no notice while typing: ${notice?.text}`);
      }),
  );

  await check(
    "BI2",
    "Hide it still works if the browser drops execCommand(insertText): a plain text box and a beforeinput editor",
    async () => {
      for (const key of ["chatgpt", "cancelling", "cancellingLexical"]) {
        await withSite(ctx, key, async (page) => {
          await resetState(ctx, {});
          await page.evaluate(
            `(${page.site.editor}).addEventListener("input", (e) => { window.__inputs = (window.__inputs || 0) + 1; })`,
          );
          await typeText(page, `my key ${KEY} ok`);
          expect(await waitForNotice(page), `${key}: no notice`);
          await evalInClotr(page, DROP_INSERT_TEXT);
          const inputsBefore = await page.evaluate(() => window.__inputs || 0);
          await clickDialogButton(page, "Hide it", readNotice);
          const text = await waitFor(async () => {
            const t = await editorText(page);
            return t.includes("[REDACTED") ? t : null;
          }, 3000);
          expect(
            text?.trim() === "my key [REDACTED AWS ACCESS KEY] ok",
            `${key}: editor text "${await editorText(page)}"`,
          );
          if (key === "chatgpt") {
            const inputs = await page.evaluate(() => window.__inputs || 0);
            expect(inputs > inputsBefore, "the page wasn't told about the edit (no input event)");
          }
          await pressEnter(page);
          await sleep(300);
          const sent = await sentMessages(page);
          expect(sent.length === 1 && !sent[0].includes(KEY), `${key}: sent ${JSON.stringify(sent)}`);
          // The "redacted" event is sent once the fallback edit is confirmed, which on a busy PC can land after the
          // send (up to ~0.5 s here): wait for it, as GEN1 does (#177), rather than reading once.
          const counted = await waitFor(
            async () => ((await store.events(ctx)).some((e) => e.action === "redacted") ? true : null),
            4000,
          );
          expect(counted, `${key}: not counted as hidden: ${JSON.stringify(await store.events(ctx))}`);
        });
      }
    },
  );

  await check(
    "BI3",
    "Without execCommand(insertText), an editor that ignores the fallback: told to delete it by hand, the page text untouched",
    () =>
      withSite(ctx, "claude", async (page) => {
        await resetState(ctx, {});
        await typeText(page, `my key ${KEY} ok`);
        expect(await waitForNotice(page), "no notice");
        await evalInClotr(page, DROP_INSERT_TEXT);
        await clickDialogButton(page, "Hide it", readNotice);
        const told = await waitFor(async () => {
          const n = await readNotice(page);
          return n && /couldn't hide/i.test(n.text) ? n : null;
        }, 3000);
        expect(told, `notice: ${JSON.stringify(await readNotice(page))}`);
        // Writing the DOM behind a rich editor's back would show the text hidden while its model still sends it.
        expect((await editorText(page)).includes(KEY), `the page's text was changed behind the editor's back`);
        expect(!(await store.events(ctx)).some((e) => e.action === "redacted"), "counted as hidden");
        ctx.problems = ctx.problems.filter((p) => !p.includes("[Clotr] couldn't edit this chat box"));
      }),
  );

  await check(
    "KM2",
    "A chat box that refuses Clotr's edit: the user is told to delete it by hand, and nothing is counted as hidden",
    () =>
      withSite(ctx, "asynced", async (page) => {
        await resetState(ctx, {}); // default Warn: a notice while typing
        await typeText(page, `my key ${KEY} ok`);
        expect(await waitForNotice(page), "no notice");
        await page.evaluate(() => {
          window.__rejectEdits = true;
        });
        await clickDialogButton(page, "Hide it", readNotice);
        const told = await waitFor(async () => {
          const n = await readNotice(page);
          return n && /couldn't hide/i.test(n.text) ? n : null;
        }, 3000);
        expect(
          told && /AWS Access Key/.test(told.text) && /delete it yourself/i.test(told.text),
          `notice: ${JSON.stringify(await readNotice(page))}`,
        );
        expect(
          !(await store.events(ctx)).some((e) => e.action === "redacted"),
          "recorded as hidden although the key is still there",
        );
        // This check causes Clotr's "couldn't edit" warning on purpose; Z2 still catches any other.
        ctx.problems = ctx.problems.filter(
          (p) => !p.startsWith("asynced page warn: [Clotr] couldn't edit this chat box"),
        );
      }),
  );

  // The self-check state the background keeps for the active tab (what the popup's site card reads).
  const tabHealth = () =>
    ctx.worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const { protectedTabs = {} } = await chrome.storage.session.get("protectedTabs");
      return protectedTabs[tab.id] || null;
    });

  await check(
    "HC1",
    "Self-check: on a chat page Clotr reports that it sees the chat box, before anything is typed",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await page.bringToFront();
        const h = await waitFor(async () => {
          const x = await tabHealth();
          return x?.editor ? x : null;
        }, 5000);
        expect(h?.editor === true && !h.editFailed, `health: ${JSON.stringify(await tabHealth())}`);
      }),
  );

  await check(
    "HC2",
    "Self-check: an AI site's page without a chat box is reported as such (running, no chat box yet)",
    () =>
      withSite(ctx, "nochat", async (page) => {
        await page.bringToFront();
        const h = await waitFor(async () => await tabHealth(), 3000);
        await sleep(1500);
        const after = await tabHealth();
        expect(h && after && after.editor === false, `health: ${JSON.stringify(after)}`);
      }),
  );

  // "Test Clotr here" (popup): what the button asks this tab's Clotr (the popup's site card itself needs a
  // real click, so it's a manual check: TESTING B31).
  const showChatBox = () =>
    ctx.worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return chrome.tabs.sendMessage(tab.id, { type: "clotr:showChatBox" }, { frameId: 0 });
    });
  const flashShown = (page) => page.evaluate(() => Boolean(document.querySelector("clotr-flash")));

  await check(
    "TC1",
    "Test Clotr here: the chat box Clotr watches is outlined for a moment; nothing typed, sent or recorded",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await page.bringToFront();
        const answer = await showChatBox();
        expect(answer?.found === true, `answer: ${JSON.stringify(answer)}`);
        expect(await flashShown(page), "no outline on the page");
        const ring = await page.evaluate(() => {
          const box = document.querySelector("#prompt-textarea").getBoundingClientRect();
          return { top: Math.round(box.top), height: Math.round(box.height) };
        });
        expect(ring.height > 0, `the chat box isn't on screen: ${JSON.stringify(ring)}`);
        await shot(page, "test-clotr-here.png");
        expect(await waitFor(async () => !(await flashShown(page)), 3000), "the outline stayed");
        expect((await editorText(page)) === "", `the chat box changed: "${await editorText(page)}"`);
        expect((await sentMessages(page)).length === 0, "something was sent");
        expect((await store.events(ctx)).length === 0, "something was recorded");
      }),
  );

  await check("TC2", "Test Clotr here on a page without a chat box: Clotr says it can't find one", () =>
    withSite(ctx, "nochat", async (page) => {
      await page.bringToFront();
      const answer = await showChatBox();
      expect(answer?.found === false, `answer: ${JSON.stringify(answer)}`);
      expect(!(await flashShown(page)), "an outline with no chat box");
    }),
  );

  await check(
    "SEC1",
    "Storage is locked to Clotr's own pages: the part running inside an AI page can't read history, the salt or other sites' settings",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await store.set(ctx, { events: seedEvents() });
        await sleep(500);
        const got = await evalInClotr(
          page,
          `(async () => {
        try {
          const all = await chrome.storage.local.get(null);
          return "readable: " + Object.keys(all).join(",");
        } catch (e) {
          return "denied";
        }
      })()`,
        );
        expect(got === "denied", `from inside the page: ${got}`);
        await store.set(ctx, { events: [] });
      }),
  );

  await check("SET1", "A setting changed while a chat tab is still starting up reaches that tab", () =>
    withSite(ctx, "chatgpt", async (page) => {
      // Straight after the page opens, before its Clotr has registered with the background.
      await ctx.worker.evaluate(() =>
        enqueue(() => chrome.storage.local.set({ responses: { aws_access_key: "block" }, guided: {} })),
      );
      await sleep(1000);
      await typeText(page, `key ${KEY}`);
      await pressEnter(page);
      expect(await waitForDialog(page), "the tab kept its old settings: the key wasn't held");
      expect((await sentMessages(page)).length === 0, "sent despite Ask before sending");
    }),
  );

  await check("HP1", "Hostile page removes Clotr's dialog: the user is never stuck (Enter still sends, D30)", () =>
    withSite(ctx, "hostile", async (page) => {
      await resetState(ctx); // Ask before sending for keys
      await page.evaluate(() => window.__removeClotr());
      await typeText(page, `key ${KEY}`);
      await sleep(600);
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press("Enter");
        await sleep(700);
      }
      const sent = await page.evaluate(() => window.__sent.length);
      expect(sent === 1, `the message never went: the user is stuck (sent ${sent})`);
    }),
  );

  await check(
    "HP2",
    "Hostile page scripts its box (fills in a detail, empties it) with no user action: nothing is recorded as sent",
    () =>
      withSite(ctx, "hostile", async (page) => {
        await resetState(ctx, {});
        await page.evaluate(() => window.__fakeSend("my ssn is 219-09-9999"));
        await sleep(2500);
        const events = await store.events(ctx);
        expect(!events.some((e) => e.action === "allowed"), `fake send recorded: ${JSON.stringify(events)}`);
      }),
  );

  await check(
    "HP3",
    "Hostile page removes the warning notice: Clotr notes it can't show warnings on this tab (self-check)",
    () =>
      withSite(ctx, "hostile", async (page) => {
        await resetState(ctx, {});
        await page.bringToFront();
        await page.evaluate(() => window.__removeClotr());
        await typeText(page, `key ${KEY}`);
        const h = await waitFor(async () => {
          const x = await tabHealth();
          return x?.uiRemoved ? x : null;
        }, 4000);
        expect(h, `health: ${JSON.stringify(await tabHealth())}`);
      }),
  );

  await check(
    "SEC2",
    "A page can't probe what Clotr knows: guesses it puts in its own chat box by script get no reaction (S24)",
    () =>
      withSite(ctx, "hostile", async (page) => {
        await resetState(ctx, {});
        const reacted = await page.evaluate((k) => window.__probe(`is it Emma? Liam? key ${k}`), KEY);
        expect(!reacted, "Clotr reacted to text the page typed by script");
        // Real typing still warns (the page's text is checked once the user types).
        await typeText(page, " qx-sec2");
        const n = await waitFor(() => readNotice(page), 3000);
        expect(n && /AWS Access Key/.test(n.text), "no warning after real typing");
      }),
  );

  await check("SEC3", "A page can't trigger Ask before sending with a scripted Enter (S24)", () =>
    withSite(ctx, "hostile", async (page) => {
      await resetState(ctx, { responses: { aws_access_key: "block" } });
      const reacted = await page.evaluate((k) => window.__probe(`key ${k}`, { enter: true }), KEY);
      expect(!reacted, "a scripted Enter opened Clotr's dialog");
    }),
  );

  await check(
    "HC4",
    "Self-check survives in-page navigation (a single-page app changing its URL, as grok.com does after loading)",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await page.bringToFront();
        expect(await waitFor(async () => (await tabHealth())?.editor, 5000), "no health before navigating");
        await page.evaluate(() => {
          history.pushState({}, "", "/c/abc123");
        });
        await sleep(1500);
        await page.evaluate(() => {
          history.pushState({}, "", "/c/def456");
        });
        await sleep(2500);
        const h = await tabHealth();
        expect(h?.editor === true, `health after in-page navigation: ${JSON.stringify(h)}`);
      }),
  );

  await check(
    "HC3",
    "Self-check: a failed Hide it marks the tab (red ! badge, tooltip says why); a later successful Hide it clears it",
    () =>
      withSite(ctx, "asynced", async (page) => {
        await resetState(ctx, {});
        await page.bringToFront();
        await typeText(page, `my key ${KEY} ok`);
        expect(await waitForNotice(page), "no notice");
        await page.evaluate(() => {
          window.__rejectEdits = true;
        });
        await clickDialogButton(page, "Hide it", readNotice);
        const h = await waitFor(async () => {
          const x = await tabHealth();
          return x?.editFailed ? x : null;
        }, 4000);
        expect(h, `health: ${JSON.stringify(await tabHealth())}`);
        const badge = await activeBadge(ctx);
        expect(badge.text === "!", `badge: ${JSON.stringify(badge)}`);
        const title = await ctx.worker.evaluate(async () => {
          const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          return chrome.action.getTitle({ tabId: tab.id });
        });
        expect(/couldn't edit the chat box/i.test(title), `title: ${title}`);
        ctx.problems = ctx.problems.filter(
          (p) => !p.startsWith("asynced page warn: [Clotr] couldn't edit this chat box"),
        );
        // The user fixes it; next time Hide it works again.
        await page.evaluate(() => {
          window.__rejectEdits = false;
        });
        await clickDialogButton(page, "OK, I'll delete it", readNotice).catch(() => {});
        await clearEditor(page);
        await typeText(page, `again ${KEY2}`);
        expect(await waitForNotice(page), "no notice the second time");
        await clickDialogButton(page, "Hide it", readNotice);
        const cleared = await waitFor(async () => {
          const x = await tabHealth();
          return x && !x.editFailed ? x : null;
        }, 4000);
        expect(cleared, `still marked: ${JSON.stringify(await tabHealth())}`);
        expect((await activeBadge(ctx)).text !== "!", "badge still shows !");
      }),
  );

  await check("N1", "Notice with several items: every item stays inside the notice (wraps between items)", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {}); // defaults: everything warns
      await typeText(page, `key ${KEY} phone 937-555-0123 mail ann.lee@example-company.com`);
      expect(await waitForNotice(page), "no notice");
      const { root } = await page.cdp.send("DOM.getDocument", { depth: -1, pierce: true });
      let box = null;
      const codes = [];
      (function walk(n) {
        const cls = (n.attributes || []).join(" ");
        if (n.nodeName === "DIV" && / notice\b/.test(` ${cls}`) && !box) box = n;
        if (n.nodeName === "CODE") codes.push(n);
        for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) walk(c);
      })(root);
      expect(box && codes.length, `notice box ${!!box}, items ${codes.length}`);
      const right = async (n) => {
        const q = (await page.cdp.send("DOM.getBoxModel", { nodeId: n.nodeId })).model.border;
        return Math.max(q[0], q[2], q[4], q[6]);
      };
      const edge = await right(box);
      for (const c of codes) {
        const r = await right(c);
        expect(r <= edge, `an item ends at x=${Math.round(r)}, past the notice edge at x=${Math.round(edge)}`);
      }
    }),
  );

  await check("R3", "Block + warn together: one dialog lists both, Redact removes both", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx);
      await typeText(page, `${KEY} and ${PHONE}`);
      const dialog = await waitForDialog(page);
      expect(
        dialog?.text.includes("AWS Access Key") && dialog.text.includes("Phone Number"),
        `dialog: ${dialog?.text}`,
      );
      expect(!(await readNotice(page)), "notice shown alongside the dialog");
      await clickDialogButton(page, "Hide it");
      const text = await editorText(page);
      expect(!text.includes(KEY) && !text.includes("5636"), `editor text: "${text}"`);
    }),
  );

  await check(
    "R4",
    "Log only: no interruption, but every detection is still recorded (nothing is silently dropped)",
    async () => {
      await resetState(ctx);
      await chooseResponse(ctx, "phone_number", "log");
      await chooseResponse(ctx, "email", "log");
      await withSite(ctx, "chatgpt", async (page) => {
        await typeText(page, `${PHONE} or bob@example.com`);
        await expectNoUI(page, "phone and email are log-only");
        await pressEnter(page);
        await sleep(300);
        expect((await sentMessages(page)).length === 1, "message not sent");
      });
      const events = await store.events(ctx);
      const types = events
        .map((e) => `${e.type}:${e.action}`)
        .sort()
        .join(",");
      expect(types === "email:suppressed,phone_number:suppressed", `events: ${types}`);
      await chooseResponse(ctx, "phone_number", "warn");
      await chooseResponse(ctx, "email", "warn");
      const { responses } = await store.get(ctx, "responses");
      expect(
        !("phone_number" in responses) && !("email" in responses),
        `defaults not restored: ${JSON.stringify(responses)}`,
      );
    },
  );

  await check("R5", "Settings list every data type with its response", async () => {
    await store.set(ctx, { responses: { email: "off" } }); // a setting saved by an older version
    const popup = await openPopup(ctx);
    await popup.click("#tab-settings");
    const rows = await popup.$$eval("select.resp[data-pattern]", (sels) =>
      sels.map((s) => [s.dataset.pattern, s.value, s.classList.contains("changed")]),
    );
    const offOptions = await popup.$$eval("select.resp option", (os) => os.filter((o) => o.value === "off").length);
    const patternCount = await popup.evaluate(() => globalThis.Clotr.PATTERNS.length);
    await shot(popup, "popup-responses.png");
    await popup.close();
    await store.set(ctx, { responses: {} });
    const byId = Object.fromEntries(rows.map(([id, v, changed]) => [id, { v, changed }]));
    expect(rows.length === patternCount, `${rows.length} rows for ${patternCount} patterns`);
    expect(byId.aws_access_key?.v === "warn" && byId.phone_number?.v === "warn", `defaults: ${JSON.stringify(byId)}`);
    expect(
      byId.email?.v === "log" && byId.email.changed,
      `old "off" should read as Log only: ${JSON.stringify(byId.email)}`,
    );
    expect(offOptions === 0, `${offOptions} "Off" options left (everything is logged, D21)`);
  });

  await check(
    "G1",
    "Settings groups: Personal info → Log only sets every personal type; Default restores them",
    async () => {
      await resetState(ctx, {});
      const popup = await openPopup(ctx);
      await popup.click("#tab-settings");
      const pick = (v) =>
        popup.evaluate((val) => {
          const sel = document.querySelector('select[data-group="personal"]');
          sel.value = val;
          sel.dispatchEvent(new Event("change"));
        }, v);
      const initial = await popup.$eval('select[data-group="credentials"]', (s) => s.value);
      await pick("log");
      await sleep(300);
      const off = (await store.get(ctx, "responses")).responses || {};
      await popup.evaluate(() => (document.querySelector('details[data-group="personal"]').open = true));
      await sleep(100);
      await shot(popup, "popup-groups.png");
      await pick("default");
      await sleep(300);
      const after = (await store.get(ctx, "responses")).responses || {};
      await popup.close();
      expect(initial === "default", `credentials group starts at ${initial}`);
      expect(
        ["us_ssn", "credit_card", "phone_number", "email", "street_address"].every((id) => off[id] === "log") &&
          Object.values(off).every((v) => v === "log"),
        `after Log only: ${JSON.stringify(off)}`,
      );
      expect(!Object.keys(after).length, `after Default: ${JSON.stringify(after)}`);
    },
  );

  await check(
    "S2",
    "A site added on huggingface.co runs Clotr only in the chosen section, not the whole site",
    async () => {
      // Regression (2026-09-24): protecting one Hugging Face page covered all of huggingface.co.
      // The permission prompt can't be clicked in a test, so the grant is simulated in the worker;
      // what's checked is the registration that decides where Clotr runs.
      const matches = await ctx.worker.evaluate(async () => {
        const realGetAll = chrome.permissions.getAll;
        chrome.permissions.getAll = async () => ({ origins: ["https://huggingface.co/*"] });
        const scope = ClotrSites.protectScope("https://huggingface.co/spaces/owner/my-app?x=1");
        await chrome.storage.local.set({ siteScopes: { "https://huggingface.co/*": [scope] } });
        await enqueue(syncUserSites); // through the worker's queue, like every real caller
        const [reg] = await chrome.scripting.getRegisteredContentScripts({ ids: [ClotrSites.USER_SCRIPT_ID] });
        chrome.permissions.getAll = realGetAll;
        await chrome.storage.local.set({ siteScopes: {} });
        await enqueue(syncUserSites);
        return reg?.matches;
      });
      expect(
        JSON.stringify(matches) === JSON.stringify(["https://huggingface.co/spaces/owner/my-app/*"]),
        `registered on: ${JSON.stringify(matches)}`,
      );
    },
  );

  await check("S1", "Settings → Built-in AI tools lists tools by name (from ai-sites.json)", async () => {
    const popup = await openPopup(ctx);
    await popup.click("#tab-settings");
    const got = await popup.evaluate(() => ({
      count: document.querySelector("#builtin-count").textContent,
      items: [...document.querySelectorAll("#builtin-sites li")].map((li) => li.textContent),
    }));
    await popup.close();
    expect(got.count === "18" && got.items.length === 18, `count ${got.count}, ${got.items.length} items`);
    expect(got.items.includes("ChatGPT — chatgpt.com, chat.openai.com"), `items: ${got.items.slice(0, 3).join(" | ")}`);
  });

  await check("R6c", "Upgrade: a user-site registration under the old name (ChainSec) is removed", async () => {
    await ctx.worker.evaluate(() =>
      chrome.scripting.registerContentScripts([
        {
          id: "chainsec-user-sites",
          matches: ["https://chatgpt.com/*"],
          js: ["patterns.js"],
          persistAcrossSessions: false,
        },
      ]),
    );
    await ctx.worker.evaluate(() => syncUserSites());
    const left = await ctx.worker.evaluate(() =>
      chrome.scripting.getRegisteredContentScripts({ ids: ["chainsec-user-sites"] }),
    );
    expect(left.length === 0, `old registration still there: ${JSON.stringify(left)}`);
  });

  await check("R6", "Upgrade: old 'don't warn again' and 'Off' settings become Log only", async () => {
    await store.set(ctx, {
      suppressed: { global: { email: true, aws_access_key: true } },
      responses: { aws_access_key: "off" },
    });
    await ctx.worker.evaluate(() => migrateSuppressed());
    await ctx.worker.evaluate(() => migrateOffToLog());
    const got = await store.get(ctx, ["suppressed", "responses"]);
    await store.set(ctx, { responses: {} });
    expect(!got.suppressed, "old key not removed");
    expect(
      got.responses?.email === "log" && got.responses?.aws_access_key === "log",
      `responses (old "off" → Log only): ${JSON.stringify(got.responses)}`,
    );
  });

  await check(
    "LG1",
    "Sign-in fields on an AI site are never watched (shown password, username, one-time code, sign-up form); its chat box is",
    () =>
      withSite(ctx, "login", async (page) => {
        await resetState(ctx);
        const typeInto = async (sel, text) => {
          TYPED_VALUES.add(text);
          await page.focus(sel);
          await page.keyboard.sendCharacter(text);
        };
        await page.click("#show"); // "show password" makes it a text field
        await typeInto("#pass", KEY);
        await typeInto("#user", "grandma.jones@example.com");
        await typeInto("#otp", "937-555-0147");
        await typeInto("#new-user", "grandma.jones@example.com");
        await typeInto("#new-pass", KEY2);
        await page.keyboard.press("Enter");
        await expectNoUI(page, "typing into sign-in fields");
        expect(
          !(await store.events(ctx)).length,
          `sign-in fields were recorded: ${JSON.stringify(await store.events(ctx))}`,
        );
        await typeText(page, `here is the key ${KEY}`);
        expect(
          (await waitForNotice(page)) || (await waitForDialog(page)),
          "the chat box on the same page isn't protected",
        );
      }),
  );

  await check("P1", "Documentation example keys and placeholders don't trigger", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx);
      await typeText(
        page,
        "aws configure → AKIAIOSFODNN7EXAMPLE, OPENAI_API_KEY=sk-your-api-key-here-1234567890, pip install sk-learn-is-a-great-library",
      );
      await expectNoUI(page, "only example keys/placeholders");
      expect(!(await store.events(ctx)).length, "placeholder was counted");
    }),
  );

  await check("P2", '"my password is …" blocks; Redact removes only the password', () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx);
      await typeText(page, "my password is Fluffy123 can you remember it");
      const dialog = await waitForDialog(page);
      expect(dialog?.text.includes("Password or Secret"), `dialog: ${dialog?.text}`);
      expect(!dialog.text.includes("Fluffy123"), "dialog shows the password");
      await clickDialogButton(page, "Hide it");
      const text = await editorText(page);
      expect(text === "my password is [REDACTED PASSWORD OR SECRET] can you remember it", `editor text: "${text}"`);
    }),
  );

  await check("R7", "Bulk paste: the notice summarizes counts instead of listing every value", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      const rows = Array.from(
        { length: 30 },
        (_, i) => `user${i},user${i}@example${i}.com,937-555-${String(1000 + i)}`,
      );
      await typeText(page, ["name,email,phone", ...rows].join("\n"));
      const notice = await waitForNotice(page);
      await page.screenshot({ path: path.join(OUT, "notice-bulk.png") });
      expect(
        /Large paste: 31 lines/.test(notice?.text || ""),
        `notice: ${notice?.text} LOGS: ${page.logs.slice(-6).join(" || ")}`,
      );
      expect(/Email Address ×30/.test(notice.text) && /Phone Number ×30/.test(notice.text), `notice: ${notice.text}`);
      expect(!/@example/.test(notice.text), "notice lists values");
      await clickDialogButton(page, "Hide it", readNotice);
      const text = await editorText(page);
      expect(!/@example|937-555-1/.test(text), `not all redacted: ${text.slice(0, 120)}`);
    }),
  );

  await check("R8", "Attached text file: its contents are scanned and the notice names the file", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      const file = path.join(OUT, "customers.csv");
      const rows = ["name,email", "Ann,ann.lee@gmail.com", "Bo,bo.chan@yahoo.com", "Cy,cy.diaz@outlook.com"];
      rows.forEach((r) => TYPED_VALUES.add(r));
      fs.writeFileSync(file, rows.join("\n"));
      const input = await page.$("#attach");
      await input.uploadFile(file);
      const notice = await waitForNotice(page);
      await page.screenshot({ path: path.join(OUT, "notice-file.png") });
      fs.rmSync(file);
      expect(
        /customers\.csv/.test(notice?.text || "") && /Email Address ×3/.test(notice.text),
        `notice: ${notice?.text} LOGS: ${page.logs.slice(-6).join(" || ")}`,
      );
      expect(!notice.buttons.some((b) => b.text === "Hide it"), "offers Remove it for a file");
      await clickDialogButton(page, "OK", readNotice);
      const events = await waitFor(
        async () => ((await store.events(ctx)).length === 3 ? store.events(ctx) : null),
        2000,
      );
      expect(
        events?.every((e) => e.action === "allowed" && e.type === "email"),
        `events: ${JSON.stringify(await store.events(ctx))}`,
      );
    }),
  );

  // Office documents are zip files of XML. A minimal zip writer for test fixtures (stored or deflated).
  function makeZip(file, entries) {
    const zlib = require("zlib");
    const parts = [];
    const central = [];
    let offset = 0;
    for (const [name, content, deflate = true] of entries) {
      const data = Buffer.from(content);
      const body = deflate ? zlib.deflateRawSync(data) : data;
      const nameBuf = Buffer.from(name);
      const crc = zlib.crc32(data);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(deflate ? 8 : 0, 8);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt16LE(20, 4);
      cd.writeUInt16LE(20, 6);
      cd.writeUInt16LE(deflate ? 8 : 0, 10);
      cd.writeUInt32LE(crc, 16);
      cd.writeUInt32LE(body.length, 20);
      cd.writeUInt32LE(data.length, 24);
      cd.writeUInt16LE(nameBuf.length, 28);
      cd.writeUInt32LE(offset, 42);
      parts.push(local, nameBuf, body);
      central.push(cd, nameBuf);
      offset += 30 + nameBuf.length + body.length;
    }
    const cdBuf = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cdBuf.length, 12);
    end.writeUInt32LE(offset, 16);
    fs.writeFileSync(file, Buffer.concat([...parts, cdBuf, end]));
  }
  const docxXml = (paras) =>
    `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${paras.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`;

  await check("R8d", "Attached Word document: the text inside is scanned (key and phone found)", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      const file = path.join(OUT, "resume.docx");
      makeZip(file, [
        ["[Content_Types].xml", "<Types/>"],
        ["word/document.xml", docxXml(["Jane Example", `deploy key ${KEY}`, "Call me: 937-555-0123"])],
      ]);
      await (await page.$("#attach")).uploadFile(file);
      const notice = await waitForNotice(page);
      fs.rmSync(file);
      expect(
        /resume\.docx/.test(notice?.text || "") &&
          /AWS Access Key/.test(notice.text) &&
          /Phone Number/.test(notice.text),
        `notice: ${notice?.text} LOGS: ${page.logs.slice(-4).join(" || ")}`,
      );
    }),
  );

  await check(
    "R8m",
    "Several attached files at once: one notice names every file with personal data, and each is recorded once",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        const dir = path.join(OUT, "many");
        fs.mkdirSync(dir, { recursive: true });
        const files = [];
        for (let i = 0; i < 8; i++) {
          const file = path.join(dir, `notes${i}.txt`);
          const risky =
            i === 1
              ? "mail ann.lee@gmail.com"
              : i === 4
                ? "call 937-555-0144"
                : i === 6
                  ? `key ${KEY}`
                  : "nothing private here";
          TYPED_VALUES.add(risky);
          fs.writeFileSync(file, `meeting notes ${i}\n${risky}\n`);
          files.push(file);
        }
        await (await page.$("#attach")).uploadFile(...files);
        await sleep(800);
        const notice = await waitForNotice(page);
        fs.rmSync(dir, { recursive: true });
        const text = notice?.text || "";
        expect(
          /notes1\.txt/.test(text) && /notes4\.txt/.test(text) && /notes6\.txt/.test(text),
          `notice doesn't name all three files: ${text}`,
        );
        expect(
          /Email Address/.test(text) && /Phone Number/.test(text) && /AWS Access Key/.test(text),
          `notice doesn't list all kinds: ${text}`,
        );
        await clickDialogButton(page, "OK", readNotice);
        const events =
          (await waitFor(async () => {
            const ev = await store.events(ctx);
            return ev.length >= 3 ? ev : null;
          }, 3000)) || (await store.events(ctx));
        expect(
          events.length === 3 && events.every((e) => e.action === "allowed"),
          `records: ${JSON.stringify(events.map((e) => [e.type, e.action]))}`,
        );
      }),
  );

  await check("R8x", "Attached spreadsheet (.xlsx): cell text is scanned", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      const file = path.join(OUT, "customers.xlsx");
      makeZip(file, [
        [
          "xl/sharedStrings.xml",
          `<sst><si><t>Ann</t></si><si><t>ann.lee@gmail.com</t></si><si><t>bo.chan@yahoo.com</t></si></sst>`,
        ],
        ["xl/worksheets/sheet1.xml", "<worksheet/>"],
      ]);
      await (await page.$("#attach")).uploadFile(file);
      const notice = await waitForNotice(page);
      fs.rmSync(file);
      expect(
        /customers\.xlsx/.test(notice?.text || "") && /Email Address/.test(notice.text),
        `notice: ${notice?.text}`,
      );
    }),
  );

  await check(
    "R8p",
    "Attached PDF (a real one, printed by the browser: compressed, embedded fonts): its text is checked",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        const file = path.join(OUT, "statement.pdf");
        const printer = await ctx.browser.newPage();
        await printer.setRequestInterception(true);
        printer.on("request", (req) => req.abort());
        await printer.setContent(`<html><body style="font-family:Arial"><h1>Account statement</h1>
        <p>Customer: Jane Example</p><p>Phone: 937-555-0123</p><p>Email: jane.example@gmail.com</p>
        <p>Deploy key ${KEY}</p></body></html>`);
        fs.writeFileSync(file, await printer.pdf({ format: "A4" }));
        await printer.close();
        await (await page.$("#attach")).uploadFile(file);
        const notice = await waitForNotice(page);
        fs.rmSync(file);
        expect(
          /statement\.pdf/.test(notice?.text || "") &&
            /Phone Number/.test(notice.text) &&
            /AWS Access Key/.test(notice.text) &&
            /Email Address/.test(notice.text),
          `notice: ${notice?.text} LOGS: ${page.logs.slice(-3).join(" || ")}`,
        );
      }),
  );

  await check(
    "R8q",
    "PDF bomb (a tiny file whose stream inflates to 60 MB): capped, no hang, the chat keeps working",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        const file = path.join(OUT, "bomb.pdf");
        const zlib = require("zlib");
        const body = zlib.deflateSync(Buffer.from(`BT (${"A".repeat(60 * 1024 * 1024)}) Tj ET`));
        const NL = String.fromCharCode(10);
        fs.writeFileSync(
          file,
          Buffer.concat([
            Buffer.from(
              ["%PDF-1.4", `1 0 obj << /Length ${body.length} /Filter /FlateDecode >>`, "stream", ""].join(NL),
            ),
            body,
            Buffer.from(["", "endstream", "endobj", "%%EOF"].join(NL)),
          ]),
        );
        const t0 = Date.now();
        await (await page.$("#attach")).uploadFile(file);
        await sleep(2500);
        fs.rmSync(file);
        const alive = await page.evaluate(() => 1 + 1).catch(() => 0);
        expect(alive === 2 && Date.now() - t0 < 8000, `page responsive: ${alive}, ${Date.now() - t0} ms`);
        await typeText(page, "call me at 937-555-0123");
        expect(await waitForNotice(page), "Clotr stopped working after the PDF bomb");
      }),
  );

  await check(
    "R8r",
    "Hostile PDF built to make the parser crawl (200k unclosed dictionaries): no hang, chat keeps working",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        const file = path.join(OUT, "crawl.pdf");
        fs.writeFileSync(file, "%PDF-1.4 " + "<< /A <x ".repeat(200000) + ">> endobj stream");
        const t0 = Date.now();
        await (await page.$("#attach")).uploadFile(file);
        await sleep(1500);
        fs.rmSync(file);
        const ms = await page.evaluate(() => {
          const s = performance.now();
          return new Promise((r) => setTimeout(() => r(performance.now() - s), 0));
        });
        expect(
          ms < 500 && Date.now() - t0 < 6000,
          `page stalled: event loop ${Math.round(ms)} ms, total ${Date.now() - t0} ms`,
        );
        await typeText(page, "call me at 937-555-0123");
        expect(await waitForNotice(page), "Clotr stopped working after the hostile PDF");
      }),
  );

  await check("R8s", "Hostile PDF with hundreds of streams that never end (18 MB): no hang, chat keeps working", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      const file = path.join(OUT, "endless.pdf");
      const NL = String.fromCharCode(10);
      fs.writeFileSync(file, "%PDF-1.4 " + ("<< /A 1 >> stream" + NL + "x".repeat(45000) + " ").repeat(400));
      const t0 = Date.now();
      await (await page.$("#attach")).uploadFile(file);
      await sleep(2000);
      const lag = await page.evaluate(() => {
        const s = performance.now();
        return new Promise((r) => setTimeout(() => r(performance.now() - s), 0));
      });
      expect(
        lag < 500 && Date.now() - t0 < 8000,
        `page stalled: event loop ${Math.round(lag)} ms, total ${Date.now() - t0} ms`,
      );
      // Deleted without waiting: on Windows the browser keeps the uploaded file open, and a
      // synchronous delete then blocks this test for seconds (that was R8s's "stall", not the page).
      fs.rm(file, { force: true, maxRetries: 10, retryDelay: 500 }, () => {});
      await typeText(page, "call me at 937-555-0123");
      expect(await waitForNotice(page), "Clotr stopped working after the hostile PDF");
    }),
  );

  await check(
    "R8z",
    "Zip bomb in a .docx (60 MB of text from a tiny file): read is capped, no hang, the chat keeps working",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        const file = path.join(OUT, "bomb.docx");
        makeZip(file, [["word/document.xml", docxXml(["A".repeat(60 * 1024 * 1024)])]]);
        const t0 = Date.now();
        await (await page.$("#attach")).uploadFile(file);
        await sleep(2500);
        fs.rmSync(file);
        const alive = await page.evaluate(() => 1 + 1).catch(() => 0);
        expect(alive === 2 && Date.now() - t0 < 8000, `page responsive: ${alive}, ${Date.now() - t0} ms`);
        await typeText(page, "call me at 937-555-0123");
        expect(await waitForNotice(page), "Clotr stopped working after the zip bomb");
      }),
  );

  Object.assign(env, { docxXml, makeZip }); // used by later sections
};
