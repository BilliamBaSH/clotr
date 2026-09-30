// Detection tests. Run from the repo root:  node --test tests/
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../extension/patterns.js");
require("../extension/detector.js");

// The extension's own detect(), reshaped to { patternId: [matched text, …] }
function detect(text) {
  return Object.fromEntries(globalThis.Clotr.detect(text).map((r) => [r.id, r.matches]));
}

function expectNone(text) {
  const found = detect(text);
  assert.deepEqual(found, {}, `"${text}" → ${JSON.stringify(found)}`);
}

// Growth check for code that reads attacker-controlled input: 4× the input may take ~4× the
// time, not ~16× (quadratic). Best of 3 runs, and ratios only once times are measurable, so a
// garbage-collection pause can't fail it.
function assertLinear(fn, makeInput, units, n = 50000, budget = 400) {
  const best = (input) => {
    let t = Infinity;
    for (let r = 0; r < 3; r++) {
      const s = performance.now();
      fn(input);
      t = Math.min(t, performance.now() - s);
    }
    return t;
  };
  for (const unit of units) {
    const small = best(makeInput(unit, n));
    const big = best(makeInput(unit, n * 4));
    assert.ok(big < budget, `${JSON.stringify(unit)}: ${big.toFixed(1)} ms for ${n * 4} repeats`);
    // Growth is only meaningful once timings rise above scheduler/GC noise (a 1 ms run next to a
    // 20 ms one with a GC pause looked "quadratic" once, 2026-09-25); the budget catches the rest.
    if (big >= 50)
      assert.ok(
        big / Math.max(small, 5) < 10,
        `${JSON.stringify(unit)}: ${small.toFixed(1)} → ${big.toFixed(1)} ms for 4× the input`,
      );
  }
}

function expectOnly(text, id, match) {
  const found = detect(text);
  assert.deepEqual(Object.keys(found), [id], `"${text}" → ${JSON.stringify(found)}`);
  if (match !== undefined) assert.deepEqual(found[id], [match]);
}

function expectNothing(text) {
  assert.deepEqual(detect(text), {}, `"${text}" should not match`);
}

// Random-looking fakes (not real keys): real keys are random, and repetitive or
// documentation keys are now ignored as placeholders.
const FAKE = {
  aws: "AKIA4HPQ7XZ2R6TWLJ3N",
  github: "ghp_" + "7Rk2QwZ9LmX4vB8nT1cY6pJ3sH5dF0gA2eUi",
  anthropic: "sk-ant-api03-Zq8Lm2Xv9Rt4Kp7Wn1Bc6Hy3Jd5Gf0Qs",
  openai: "sk-proj-Hk3Pq9Zr7Tm2Xw5Lv8Nb1Cy4Jg6Df0Sa",
};

test("credentials", () => {
  expectOnly(`key ${FAKE.aws} here`, "aws_access_key");
  expectOnly(FAKE.github, "github_token");
  expectOnly(FAKE.anthropic, "anthropic_key");
  expectOnly(FAKE.openai, "openai_key");
  expectOnly("sk-" + "T3BlbkFJ9xQ2mZ7Lr4Wv8Kp1Nc6Hy5Gd0Bs3", "openai_key"); // legacy format
  expectOnly("-----BEGIN RSA PRIVATE KEY-----", "private_key");
  // A Google key may end in a dash (the 10,000-message oracle run, 2026-09-30)
  expectOnly("maps key AIzaHvneKu6rq2gXKZtw-eOhOYwuVw6AAiq_ps- is failing", "google_api_key");
});

test("fewer false alarms: placeholders and non-random look-alikes", () => {
  // Well-known documentation/example keys and obvious placeholders
  expectNothing("AKIAIOSFODNN7EXAMPLE");
  expectNothing("AKIAABCDEFGHIJKLMNOP");
  expectNothing("AKIAXXXXXXXXXXXXXXXX");
  expectNothing("ghp_" + "a".repeat(36));
  expectNothing("sk-ant-api03-" + "x".repeat(30));
  expectNothing("sk-proj-" + "y".repeat(30));
  expectNothing("OPENAI_API_KEY=sk-your-api-key-here-1234567890");
  // Words that happen to start with sk- aren't keys
  expectNothing("I use sk-learn-is-a-great-library-for-ml every day");
  expectNothing("branch sk-My-Project-2024-Final-Draft-v2");
});

test("a house number that looks like a year (the 10,000-message oracle run)", () => {
  expectOnly(
    "Ship it to 2068 Oak Street, Albany, NY 12250 by Friday.",
    "street_address",
    "2068 Oak Street, Albany, NY 12250",
  );
  expectOnly("I live at 1999 Elm Street", "street_address", "1999 Elm Street");
});

test("phone numbers with misspelled digit words (the 10,000-message oracle run)", () => {
  expectOnly("my number is nien three seven, fiv fiv sicks, zeero one four seven", "phone_number");
  expectOnly("call nine three seven five five five zro one eigt seven", "phone_number");
  // Sound-alikes still need real digits on both sides, so an ordinary sentence stays quiet
  expectNothing("I won too many times to count, for real");
});

test("credit cards (Luhn)", () => {
  expectOnly("4111 1111 1111 1111", "credit_card");
  expectNothing("4111 1111 1111 1112");
  // Amex: its first 10 digits look like a phone number; report the card only.
  expectOnly("Card 3782 822463 10005", "credit_card");
  // Book numbers (ISBN-13, the 978/979 prefix no card network uses) pass Luhn about one time in ten: the 10,000-
  // message oracle run found 47 (2026-09-30). A 13-digit Visa still counts.
  expectNothing("The ISBN is 978-1-299-78053-2; is that the second edition?");
  expectNothing("isbn 9780353109620");
  expectOnly("card 4222222222222", "credit_card");
});

test("credit cards spelled out in words (not mistaken for a crypto seed phrase)", () => {
  expectOnly(
    "my card is four five three nine one four eight eight zero three four three six four six seven",
    "credit_card",
  );
  expectOnly("card: four one one one, one one one one, one one one one, one one one one", "credit_card");
  expectOnly(
    "la tarjeta es cuatro cinco tres nueve, uno cuatro ocho ocho, cero tres cuatro tres, seis cuatro seis siete",
    "credit_card",
  );
  expectNothing("four one one one, one one one one, one one one one, one one one two"); // fails the checksum
  // A real seed phrase is still one
  expectOnly(
    "seed: abandon ability able about above absent absorb abstract absurd abuse access accident",
    "crypto_secret",
  );
});

test("phone numbers: digit formats", () => {
  expectOnly("(937)-555-5636", "phone_number", "(937)-555-5636");
  expectOnly("937-555-5636", "phone_number", "937-555-5636");
  expectOnly("call 555-5636 tonight", "phone_number", "555-5636");
  expectOnly("9375555636", "phone_number", "9375555636");
  expectOnly("(937) 555-5636", "phone_number", "(937) 555-5636");
  expectOnly("+1 937 555 5636", "phone_number", "+1 937 555 5636");
  expectOnly("937.555.5636", "phone_number", "937.555.5636");
  expectOnly("my number is 937 555 5636 4 kids", "phone_number", "937 555 5636");
  expectOnly("phone # 9375555636", "phone_number", "9375555636");
  expectOnly("my number is 937-555-5636x12", "phone_number", "937-555-5636");
  expectOnly("call 937-555-5636 ext. 204", "phone_number", "937-555-5636");
});

test("phone numbers: spelled out and mixed", () => {
  expectOnly("ninethreesevenfivefivefivefivesixthreesix", "phone_number");
  expectOnly("9threeseve5five5five63six", "phone_number");
  expectOnly("nine three seven five five five five six three six", "phone_number");
  expectOnly("Nine-Three-Seven 555 5636", "phone_number");
  expectOnly("call me at nine three seven, five five five, five six three six", "phone_number");
  expectOnly("it's five five five five six three six", "phone_number");
});

test("phone numbers: UK and Australian local formats", () => {
  expectOnly("my mobile is 07700 900123", "phone_number", "07700 900123");
  expectOnly("ring me on 07700900123", "phone_number", "07700900123");
  expectOnly("call 020 7946 0958", "phone_number", "020 7946 0958");
  expectOnly("my number is 0412 345 678", "phone_number", "0412 345 678");
  expectOnly("text me on 0412345678", "phone_number", "0412345678");
  const fp = (m) => globalThis.Clotr.fingerprint("s", "phone_number", m);
  assert.equal(fp("07700 900123"), fp("07700-900-123"));
  expectNothing("order 07123456789 shipped");
  expectNothing("invoice 0412345678 paid");
});

test("numbered lists: the item number isn't part of the detail", () => {
  const found = detect("1. 937-555-5636\n2. 219-09-9999\n3) 937-555-1234");
  assert.deepEqual(found.phone_number, ["937-555-5636", "937-555-1234"]);
  assert.deepEqual(found.us_ssn, ["219-09-9999"]);
});

test("structured data: JSON, YAML and XML labels", () => {
  expectOnly('{"dob":"1948-03-14"}', "date_of_birth", "1948-03-14");
  expectOnly("ssn: 219099999", "us_ssn", "219099999");
  expectOnly("<ssn>219-09-9999</ssn>", "us_ssn", "219-09-9999");
  const both = detect("<phone>937-555-5636</phone><ssn>219-09-9999</ssn>");
  assert.deepEqual([both.phone_number, both.us_ssn], [["937-555-5636"], ["219-09-9999"]]);
  expectNothing("order_id: 219099999");
  assert.deepEqual(detect('{"card_number": "4111 1111 1111 1111", "cvv": "123"}').password, ["123"]);
  assert.deepEqual(detect("phone,ssn\n9375555636,219099999\n9375551234,078051120").us_ssn, ["219099999", "078051120"]);
  expectNothing("id,count\n219099999,5");
});

test("phone numbers: things that are not phones", () => {
  expectNothing("123-45-678"); // too short
  expectNothing("2026-09-23");
  expectNothing("$4,250,000 raised");
  expectNothing("1, 2, 3, go");
  expectNothing("09/23/2026");
  expectNothing("1234567");
  expectNothing("someone phoned at noon");
  expectNothing("one two three four five six seven");
  expectNothing("I have 2 cats and 3 dogs");
  expectOnly("server 192.168.100.200", "internal_ip"); // an internal IP, not a phone number
  expectNothing("timestamp 1727000000");
  expectNothing("$1,250,000");
  expectNothing("sixty seven people from Ohio");
  expectNothing("version 10.100.200.300");
  // Order, ticket and meeting numbers are labelled as what they are
  expectNothing("Order #445-2231987 from Amazon arrived damaged");
  expectNothing("The meeting ID is 845 2931 7710 on Zoom");
  expectNothing("ticket 555-1234 was closed, invoice no. 937-555-0199 paid");
  expectOnly("order 445-2231987 arrived, call me at 937-555-0147", "phone_number", "937-555-0147");
  expectNothing("El ID de la reunión de Zoom es 845 2931 7710");
  // An ID in a log isn't a phone, even when it reads like "00 49 …" (the 10,000-message oracle run, 2026-09-30)
  expectNothing("The log says 2026-05-11T14:11:59Z request id 004940008510.");
  expectNothing("transaction ID: 004582298378 failed");
  expectOnly("request id 004940008510, call me at 937-555-0147", "phone_number", "937-555-0147");
  expectOnly("about the order, call me at 937-555-0147", "phone_number", "937-555-0147");
  expectOnly("sobre el pedido, llámame al 612 345 678", "phone_number", "612 345 678");
});

test("SSNs, including spelled out", () => {
  expectOnly("123-45-6789", "us_ssn", "123-45-6789");
  expectOnly("123 45 6789", "us_ssn", "123 45 6789");
  expectOnly("one two three four five six seven eight nine", "us_ssn");
  expectOnly("my social is onetwothree45sixseven89", "us_ssn");
  expectNothing("123456789");
  expectNothing("000-12-3456");
  // In a list after another number
  assert.deepEqual(detect("my phone 937-555-5636, 219-09-9999 is my social").us_ssn, ["219-09-9999"]);
  assert.deepEqual(detect("ids: 5636; 219-09-9999").us_ssn, ["219-09-9999"]);
  const both = detect("nine three seven five five five five six three six, two one nine oh nine nine nine nine nine");
  assert.ok(both.phone_number?.length === 1 && both.us_ssn?.length === 1, JSON.stringify(both));
  expectOnly("call me at nine three seven, five five five, five six three six", "phone_number"); // commas inside one phone
  // "dash" said as a word
  expectOnly("social security two one nine dash oh nine dash nine nine nine nine", "us_ssn");
  expectOnly("call nine three seven dash five five five dash one two three four", "phone_number");
});

test("emails, including spelled out", () => {
  expectOnly("jane.doe@example.com", "email", "jane.doe@example.com");
  expectOnly("my email is bob at gmail dot com", "email", "bob at gmail dot com");
  expectOnly("john dot smith at yahoo dot com", "email", "john dot smith at yahoo dot com");
  expectOnly("bob(at)example(dot)org", "email", "bob(at)example(dot)org");
  expectOnly("bob [at] example [dot] com", "email", "bob [at] example [dot] com");
  expectOnly("bob @ gmail . com", "email", "bob @ gmail . com");
  expectNothing("I work at google dot com");
  // URL-encoded in a pasted link
  assert.deepEqual(detect("https://example.com/signup?email=ann%40gmail.com&ref=x").email, ["ann%40gmail.com"]);
  // ...and it matches the plain address in the vault (same normalized form and fingerprint)
  assert.equal(
    globalThis.Clotr.normalize("email", "ann%40gmail.com"),
    globalThis.Clotr.normalize("email", "ann@gmail.com"),
  );
  assert.equal(
    globalThis.Clotr.fingerprint("s", "email", "ann%40gmail.com"),
    globalThis.Clotr.fingerprint("s", "email", "ann@gmail.com"),
  );
  assert.equal(
    globalThis.Clotr.fingerprint("s", "email", "Ann%40Gmail.com"),
    globalThis.Clotr.fingerprint("s", "email", "ann@gmail.com"),
  );
  // The whole address, so nothing is left behind when it is hidden
  expectOnly("contact: jane(dot)doe(at)gmail(dot)com", "email", "jane(dot)doe(at)gmail(dot)com");
  expectOnly("mi correo es juan arroba gmail punto com", "email", "juan arroba gmail punto com");
  expectOnly(
    "mi correo es juan punto perez arroba hotmail punto es",
    "email",
    "juan punto perez arroba hotmail punto es",
  );
  assert.equal(
    globalThis.Clotr.fingerprint("s", "email", "juan arroba gmail punto com"),
    globalThis.Clotr.fingerprint("s", "email", "juan@gmail.com"),
  );
  // A well-known provider without ".com", after an email word
  expectOnly("my email is janedoe at yahoo", "email", "janedoe at yahoo");
  expectOnly("email me at jane.doe at gmail", "email", "jane.doe at gmail");
  expectNothing("I work at yahoo and she is at gmail");
  // Common misspellings of the big providers, spelled out
  expectOnly("email me at bob at gmial dot com", "email", "bob at gmial dot com");
  expectOnly("my email is jane dot doe at gamil dot com", "email");
  expectOnly("write to grandpa at hotmial dot com", "email", "grandpa at hotmial dot com");
  expectOnly("its sue at yaho dot com", "email", "sue at yaho dot com");
  const efp = (m) => globalThis.Clotr.fingerprint("s", "email", m);
  assert.equal(efp("janedoe at yahoo"), efp("janedoe@yahoo.com"));
  assert.equal(efp("bob at gmial dot com"), efp("bob@gmail.com")); // a misspelled provider is still yours
  assert.equal(efp("sue at hotmial dot com"), efp("sue@hotmail.com"));
  expectNothing("look at this, meet at noon");
});

test("responses: nothing blocks by default, user overrides win", () => {
  const { responseFor, defaultResponse, PATTERNS } = globalThis.Clotr;
  for (const p of PATTERNS) assert.equal(defaultResponse(p.id), "warn", p.id);
  assert.equal(responseFor("aws_access_key", { aws_access_key: "block" }), "block");
  assert.equal(responseFor("email", { email: "off" }), "log"); // no silent Off (D21): old "off" reads as Log only
  assert.equal(responseFor("email", { email: "bogus" }), "warn");
  assert.equal(responseFor("aws_access_key", undefined), "warn");
});

test("sha256 matches node's crypto", () => {
  const { createHash } = require("node:crypto");
  for (const s of ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(64), "x".repeat(1000), "héllo ☎ 937"]) {
    assert.equal(
      globalThis.Clotr.sha256(s),
      createHash("sha256").update(s).digest("hex"),
      JSON.stringify(s).slice(0, 20),
    );
  }
});

test("fingerprints: same value however it's written", () => {
  const fp = (id, m) => globalThis.Clotr.fingerprint("salt", id, m);
  const phone = fp("phone_number", "937-555-5636");
  for (const m of [
    "(937) 555-5636",
    "937.555.5636",
    "+1 937 555 5636",
    "nine three seven five five five five six three six",
    "9threeseve5five5five63six",
  ]) {
    assert.equal(fp("phone_number", m), phone, m);
  }
  assert.notEqual(fp("phone_number", "937-555-5637"), phone);
  const email = fp("email", "bob@gmail.com");
  for (const m of ["Bob@Gmail.com", "bob at gmail dot com", "bob(at)gmail(dot)com", "bob [at] gmail [dot] com"]) {
    assert.equal(fp("email", m), email, m);
  }
  assert.notEqual(fp("email", "rob@gmail.com"), email);
  assert.notEqual(globalThis.Clotr.fingerprint("other-salt", "email", "bob@gmail.com"), email);
});

test("passphrases: a few plain words that end the sentence", () => {
  expectOnly("password = correct horse battery staple", "password", "correct horse battery staple");
  expectOnly("the wifi password is purple monkey dishwasher.", "password", "purple monkey dishwasher");
  expectOnly("mi contraseña es gato azul pizza fría", "password", "gato azul pizza fría");
  expectNothing("my password is the same as before");
  expectNothing("my password is changed every month");
  expectNothing("my password is too long and hard to remember");
  expectNothing("the password was reset yesterday morning");
  expectNothing("your password is required for login");
  expectNothing("my password is strong enough now");
  expectNothing("the password is safe and secure");
});

test("card security codes, remote-access codes and memorable words", () => {
  expectOnly("my card expires 12/27 and the CVV is 123", "password", "123");
  expectOnly("cvv 482", "password", "482");
  expectOnly("the security code on the back is 4821", "password", "4821");
  expectOnly("the AnyDesk code is 123 456 789", "password", "123 456 789");
  expectOnly("the tech support guy asked for my remote access code 889 221 334", "password", "889 221 334");
  expectOnly("my online banking memorable word is sunflower", "password", "sunflower");
  expectNothing("where is the CVV on a card?");
  expectNothing("my wallet address is 0x742d35Cc6634C0532925a3b844Bc454e4438f44e");
  expectNothing("my bank card ends in 1234");
});

test("Spanish: card, door and remote-access codes, and a password without 'es'", () => {
  expectOnly("el CVV es 123", "password", "123");
  expectOnly("el código de seguridad de la tarjeta es 482", "password", "482");
  expectOnly("el código de AnyDesk es 123 456 789", "password", "123 456 789");
  expectOnly("el código del portal es 4821", "password", "4821");
  expectOnly("mi usuario es jperez y la contraseña Luna2020", "password", "Luna2020");
  expectNothing("¿dónde está el CVV de la tarjeta?");
  expectNothing("el código postal es 28013 y el código de área es 91");
});

test("two-factor backup codes and recovery keys", () => {
  expectOnly(
    "my google backup codes are 1234 5678, 2345 6789, 3456 7890",
    "password",
    "1234 5678, 2345 6789, 3456 7890",
  );
  expectOnly("2FA recovery codes: 8f3k-2m9x, 7h2p-4q8w", "password", "8f3k-2m9x, 7h2p-4q8w");
  expectOnly("my bitlocker recovery key is 123456-234567-345678-456789-567890-678901-789012-890123", "password");
  expectOnly(
    "microsoft account recovery code AB12C-D34EF-5GH6I-J78KL-MN9OP",
    "password",
    "AB12C-D34EF-5GH6I-J78KL-MN9OP",
  );
  expectNothing("what are backup codes and where do I keep them?");
  expectNothing("my recovery key is lost, how do I get a new one?");
  expectOnly("mis códigos de respaldo son 1234 5678, 2345 6789", "password", "1234 5678, 2345 6789");
  expectOnly("el código de recuperación es AB12C-D34EF-5GH6I", "password", "AB12C-D34EF-5GH6I");
  expectOnly("el pin de la tarjeta 4821", "password", "4821");
  expectNothing("¿qué son los códigos de respaldo?");
});

test("session cookies in pasted headers", () => {
  expectOnly(
    "Cookie: sessionid=8f2k3m9x7q1w5e4r6t8y0u2i4o6p8a1s; theme=dark",
    "password",
    "8f2k3m9x7q1w5e4r6t8y0u2i4o6p8a1s",
  );
  expectOnly(
    "Set-Cookie: SID=FgT7s9kX2mQ4vL8pR1nZ6wB3yH5jD0cA; Path=/; HttpOnly",
    "password",
    "FgT7s9kX2mQ4vL8pR1nZ6wB3yH5jD0cA",
  );
  expectOnly("curl -b connect.sid=s%3AkJ8h2Lq9mX4vT7rP1wZ6nB3yF5dG0cS https://app.example.com", "password");
  expectOnly("aws_secret_access_key = Zq8Lm2Xv9Rt4Kp7Wn1Bc" + "6Hy3Jd5Gf0QsAb12Cd34", "password");
  expectNothing("the session cookie was invalid after logout; Cookie: theme=dark; lang=en");
});

test("logins, home codes and passwords told in passing", () => {
  expectOnly("my bank login is jdoe99 and the password Summer2024", "password", "Summer2024");
  const pair = detect("here's my login: jdoe@gmail.com / Fluffy!23");
  assert.deepEqual(pair.password, ["Fluffy!23"], JSON.stringify(pair));
  assert.deepEqual(detect("login jdoe@gmail.com pw Fluffy!23").password, ["Fluffy!23"]);
  expectOnly("the gate code is 1234", "password", "1234");
  expectOnly("my alarm code is 4821", "password", "4821");
  expectOnly("the garage code is 5580#", "password", "5580#");
  expectOnly("my ATM pin 4821", "password", "4821");
  expectOnly("the passcode to my phone is 482913", "password", "482913");
  expectOnly("the safe combination is 12-34-56", "password", "12-34-56");
  expectOnly("my password is my dog's name Rex2019", "password", "Rex2019");
  // Everyday codes and password talk stay quiet
  expectNothing("my zip code is 45402 and the area code is 937");
  expectNothing("I got error code 1234 and status code 404");
  expectNothing("the password reset link expired");
  expectNothing("my password is not working since 2019");
  expectNothing("enter the code 1234 from the example");
  expectNothing("the combination 1-2-3 is easiest to remember");
  // Code that handles passwords, and API routes named login
  expectNothing("password = request.form['password']");
  expectNothing("login: POST /api/v1/login / returns 200");
  expectNothing("const pw = req.body.password; password = getpass()");
});

test("passwords and secrets written with context words", () => {
  expectOnly("password: hunter2", "password", "hunter2");
  expectOnly("DB_PASSWORD=S3cr3t!pass", "password", "S3cr3t!pass");
  expectOnly('config: { "token": "a8f3Kd92LmQ" }', "password", "a8f3Kd92LmQ");
  expectOnly("my PIN: 4821", "password", "4821");
  expectOnly("my password is Fluffy123", "password", "Fluffy123");
  expectOnly("my wifi password is sunflower", "password", "sunflower");
  expectOnly("Grandma, the password is 'bluebird'.", "password", "bluebird");
  // Not secrets: no value, placeholders, templates, ordinary words
  expectNothing("the password is required");
  expectNothing("my password is incorrect, how do I reset it?");
  expectNothing("reset your password: click the link");
  expectNothing("password: ********");
  expectNothing("password=<your password>");
  expectNothing("token: ${API_TOKEN}");
  expectNothing("api_key=your-api-key");
  expectNothing("pin: this message to the top");
  // A key after a label is reported as the key, not twice
  expectOnly("OPENAI_API_KEY=sk-proj-Hk3Pq9Zr7Tm2Xw5Lv8Nb1Cy4Jg6Df0Sa", "openai_key");
});

test("street addresses, however they're written", () => {
  expectOnly(
    "I live at 123 Main St, Springfield, IL 62704 now",
    "street_address",
    "123 Main St, Springfield, IL 62704",
  );
  expectOnly("ship to 4500 N. Oak Ridge Road Apt 4B please", "street_address", "4500 N. Oak Ridge Road Apt 4B");
  expectOnly("send it to 12 Baker Street", "street_address", "12 Baker Street");
  expectOnly("my house is 77 west 5th avenue", "street_address", "77 west 5th avenue");
  expectOnly("one twenty three main street apt 4", "street_address", "one twenty three main street apt 4");
  expectOnly("mail it to P.O. Box 1234", "street_address", "P.O. Box 1234");
  expectOnly("po box 55, Dayton, OH 45402", "street_address", "po box 55, Dayton, OH 45402");
  expectOnly(
    "1600 Pennsylvania Ave NW, Washington, DC 20500",
    "street_address",
    "1600 Pennsylvania Ave NW, Washington, DC 20500",
  );
  // Not addresses
  expectNothing("I bought 2 hard drive enclosures");
  expectNothing("it's a 5 minutes drive from here");
  expectNothing("I walked down Main Street yesterday");
  expectNothing("it's a 2 way street");
  expectNothing("read chapter 12 of the book");
  expectNothing("in 2024 the road was closed");
  // A house number like a year is still an address; it's a year only after a time word (the oracle run)
  expectNothing("By 2030 Main Street will be pedestrian only");
  expectNothing("since 1998 Elm Street has flooded");
  expectNothing("take the 3 main roads north");
  expectNothing("a 5 star place to eat");
  expectNothing("she came in 2nd place");
  expectNothing("a 3 bedroom place near the lake");
});

test("Spanish: dates of birth, digits or words", () => {
  expectOnly("nací el 14 de marzo de 1962", "date_of_birth", "14 de marzo de 1962");
  expectOnly("mi fecha de nacimiento es 14/03/1962", "date_of_birth", "14/03/1962");
  expectOnly(
    "mi fecha de nacimiento es catorce de marzo de mil novecientos sesenta y dos",
    "date_of_birth",
    "catorce de marzo de mil novecientos sesenta y dos",
  );
  expectOnly("mi cumpleaños es el 3 de julio", "date_of_birth", "3 de julio");
  expectOnly("nació el primero de mayo de 1990 en Lima", "date_of_birth", "primero de mayo de 1990");
  expectNothing("la reunión es el 14 de marzo de 2026");
  expectNothing("nací en Madrid");
  expectNothing("mi cumpleaños es pronto");
});

test("dates of birth, digits or words", () => {
  expectOnly("I was born 3/14/1948 in Ohio", "date_of_birth", "3/14/1948");
  expectOnly("DOB: 03-14-1948", "date_of_birth", "03-14-1948");
  expectOnly("birthdate 1948-03-14", "date_of_birth", "1948-03-14");
  expectOnly("date of birth: March 14, 1948", "date_of_birth", "March 14, 1948");
  expectOnly("my birthday is March 14th", "date_of_birth", "March 14th");
  expectOnly(
    "I was born on the fourteenth of March nineteen forty eight",
    "date_of_birth",
    "fourteenth of March nineteen forty eight",
  );
  expectOnly("born March fourteenth, nineteen forty-eight", "date_of_birth", "March fourteenth, nineteen forty-eight");
  expectOnly("b-day: 14 Mar 1948", "date_of_birth", "14 Mar 1948");
  // Not a birth date
  expectNothing("the meeting is 3/14/2026");
  expectNothing("I was born in Ohio");
  expectNothing("my birthday is coming up soon");
  expectNothing("born 13/45/1948");
});

test("UK, Indian and Australian IDs: NHS, NI, Aadhaar, TFN, Medicare (checksum-validated)", () => {
  expectOnly("my NHS number is 943 476 5919", "medical_record", "943 476 5919");
  expectOnly("my national insurance number is AB 12 34 56 C", "national_id");
  expectOnly("my aadhaar is 2345 6789 0124", "national_id", "2345 6789 0124");
  expectOnly("my australian TFN is 123 456 782", "national_id", "123 456 782");
  expectOnly("my tax file number is 123 456 782", "national_id", "123 456 782");
  expectOnly("my medicare card number is 2123 45670 1", "medicare_id", "2123 45670 1");
  expectNothing("my aadhaar is 2345 6789 0123"); // wrong check digit
  expectNothing("the NHS number has 10 digits");
});

test("US tax and immigration numbers, VA file and Medicaid IDs", () => {
  expectOnly("my ITIN is 912-70-1234", "national_id", "912-70-1234");
  expectOnly("our EIN is 12-3456789", "national_id", "12-3456789");
  expectOnly("my tax id is 12-3456789", "national_id", "12-3456789");
  expectOnly("my A-number is A123456789", "national_id", "A123456789");
  expectOnly("my green card number is SRC1234567890", "national_id", "SRC1234567890");
  expectOnly("my VA file number is 12345678", "national_id", "12345678");
  expectOnly("my medicaid id is 12345678A", "insurance_id", "12345678A");
  expectNothing("an EIN has 9 digits and an ITIN starts with 9");
  expectNothing("order 912-40-1234 shipped"); // not an ITIN range
});

test("bank, Medicare, license, passport and insurance numbers", () => {
  expectOnly("my account number is 123456789012", "bank_account", "123456789012");
  expectOnly("routing: 021000021", "bank_account", "021000021");
  expectOnly("checking acct # 4400-1234-5678", "bank_account", "4400-1234-5678");
  expectOnly(
    "acct no. one two three four five six seven eight",
    "bank_account",
    "one two three four five six seven eight",
  );
  expectOnly("Medicare number 1EG4-TE5-MK73", "medicare_id", "1EG4-TE5-MK73");
  expectOnly("card says 1EG4TE5MK73", "medicare_id", "1EG4TE5MK73");
  expectOnly("driver's license: D1234567", "drivers_license", "D1234567");
  expectOnly("DL# S12345678", "drivers_license", "S12345678");
  expectOnly("passport number 912345678", "passport", "912345678");
  expectOnly("passport no. X12345678", "passport", "X12345678");
  expectOnly("insurance member ID: XYZ123456789", "insurance_id", "XYZ123456789");
  // Not these
  expectNothing("routing number 123456789"); // fails the ABA checksum
  expectNothing("I have 2 accounts at the bank");
  expectNothing("my account is locked, account settings won't open");
  expectNothing("check your passport is valid for 6 months");
  expectNothing("the license is MIT");
  expectNothing("member id is required");
});

test("spoken numbers with hundred and thousand", () => {
  expectOnly("call me at nine three seven, five hundred fifty five, twelve thirty four", "phone_number");
  expectOnly("my cell is nine three seven five hundred and five one two three four", "phone_number");
  expectOnly("phone: nine three seven, eight hundred, fifty six thirty six", "phone_number");
  expectOnly("SSN one two three, forty five, six thousand seven hundred eighty nine", "us_ssn");
  const fp = (m) => globalThis.Clotr.fingerprint("s", "phone_number", m);
  assert.equal(fp("nine three seven, five hundred fifty five, twelve thirty four"), fp("937-555-1234"));
  // "double five" = 55, "triple seven" = 777, as numbers are often read out
  expectOnly("ring me on nine three seven, double five five, one two three four", "phone_number");
  expectOnly("my number is 937 triple 5 double 1 two three", "phone_number");
  assert.equal(fp("nine three seven, double five five, one two three four"), fp("937-555-1234"));
  expectNothing("I got a double espresso and a triple shot at five");
  // Amounts and years stay quiet
  expectNothing("it cost five hundred dollars and took two thousand hours");
  expectNothing("a hundred people came, maybe a thousand");
  expectNothing("in nineteen hundred and five the town had six hundred homes");
});

test("more disguises: teens/tens, letters for digits, sound-alike words", () => {
  expectOnly("call nine three seven, five fifty five, fifty six thirty six", "phone_number");
  expectOnly("my number is nine three seven five five five fifty six thirty six", "phone_number");
  expectOnly("937-555-O636", "phone_number", "937-555-O636");
  expectOnly("93755556l6", "phone_number", "93755556l6");
  expectOnly("nine three seven five five five won two three four", "phone_number"); // sound-alikes only count between digits
  expectOnly("social one two three, forty five, sixty seven eighty nine", "us_ssn");
  // Same number however it's disguised → same fingerprint (It's me, repeats)
  const fp = (m) => globalThis.Clotr.fingerprint("s", "phone_number", m);
  assert.equal(fp("nine three seven, five fifty five, fifty six thirty six"), fp("937-555-5636"));
  assert.equal(fp("937-555-O636"), fp("937-555-0636"));
  // Everyday words stay words
  expectNothing("I want to go for a walk at 5 to 6");
  expectNothing("we won 2 to 1 and ate for free");
  expectNothing("Ohio has 88 counties and hello world");
  expectNothing("sixty seven people from Ohio");
  expectNothing("twenty twenty four was a good year");
});

test("international phone numbers (+, plus, 00)", () => {
  expectOnly("London office: +44 20 7946 0958", "phone_number", "+44 20 7946 0958");
  expectOnly("call +91 98765 43210 anytime", "phone_number", "+91 98765 43210");
  expectOnly("0044 20 7946 0958", "phone_number", "0044 20 7946 0958");
  expectOnly("+33 1 23 45 67 89", "phone_number", "+33 1 23 45 67 89");
  expectOnly("+44 (0)20 7946 0958", "phone_number", "+44 (0)20 7946 0958");
  expectOnly("plus four four two zero seven nine four six zero nine five eight", "phone_number");
  expectOnly("+1 937 555 5636", "phone_number", "+1 937 555 5636");
  const fp = (m) => globalThis.Clotr.fingerprint("s", "phone_number", m);
  assert.equal(fp("0044 20 7946 0958"), fp("+44 20 7946 0958"));
  assert.equal(fp("+44 (0)20 7946 0958"), fp("+44 20 7946 0958"));
  expectNothing("the score went from +3 to +7");
  expectNothing("that's 2 plus 3 plus 15");
  expectNothing("code 00100 is fine");
});

test("vault names match with or without accents; entries saved before still match", () => {
  const C = globalThis.Clotr;
  const salt = "s4lt";
  C.setVault({
    salt,
    entries: [
      { kind: "word", type: "my_name", fp: C.fingerprint(salt, "watch_list", "José García"), words: 2 },
      // An entry saved by an older version: its fingerprint kept the accents.
      { kind: "word", type: "family_name", fp: C.fingerprint(salt, "watch_list_accented", "Íñigo"), words: 1 },
    ],
  });
  try {
    expectOnly("soy Jose Garcia", "my_name", "Jose Garcia");
    expectOnly("soy josé garcía", "my_name", "josé garcía");
    expectOnly("mi hijo Íñigo tiene fiebre", "family_name", "Íñigo");
    assert.equal(C.fingerprint(salt, "watch_list", "José"), C.fingerprint(salt, "watch_list", "jose"));
    assert.equal(C.fingerprint(salt, "my_name", "José García"), C.fingerprint(salt, "my_name", "jose  garcia")); // history and reply check
  } finally {
    C.setVault(null);
  }
});

test("vault: your words by category (fingerprinted) and ID formats", () => {
  const C = globalThis.Clotr;
  const salt = "s4lt";
  const word = (type, w) => ({
    kind: "word",
    type,
    fp: C.fingerprint(salt, "watch_list", w),
    words: w.split(" ").length,
  });
  C.setVault({
    salt,
    entries: [
      word("watch_list", "Project Falcon"),
      word("watch_list", "Acme"),
      word("my_name", "Jane Q Doe"),
      word("family_name", "Emma"),
      word("employer", "Initech"),
      { kind: "shape", type: "watch_list", shape: "EMP-#####" },
      { kind: "shape", type: "my_id", shape: "@@-####" },
      { kind: "value", type: "phone_number", fp: "ffffffffffffffff", mode: "protect" }, // values: handled by content.js
    ],
  });
  expectOnly("status of project   FALCON please", "watch_list", "project   FALCON");
  expectOnly("the Acme renewal", "watch_list", "Acme");
  expectOnly("ticket for EMP-12345 today", "watch_list", "EMP-12345");
  expectOnly("ref AB-1234 ok", "my_id", "AB-1234");
  expectOnly("hi, I'm jane q doe", "my_name", "jane q doe");
  expectOnly("Emma has a fever", "family_name", "Emma");
  expectOnly("it's Emma's birthday", "family_name", "Emma"); // possessive: just the name
  expectOnly("Emma’s school", "family_name", "Emma");
  expectOnly("I work at Initech.", "employer", "Initech");
  expectNothing("the falcon flew over the project");
  expectNothing("EMP-1234 has four digits");
  expectNothing("acmes are not acme-like"); // whole words only
  C.setVault(null);
  expectNothing("status of project falcon");
});

test("addresses normalize: St = Street, words = digits, case and punctuation ignored", () => {
  const fp = (m) => globalThis.Clotr.fingerprint("s", "street_address", m);
  const want = fp("123 Oak Street");
  for (const m of [
    "123 oak st.",
    "123 Oak St, Springfield, IL 62704",
    "one twenty three Oak Street Apt 4",
    "123 OAK STREET",
  ]) {
    assert.equal(fp(m), want, m);
  }
  assert.equal(fp("77 W. 5th Ave"), fp("77 west 5th avenue"));
  assert.notEqual(fp("125 Oak Street"), want);
  assert.notEqual(fp("123 Oak Road"), want);
  assert.equal(fp("P.O. Box 55"), fp("po box 55, Dayton, OH 45402"));
});

test("connection strings, JWTs, .env files, internal IPs and hosts", () => {
  expectOnly(
    "DATABASE_URL is postgres://admin:S3cr3tPw@db.prod.internal:5432/app",
    "connection_string",
    "postgres://admin:S3cr3tPw@db.prod.internal:5432/app",
  );
  expectOnly("mongodb+srv://app:hunter2x@cluster0.ab1cd.mongodb.net/test", "connection_string");
  expectNothing("format: postgres://user:password@localhost/db");
  const jwt =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI0MjQyIiwibmFtZSI6IkphbmUifQ.Xk3v9Qm2Lr7Tz5Wn8Bc1Hy4Jg6Df0SaPq";
  expectOnly(`token ${jwt}`, "jwt", jwt);
  const env = "DB_HOST=localhost\nDB_PASSWORD=Pr0dPassw0rd!\nSTRIPE_WEBHOOK_SECRET_KEY=whsec_9f8e7d6c5b4a\nPORT=3000";
  assert.deepEqual(detect(env), { password: ["Pr0dPassw0rd!", "whsec_9f8e7d6c5b4a"] });
  expectOnly("the server is 10.0.4.21 now", "internal_ip", "10.0.4.21");
  expectOnly("router at 192.168.1.1", "internal_ip", "192.168.1.1");
  expectOnly("docker gave it 172.20.0.5", "internal_ip", "172.20.0.5");
  expectNothing("public DNS 8.8.8.8 and 172.32.0.1");
  expectNothing("version 10.2.3 and build 10.0.19041.1");
  expectOnly("ssh into build-01.corp tonight", "internal_host", "build-01.corp");
  expectOnly("print to printer.local", "internal_host", "printer.local");
  expectOnly("call api.internal/v1", "internal_host", "api.internal");
  expectNothing("the local news and internal memo");
});

// M3 performance: detection runs on every pause in typing and again on Enter, so it
// must stay fast on long drafts and big pastes. Budgets are generous (slow CI machines);
// the bug they guard against took 850 ms for 20k characters and 4 s for 40k.
test("detection stays fast on long drafts and big pastes (no quadratic patterns)", () => {
  const prose = "I was thinking about the project plan for next week and how to structure the meeting. ";
  const inputs = {
    "long prose": prose.repeat(2300),
    "spelled-out numbers": "one two three four five six seven eight nine ten ".repeat(800),
    "number words and streets": "twenty one forty two main street and ninety nine ".repeat(800),
    "csv paste": Array.from({ length: 2000 }, (_, i) => `Person ${i},p${i}@example.com,937-555-${1000 + i}`).join("\n"),
    digits: "1234567890 ".repeat(4000),
  };
  for (const [name, text] of Object.entries(inputs)) {
    // Best of 3, like the other speed checks: one garbage-collection pause on a busy CI runner isn't
    // the detector being slow (a run took 422 ms there that takes 80 ms locally, 2026-09-26).
    let ms = Infinity;
    for (let r = 0; r < 3; r++) {
      const t0 = performance.now();
      globalThis.Clotr.detect(text);
      ms = Math.min(ms, performance.now() - t0);
    }
    assert.ok(ms < 400, `${name} (${text.length} chars) took ${ms.toFixed(0)} ms`);
  }
});

test("a paste with thousands of different details scans in linear time (overlap check isn't pairwise)", () => {
  const csv = (n) =>
    Array.from(
      { length: n },
      (_, i) => `Person ${i},p${i}@example.com,937-555-${String(1000 + (i % 9000)).padStart(4, "0")}`,
    ).join("\n");
  const best = (t) => {
    let ms = Infinity;
    for (let r = 0; r < 3; r++) {
      const s = performance.now();
      globalThis.Clotr.detect(t);
      ms = Math.min(ms, performance.now() - s);
    }
    return ms;
  };
  const small = best(csv(1000)),
    big = best(csv(8000));
  // 8× the lines: about 7× the time locally. The pairwise overlap check took 18× (40 → 723 ms, 2026-09-26);
  // 12× leaves room for busy CI runners (a 4× step measured 6.8× there once).
  assert.ok(big / small < 12, `1,000 → 8,000 lines: ${small.toFixed(0)} → ${big.toFixed(0)} ms`);
});

test("home coordinates are an address; other places are not", () => {
  expectOnly("my home is at 40.712776, -74.005974", "street_address", "40.712776, -74.005974");
  expectOnly("my house GPS: 51.5007° N, 0.1246° W", "street_address", "51.5007° N, 0.1246° W");
  expectOnly("mi casa está en 40.4168, -3.7038", "street_address", "40.4168, -3.7038");
  expectNothing("what restaurants are near 40.7128,-74.0060?");
  expectNothing("The Eiffel Tower is at 48.8584, 2.2945");
  expectNothing("my home is about 40.7 miles from work");
});

// A message with many details, one per line, finds each of them: a pattern must never run on from one
// line into the next and hide what's written there (an address after a ZIP code did, 0.9.77).
test("many details on separate lines are each found", () => {
  const LINES = [
    "call me at 937-555-5636",
    "my number is nine three seven five five five five six three six",
    "ring me on 07700 900123",
    "+44 20 7946 0958",
    "my social is 219-09-9999",
    "social security two one nine dash oh nine dash nine nine nine nine",
    "jane.doe@example.com",
    "my email is bob at gmail dot com",
    "email me at bob at gmial dot com",
    "I live at 123 Main St, Springfield, IL 62704",
    "one twenty three main street apt 4",
    "vivo en Calle Mayor 5, Madrid",
    "my home is at 40.712776, -74.005974",
    "I was born on 3/14/1948",
    "nací el 14 de marzo de 1962",
    "4111 1111 1111 1111",
    "my card is four five three nine one four eight eight zero three four three six four six seven",
    "account number is 123456789012",
    "routing: 021000021",
    "IBAN DE89 3704 0044 0532 0130 00",
    "mi DNI es 12345678Z",
    "CURP: GODE561231HDFRRN00",
    "my ITIN is 912-70-1234",
    "my NHS number is 943 476 5919",
    "my aadhaar is 2345 6789 0124",
    "my medicare number is 1EG4-TE5-MK73",
    "my password is Fluffy123",
    "the gate code is 1234",
    "the CVV is 123",
    "the AnyDesk code is 123 456 789",
    "my mother's maiden name is Smith",
    "my google backup codes are 1234 5678, 2345 6789",
    "Cookie: sessionid=8f2k3m9x7q1w5e4r6t8y0u2i4o6p8a1s; theme=dark",
    "password = correct horse battery staple",
    "key AKIA4HPQ7XZ2R6TWLJ3N here",
    "ghp_" + "7Rk2QwZ9LmX4vB8nT1cY6pJ3sH5dF0gA2eUi",
    "postgres://admin:S3cr3tPw@db.prod.internal:5432/app",
    "the server is 10.0.4.21 now",
    // Spanish
    "mi móvil es 612 345 678",
    "llámame al seis cero cero, doce, treinta y cuatro, cincuenta y seis",
    "el pin de la tarjeta 4821",
    "NSS: 281234567840",
    "RFC: PEPJ800101AB3",
    "vivo en calle mayor 5, madrid",
    "el código de AnyDesk es 123 456 789",
    "mi correo es juan arroba gmail punto com",
    "nací el 14 de marzo de 1962",
    "la contraseña es gato azul pizza fría.",
    "mis códigos de respaldo son 1234 5678, 2345 6789",
    "el CVV es 123",
    "mi casa está en 40.4168, -3.7038",
  ];
  const each = LINES.map((line) => detect(line));
  const missing = [];
  for (const order of ["forward", "reversed"]) {
    // what comes before a line matters too
    const all = detect((order === "forward" ? LINES : [...LINES].reverse()).join("\n"));
    each.forEach((found, i) => {
      for (const [id, matches] of Object.entries(found)) {
        for (const m of matches)
          if (
            !Object.values(all)
              .flat()
              .some((x) => x.includes(m))
          )
            missing.push(`${order}: ${LINES[i]} → ${id}: ${m}`);
      }
    });
  }
  assert.deepEqual(missing, []);
});

// Hide it must leave nothing of the detail behind: a match that covers only part of it ("doe(at)gmail(dot)com"
// without "jane(dot)", 0.9.82) still shows who it is. Each line below is one detail plus ordinary words.
test("Hide it leaves no part of a detail behind", () => {
  const { detect: find, redact } = globalThis.Clotr;
  const WORD =
    "(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|cero|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve)";
  const LEFT = new RegExp(
    String.raw`\d{3}|\b${WORD}\b(?:[\s,-]+\b${WORD}\b){2}|@|\(at\)|\b(?:dot|arroba|punto)\b`,
    "i",
  );
  const DETAILS = [
    "call me at nine three seven, five five five, five six three six please",
    "my social is two one nine dash oh nine dash nine nine nine nine",
    "contact: jane(dot)doe(at)gmail(dot)com thanks",
    "mi correo es juan punto perez arroba hotmail punto es gracias",
    "email me at bob at gmial dot com",
    "write to jane dot doe at gmail dot com",
    "my card is four five three nine one four eight eight zero three four three six four six seven",
    "1. 937-555-5636",
    "my number is 937-555-5636x12",
    "+44 20 7946 0958 is the office",
    "ring me on 07700 900123 today",
    "my google backup codes are 1234 5678, 2345 6789",
    "my bitlocker recovery key is 123456-234567-345678-456789-567890",
    "the AnyDesk code is 123 456 789 ok",
    "mi DNI es 12345678Z",
    "my ITIN is 912-70-1234",
    "llámame al seis cero cero, doce, treinta y cuatro, cincuenta y seis",
    "my number is nine three seven five hundred fifty five, twelve thirty four",
    "phone # 9375555636",
  ];
  const left = [];
  for (const line of DETAILS) {
    const covered = redact(line, find(line));
    if (LEFT.test(covered.replace(/\[REDACTED [^\]]*\]/g, ""))) left.push(`${line} → ${covered}`);
    // …and the hidden message is quiet: the warning doesn't come back, and the labels trigger nothing.
    else if (find(covered).length) left.push(`${line} → still found in "${covered}"`);
  }
  assert.deepEqual(left, []);
});

test("spelled-out house numbers up to six words are still addresses", () => {
  // An address on the next line is found too (a match used to run on from the ZIP code above).
  assert.deepEqual(
    detect("I live at 123 Main St, Springfield, IL 62704\none twenty three main street apt 4").street_address,
    ["123 Main St, Springfield, IL 62704", "one twenty three main street apt 4"],
  );
  expectOnly("it's one two three four five six oak street", "street_address", "one two three four five six oak street");
  expectOnly("twelve thousand three hundred forty five main street", "street_address");
});

// M3 false-alarm budget: ordinary messages (tests/corpus/normal-messages.txt) may raise at
// most 1 false alarm per 50 messages. Every false alarm found there also gets its own test.
test("false-alarm budget: at most 1 per 50 normal messages", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const msgs = fs
    .readFileSync(path.join(__dirname, "corpus", "normal-messages.txt"), "utf8")
    .split(/\r?\n---\r?\n/)
    .slice(1)
    .map((s) => s.trim())
    .filter(Boolean);
  assert.ok(msgs.length >= 150, `corpus has only ${msgs.length} messages`);
  const alarms = msgs.map((m) => [m, detect(m)]).filter(([, f]) => Object.keys(f).length);
  assert.ok(
    alarms.length <= Math.floor(msgs.length / 50),
    `${alarms.length} false alarms in ${msgs.length} messages:\n` +
      alarms.map(([m, f]) => `  ${JSON.stringify(f)} ← ${m.slice(0, 80)}`).join("\n"),
  );
});

test("not phones: digits inside IDs and hashes, lists of small numbers", () => {
  expectNone("The API returned request id 7c9e6679-7425-40de-944b-e07fc1f90ae7 with a 500 error.");
  expectNone("Explain the Fibonacci sequence: 1, 1, 2, 3, 5, 8, 13, 21, 34, 55.");
  expectNone("build a1b2c3d4-9375-5501-23ef finished");
  // still phones: whole runs in any grouping, and two numbers in one list
  expectOnly("call 9 3 7 5 5 5 0 1 2 3 please", "phone_number", "9 3 7 5 5 5 0 1 2 3");
  assert.deepEqual(detect("reach us at 937-555-0123, 937-555-0199")["phone_number"], ["937-555-0123", "937-555-0199"]);
  expectOnly("my number is 937-555-O636", "phone_number", "937-555-O636");
});

// M5 security: page text is attacker-controlled. No pattern may backtrack badly on hostile
// input (ReDoS): each gets 10k characters of repeated fragments it cares about. Before the
// fix, the email pattern took ~3 s on 20k characters of "a-a-a-…".
test("no pattern is slow on hostile text (ReDoS fuzz)", () => {
  const N = 10000;
  const units = [
    "a",
    "1",
    " ",
    "-",
    ".",
    "@",
    "_",
    "a1",
    "a ",
    "1 ",
    "1-",
    "a.",
    "a-",
    "Aa",
    "one ",
    "one-",
    "at ",
    "dot ",
    "a at ",
    "a dot ",
    "password: ",
    "key=",
    "sk-",
    "eyJa.",
    "postgres://",
    "a:b@",
    "10.",
    "192.168.",
    "host.",
    "born ",
    "1/",
    "account number ",
    "main street ",
    "1 main ",
    "PO Box ",
    "+4",
    "(",
    "O",
    "l",
    "a\n",
    "xxxxx=",
    "1. ",
    "1. 2\n",
    "nine, ",
    "password is ",
    "code is ",
    "login a / ",
    "vivo en calle ",
    "backup codes are ",
  ];
  // Absolute budgets depend on the machine (a regression passed locally at 149 ms and failed in
  // CI at 201 ms), so also compare growth: 4× the text should take ~4× the time, not ~16×.
  // Best of 3 runs: a garbage-collection pause inside one run once looked like 11× growth in CI.
  const time = (p, text) => {
    let best = Infinity;
    for (let r = 0; r < 3; r++) {
      const t0 = performance.now();
      p.find ? p.find(text) : text.match(p.regex);
      best = Math.min(best, performance.now() - t0);
    }
    return best;
  };
  const make = (u, n) => u.repeat(Math.ceil(n / u.length)).slice(0, n) + "!";
  const slow = [];
  for (const u of units) {
    for (const p of globalThis.Clotr.PATTERNS) {
      const mid = time(p, make(u, N));
      if (mid > 150) {
        slow.push(`${p.id} on ${JSON.stringify(u)}: ${mid.toFixed(0)} ms at ${N}`);
        continue;
      }
      if (mid < 4) continue; // too fast to measure growth reliably
      const big = time(p, make(u, N * 2));
      const small = Math.max(0.5, time(p, make(u, N / 2)));
      if (big / small > 10)
        slow.push(
          `${p.id} on ${JSON.stringify(u)}: ${small.toFixed(1)} → ${big.toFixed(1)} ms for 4× the text (grows faster than linear)`,
        );
    }
  }
  assert.deepEqual(slow, []);
});

test("your ID's fingerprint ignores case, like the format match does (D23)", () => {
  const { fingerprint } = globalThis.Clotr;
  assert.equal(fingerprint("s4lt", "my_id", "AB-123456"), fingerprint("s4lt", "my_id", "ab-123456"));
  assert.notEqual(fingerprint("s4lt", "my_id", "AB-123456"), fingerprint("s4lt", "my_id", "AB-123457"));
});

// First-release polish (M7): what people actually paste into AI chats. Fake tokens are
// generated here, in the real formats, so no secret-looking string is ever committed.
test("leak corpus: common service tokens, auth headers and password labels are caught", () => {
  let seed = 11;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const gen = (n, set = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789") =>
    Array.from({ length: n }, () => set[Math.floor(rnd() * set.length)]).join("");
  const hex = (n) => gen(n, "0123456789abcdef");
  const digits = (n) => gen(n, "0123456789");
  const cases = [
    ["service_token", `my Hugging Face token is hf_${gen(34)}`],
    ["service_token", `//registry.npmjs.org/:_authToken=npm_${gen(36)}`],
    ["service_token", `twine upload -u __token__ -p pypi-AgEIcHlwaS5vcmc${gen(60)}`],
    ["service_token", `GITLAB=glpat-${gen(20)}`],
    ["service_token", `sendgrid: SG.${gen(22)}.${gen(43)}`],
    ["service_token", `twilio api key SK${hex(32)}`],
    ["service_token", `mailgun key-${hex(32)}`],
    ["service_token", `shopify admin shpat_${hex(32)}`],
    ["service_token", `do token dop_v1_${hex(64)}`],
    ["service_token", `bot: ${digits(10)}:AA${gen(33)}`],
    ["service_token", `discord bot token M${gen(25)}.${gen(6)}.${gen(38)}`],
    ["service_token", `AccountName=acct;AccountKey=${gen(86)}==;EndpointSuffix=core.windows.net`],
    ["service_token", `post to https://hooks.slack.com/services/T${digits(9)}/B${digits(11)}/${gen(24)}`],
    ["service_token", `https://discord.com/api/webhooks/${digits(19)}/${gen(68)}`],
    ["password", `curl -H "Authorization: Bearer ${gen(32)}" https://api.example.com/v1`],
    ["password", `curl -H "x-api-key: ${gen(40)}" https://api.example.com`],
    ["password", "login: jdoe / pass: Tr0ub4dor&3"],
  ];
  const missed = cases.filter(([id, text]) => !detect(text)[id]).map(([id, text]) => `${id} ← ${text.slice(0, 60)}`);
  assert.deepEqual(missed, []);
});

test("not a phone: a dotted IP address", () => {
  assert.equal(detect("my home IP is 73.162.44.201, how do I port forward")["phone_number"], undefined);
  assert.equal(detect("ping 24.199.103.87 from the router")["phone_number"], undefined);
});

test("not a secret: references to environment/config variables in code", () => {
  expectNone("In my Express app I read the key with api-key: process.env.OPENAI_KEY");
  expectNone('password: os.environ["DB_PASSWORD"]');
  expectNone("token = import.meta.env.VITE_TOKEN");
  expectNone("secret: config.stripeSecret");
});

// M7, part 2. Public test vectors only: BIP-39 sample mnemonics, the Ethereum docs sample key,
// the standard example IBAN, the canonical test SIN, HMRC's example NI prefix.
test("leak corpus: crypto wallet secrets, international IDs, medical record numbers, your IP", () => {
  const cases = [
    ["crypto_secret", "my seed phrase is legal winner thank year wave sausage worth useful legal winner thank yellow"],
    [
      "crypto_secret",
      "recovery words:\n1. abandon 2. abandon 3. abandon 4. abandon 5. abandon 6. abandon\n7. abandon 8. abandon 9. abandon 10. abandon 11. abandon 12. about",
    ],
    ["crypto_secret", "private key 0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318"],
    ["bank_account", "wire it to IBAN DE89 3704 0044 0532 0130 00 please"],
    ["bank_account", "my iban is GB82WEST12345698765432"],
    ["national_id", "my national insurance number is AB 12 34 56 C"],
    ["national_id", "my SIN is 046 454 286"],
    ["medical_record", "patient MRN 00123456, admitted Tuesday"],
    ["public_ip", "my home IP is 73.162.44.201 how do I port forward"],
  ];
  const missed = cases.filter(([id, text]) => !detect(text)[id]).map(([id, text]) => `${id} ← ${text.slice(0, 60)}`);
  assert.deepEqual(missed, []);
});

test("not personal: ordinary prose, hashes, invalid IBANs, 9-digit numbers without a label", () => {
  expectNone("I want to abandon the project because the team can't agree on the design or the budget for next year.");
  expectNone("commit 4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318 broke the build");
  expectNone("the invoice id DE89 3704 0044 0532 0130 01 is wrong"); // bad checksum
  expectNone("order 046454286 shipped");
  expectNone("the server at 8.8.8.8 answers DNS");
});

// Security (M8): text copied from web pages, documents and chat apps carries invisible or
// look-alike characters. They must not hide a leak, and Hide it must remove what's really there.
test("invisible and look-alike characters don't hide a leak (and matches are the original text)", () => {
  const K = "AKIA4HPQ7XZ2R6TWLJ3N";
  const cases = [
    ["aws_access_key", "key AKIA4HPQ​7XZ2R6TWLJ3N"], // zero-width space
    ["aws_access_key", "key AKIA‍4HPQ7XZ2R6TWLJ3N"], // zero-width joiner
    ["aws_access_key", "key AKIA4HP­Q7XZ2R6TWLJ3N"], // soft hyphen
    ["aws_access_key", "key ⁦" + K + "⁩"], // bidi isolates
    ["phone_number", "call 937 555 0123"], // no-break space (web pages, Word)
    ["phone_number", "call 937 555 0123"], // narrow no-break space
    ["phone_number", "call 937—555—0123"], // em dash
    ["phone_number", "call ９３７-５５５-０１２３"], // full-width
    ["phone_number", "call ٩٣٧-٥٥٥-٠١٢٣"], // Arabic-Indic digits
    ["us_ssn", "ssn １２３-４５-６７８９"],
    ["us_ssn", "ssn 123 - 45 - 6789"], // thin spaces
    ["email", "mail jane.doe＠gmail.com"], // full-width @
    ["email", "mail jane.do​e@gmail.com"],
    ["credit_card", "card 4111​1111​1111​1111"],
  ];
  const missed = [];
  for (const [id, text] of cases) {
    const found = detect(text)[id];
    // Each match must be a real piece of the original text, so Hide it can remove it.
    if (!found || !found.every((m) => text.includes(m)))
      missed.push(`${id} ← ${JSON.stringify(text)} → ${JSON.stringify(found)}`);
  }
  assert.deepEqual(missed, []);
  // The zero-width space is part of what gets hidden, not left behind.
  assert.deepEqual(detect("key AKIA4HPQ​7XZ2R6TWLJ3N")["aws_access_key"], ["AKIA4HPQ​7XZ2R6TWLJ3N"]);
});

test("fingerprints ignore invisible characters and look-alike digits", () => {
  const { fingerprint } = globalThis.Clotr;
  assert.equal(fingerprint("s", "phone_number", "937 555 0123"), fingerprint("s", "phone_number", "937 555 0123"));
  assert.equal(fingerprint("s", "email", "jane.do​e@gmail.com"), fingerprint("s", "email", "jane.doe@gmail.com"));
});

// M8: PDF parsing runs on attacker-controlled files. Finding the streams must stay linear
// (a regex version took 24 s on 900 KB of unclosed "<<" dictionaries).
test("PDF streams: found in a real-shaped file, and hostile files stay fast", () => {
  const { findPdfStreams } = globalThis.Clotr;
  const NL = String.fromCharCode(10);
  const pdf = [
    "%PDF-1.4",
    "1 0 obj << /Length 12 /Filter /FlateDecode /DecodeParms << /Predictor 1 >> >>",
    "stream",
    "xxxxxxxxxxxx",
    "endstream endobj",
    "2 0 obj <</Length 5>>stream",
    "abcde",
    "endstream",
  ].join(NL);
  const found = findPdfStreams(pdf);
  assert.equal(found.length, 2);
  assert.match(found[0].dict, /\/FlateDecode/);
  assert.equal(pdf.slice(found[1].start, found[1].start + 5), "abcde");
  assertLinear(
    findPdfStreams,
    (u, n) => "%PDF " + u.repeat(n) + ">> endobj stream" + NL,
    ["<< /A <x ", "<< /A (x) ", "stream ", ">> stream" + NL],
    25000,
  );
});

test("PDF page text: literal strings, TJ arrays and ToUnicode-mapped fonts; hostile streams stay fast", () => {
  const { pdfPageText } = globalThis.Clotr;
  const cmap =
    "begincmap 2 beginbfchar <0001> <0039> <0002> <0033> endbfchar 1 beginbfrange <0010> <0019> <0030> endbfrange endcmap";
  const page = "BT /F1 12 Tf (call me at ) Tj [(937)-120(-555-)] TJ <001000110012> Tj ET BT <00010002> Tj ET";
  const text = pdfPageText([cmap, page]);
  assert.match(text, /call me at 937-555-012/);
  assert.match(text, /93/);
  assertLinear(
    (x) => pdfPageText([x]),
    (u, n) => "BT " + u.repeat(n) + " Tj",
    ["(", "<0", "beginbfchar ", "[(", "(a\\"],
  );
});

// M8: Office documents are attacker-controlled too. The first tag stripper (/<[^>]*>/g) took
// 54 s on 600 KB of "<a <a <a…"; stripping must stay linear.
test("Office XML to text: paragraphs and entities read; hostile XML stays fast", () => {
  const { xmlToText } = globalThis.Clotr;
  assert.equal(
    xmlToText(
      "<w:p><w:r><w:t>call 937-555-0123</w:t></w:r></w:p><w:p><w:t>Tom &amp; Ann &#64; home</w:t></w:p>",
    ).trim(),
    "call 937-555-0123\nTom & Ann @ home",
  );
  assertLinear(xmlToText, (u, n) => u.repeat(n), ["<a ", "&aaaa", "</w:", "<w:p"]);
});

// Stress (2026-09-25): thousands of random messages built from what the detectors look for
// (digits, number words, separators, @ and dots, key prefixes, invisible and full-width
// characters). Seeded, so a failure reproduces. None may throw, and none may be slow.
test("fuzz: 3,000 random messages never break detection and each stays fast", () => {
  let seed = 20260925;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const Z = String.fromCharCode(0x200b),
    NBSP = String.fromCharCode(0xa0),
    FW5 = String.fromCharCode(0xff15);
  const parts = [
    "0",
    "1",
    "5",
    "9",
    "12",
    "555",
    "937",
    "0147",
    "-",
    ".",
    " ",
    "  ",
    "(",
    ")",
    "+1",
    "@",
    "gmail",
    ".com",
    "five",
    "nine",
    "oh",
    "zero",
    "hundred",
    "my",
    "phone",
    "number",
    "is",
    "password",
    ":",
    "=",
    "AKIA",
    "sk-",
    "ghp_",
    "xoxb-",
    "Bearer ",
    "\n",
    "\t",
    Z,
    NBSP,
    FW5,
    "Street",
    "Ave",
    "apt",
    "#",
    "ssn",
    "dob",
    "IBAN",
    "DE89",
    "/",
    "\\",
    "é",
    "ü",
    "🙂",
  ];
  let slowest = 0;
  for (let i = 0; i < 3000; i++) {
    const len = 1 + Math.floor(rand() * (i % 50 === 0 ? 2000 : 60));
    let text = "";
    for (let j = 0; j < len; j++) text += pick(parts);
    const t = performance.now();
    assert.doesNotThrow(() => globalThis.Clotr.detect(text), `case ${i}: ${JSON.stringify(text.slice(0, 80))}`);
    slowest = Math.max(slowest, performance.now() - t);
  }
  assert.ok(slowest < 250, `slowest message took ${slowest.toFixed(1)} ms`);
});

// Spanish (queue item 12): the same corpus budget for everyday Spanish messages.
test("false-alarm budget (Spanish): at most 1 per 50 normal messages", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const msgs = fs
    .readFileSync(path.join(__dirname, "corpus", "normal-messages-es.txt"), "utf8")
    .split(/\r?\n---\r?\n/)
    .slice(1)
    .map((s) => s.trim())
    .filter(Boolean);
  assert.ok(msgs.length >= 60, `corpus has only ${msgs.length} messages`);
  const alarms = msgs.map((m) => [m, detect(m)]).filter(([, f]) => Object.keys(f).length);
  assert.ok(
    alarms.length <= Math.floor(msgs.length / 50),
    `${alarms.length} false alarms in ${msgs.length} messages:\n` +
      alarms.map(([m, f]) => `  ${JSON.stringify(f)} ← ${m.slice(0, 80)}`).join("\n"),
  );
});

test("Spanish: phone numbers spelled out in Spanish, mixed with digits", () => {
  expectOnly("mi número es nueve tres siete cinco cinco cinco cero uno cuatro siete", "phone_number");
  expectOnly("llámame al 6 uno dos tres cuatro cinco seis siete ocho", "phone_number");
  expectNothing("tengo dos o tres preguntas");
  expectNothing("todos los días a las siete");
  expectOnly("mi móvil es 612 345 678", "phone_number", "612 345 678");
  expectOnly("mi fijo es 93 412 34 56", "phone_number", "93 412 34 56"); // a landline
  expectOnly("my SSN is 219-09-9999", "us_ssn"); // 9 digits without a phone word stay an SSN
});

test("Spanish: numbers said in pairs and hundreds, as people read out phone numbers", () => {
  expectOnly("mi móvil es seis cero cero, doce, treinta y cuatro, cincuenta y seis", "phone_number");
  expectOnly(
    "llámame al novecientos treinta y siete, quinientos cincuenta y cinco, doce, treinta y cuatro",
    "phone_number",
  );
  expectOnly(
    "mi celular es cincuenta y cinco, doce, treinta y cuatro, cincuenta y seis, setenta y ocho",
    "phone_number",
  );
  expectOnly("mi teléfono: seis veintidós, dieciséis, cuarenta, noventa y nueve", "phone_number");
  const fp = (m) => globalThis.Clotr.fingerprint("s", "phone_number", m);
  assert.equal(fp("seis cero cero, doce, treinta y cuatro, cincuenta y seis"), fp("600 12 34 56"));
  // Ages, prices and counts stay quiet
  expectNothing("tengo treinta y cinco años y ahorré dos mil euros");
  expectNothing("cuesta quinientos euros y éramos veinte personas");
  expectNothing("nací en mil novecientos ochenta y dos");
});

test("security-question answers are secrets", () => {
  expectOnly("my mother's maiden name is Smith", "password", "Smith");
  expectOnly("the answer to my security question is Rover", "password", "Rover");
  expectOnly("my first pet's name was Biscuit", "password", "Biscuit");
  expectOnly("el apellido de soltera de mi madre es García", "password", "García");
  expectNothing("what is a maiden name?");
  expectNothing("The security question was easy, what should my answer be?");
  expectOnly("my security answer is Rover", "password", "Rover");
  expectNothing("my first pet's name was a secret to everyone");
});

test("Spanish: passwords said the way people write them", () => {
  expectOnly("mi contraseña es Gato2024!", "password", "Gato2024"); // the "!" ends the sentence, as in English
  expectOnly("la contraseña del wifi es sol-y-luna", "password", "sol-y-luna");
  expectOnly("clave: Xk9#mP2q", "password", "Xk9#mP2q");
  expectNothing("olvidé la contraseña de mi correo");
  expectNothing("mi contraseña es incorrecta");
  expectOnly("el pin de mi tarjeta es 4821", "password", "4821");
  expectOnly("la clave de mi correo es Luna2020", "password", "Luna2020");
});

test("Spanish and Mexican ID numbers (checksum-validated)", () => {
  expectOnly("mi DNI es 12345678Z", "national_id", "12345678Z");
  expectOnly("NIE X1234567L por favor", "national_id", "X1234567L");
  expectOnly("CURP: GODE561231HDFRRN00", "national_id", "GODE561231HDFRRN00");
  expectNothing("GODE561231HDFRRN04"); // wrong check digit
  expectNothing("12345678A"); // wrong DNI letter
  expectNothing("referencia 87654321B del pedido"); // wrong letter too
  // Mexico's RFC and Spain's social security number: only after their label
  expectOnly("mi RFC es PEPJ800101AB3", "national_id", "PEPJ800101AB3");
  expectOnly("RFC: GOD8012315Q7", "national_id", "GOD8012315Q7"); // a company's (3 letters)
  expectOnly("mi número de la seguridad social es 28 1234567840", "national_id", "28 1234567840");
  expectOnly("NSS: 281234567840", "national_id", "281234567840");
  expectNothing("see RFC 7231 and RFC 9110 section 15");
  expectNothing("mi RFC es PEPJ801301AB3"); // no month 13
  expectNothing("la seguridad social es importante para 2026");
  assert.equal(globalThis.Clotr.PATTERNS.find((p) => p.id === "national_id").name, "National ID Number");
});

test("Spanish street addresses", () => {
  expectOnly("vivo en Calle Mayor 5, Madrid", "street_address");
  expectOnly("la oficina está en Avenida Paseo de la Reforma 222", "street_address");
  expectOnly("envíalo a C/ Alcalá, 45", "street_address");
  expectOnly("vivo en la calle Mayor número 5, tercero B", "street_address");
  assert.equal(globalThis.Clotr.addressCore("Calle Mayor número 5"), globalThis.Clotr.addressCore("calle mayor 5"));
  expectNothing("la calle está mojada");
  expectNothing("vivo cerca de una avenida con mucho tráfico");
  // Typed all in lowercase, right after an address phrase
  expectOnly("vivo en calle mayor 5, madrid", "street_address");
  expectOnly("mi dirección es avenida de la constitución 12", "street_address");
  expectOnly("mándalo a c/ alcalá 45", "street_address");
  expectNothing("la calle 5 está cortada");
  expectNothing("paseo por la avenida 3 veces al día");
  expectNothing("en la plaza mayor 3 niños jugaban");
  expectNothing("vivo en la calle de al lado hace 5 años");
});

// Translations (D65), with a stand-in for chrome.i18n built from the Spanish file.
test("translations: Spanish with values filled in; English when a message is missing", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const es = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "extension", "_locales", "es", "messages.json"), "utf8"),
  );
  const getMessage = (key, subs = []) => {
    const m = es[key];
    if (!m) return "";
    return m.message.replace(/\$([A-Za-z0-9_]+)\$/g, (_, name) => {
      const n = Number(/^\$(\d)$/.exec(m.placeholders[name].content)[1]);
      return subs[n - 1] ?? "";
    });
  };
  const { msg } = globalThis.Clotr;
  globalThis.chrome = { i18n: { getMessage } };
  try {
    assert.equal(
      msg("choiceLogKinds", "Leave it in, and stop warning me about: $1", "Número de teléfono"),
      "Dejarlo, y dejar de avisarme de: Número de teléfono",
    );
    assert.equal(
      msg("tipHow", "How should Clotr treat $1 from now on?", "a Phone Number", "Número de teléfono"),
      "¿Cómo quieres que Clotr trate este tipo de dato (Número de teléfono) a partir de ahora?",
    );
    assert.equal(msg("noSuchKey", "Only in English, $1", "here"), "Only in English, here");
  } finally {
    delete globalThis.chrome;
  }
  assert.equal(msg("coverIt", "Hide it"), "Hide it", "without chrome.i18n (tests, a lost context): English");
});

test("Spanish addresses in the vault: accepted, and the same address matches however it's written", () => {
  const { addressCore, fingerprint } = globalThis.Clotr;
  assert.equal(addressCore("Calle Alcalá 45"), "calle alcalá 45");
  assert.equal(addressCore("c/ Alcalá, 45"), "calle alcalá 45");
  assert.equal(addressCore("Avda. de la Constitución 12"), "avenida de la constitución 12");
  const fp = (m) => fingerprint("salt", "street_address", m);
  assert.equal(fp("C/ Alcalá, 45"), fp("calle alcalá 45"));
  assert.equal(fp("Calle Alcalá 45"), fp("calle alcala 45")); // with or without accents
  // What detection finds in a chat matches what you saved in the vault.
  const found = detect("envíalo a C/ Alcalá, 45 por favor").street_address[0];
  assert.equal(fp(found), fp("Calle Alcalá 45"));
});

// Release polish probe (2026-09-27): questions people ask about passwords, public toll-free numbers,
// and codes a scam caller asks for.
test("not a secret or a phone: a password manager question, toll-free numbers", () => {
  expectNone("What is a good password manager?");
  expectNone("Is a password generator safe!");
  expectNone("Call 911 if it happens again, or poison control at 1-800-222-1222.");
  expectNone("their support line is (888) 555-0199 or 1 877 555 0100");
});

test("leak corpus: texted verification codes, a bare pin number, a security question with its topic", () => {
  const cases = [
    ["password", "the verification code they texted me is 482913, what do I do with it"],
    ["password", "They called from Microsoft and asked for the code 739201, should I give it?"],
    ["password", "my one-time code: 552 019"],
    ["password", "they sent me a code 8841 by text"],
    ["password", "the OTP is 283746"],
    ["password", "Here's my 2FA: 482 913"],
    ["password", "pin number 5832"],
    ["password", "my pin 5832 for the debit card"],
    ["password", "the answer to my security question (first pet) is Rusty"],
  ];
  const missed = cases.filter(([id, text]) => !detect(text)[id]).map(([id, text]) => `${id} ← ${text.slice(0, 60)}`);
  assert.deepEqual(missed, []);
  expectNone("the error code is 404 and the verification code expired");
  expectNone("I sent the code 2024 version to my boss");
  expectNone("I never got the verification code in 2024");
  expectNone("the booking confirmation code is 7712, see you Friday");
  expectNone("she sent me the code snippet 2048 lines long");
  expectNone("pin 13 on the arduino, and set pin number 12 to high");
  expectNone("my pin is loose on the hinge");
});

test("leak corpus: misspelled passwords, what the password is for, SS#, keypad codes with dashes", () => {
  const cases = [
    ["password", "my pasword is Rover2011"],
    ["password", "my passwrod is Rover2011"],
    ["password", "my pw is rover2011"],
    ["password", "my password for netflix is Rover2011"],
    ["password", "password to my email is rover2011"],
    ["password", "the password for my bank account is Tulip!55"],
    ["password", "the passward is Bluebird44"],
    ["password", "our house alarm code is 1-9-7-5"],
    ["us_ssn", "My SS# is 219099999"],
    ["us_ssn", "my soc sec number 219099999"],
  ];
  const missed = cases.filter(([id, text]) => !detect(text)[id]).map(([id, text]) => `${id} ← ${text.slice(0, 60)}`);
  assert.deepEqual(missed, []);
  expectNone("the password for everything is the same, is that bad?");
  expectNone("my password for work is too long to remember");
  expectNone("the combination is 1-2-3-4 on the demo lock");
  expectNone("the passwords for these accounts were changed");
  expectNone("the password to the router is printed on the back");
  assert.ok(detect("the password for my kid's ipad is 1234 but he changed it").password);
});

test("Spanish: verification codes, a password for something, free-phone numbers", () => {
  const cases = [
    ["password", "el código de verificación es 482913"],
    ["password", "me mandaron un código por SMS: 552019"],
    ["password", "el código que me llegó es 739201, lo doy?"],
    ["password", "me pidieron el código 739201"],
    ["password", "mi contraseña para el banco es Tulip55"],
  ];
  const missed = cases.filter(([id, text]) => !detect(text)[id]).map(([id, text]) => `${id} ← ${text.slice(0, 60)}`);
  assert.deepEqual(missed, []);
  expectNone("llama al 900 123 456, es gratuito");
  expectNone("el código de verificación caduca en 2024");
  expectNone("el código de confirmación de la reserva es 7712");
  expectNone("me mandaron el código fuente 2048 líneas");
});

test("leak corpus: a school locker combination, with dashes or spaces", () => {
  assert.ok(detect("i go to lincoln middle school and my locker combo is 12-34-08").password);
  assert.ok(detect("my locker combination is 24 12 36").password);
  expectNone("the combination is 1 2 3 on the demo lock");
  expectNone("my lock screen is 3 by 3 grid");
});

test("not a secret: a year after OTP, words describing a password", () => {
  expectNone("OTP 2024 conference in Houston");
  expectNone("the password for 2FA is separate");
  expectNone("the password for the account is expiring in 5 days");
  assert.ok(detect("the password for guest wifi is guest").password); // that one really is the password
});

// Pre-release Batch 3: "generalize instead of remove". A birth date keeps its month and year, an address its town;
// what can't be made general is hidden as before, and the result never holds the exact detail.
test("generalize: a birth date becomes its month and year, an address its town", () => {
  const { detect: find, generalize, generalForms } = globalThis.Clotr;
  const gen = (text) => generalize(text, find(text), "en-US");
  assert.equal(gen("I was born on 03/14/1948"), "I was born on March 1948");
  assert.equal(gen("born March 14, 1948 in Ohio"), "born March 1948 in Ohio");
  assert.equal(gen("DOB: 1948-03-14"), "DOB: March 1948");
  assert.equal(gen("my birthday is 14 March 1948"), "my birthday is March 1948");
  // 04/05 could be April 5 or 4 May: only the year, never a wrong month.
  assert.equal(gen("I was born on 04/05/1948"), "I was born on 1948");
  assert.equal(gen("my address is 123 Oak Street, Springfield, IL 62704"), "my address is Springfield");
  assert.equal(gen("send it to 42 Elm Ave, Portland OR 97201 please"), "send it to Portland please");
  // No town to keep: hidden like before.
  assert.equal(gen("I live at 123 Oak Street"), "I live at [REDACTED STREET ADDRESS]");
  // Mixed: the date generalized, the phone hidden.
  const mixed = gen("born 03/14/1948, call me at 937-555-0123");
  assert.equal(mixed, "born March 1948, call me at [REDACTED PHONE NUMBER]");
  // In Spanish, the month is Spanish.
  const es = (text) => generalize(text, find(text), "es-ES");
  assert.equal(es("nací el 14/03/1948"), "nací el marzo de 1948");
  assert.equal(es("mi fecha de nacimiento es 14 de marzo de 1948"), "mi fecha de nacimiento es marzo de 1948");
  // What the button shows, and nothing when there's nothing to generalize.
  assert.deepEqual(
    generalForms(find("born 03/14/1948, call me at 937-555-0123"), "en-US").map((g) => g.general),
    ["March 1948"],
  );
  assert.deepEqual(generalForms(find("call me at 937-555-0123"), "en-US"), []);
  // The general message is quiet: nothing in it is found again.
  for (const t of ["I was born on 03/14/1948", "my address is 123 Oak Street, Springfield, IL 62704"]) {
    assert.deepEqual(find(gen(t)), [], `still found in "${gen(t)}"`);
  }
});

// Bug (2026-09-29): Spanish birth dates in these forms weren't caught.
test("Spanish birth dates: nacido/nacida, nacimiento:, and year-month-day", () => {
  assert.deepEqual(detect("fecha de nacimiento: 1948-03-14").date_of_birth, ["1948-03-14"]);
  assert.deepEqual(detect("nacido el 14/03/1948 en Madrid").date_of_birth, ["14/03/1948"]);
  assert.deepEqual(detect("nacida el 3 de julio de 1962").date_of_birth, ["3 de julio de 1962"]);
  assert.deepEqual(detect("Nacimiento: 14/03/1948").date_of_birth, ["14/03/1948"]);
  // Still quiet: a birthplace, and a date that isn't a birth date.
  expectNone("lugar de nacimiento: Madrid");
  expectNone("la reunión es el 14/03/2027");
});

// Security review (2026-09-30): a huge paste of digits must stay quick to read. Every digit added to a long run used to
// re-check the whole run for a list marker ("1.", "2)"): 40,000 digits took about a second and froze the chat page.
// Measured so a busy machine can't fail it (CI, 2026-09-30: 10,000 digits in 5 ms, 40,000 in 48 ms, where the 5 ms
// floor made the check "under 40 ms"): texts large enough to time well above the floor, the two sizes read in
// turns so a slow moment hits both, the best of five each. The rule is unchanged: four times the text may take less
// than eight times as long; the old way took about sixteen times.
test("reading a long run of digits grows in step with its length (no freeze on a huge paste)", () => {
  let n = 0;
  const once = (digits) => {
    const text = "1".repeat(digits) + "x" + n++; // a new text each time: the last read is cached
    const t0 = process.hrtime.bigint();
    globalThis.Clotr.detect(text);
    return Number(process.hrtime.bigint() - t0) / 1e6;
  };
  once(2000); // warm up
  let small = Infinity;
  let big = Infinity;
  for (let i = 0; i < 5; i++) {
    small = Math.min(small, once(20000));
    big = Math.min(big, once(80000));
  }
  assert.ok(
    big < 8 * Math.max(small, 5),
    `20,000 digits: ${small.toFixed(0)} ms, 80,000: ${big.toFixed(0)} ms (four times the text should take about four times as long)`,
  );
});
