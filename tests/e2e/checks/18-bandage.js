// E2E checks: BN. Bandage (pre-release Batch 2, D93): personal details become bracket labels while you type, the same
// label for the same detail in one chat; the first time, Clotr asks; passwords and keys keep their warning.
// Run in order by ../run.js with one shared env (helpers from ../lib.js).
"use strict";

module.exports = async function (env) {
  const {
    ORPHAN_CLOTR,
    KEY,
    TYPED_VALUES,
    check,
    clearEditor,
    clickDialogButton,
    clickNode,
    ctx,
    editorText,
    evalInClotr,
    expect,
    openExtPage,
    pressEnter,
    readNotice,
    readUI,
    resetState,
    sentMessages,
    sleep,
    store,
    typeText,
    waitFor,
    waitForNotice,
    withSite,
  } = env;
  const PHONE = "937-555-0123";
  const HOME = "123 Oak Street";
  TYPED_VALUES.add(PHONE);
  TYPED_VALUES.add(HOME);
  const covered = (page, want) => waitFor(async () => ((await editorText(page)) === want ? true : null), 4000);

  await check(
    "BN1",
    "Bandage on: a phone number and an address become [Phone 1] and [Address 1] while you type, with no warning",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await store.set(ctx, { bandage: { "chatgpt.com": true } });
        await sleep(300);
        await typeText(page, `call me at ${PHONE}, I live at ${HOME}`);
        const ok = await covered(page, "call me at [Phone 1], I live at [Address 1]");
        expect(ok, `chat box: "${await editorText(page)}"`);
        expect(!(await readNotice(page)), "a warning appeared for covered details");
        const counted = await waitFor(async () => {
          const events = await store.events(ctx);
          return events.some((e) => e.action === "redacted" && e.type === "phone_number") ? true : null;
        }, 3000);
        expect(counted, "not counted as hidden");
        const events = await store.events(ctx);
        expect(!JSON.stringify(events).includes("0123"), "the number was stored");
      }),
  );

  await check(
    "BN2",
    "Bandage: the same detail keeps its label in the same chat; a second, different one gets the next number",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await store.set(ctx, { bandage: { "chatgpt.com": true } });
        await sleep(300);
        await typeText(page, `my number ${PHONE}`);
        expect(await covered(page, "my number [Phone 1]"), `first: "${await editorText(page)}"`);
        await clearEditor(page);
        await typeText(page, `again ${PHONE} and my work line 937-555-0199`);
        TYPED_VALUES.add("937-555-0199");
        expect(
          await covered(page, "again [Phone 1] and my work line [Phone 2]"),
          `second: "${await editorText(page)}"`,
        );
      }),
  );

  await check("BN3", "Bandage never covers passwords or keys: a key still gets its warning", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await store.set(ctx, { bandage: { "chatgpt.com": true } });
      await sleep(300);
      await typeText(page, `key ${KEY}`);
      const n = await waitForNotice(page);
      expect(n && /AWS Access Key/.test(n.text), `notice: ${n?.text}`);
      expect((await editorText(page)).includes(KEY), "the key was swapped for a label");
    }),
  );

  await check(
    "BN4",
    "Typed fast: the first Enter is held once while details are covered; the next Enter sends labels only",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await store.set(ctx, { bandage: { "chatgpt.com": true } });
        await sleep(300);
        await page.evaluate((t) => {
          const box = document.querySelector("textarea, [contenteditable='true']");
          box.focus();
          document.execCommand("insertText", false, t);
        }, `phone ${PHONE}`);
        await pressEnter(page); // before the typing pause
        await sleep(300);
        expect((await sentMessages(page)).length === 0, "sent before covering");
        expect(await covered(page, "phone [Phone 1]"), `chat box: "${await editorText(page)}"`);
        await pressEnter(page);
        await sleep(300);
        const sent = await sentMessages(page);
        expect(
          sent.length === 1 && sent[0].includes("[Phone 1]") && !sent[0].includes("0123"),
          `sent: ${JSON.stringify(sent)}`,
        );
      }),
  );

  await check(
    "BN5",
    "First time: the warning offers cover names; yes turns Bandage on for this site and covers the detail now",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await store.set(ctx, { bandage: {} });
        await sleep(300);
        await typeText(page, `my number is ${PHONE}`);
        const n = await waitForNotice(page);
        expect(n && /cover name/i.test(n.text), `no offer: ${n?.text}`);
        await clickDialogButton(page, "Yes, use cover names", readNotice);
        expect(await covered(page, "my number is [Phone 1]"), `chat box: "${await editorText(page)}"`);
        const { bandage } = await store.get(ctx, "bandage");
        expect(bandage?.["chatgpt.com"] === true, `bandage: ${JSON.stringify(bandage)}`);
        await store.set(ctx, { bandage: {} });
      }),
  );

  await check("BN6", "First time, no thanks: the normal warning stays, and Clotr doesn't ask again on this site", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      await store.set(ctx, { bandage: {} });
      await sleep(300);
      await typeText(page, `my number is ${PHONE}`);
      expect(await waitForNotice(page), "no notice");
      await clickDialogButton(page, "No thanks", readNotice);
      // The choice is stored by the background a moment after the click: wait for it, as BI2 does, rather than
      // reading once (it failed that way on a busy PC, 2026-09-30).
      const said = await waitFor(async () => {
        const { bandage } = await store.get(ctx, "bandage");
        return bandage?.["chatgpt.com"] === false ? true : null;
      }, 4000);
      expect(said, `bandage: ${JSON.stringify((await store.get(ctx, "bandage")).bandage)}`);
      await clearEditor(page);
      await typeText(page, "or 937-555-0177");
      TYPED_VALUES.add("937-555-0177");
      const n = await waitForNotice(page);
      expect(n && !/cover name/i.test(n.text), `asked again: ${n?.text}`);
      expect((await editorText(page)).includes("937-555-0177"), "covered without a yes");
      await store.set(ctx, { bandage: {} });
    }),
  );

  await check(
    "BN7",
    "Bandage in a rich chat box (ProseMirror): the email becomes [Email 1] and the message sends with the label",
    () =>
      withSite(ctx, "claude", async (page) => {
        await resetState(ctx, {});
        await store.set(ctx, { bandage: { "claude.ai": true } });
        await sleep(300);
        TYPED_VALUES.add("jane.doe@example.com");
        await typeText(page, "write to jane.doe@example.com please");
        expect(await covered(page, "write to [Email 1] please"), `chat box: "${await editorText(page)}"`);
        await pressEnter(page);
        await sleep(300);
        const sent = await sentMessages(page);
        expect(
          sent.length === 1 && sent[0].includes("[Email 1]") && !sent[0].includes("jane.doe"),
          `sent: ${JSON.stringify(sent)}`,
        );
        await resetState(ctx, {});
      }),
  );

  // Step 2 (D93, D99): pointing at (or tabbing to) a label in the AI's answer shows the real detail in a Clotr
  // bubble. Clotr lays its own hotspots over the labels; the AI's page is never changed (rewriting a reply under a
  // site's framework can break the chat, D30).
  const REPLY = "Sure, I'll call [Phone 1] soon.";
  async function coveredReply(page) {
    await resetState(ctx, {});
    await store.set(ctx, { bandage: { "chatgpt.com": true } });
    await sleep(300);
    await typeText(page, `call me at ${PHONE}`);
    expect(await covered(page, `call me at [Phone 1]`), `chat box: "${await editorText(page)}"`);
    await pressEnter(page);
    await sleep(300);
    await page.evaluate((t) => window.__reply(t), REPLY);
    const spots = await waitFor(() => readUI(page, "CLOTR-SPOTS"), 5000);
    expect(spots && spots.buttons.length === 1, `hotspots: ${JSON.stringify(spots)}`);
    return spots;
  }
  // Where "[Phone 1]" is drawn on screen, found in the page's own text.
  const labelPoint = (page) =>
    page.evaluate((label) => {
      const t = [...document.querySelectorAll(".reply")].pop().firstChild;
      const r = document.createRange();
      r.setStart(t, t.nodeValue.indexOf(label));
      r.setEnd(t, t.nodeValue.indexOf(label) + label.length);
      const b = r.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    }, "[Phone 1]");

  await check(
    "BN8",
    "Hover to peek: pointing at a label shows the real detail in a Clotr bubble; the AI's reply stays exactly as the site wrote it",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await coveredReply(page);
        const html = await page.evaluate(() => [...document.querySelectorAll(".reply")].pop().innerHTML);
        expect(html === REPLY.replace(/'/g, "&#39;") || html === REPLY, `the reply was changed: ${html}`);
        const { x, y } = await labelPoint(page);
        await page.mouse.move(x, y);
        const peek = await waitFor(() => readUI(page, "CLOTR-PEEK"), 3000);
        expect(peek && peek.text.includes(PHONE), `peek: ${JSON.stringify(peek)}`);
        const pageText = await page.evaluate(() => document.body.innerText);
        expect(!pageText.includes(PHONE), "the real number is readable in the page");
        await page.mouse.move(0, 0);
        const closed = await waitFor(async () => ((await readUI(page, "CLOTR-PEEK")) ? null : true), 2000);
        expect(closed, "the bubble stayed open after moving away");
        await resetState(ctx, {});
      }),
  );

  await check("BN9", "Copy with real names: the bubble copies the whole answer with the label swapped back", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await coveredReply(page);
      const { x, y } = await labelPoint(page);
      await page.mouse.move(x, y);
      const peek = await waitFor(() => readUI(page, "CLOTR-PEEK"), 3000);
      expect(peek, "no bubble appeared");
      await evalInClotr(
        page,
        `window.__copied = null; navigator.clipboard.writeText = (t) => { window.__copied = t; return Promise.resolve(); }, true`,
      );
      const btn = peek.buttons.find((b) => /copy/i.test(b.text));
      expect(btn, `no copy button: ${JSON.stringify(peek.buttons)}`);
      await clickNode(page, btn.nodeId);
      await sleep(200);
      const copied = await evalInClotr(page, "window.__copied");
      expect(copied === "Sure, I'll call 937-555-0123 soon.", `copied: ${JSON.stringify(copied)}`);
      await resetState(ctx, {});
    }),
  );

  await check("BN10", "Keyboard: focusing a label's hotspot opens the bubble; moving focus away closes it", () =>
    withSite(ctx, "chatgpt", async (page) => {
      const spots = await coveredReply(page);
      await page.cdp.send("DOM.focus", { nodeId: spots.buttons[0].nodeId });
      const peek = await waitFor(() => readUI(page, "CLOTR-PEEK"), 3000);
      expect(peek && peek.text.includes(PHONE), `peek: ${JSON.stringify(peek)}`);
      await page.evaluate(() => document.querySelector("textarea, [contenteditable='true']").focus());
      const closed = await waitFor(async () => ((await readUI(page, "CLOTR-PEEK")) ? null : true), 2000);
      expect(closed, "the bubble stayed open after focus moved on");
      await resetState(ctx, {});
    }),
  );
  // The labels most people meet first: their own name, family, a birth date (D93: [Me], [Family 1], the decade).
  await check(
    "BN11",
    "Bandage with your vault: your name becomes [Me], family [Family 1], a birth date its decade",
    async () => {
      await resetState(ctx, {});
      const vp = await openExtPage(ctx, "vault.html");
      try {
        await vp.type("#f-my_name", "Jane Q Doe");
        await vp.type("#f-family_name", "Emma");
        await vp.click("#save");
        const saved = await waitFor(async () => vp.$eval("#save-msg", (n) => n.textContent || null), 3000);
        expect(saved, "the vault didn't save");
      } finally {
        await vp.close();
      }
      await store.set(ctx, { bandage: { "chatgpt.com": true } });
      await sleep(300);
      await withSite(ctx, "chatgpt", async (page) => {
        for (const v of ["Jane Q Doe", "Emma", "03/14/1948"]) TYPED_VALUES.add(v);
        await typeText(page, "I'm Jane Q Doe and my sister Emma was born on 03/14/1948");
        const text = await waitFor(async () => {
          const t = await editorText(page);
          return t.includes("[Me]") && t.includes("[Family 1]") ? t : null;
        }, 5000);
        expect(text, `chat box: "${await editorText(page)}"`);
        expect(/\[born in the 1940s\]/.test(text), `no decade label: "${text}"`);
        expect(!/Jane|Emma|1948/.test(text), `a real detail is left: "${text}"`);
      });
      await resetState(ctx, {});
    },
  );
  await check(
    "BN12",
    "Hotspots follow their label when the page's layout shifts without a scroll (a sidebar opens)",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await coveredReply(page);
        await page.evaluate(() => {
          [...document.querySelectorAll(".reply")].pop().style.marginLeft = "220px"; // no scroll, no resize event
        });
        const follows = await waitFor(async () => {
          const spot = await readUI(page, "CLOTR-SPOTS");
          const { model } = await page.cdp.send("DOM.getBoxModel", { nodeId: spot.buttons[0].nodeId });
          const hotX = (model.border[0] + model.border[2]) / 2;
          const { x } = await labelPoint(page);
          return Math.abs(hotX - x) < 6 ? true : null;
        }, 3000);
        expect(follows, "the hotspot stayed where the label used to be");
        await resetState(ctx, {});
      }),
  );
  await check(
    "BN13",
    "Typing through an input method (Japanese, Chinese…): nothing is swapped mid-composition, then covered",
    () =>
      withSite(ctx, "chatgpt", async (page) => {
        await resetState(ctx, {});
        await store.set(ctx, { bandage: { "chatgpt.com": true } });
        await sleep(300);
        await page.evaluate((t) => {
          const box = document.querySelector("#prompt-textarea");
          box.focus();
          box.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
          document.execCommand("insertText", false, t);
        }, `call me at ${PHONE}`);
        await sleep(1200); // well past the typing pause: still composing, so nothing may change
        expect((await editorText(page)).includes(PHONE), `swapped mid-composition: "${await editorText(page)}"`);
        await page.evaluate(() => {
          const box = document.querySelector("#prompt-textarea");
          box.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }));
          box.dispatchEvent(new InputEvent("input", { bubbles: true }));
        });
        expect(await covered(page, "call me at [Phone 1]"), `after composing: "${await editorText(page)}"`);
        await resetState(ctx, {});
      }),
  );
  await check(
    "BN14",
    "Bandage in a chat box inside a shadow root (Gemini, NotebookLM): the phone becomes [Phone 1] and sends",
    () =>
      withSite(ctx, "notebook", async (page) => {
        await resetState(ctx, {});
        await store.set(ctx, { bandage: { "notebook.google.com": true } });
        await sleep(300);
        await typeText(page, `call me at ${PHONE}`);
        expect(await covered(page, "call me at [Phone 1]"), `chat box: "${await editorText(page)}"`);
        await pressEnter(page);
        await sleep(300);
        const sent = await sentMessages(page);
        expect(
          sent.length === 1 && sent[0].includes("[Phone 1]") && !sent[0].includes("0123"),
          `sent: ${JSON.stringify(sent)}`,
        );
        await resetState(ctx, {});
      }),
  );
  // A site's screen-reader-only copy of a message ("You said: call me at [Phone 1]", in a 1-pixel clipped box) holds
  // the label too; a hotspot there draws a stray underline over empty page (seen on claude.ai).
  await check("BN15", "No hotspot for a label inside screen-reader-only text: only the visible label gets one", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      await store.set(ctx, { bandage: { "chatgpt.com": true } });
      await sleep(300);
      await typeText(page, `call me at ${PHONE}`);
      expect(await covered(page, `call me at [Phone 1]`), `chat box: "${await editorText(page)}"`);
      await pressEnter(page);
      await sleep(300);
      // The reply arrives with its hidden copy, as claude.ai's message rows do.
      await page.evaluate((text) => {
        const d = document.createElement("div");
        d.className = "reply";
        d.textContent = text;
        const sr = document.createElement("span");
        sr.textContent = "You said: call me at [Phone 1]";
        Object.assign(sr.style, {
          position: "absolute",
          width: "1px",
          height: "1px",
          overflow: "hidden",
          clip: "rect(0 0 0 0)",
          whiteSpace: "nowrap",
        });
        d.append(sr);
        document.body.append(d);
      }, REPLY);
      await waitFor(() => readUI(page, "CLOTR-SPOTS"), 5000);
      await sleep(600);
      const spots = await readUI(page, "CLOTR-SPOTS");
      expect(spots?.buttons.length === 1, `hotspots: ${spots?.buttons.length}`);
      await resetState(ctx, {});
    }),
  );
  // An update takes over an open tab (D39): the old copy steps aside. Its hotspots and an open bubble have to go
  // with it, or they stay on the page with nothing to move or close them (seen on claude.ai).
  await check("BN16", "When an updated Clotr takes over, the old copy's hotspots and open bubble leave the page", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await coveredReply(page);
      const { x, y } = await labelPoint(page);
      await page.mouse.move(x, y);
      expect(await waitFor(() => readUI(page, "CLOTR-PEEK"), 3000), "no bubble to start with");
      await evalInClotr(page, ORPHAN_CLOTR);
      await page.evaluate(() => document.dispatchEvent(new CustomEvent("clotr:hello")));
      await sleep(400);
      expect(!(await readUI(page, "CLOTR-PEEK")), "the old copy's bubble stayed on the page");
      expect(!(await readUI(page, "CLOTR-SPOTS")), "the old copy's hotspots stayed on the page");
    }),
  );

  // Microsoft Copilot, a new chat's first message: a moment of activity right after the send, then several quiet
  // seconds while it builds the conversation's own page (a new address), then the answer. Clotr has to still be
  // looking when the answer comes (seen on copilot.microsoft.com, 2026-09-30: the second answer had its hotspot,
  // the first didn't).
  await check("BN17", "A first answer that comes after a quiet pause and a new address still gets its hotspot", () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx, {});
      await store.set(ctx, { bandage: { "chatgpt.com": true } });
      await sleep(300);
      await typeText(page, `call me at ${PHONE}`);
      expect(await covered(page, "call me at [Phone 1]"), `chat box: "${await editorText(page)}"`);
      await pressEnter(page);
      await page.evaluate(() => {
        const busy = document.createElement("div");
        busy.className = "thinking";
        busy.textContent = "…";
        document.body.append(busy);
      });
      await sleep(4000); // longer than Clotr's wait for a pause in a streaming answer
      await page.evaluate((t) => {
        document.querySelector(".thinking")?.remove();
        history.pushState({}, "", "/c/0f3c1e8a-5b7d-4c2e-9a61-3d2f8e4b7c90");
        window.__reply(t);
      }, REPLY);
      const spots = await waitFor(() => readUI(page, "CLOTR-SPOTS"), 6000);
      expect(spots && spots.buttons.length === 1, `hotspots: ${JSON.stringify(spots)}`);
      await resetState(ctx, {});
    }),
  );
};
