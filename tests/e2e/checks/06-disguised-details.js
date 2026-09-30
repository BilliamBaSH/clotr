// E2E checks: F. Personal info in disguise. Run in order by ../run.js with one shared env (helpers from ../lib.js).
"use strict";

module.exports = async function (env) {
  const {
    DIALOG_WAIT,
    QUIET_WAIT,
    check,
    clickDialogButton,
    ctx,
    editorText,
    expect,
    readDialog,
    readNotice,
    resetState,
    sleep,
    typeText,
    waitFor,
    withSite,
  } = env;
  const DISGUISED = [
    ["(937)-555-5636", "Phone Number"],
    ["937-555-5636", "Phone Number"],
    ["call 555-5636 tonight", "Phone Number"],
    ["9375555636", "Phone Number"],
    ["ninethreesevenfivefivefivefivesixthreesix", "Phone Number"],
    ["9threeseve5five5five63six", "Phone Number"],
    ["call me at nine three seven, five five five, five six three six", "Phone Number"],
    ["my social is one two three four five six seven eight nine", "US Social Security Number"],
    ["write to me at bob at gmail dot com", "Email Address"],
    ["bob(at)example(dot)org", "Email Address"],
    ["I live at 123 Main St, Springfield, IL 62704", "Street Address"],
    ["one twenty three main street apt 4", "Street Address"],
    ["I was born on the fourteenth of March nineteen forty eight", "Date of Birth"],
    ["DOB: 03-14-1948", "Date of Birth"],
    ["acct no. one two three four five six seven eight", "Bank Account or Routing Number"],
    ["Medicare number 1EG4-TE5-MK73", "Medicare Number"],
    ["call nine three seven, five fifty five, fifty six thirty six", "Phone Number"],
    ["937-555-O636", "Phone Number"],
    ["London office: +44 20 7946 0958", "Phone Number"],
    ["DATABASE_URL is postgres://admin:S3cr3tPw@db.prod.internal:5432/app", "Connection String"],
  ];
  await check("F1-7", `Disguised phone/SSN/email detected and fully redacted (${DISGUISED.length} forms)`, () =>
    withSite(ctx, "chatgpt", async (page) => {
      await resetState(ctx);
      // All forms in one message, one Hide it (one wait instead of one per form): a form that wasn't
      // detected, or not fully hidden, leaves its digits or number words behind. Detection of each form
      // on its own is in the unit tests.
      await typeText(page, DISGUISED.map(([input]) => input).join("\n"));
      const ui = await waitFor(
        async () => ((await readDialog(page)) ? "dialog" : (await readNotice(page)) ? "notice" : null),
        DIALOG_WAIT,
      );
      expect(ui, "nothing shown for the disguised details");
      await clickDialogButton(page, "Hide it", ui === "notice" ? readNotice : readDialog);
      const after = await editorText(page);
      const covered = (after.match(/\[REDACTED/g) || []).length;
      // Forms holding the same value share one label ("937-555-5636" is inside "(937)-555-5636").
      expect(
        covered >= DISGUISED.length - 2 && !/\d{3}|five|three|gmail|example/i.test(after),
        `after Hide it (${covered} hidden): "${after.replace(/\n/g, " / ")}"`,
      );
    }),
  );

  const ORDINARY = [
    "someone phoned at noon",
    "I have 2 cats and 3 dogs",
    "I work at google dot com",
    "the invoice was $4,250,000",
    "sixty seven people from Ohio",
    "meet me on 2026-09-23 at 10:30",
    "my password is incorrect, how do I reset it?",
    "reset your password: click the link",
    "a 5 star place to eat",
    "it's a 5 minutes drive from here",
    "I walked down Main Street",
    "the meeting is 3/14/2026",
    "my birthday is coming up soon",
    "I have 2 accounts at the bank",
    "the license is MIT",
    "I want to go for a walk at 5 to 6",
    "we won 2 to 1 and ate for free",
    "the score went from +3 to +7",
    "version 10.2.3 and build 10.0.19041.1",
    "the local news and internal memo",
  ];
  // Each sentence is also in tests/corpus/normal-messages.txt (checked one by one in the unit tests);
  // here they go through the real chat box together, which takes one wait instead of twenty.
  await check("F8", `Ordinary sentences don't trigger the dialog (${ORDINARY.length} sentences)`, () =>
    withSite(ctx, "chatgpt", async (page) => {
      await typeText(page, ORDINARY.join("\n"));
      await sleep(QUIET_WAIT);
      const dialog = await readDialog(page);
      const notice = await readNotice(page);
      expect(!dialog && !notice, `alarm: ${(dialog || notice)?.text}`);
    }),
  );
};
