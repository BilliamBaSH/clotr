// Clotr — detection patterns (what to look for).
// detector.js (loaded next) runs them: detect(), responses, fingerprints.
//
// MV3 content scripts are classic scripts, not ES modules, so `export` is not
// allowed here. Patterns are shared with content.js through a global namespace.
(() => {
  "use strict";

  // Luhn checksum, to cut false positives on credit-card-shaped numbers.
  function luhn(candidate) {
    const digits = candidate.replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) return false;
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    }
    return sum % 10 === 0;
  }

  // ---------- Fewer false alarms for credentials ----------

  // Documentation keys and obvious placeholders: AWS's AKIAIOSFODNN7EXAMPLE, "xxxxxxxx",
  // "your-api-key-here", "ABCDEFGHIJ…". Real keys never look like this.
  function isPlaceholder(m) {
    if (/example|your[_-]?(api[_-]?)?(key|token|secret)|placeholder|dummy|redacted|insert[_-]?here/i.test(m))
      return true;
    if (/(.)\1{5,}/.test(m)) return true; // six of the same character in a row
    let run = 1; // a long alphabet/number sequence: ABCDEFGH, 12345678
    for (let i = 1; i < m.length; i++) {
      run = m.charCodeAt(i) === m.charCodeAt(i - 1) + 1 && /[A-Za-z0-9]/.test(m[i]) ? run + 1 : 1;
      if (run >= 8) return true;
    }
    return false;
  }

  function entropy(s) {
    const counts = {};
    for (const ch of s) counts[ch] = (counts[ch] || 0) + 1;
    return Object.values(counts).reduce((h, c) => h - (c / s.length) * Math.log2(c / s.length), 0);
  }

  // For keys whose prefix is also an ordinary word start ("sk-learn-…"): the part after the
  // prefix must look machine-made: mixed case with digits, long unbroken stretches
  // (slugs break every few characters), and high character variety.
  function looksRandom(body) {
    return (
      body.length >= 20 &&
      /\d/.test(body) &&
      /[a-z]/.test(body) &&
      /[A-Z]/.test(body) &&
      Math.max(...body.split(/[-_]/).map((seg) => seg.length)) >= 12 &&
      entropy(body) >= 3.5
    );
  }

  // ---------- Numbers written any way ----------
  // Reads digit sequences whether typed as digits, number words, or a mix, with or
  // without separators: "937-555-5636", "nine three seven…",
  // "ninethreesevenfive…", "9threeseve5five5five63six". Aimed at people who don't
  // realize spelling a number out doesn't hide it.

  // ---------- Translations (D65) ----------
  // The browser picks the language (Spanish from _locales/es). English is written in the code and is
  // the fallback: a missing translation, or a context lost after an update, never breaks a warning.
  function msg(key, english, ...subs) {
    let text = "";
    try {
      text = globalThis.chrome?.i18n?.getMessage(key, subs.map(String)) || "";
    } catch {
      /* extension context gone: English */
    }
    return text || english.replace(/\$(\d)/g, (_, n) => String(subs[n - 1] ?? ""));
  }

  // Digit words, with common misspellings (none of them an everyday word; those are WEAK_WORDS below).
  const NUMBER_WORDS = {
    zero: "0",
    zeero: "0",
    zro: "0",
    oh: "0",
    sicks: "6",
    siks: "6",
    eigt: "8",
    eihgt: "8",
    nien: "9",
    fiev: "5",
    sevin: "7",
    one: "1",
    two: "2",
    three: "3",
    thre: "3",
    four: "4",
    five: "5",
    fiv: "5",
    six: "6",
    seven: "7",
    sevn: "7",
    seve: "7",
    eight: "8",
    eigth: "8",
    eigh: "8",
    nine: "9",
    ten: "10",
    eleven: "11",
    twelve: "12",
    thirteen: "13",
    fourteen: "14",
    fifteen: "15",
    sixteen: "16",
    seventeen: "17",
    eighteen: "18",
    nineteen: "19",
    // Spanish (D64)
    cero: "0",
    uno: "1",
    dos: "2",
    tres: "3",
    cuatro: "4",
    cinco: "5",
    seis: "6",
    siete: "7",
    ocho: "8",
    nueve: "9",
    // Spanish numbers are often read out in pairs ("seis cero cero, doce, treinta y cuatro"). Not "once"
    // (eleven): it's an everyday English word.
    diez: "10",
    doce: "12",
    trece: "13",
    catorce: "14",
    quince: "15",
    dieciseis: "16",
    dieciséis: "16",
    diecisiete: "17",
    dieciocho: "18",
    diecinueve: "19",
    veintiuno: "21",
    veintidos: "22",
    veintidós: "22",
    veintitres: "23",
    veintitrés: "23",
    veinticuatro: "24",
    veinticinco: "25",
    veintiseis: "26",
    veintiséis: "26",
    veintisiete: "27",
    veintiocho: "28",
    veintinueve: "29",
  };
  // "fifty five" = 55, "fifty" alone = 50; Spanish "treinta y cuatro" = 34.
  const TENS_WORDS = {
    twenty: "2",
    thirty: "3",
    forty: "4",
    fourty: "4",
    fifty: "5",
    sixty: "6",
    seventy: "7",
    eighty: "8",
    ninety: "9",
    veinte: "2",
    treinta: "3",
    cuarenta: "4",
    cincuenta: "5",
    sesenta: "6",
    setenta: "7",
    ochenta: "8",
    noventa: "9",
  };
  // Spanish hundreds are one word ("novecientos treinta y siete" = 937).
  const HUNDRED_WORDS = {
    cien: "1",
    ciento: "1",
    doscientos: "2",
    doscientas: "2",
    trescientos: "3",
    trescientas: "3",
    cuatrocientos: "4",
    cuatrocientas: "4",
    quinientos: "5",
    quinientas: "5",
    seiscientos: "6",
    seiscientas: "6",
    setecientos: "7",
    setecientas: "7",
    ochocientos: "8",
    ochocientas: "8",
    novecientos: "9",
    novecientas: "9",
  };
  // Sound-alikes and look-alikes. Everyday words, so they only count between real digits.
  const WEAK_WORDS = { won: "1", to: "2", too: "2", for: "4", fore: "4", ate: "8" };
  const WEAK_LETTERS = { O: "0", o: "0", l: "1" };
  // "five hundred fifty five" = 555, "six thousand seven hundred" = 6700: how many places each fills.
  const MULTIPLIERS = { hundred: 2, thousand: 3, mil: 3 };
  // "double five" = 55, "triple seven" = 777.
  const REPEATS = { double: 2, triple: 3 };
  const ALL_WORDS = { ...NUMBER_WORDS, ...TENS_WORDS, ...HUNDRED_WORDS, ...WEAK_WORDS, ...MULTIPLIERS, ...REPEATS };
  // Longest words first, so "seventeen" wins over "seven" and "three" over "thre".
  const UNIT_RE = new RegExp(
    `\\d|${Object.keys(ALL_WORDS)
      .sort((a, b) => b.length - a.length)
      .join("|")}|[Ool]`,
    "iy",
  );
  // What may sit between digits of one number: spaces, dashes, dots, commas, parentheses, slashes, plus.
  const SEPARATOR_RE = /^[ \t \-–.,()/+_*]{1,3}$/;
  const isLetter = (ch) => ch !== undefined && /\p{L}/u.test(ch);
  // …or the separator said as a word: "two one nine dash oh nine".
  const SPOKEN_SEPARATOR_RE = /^\s+(?:dash|hyphen|gui[oó]n)\s+$/i;
  const isGap = (g) => g === "" || SEPARATOR_RE.test(g) || SPOKEN_SEPARATOR_RE.test(g);

  function readUnit(s, start) {
    const w = s.toLowerCase();
    const unit = (digits, kind) => ({
      start,
      end: start + s.length,
      digits,
      kind,
      isWord: kind !== "digit" && kind !== "letter",
    });
    if (/^\d$/.test(s)) return unit(s, "digit");
    if (s.length === 1) return WEAK_LETTERS[s] ? unit(WEAK_LETTERS[s], "letter") : null;
    if (NUMBER_WORDS[w]) return unit(NUMBER_WORDS[w], "word");
    if (TENS_WORDS[w]) return unit(TENS_WORDS[w], "tens");
    if (HUNDRED_WORDS[w]) return unit(HUNDRED_WORDS[w], "hund");
    if (MULTIPLIERS[w]) return { ...unit("", "mult"), places: MULTIPLIERS[w] };
    if (REPEATS[w]) return { ...unit("", "rep"), times: REPEATS[w] };
    return unit(WEAK_WORDS[w], "weak");
  }

  // Splits text into runs of digits. Each run is a list of groups (digits written
  // together, with no separator between them); each group is a list of units
  // { start, end, digits, kind, isWord }. Several patterns read the same message, so the last result is
  // kept (callers only read it): a big paste is read once per scan, not once per pattern.
  let lastRunsText = null;
  let lastRuns = null;
  function numberRuns(text) {
    if (text === lastRunsText) return lastRuns;
    const runs = readNumberRuns(text);
    lastRunsText = text;
    lastRuns = runs;
    return runs;
  }

  function readNumberRuns(text) {
    const units = [];
    for (let i = 0; i < text.length;) {
      UNIT_RE.lastIndex = i;
      const m = UNIT_RE.exec(text);
      const u = m && readUnit(m[0], i);
      if (!u) {
        i++;
        continue;
      }
      units.push(u);
      i = u.end;
    }

    // A number word only counts when it isn't part of an ordinary word
    // ("someone", "Ohio", "phone", "fortunately").
    const wordOk = (u, k) => {
      const touchesPrev = k > 0 && units[k - 1].end === u.start;
      const touchesNext = k < units.length - 1 && units[k + 1].start === u.end;
      return (touchesPrev || !isLetter(text[u.start - 1])) && (touchesNext || !isLetter(text[u.end]));
    };
    const strong = units.map(
      (u, k) => u.kind === "digit" || (["word", "tens", "hund", "mult", "rep"].includes(u.kind) && wordOk(u, k)),
    );
    // Weak units need a real digit on both sides ("five won two", "555-O636"); a letter must also touch one.
    const valid = units.filter((u, k) => {
      if (strong[k]) return true;
      if (u.kind === "weak" && !wordOk(u, k)) return false;
      if (u.kind !== "weak" && u.kind !== "letter") return false;
      if (!strong[k - 1] || !strong[k + 1]) return false;
      const before = text.slice(units[k - 1].end, u.start);
      const after = text.slice(u.end, units[k + 1].start);
      if (!isGap(before) || !isGap(after)) return false;
      return u.kind === "weak" || before === "" || after === "";
    });

    // "double five" → 55: the next single digit, repeated. A "double" not before a digit isn't one.
    const repeated = [];
    for (let k = 0; k < valid.length; k++) {
      const u = valid[k],
        next = valid[k + 1];
      if (u.kind !== "rep") {
        repeated.push(u);
        continue;
      }
      if (
        next &&
        (next.kind === "word" || next.kind === "digit") &&
        /^\d$/.test(next.digits) &&
        /^[\s-]?$/.test(text.slice(u.end, next.start))
      ) {
        repeated.push({ ...next, start: u.start, digits: next.digits.repeat(u.times), kind: "word", isWord: true });
        k++;
      }
    }

    // "fifty six" → 56; a lone "fifty" → 50.
    const merged = [];
    for (let k = 0; k < repeated.length; k++) {
      const u = repeated[k];
      if (u.kind !== "tens") {
        merged.push(u);
        continue;
      }
      const next = repeated[k + 1];
      if (
        next &&
        next.kind === "word" &&
        /^[1-9]$/.test(next.digits) &&
        /^(?:[\s-]?|\s+y\s+)$/i.test(text.slice(u.end, next.start))
      ) {
        merged.push({ ...u, end: next.end, digits: u.digits + next.digits, kind: "word" });
        k++;
      } else {
        merged.push({ ...u, digits: u.digits + "0", kind: "word" });
      }
    }

    // "five hundred [and] fifty five" → 555; hundreds first, so "six thousand seven hundred" → 6700.
    // A multiplier without a number word before it ("a hundred") isn't a digit.
    const withPlaces = (list, places) => {
      const out = [];
      for (let k = 0; k < list.length; k++) {
        const u = list[k],
          m = list[k + 1],
          low = list[k + 2];
        if (places === 2 && u.kind === "hund") {
          // "quinientos cincuenta y cinco": the hundred is in the word
          const fill = m?.kind === "word" && m.digits.length <= 2 && /^[\s-]+$/.test(text.slice(u.end, m.start));
          out.push({
            ...u,
            kind: "word",
            end: (fill ? m : u).end,
            digits: u.digits + (fill ? m.digits.padStart(2, "0") : "00"),
          });
          k += fill ? 1 : 0;
          continue;
        }
        const lead =
          u.kind === "word" &&
          /^[1-9]\d?$/.test(u.digits) &&
          m?.kind === "mult" &&
          m.places === places &&
          /^[\s-]?$/.test(text.slice(u.end, m.start));
        if (!lead) {
          out.push(u);
          continue;
        }
        const fill =
          low?.kind === "word" &&
          low.digits.length <= places &&
          /^[\s-]+(?:and\s+)?$/i.test(text.slice(m.end, low.start));
        out.push({
          ...u,
          end: (fill ? low : m).end,
          digits: u.digits + (fill ? low.digits.padStart(places, "0") : "0".repeat(places)),
        });
        k += fill ? 2 : 1;
      }
      return out;
    };
    const placed = withPlaces(withPlaces(merged, 2), 3).filter((u) => u.kind !== "mult");

    // A numbered list's item number ("1. …", "2) …" at the start of a line) isn't part of the detail after it.
    const atLineStart = (at) => {
      // only spaces or tabs back to a line break (looks back no further, so it stays linear)
      let i = at - 1;
      while (i >= 0 && (text[i] === " " || text[i] === "\t")) i--;
      return i < 0 || text[i] === "\n";
    };
    // The cheap tests first: this runs for every unit added to a run, so walking the whole run each time made a huge
    // paste of digits quadratic (40,000 digits froze the page for a second; security review, 2026-09-30).
    const listNumber = (r, gap) =>
      r.units.length <= 3 &&
      r.groups.length === 1 &&
      /^[.)][^\S\n]+$/.test(gap) &&
      r.units.every((x) => x.kind === "digit") &&
      atLineStart(r.units[0].start);
    const runs = [];
    let run = null;
    for (const u of placed) {
      const gap = run ? text.slice(run.units[run.units.length - 1].end, u.start) : null;
      if (run && isGap(gap) && !listNumber(run, gap)) {
        if (gap !== "") run.groups.push([]);
        run.groups[run.groups.length - 1].push(u);
        run.units.push(u);
      } else {
        run = { units: [u], groups: [[u]] };
        runs.push(run);
      }
    }
    return runs;
  }

  const spanText = (text, groups) => text.slice(groups[0][0].start, groups[groups.length - 1].at(-1).end);
  const digitsOf = (groups) =>
    groups
      .flat()
      .map((u) => u.digits)
      .join("");
  const hasWord = (groups) => groups.flat().some((u) => u.isWord);
  const sizesOf = (groups) => groups.map((g) => g.reduce((n, u) => n + u.digits.length, 0)).join(",");

  // North American numbering: area code and exchange can't start with 0 or 1.
  const NANP10 = /^[2-9]\d{2}[2-9]\d{6}$/;
  // Toll-free numbers belong to businesses and help lines ("poison control at 1-800-222-1222"), never a person.
  const TOLL_FREE = /^1?8(?:00|33|44|55|66|77|88)/;
  // Spain's free numbers are 9 digits: 900 and 800.
  const tollFree = (d) =>
    ((d.length === 10 || d.length === 11) && TOLL_FREE.test(d.length === 11 ? d : "1" + d)) ||
    (d.length === 9 && /^[89]00/.test(d));
  function isPhone(groups, wholeRun) {
    const d = digitsOf(groups);
    // Spelled-out numbers must be the whole run, so "one two … nine" (a 9-digit SSN) isn't read as a phone.
    if (hasWord(groups) && !wholeRun) return false;
    if (d.length === 10) return NANP10.test(d);
    if (d.length === 11) return d[0] === "1" && NANP10.test(d.slice(1));
    // 7 digits (local number) only when clearly phone-shaped; plain "5555636" is too often an amount or ID.
    if (d.length === 7) return /^[2-9]/.test(d) && (hasWord(groups) || sizesOf(groups) === "3,4");
    return false;
  }

  // International: "+44 20 7946 0958", "0044 …", "plus four four …". The prefix is required,
  // so ordinary long numbers stay quiet. E.164 allows at most 15 digits after it.
  function internationalPhone(text, run) {
    const start = run.units[0].start;
    const plus = /(?:\+|\bplus\s+)$/i.exec(text.slice(Math.max(0, start - 6), start));
    let d = digitsOf(run.groups);
    if (!plus && !/^00[1-9]/.test(d)) return null;
    if (!plus) d = d.slice(2);
    if (d[0] === "1" || d[0] === "0") return null; // +1 is North American: handled below
    // Longest prefix of groups that stays within 15 digits.
    let end = 0,
      n = 0;
    for (let k = 0; k < run.groups.length; k++) {
      n += digitsOf([run.groups[k]]).length;
      if (n - (plus ? 0 : 2) > 15) break;
      end = k;
    }
    const digits = digitsOf(run.groups.slice(0, end + 1)).length - (plus ? 0 : 2);
    if (digits < 8) return null;
    return text.slice(start - (plus ? plus[0].length : 0), run.groups[end].at(-1).end);
  }

  // A phone taken out of a longer run of digits must be phone-shaped, so a list like
  // "1, 2, 3, 5, 8, 13, 21, 34" isn't read as one; a whole run may be grouped any way.
  const PHONE_SHAPES = new Set(["10", "11", "3,3,4", "1,3,3,4", "3,4", "3,7"]);
  // Digits glued to letters belong to a bigger token (a hash, UUID or model number).
  const glued = (text, span) => {
    const first = span[0][0];
    const last = span.at(-1).at(-1);
    // An extension right after the number ("937-555-5636x12") doesn't make it part of a word.
    const extension = /^x\d{1,5}\b/i.test(text.slice(last.end, last.end + 7));
    return (
      (first.kind === "digit" && isLetter(text[first.start - 1])) ||
      (last.kind === "digit" && isLetter(text[last.end]) && !extension)
    );
  };

  // A phone word just before a number ("llámame al …", "my cell is …"): then 9 digits are a phone
  // number (Spain, much of Europe and Latin America), not a US Social Security number (D64).
  const PHONE_CONTEXT =
    /(?:\b(?:call|text|phone|cell|mobile|whatsapp|tel)|ll[aá]mame|llamar|llama|tel[eé]fono|m[oó]vil|celular|fijo|n[uú]mero)\b[^\d\n]{0,20}$/i;
  // An SSN label right before the number ("ssn: 219099999", "<ssn>219-09-9999", "social security #…") beats a
  // phone word further back ("<phone>…</phone><ssn>…").
  const SSN_LABEL =
    /\b(?:ssn|ss\s*#|soc(?:ial)?\.?\s+sec(?:urity|\.)?(?:[\s_]+(?:number|no\.?|#))?|social(?:[\s_]+security)?(?:[\s_]+(?:number|no\.?|#))?)["']?\s*(?:is\s*)?[:=>#-]?\s*["']?$/i;
  const ssnLabelBefore = (text, run) =>
    SSN_LABEL.test(text.slice(Math.max(0, run.units[0].start - 30), run.units[0].start));
  const phoneContextBefore = (text, run) =>
    !ssnLabelBefore(text, run) &&
    PHONE_CONTEXT.test(text.slice(Math.max(0, run.units[0].start - 30), run.units[0].start));

  // UK and Australian numbers written the local way: mobiles "07700 900123" / "0412 345 678", UK landlines
  // "020 7946 0958". Grouped like a phone, or right after a phone word ("ring me on 07700900123"); a bare
  // "order 07123456789" isn't one.
  const LOCAL_PHONE = /^(?:07\d{9}|04\d{8}|0[12]\d{8,9})$/;
  const LOCAL_SHAPES = new Set(["5,6", "5,3,3", "4,3,3", "4,3,4", "3,4,4", "4,6", "2,4,4", "4,4,3"]);
  const LOCAL_CONTEXT = /\b(?:call|ring|text|phone|mobile|cell|whatsapp|tel|number)\b[^\d\n]{0,20}$/i;
  function localPhone(text, run) {
    if (!LOCAL_PHONE.test(digitsOf(run.groups))) return false;
    const start = run.units[0].start;
    return LOCAL_SHAPES.has(sizesOf(run.groups)) || LOCAL_CONTEXT.test(text.slice(Math.max(0, start - 30), start));
  }

  // A number labelled as something else isn't a phone: "Order #445-2231987", "meeting ID is 845 2931 7710",
  // "ticket 555-1234", "invoice no. 937-555-0199", "request id 004940008510" (a log's IDs read like "00 49 …").
  // The label may be a few words back ("El ID de la reunión de Zoom es …"); a phone word after it wins
  // ("about the order, call me at …").
  const OTHER_NUMBER_BEFORE =
    /(?:#\s*$|(?<![\p{L}])(?:order|invoice|ticket|case|ref(?:erence)?|tracking|confirmation|booking|reservation|meeting|claim|serial|model|part|sku|po|pedido|factura|referencia|reuni[oó]n|reserva|localizador|nhs|medicare|aadhaar|aadhar|tfn|tax\s+file|(?:request|transaction|trace|session|correlation|device)[\s_-]*id)(?![\p{L}])[^\d\n]{0,25}$)/iu;
  const PHONE_WORD =
    /(?<![\p{L}])(?:call|ring|text|phone|mobile|cell|whatsapp|tel|ll[aá]m\p{L}*|tel[eé]fono|m[oó]vil|celular)(?![\p{L}])/iu;
  function labelledAsOther(text, run) {
    const start = run.units[0].start;
    const before = text.slice(Math.max(0, start - 40), start);
    // A phone word anywhere close by wins: "about the order, call me at …", "phone # 9375555636".
    return OTHER_NUMBER_BEFORE.test(before) && !PHONE_WORD.test(before);
  }

  function findPhones(text) {
    const found = [];
    for (const run of numberRuns(text)) {
      if (labelledAsOther(text, run) || tollFree(digitsOf(run.groups))) continue;
      if (localPhone(text, run)) {
        found.push(spanText(text, run.groups));
        continue;
      }
      if (digitsOf(run.groups).length === 9 && phoneContextBefore(text, run)) {
        found.push(spanText(text, run.groups));
        continue;
      }
      // A dotted IPv4 address ("73.162.44.201") has phone-like digits but isn't one.
      const ip = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(spanText(text, run.groups));
      if (ip && ip.slice(1).every((n) => Number(n) <= 255)) continue;
      const intl = internationalPhone(text, run);
      if (intl) {
        found.push(intl);
        continue;
      }
      const g = run.groups;
      for (let s = 0; s < g.length;) {
        let bestEnd = -1;
        let len = 0; // digits in g[s..e], counted as the span grows
        for (let e = s; e < g.length; e++) {
          for (const u of g[e]) len += u.digits.length;
          if (len > 11) break;
          if (len !== 7 && len < 10) continue; // a phone has 7, 10 or 11 digits (isPhone)
          const span = g.slice(s, e + 1);
          // Spelled out, from a list break to a list break counts as whole ("…six three six, two one nine…" is
          // two numbers). Digits keep the stricter rule, so "1, 2, 3, 5, 8, 13" stays a list.
          const wholeRun =
            (s === 0 && e === g.length - 1) ||
            (hasWord(span) &&
              (s === 0 || listBreakAfter(text, g, s - 1)) &&
              (e === g.length - 1 || listBreakAfter(text, g, e)));
          if (!wholeRun && !hasWord(span) && !PHONE_SHAPES.has(sizesOf(span))) continue;
          if (glued(text, span)) continue;
          if (isPhone(span, wholeRun)) bestEnd = e; // keep the longest
        }
        if (bestEnd >= 0) {
          // Include an opening "(" or "+" right before the number, so redaction doesn't leave it behind.
          const first = g[s][0].start;
          const lead = /[(+]/.test(text[first - 1] || "") ? 1 : 0;
          found.push(text.slice(first - lead, g[bestEnd].at(-1).end));
          s = bestEnd + 1;
        } else {
          s++;
        }
      }
    }
    return found;
  }

  // Card numbers in digits (spaces or dashes allowed), or read out in words ("four five three nine…"),
  // checked with the Luhn sum. A spelled-out one must start like a card (3-6) and be the whole run.
  // A 13-digit number starting 978 or 979 is a book's ISBN (no card network uses that prefix); about one in ten
  // passes Luhn anyway.
  const CARD_RE = /(?<![A-Z]{2}\d\d ?)\b(?:\d[ -]?){12,18}\d\b/g;
  const isIsbn13 = (candidate) => /^97[89]\d{10}$/.test(candidate.replace(/\D/g, ""));
  function findCards(text) {
    const found = [...text.matchAll(CARD_RE)].map((m) => m[0]).filter((c) => luhn(c) && !isIsbn13(c));
    for (const run of numberRuns(text)) {
      if (!hasWord(run.groups)) continue;
      const d = digitsOf(run.groups);
      if (/^[3-6]/.test(d) && luhn(d)) found.push(spanText(text, run.groups));
    }
    return found;
  }

  // An SSN written in digits inside a longer list ("937-555-5636, 219-09-9999"): a 3-2-4 group set off by a
  // comma or semicolon, with no comma inside. (", " also joins the parts of a spelled-out phone, so the
  // number reader keeps them in one run.)
  // The run cut at its list breaks: [[group, …], …].
  const listBreakAfter = (text, groups, i) =>
    i < groups.length - 1 && /[,;]/.test(text.slice(groups[i].at(-1).end, groups[i + 1][0].start));
  function listChunks(text, groups) {
    const chunks = [[]];
    groups.forEach((g, i) => {
      chunks.at(-1).push(g);
      if (listBreakAfter(text, groups, i)) chunks.push([]);
    });
    return chunks;
  }
  function listedSSNs(text, groups) {
    const chunks = listChunks(text, groups);
    if (chunks.length < 2) return [];
    return chunks
      .filter((c) => {
        const d = digitsOf(c);
        return (
          d.length === 9 &&
          (hasWord(c) || sizesOf(c) === "3,2,4") &&
          /^(?!000|666|9)\d{3}(?!00)\d{2}(?!0000)\d{4}$/.test(d)
        );
      })
      .map((c) => spanText(text, c));
  }

  // A CSV export with an SSN column ("phone,ssn" then "9375555636,219099999"): the header says what the
  // plain 9-digit values are.
  const SSN_COLUMN = /^["']?(?:ssn|social[\s_]*security(?:[\s_]*(?:number|no))?|social)["']?$/i;
  function ssnColumn(text) {
    if (!/ssn|social/i.test(text)) return [];
    const found = [];
    let col = -1;
    for (const line of text.split("\n")) {
      const cells = line.split(",").map((c) => c.trim());
      const header = cells.findIndex((c) => SSN_COLUMN.test(c));
      if (header >= 0) {
        col = header;
        continue;
      }
      if (col < 0 || cells.length <= col) {
        col = cells.length > 1 ? col : -1;
        continue;
      }
      const v = cells[col].replace(/^["']|["']$/g, "");
      if (/^\d{3}-?\d{2}-?\d{4}$/.test(v) && /^(?!000|666|9)\d{3}(?!00)\d{2}(?!0000)\d{4}$/.test(v.replace(/-/g, "")))
        found.push(v);
    }
    return found;
  }

  function findSSNs(text) {
    const found = ssnColumn(text);
    for (const run of numberRuns(text)) {
      const d = digitsOf(run.groups);
      if (d.length !== 9) {
        found.push(...listedSSNs(text, run.groups));
        continue;
      }
      if (phoneContextBefore(text, run)) continue; // "call me at …": a 9-digit phone number, not an SSN
      // Digits need the 3-2-4 shape, unless an SSN label says what they are; spelled-out ones may be written any way.
      if (!hasWord(run.groups) && sizesOf(run.groups) !== "3,2,4" && !ssnLabelBefore(text, run)) continue;
      if (!/^(?!000|666|9)\d{3}(?!00)\d{2}(?!0000)\d{4}$/.test(d)) continue;
      found.push(spanText(text, run.groups));
    }
    return found;
  }

  // ---------- Emails, including spelled-out forms ----------

  // Parts are bounded by their real limits (local part 64, domain 253, label 63): unbounded
  // repeats backtracked quadratically on hostile text like "a-a-a-…" (ReDoS, M5).
  const EMAIL_RE = /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}\b/g;
  const TLDS = "com|net|org|edu|gov|mil|us|uk|ca|au|de|fr|io|co|me|info|biz|app|dev|ai|es|mx|ar|cl|pe";
  // Common personal-email providers: with a plain " at " we require one of these,
  // so "I work at google dot com" isn't flagged, but "bob at gmail dot com" is.
  // Plus the usual misspellings when an address is spelled out ("bob at gmial dot com").
  const PROVIDERS =
    "gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|aol|icloud|me|mac|protonmail|proton|pm|comcast|att|verizon|sbcglobal|bellsouth|charter|cox|earthlink|gmx|zoho|yandex|mail" +
    "|gmial|gmal|gamil|gmaill|gnail|yaho|yahooo|yahho|hotmial|hotmal|hotmai|homail|outlok|outloook|iclod|icoud";
  // "jane dot doe", "jane(dot)doe", Spanish "juan punto perez".
  const LOCAL = String.raw`[A-Za-z0-9._%+-]{1,64}(?:(?:\s+(?:dot|punto)\s+|\s*[(\[{<]\s*(?:dot|punto)\s*[)\]}>]\s*)[A-Za-z0-9._%+-]{1,64}){0,4}`;
  const LABEL = String.raw`[A-Za-z0-9-]{1,63}`;
  const DOT = String.raw`(?:\s*[(\[{<]\s*(?:dot|punto)\s*[)\]}>]\s*|\s+(?:dot|punto)\s+|\s*\.\s*)`;
  // "(at)", "[at]", "{at}", "<at>", or an "@" with spaces around it: always obfuscation.
  const BRACKET_AT = String.raw`(?:\s*[(\[{<]\s*at\s*[)\]}>]\s*|\s+@\s*|\s*@\s+)`;
  const EMAIL_BRACKETED = new RegExp(
    String.raw`\b${LOCAL}${BRACKET_AT}${LABEL}(?:${DOT}${LABEL}){0,4}?${DOT}(?:${TLDS})\b`,
    "gi",
  );
  const EMAIL_WORDED = new RegExp(
    String.raw`\b${LOCAL}\s+(?:at|arroba)\s+(?:${PROVIDERS})(?:${DOT}${LABEL}){0,4}?${DOT}(?:${TLDS})\b`,
    "gi",
  );
  // "my email is janedoe at yahoo": a big provider with no ".com", only right after an email word, so
  // "I work at yahoo" stays quiet.
  const BIG_PROVIDERS = "gmail|googlemail|yahoo|ymail|hotmail|outlook|aol|icloud|protonmail|comcast|gmx|zoho|yandex";
  const EMAIL_NO_TLD = new RegExp(
    String.raw`\b(?:e-?mail|correo)\b[^\n@]{0,20}?\b([A-Za-z0-9][A-Za-z0-9._%+-]{0,63}\s+(?:at|arroba)\s+(?:${BIG_PROVIDERS}))\b(?!\s*(?:[(\[{<]\s*)?(?:dot|punto)\b|\.[A-Za-z]|\s*@)`,
    "gi",
  );

  function findEmails(text) {
    return [
      ...(text.match(EMAIL_RE) || []),
      ...(text.match(EMAIL_BRACKETED) || []),
      ...(text.match(EMAIL_WORDED) || []),
      ...[...text.matchAll(EMAIL_NO_TLD)].map((m) => m[1]),
    ];
  }

  // ---------- Street addresses (US style), digits or spelled out ----------
  // "123 Main St, Springfield, IL 62704", "4500 N. Oak Ridge Road Apt 4B",
  // "one twenty three main street apt 4", "P.O. Box 1234".

  const NUM_WORDS =
    "zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand";
  // At most 8 number words: a real house number is shorter, and an unbounded run made the
  // scan quadratic on long spelled-out text (4 s for 40k characters).
  const HOUSE_NUM = String.raw`(?:\d{1,6}[A-Za-z]?|(?:${NUM_WORDS})(?:[\s-]+(?:${NUM_WORDS}|and)){0,7})`;
  const DIRECTION = String.raw`(?:north|south|east|west|n|s|e|w|ne|nw|se|sw)\.?`;
  const SUFFIX = String.raw`(?:street|st|avenue|ave|av|road|rd|boulevard|blvd|drive|dr|lane|ln|court|ct|way|place|pl|terrace|ter|circle|cir|parkway|pkwy|highway|hwy|trail|trl|square|sq|loop|pike|crescent|cres)\.?`;
  const UNIT = String.raw`(?:,?\s+(?:apt|apartment|unit|suite|ste|#)\.?\s*#?\s*[A-Za-z0-9-]+)?`;
  // One line only ([^\S\n]: spaces, not line breaks): a match that ran on from a ZIP code into the next line
  // hid the address written there.
  const STREET_RE = new RegExp(
    String.raw`\b(?<num>${HOUSE_NUM})[^\S\n]+(?:(?<pre>${DIRECTION})[^\S\n]+)?(?<name>(?:[A-Za-z0-9][\w'.-]*[^\S\n]+){0,3}?[A-Za-z0-9][\w'.-]*)[^\S\n]+(?<suf>${SUFFIX})(?:[^\S\n]+(?<post>${DIRECTION}))?(?![\w])${UNIT}`,
    "gi",
  );
  const PO_BOX_RE = /\b(?:p\.?\s?o\.?\s*box|post\s+office\s+box)\s*#?\s*\d{1,6}\b/gi;
  // Words that make "<number> <word> <street word>" something else: "2 hard drive", "5 minutes drive".
  const NOT_A_STREET = new Set(
    (
      "hard test disk flash usb thumb long right wrong the a an this that my your our his her " +
      "any some no one other same half all each every way lane minute minutes min mins hour hours mile miles km " +
      "day days week weeks year years time times people more less of to in for and or star stars point points step " +
      "steps bed beds bedroom bedrooms room rooms car cars story stories person man men dollar dollars"
    ).split(" "),
  );
  const STATES =
    "AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY";
  // Case-sensitive tail, so "…St, then walk to me" doesn't swallow the rest of the sentence.
  const CITY_STATE_ZIP = new RegExp(
    String.raw`^(?:,?\s*[A-Z][a-z]+(?:\s[A-Z][a-z]+){0,2},?\s+(?:${STATES})\b(?:\s+\d{5}(?:-\d{4})?)?|,?\s+(?:${STATES})\s+\d{5}(?:-\d{4})?|,?\s+\d{5}(?:-\d{4})?\b)`,
  );

  // The same address however it's written → one canonical core for fingerprints:
  // "123 Oak St., Springfield" = "one twenty three oak street apt 4" → "123 oak street".
  const SUFFIX_CANON = {
    st: "street",
    ave: "avenue",
    av: "avenue",
    rd: "road",
    blvd: "boulevard",
    dr: "drive",
    ln: "lane",
    ct: "court",
    pl: "place",
    ter: "terrace",
    cir: "circle",
    pkwy: "parkway",
    hwy: "highway",
    trl: "trail",
    sq: "square",
    cres: "crescent",
  };
  const DIR_CANON = {
    n: "north",
    s: "south",
    e: "east",
    w: "west",
    ne: "northeast",
    nw: "northwest",
    se: "southeast",
    sw: "southwest",
  };
  const canon = (word, map) => {
    const w = word.toLowerCase().replace(/\.$/, "");
    return map[w] || w;
  };

  function addressCore(text) {
    const box = /\b(?:p\.?\s?o\.?\s*box|post\s+office\s+box)\s*#?\s*(\d{1,6})\b/i.exec(text);
    if (box) return `po box ${box[1]}`;
    const m = new RegExp(STREET_RE.source, "i").exec(text);
    if (!m) return spanishAddressCore(text);
    const g = m.groups;
    const num = /^\d/.test(g.num)
      ? g.num.toLowerCase()
      : numberRuns(g.num)
          .flatMap((r) => r.units)
          .map((u) => u.digits)
          .join("");
    return [
      num,
      g.pre && canon(g.pre, DIR_CANON),
      ...g.name.toLowerCase().replace(/\./g, "").split(/\s+/),
      canon(g.suf, SUFFIX_CANON),
      g.post && canon(g.post, DIR_CANON),
    ]
      .filter(Boolean)
      .join(" ");
  }

  // Spanish: street type, a capitalized name (with "de la", "del"…), then the number (D64).
  const ES_STREET_TYPES =
    "[Cc]alle|[Cc]/|[Aa]venida|[Aa]vda\\.?|[Aa]v\\.|[Pp]aseo|[Pp]laza|[Pp]za\\.|[Cc]arrera|[Cc]ra\\.|[Cc]amino|[Rr]onda|[Tt]raves[ií]a|[Cc]alzada|[Bb]ulevar";
  const ES_WORD = "[A-ZÁÉÍÓÚÑ][\\p{L}.'-]*";
  const ES_JOIN = "(?:de(?:l|\\s+la|\\s+los|\\s+las)?\\s+)?";
  const ES_STREET_RE = new RegExp(
    `(?<![\\p{L}])(?:${ES_STREET_TYPES})\\s*${ES_JOIN}${ES_WORD}(?:\\s+${ES_JOIN}${ES_WORD}){0,4},?\\s+(?:(?:n[º°o.]|n[uú]mero|num\\.?)\\s*)?\\d{1,4}(?!\\d)`,
    "gu",
  );
  // Your home as map coordinates ("my home is at 40.712776, -74.005974"): as exact as an address. Only after a
  // home phrase and with 4+ decimals (about 10 m); a landmark's or a restaurant search's coordinates aren't yours.
  const COORD = String.raw`-?\d{1,3}\.\d{4,}°?\s*[NSEW]?`;
  const HOME_COORDINATES = new RegExp(
    String.raw`(?<![\p{L}])(?:my\s+(?:home|house|place|apartment|flat|address)|I\s+live|mi\s+(?:casa|piso|domicilio)|vivo)(?![\p{L}])[^\n\d-]{0,25}(${COORD}\s*,?\s*${COORD})`,
    "giu",
  );
  // Any case, used only right after an address phrase: "vivo en (la)", "mi dirección es", "domicilio:", "mándalo a".
  const ES_STREET_ANY_CASE = new RegExp(ES_STREET_RE.source, "iuy");
  const ES_NOT_A_STREET = new Set(
    "al lado hace que con en muy por para desde hasta cerca frente junto donde esta este esa ese una un y o sin sobre entre tras hacia según como".split(
      " ",
    ),
  );
  const ES_ADDRESS_CONTEXT =
    /(?<![\p{L}])(?:viv(?:o|e|imos|en)\s+en(?:\s+la)?|(?:mi\s+)?(?:direcci[oó]n|domicilio)(?:\s+es|\s*:)|(?:m[aá]nd|env[ií])\p{L}*\s+a)\s+/giu;
  // The same Spanish address however it's written: "C/ Alcalá, 45" = "calle alcalá 45" (vault fingerprints).
  const ES_TYPE_CANON = [
    [/^c(?:alle|\/)$/, "calle"],
    [/^av(?:enida|da\.?|\.)$/, "avenida"],
    [/^p(?:laza|za\.)$/, "plaza"],
    [/^c(?:arrera|ra\.?)$/, "carrera"],
    [/^traves[ií]a$/, "travesía"],
  ];
  function spanishAddressCore(text) {
    const m = new RegExp(ES_STREET_RE.source, "iu").exec(text); // any case: the vault says it's an address
    if (!m) return null;
    const words = m[0]
      .toLowerCase()
      .replace(/,/g, " ")
      .replace(/(?<![\p{L}])(?:n[º°o.]|n[uú]mero|num\.?)(?:\s+|(?=\d))/gu, "")
      .split(/\s+/)
      .filter(Boolean);
    const [type, ...rest] = /^c\/./.test(words[0]) ? ["c/", words[0].slice(2), ...words.slice(1)] : words;
    const canon = (ES_TYPE_CANON.find(([re]) => re.test(type)) || [null, type])[1];
    return [canon, ...rest].join(" ");
  }

  // A house number like 1900-2099 is a year only after a time word ("in 2024 the road…", "by 2030 Main Street
  // will…"); "ship it to 2068 Oak Street" is an address (the 10,000-message oracle run, 2026-09-30).
  const YEAR_BEFORE =
    /(?<!\p{L})(?:in|since|by|from|until|till|before|after|during|of|circa|around|the|en|desde|hasta)\s+$/iu;
  function findAddresses(text) {
    const found = [];
    const withTail = (start, end) => {
      const tail = CITY_STATE_ZIP.exec(text.slice(end));
      found.push(text.slice(start, end + (tail ? tail[0].length : 0)));
    };
    for (const m of text.matchAll(STREET_RE)) {
      const words = m.groups.name.toLowerCase().split(/\s+/);
      if (words.some((w) => NOT_A_STREET.has(w))) continue;
      const yearLike = /^(?:19|20)\d\d$/.test(m[0].split(/\s/)[0]);
      if (yearLike && YEAR_BEFORE.test(text.slice(Math.max(0, m.index - 12), m.index))) continue;
      withTail(m.index, m.index + m[0].length);
    }
    for (const m of text.matchAll(PO_BOX_RE)) withTail(m.index, m.index + m[0].length);
    for (const m of text.matchAll(ES_STREET_RE)) found.push(m[0]);
    for (const m of text.matchAll(HOME_COORDINATES)) found.push(m[1]);
    // All in lowercase ("vivo en calle mayor 5"): only right after an address phrase, where what follows is one.
    for (const m of text.matchAll(ES_ADDRESS_CONTEXT)) {
      ES_STREET_ANY_CASE.lastIndex = m.index + m[0].length;
      const s = ES_STREET_ANY_CASE.exec(text);
      // Everyday words mean a sentence, not a street name ("vivo en la calle de al lado hace 5 años").
      if (
        s &&
        !s[0]
          .toLowerCase()
          .split(/[\s,]+/)
          .some((w) => ES_NOT_A_STREET.has(w))
      )
        found.push(s[0]);
    }
    return found;
  }

  // ---------- Dates of birth (only next to a birth word; a plain date isn't personal) ----------
  // "born 3/14/1948", "DOB: 1948-03-14", "my birthday is March 14th",
  // "born on the fourteenth of March nineteen forty eight".

  const MONTHS =
    "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec";
  const ORDINAL_WORDS =
    "first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth";
  const DAY = String.raw`(?:\d{1,2}(?:st|nd|rd|th)?|(?:twenty|thirty)[\s-]+(?:${ORDINAL_WORDS})|(?:${ORDINAL_WORDS}))`;
  const YEAR = String.raw`(?:\d{4}|'\d{2}|(?:eighteen|nineteen|twenty)(?:[\s-]+(?:oh|${NUM_WORDS})){1,2}|two\s+thousand(?:\s+and)?(?:[\s-]+(?:${NUM_WORDS}))?)`;
  const DATE_RE = new RegExp(
    String.raw`(?:\d{1,2}[/.-]\d{1,2}[/.-](?:\d{4}|\d{2})|\d{4}-\d{1,2}-\d{1,2}` +
      String.raw`|(?:${MONTHS})\.?\s+${DAY}(?:,?\s+${YEAR})?` +
      String.raw`|${DAY}\s+(?:of\s+)?(?:${MONTHS})\.?(?:,?\s+${YEAR})?)(?![\w/])`,
    "iy",
  );
  // Also as a key in data: "dob": "1948-03-14", birth_date = '1948-03-14'.
  const BIRTH_WORDS =
    /\b(?:born|birthday|b-?day|birth[\s_]*date|date[\s_]+of[\s_]+birth|d\.?o\.?b\.?)(?:["']?\s*[:=-]\s*["']?|\s+)(?:(?:is|was|on|the)\s+)*/gi;
  // Spanish: "nací el 14 de marzo de 1962", "fecha de nacimiento: catorce de marzo de mil novecientos
  // sesenta y dos", "mi cumpleaños es el 3 de julio".
  const MESES = "enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre";
  const ES_NUM =
    "cero|uno|un|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|dieciséis|dieciseis|diecisiete|dieciocho|diecinueve|veinte|veintiuno|veintiún|veintidós|veintidos|veintitrés|veintitres|veinticuatro|veinticinco|veintiséis|veintiseis|veintisiete|veintiocho|veintinueve|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa";
  const DIA = String.raw`(?:\d{1,2}|primero|(?:${ES_NUM})(?:\s+y\s+uno)?)`;
  const ANIO = String.raw`(?:\d{4}|(?:mil\s+(?:novecientos|ochocientos)|dos\s+mil)(?:\s+(?:y\s+)?(?:${ES_NUM})){0,3})`;
  const DATE_ES_RE = new RegExp(
    String.raw`(?:\d{1,2}[/.-]\d{1,2}[/.-](?:\d{4}|\d{2})|\d{4}-\d{1,2}-\d{1,2}|${DIA}\s+de\s+(?:${MESES})(?:\s+(?:de|del)\s+${ANIO})?)(?![\p{L}\d/])`,
    "iuy",
  );
  // "nací", "nació", "nacido/a el …", "(fecha de) nacimiento: …", "cumpleaños".
  const BIRTH_WORDS_ES =
    /(?<![\p{L}])(?:nac[ií]|naci[oó]|nacid[oa]s?|(?:fecha\s+de\s+)?nacimiento|cumplea(?:ñ|n)os)(?:\s*:\s*|\s+)(?:(?:es|fue|el|en\s+el)\s+)*/giu;

  function validNumericDate(d) {
    const parts = d.split(/[/.-]/).map(Number);
    if (parts[0] > 31) return parts[1] >= 1 && parts[1] <= 12 && parts[2] >= 1 && parts[2] <= 31; // yyyy-mm-dd
    const [a, b] = parts;
    return a >= 1 && b >= 1 && ((a <= 12 && b <= 31) || (b <= 12 && a <= 31)); // m/d or d/m
  }

  function findBirthDates(text) {
    const found = [];
    for (const m of text.matchAll(BIRTH_WORDS)) {
      DATE_RE.lastIndex = m.index + m[0].length;
      const d = DATE_RE.exec(text);
      if (!d) continue;
      if (/^\d/.test(d[0]) && /^[\d/.-]+$/.test(d[0]) && !validNumericDate(d[0])) continue;
      found.push(d[0]);
    }
    for (const m of text.matchAll(BIRTH_WORDS_ES)) {
      DATE_ES_RE.lastIndex = m.index + m[0].length;
      const d = DATE_ES_RE.exec(text);
      if (!d || (/^[\d/.-]+$/.test(d[0]) && !validNumericDate(d[0]))) continue;
      found.push(d[0]);
    }
    return found;
  }

  // ---------- Bank and ID numbers: the value right after a label ----------
  // "account number is 1234…", "routing: 021000021", "driver's license: D1234567",
  // "passport no. X12345678", "member ID: XYZ123…". Medicare numbers also on their own.

  const CONNECT = String.raw`(?:\s*(?:number|no\.?|num|#|id))?\s*(?:[:=#]|is|was)?\s*`;
  const label = (words, flags = "gi") => new RegExp(String.raw`\b(?:${words})(?![a-z])${CONNECT}`, flags);
  const BANK_LABELS = [label(String.raw`(?:(?:bank|checking|savings)\s+)?(?:account|acct)`)];
  const ROUTING_LABELS = [label(String.raw`routing|aba|rtn`)];
  const LICENSE_LABELS = [label(String.raw`driver'?s?\s+licen[cs]e|driving\s+licen[cs]e`), label("DL", "g")];
  const PASSPORT_LABELS = [label("passport")];
  const INSURANCE_LABELS = [
    label(String.raw`(?:insurance|member|policy|subscriber|medicaid)(?=\s*(?:id|number|no\.?|#))`),
  ];
  const MEDICARE_LABELS = [label("medicare")];
  // Medicare Beneficiary Identifier: 11 characters in a fixed letter/digit layout (no S, L, O, I, B, Z).
  const MBI_L = "[AC-HJKMNP-RT-Y]";
  const MBI_RE = new RegExp(
    String.raw`\b[1-9]${MBI_L}[AC-HJKMNP-RT-Y0-9]\d-?${MBI_L}[AC-HJKMNP-RT-Y0-9]\d-?${MBI_L}{2}\d{2}\b`,
    "g",
  );
  const ALNUM_ID = /[A-Za-z0-9][A-Za-z0-9-]{3,19}/y;

  // A number (digits or number words) that starts exactly where the label ends.
  function numberAfter(labels, text, okDigits) {
    let byStart = null; // run by where it starts, built only once a label is found
    const found = [];
    for (const re of labels) {
      for (const m of text.matchAll(re)) {
        const at = m.index + m[0].length;
        byStart ??= new Map(numberRuns(text).map((r) => [r.units[0].start, r]));
        const run = byStart.get(at);
        if (run && okDigits(digitsOf(run.groups))) found.push(spanText(text, run.groups));
      }
    }
    return found;
  }

  // A letters-and-digits ID right after the label (must contain a digit: "the license is MIT" isn't one).
  function idAfter(labels, text) {
    const found = [];
    for (const re of labels) {
      for (const m of text.matchAll(re)) {
        ALNUM_ID.lastIndex = m.index + m[0].length;
        const v = ALNUM_ID.exec(text)?.[0].replace(/-+$/, "");
        if (v && /\d/.test(v) && (v.match(/\d/g) || []).length >= 4) found.push(v);
      }
    }
    return found;
  }

  // ABA routing checksum: 3·(d1+d4+d7) + 7·(d2+d5+d8) + (d3+d6+d9) ≡ 0 (mod 10).
  function abaValid(d) {
    if (d.length !== 9) return false;
    const n = [...d].map(Number);
    return (3 * (n[0] + n[3] + n[6]) + 7 * (n[1] + n[4] + n[7]) + (n[2] + n[5] + n[8])) % 10 === 0;
  }

  const findBankNumbers = (text) => [
    ...numberAfter(BANK_LABELS, text, (d) => d.length >= 6 && d.length <= 17),
    ...numberAfter(ROUTING_LABELS, text, abaValid),
  ];
  const findMedicare = (text) => [
    ...(text.match(MBI_RE) || []),
    ...idAfter(MEDICARE_LABELS, text),
    ...numberAfter(AU_MEDICARE_LABELS, text, auMedicareValid),
  ];
  const findLicenses = (text) => idAfter(LICENSE_LABELS, text);
  const findPassports = (text) => idAfter(PASSPORT_LABELS, text);
  const findInsuranceIds = (text) => idAfter(INSURANCE_LABELS, text);

  // ---------- International IDs, medical record numbers, your IP (M7) ----------

  // IBAN: country, 2 check digits, 11–30 letters/digits; must pass the mod-97 check.
  const IBAN_RE = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g;
  function ibanValid(raw) {
    const s = raw.replace(/ /g, "");
    if (s.length < 15 || s.length > 34) return false;
    const moved = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
    let rest = 0;
    for (const ch of moved) rest = (rest * 10 + Number(ch)) % 97;
    return rest === 1;
  }
  const findIbans = (text) => (text.match(IBAN_RE) || []).filter(ibanValid);

  // UK National Insurance number (no label needed: the letter pattern is distinctive).
  const NINO_RE = /\b(?!BG|GB|NK|KN|TN|NT|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/g;
  // Canadian Social Insurance Number: 9 digits after a label, Luhn-valid.
  const SIN_LABELS = [/\b(?:SIN|social insurance(?:\s+number)?)(?:\s*(?:#|no\.?|number))?\s*(?:is\s*)?[:#-]?\s*/g];
  // Spain: DNI (8 digits + check letter) and NIE (X/Y/Z + 7 digits + check letter). Mexico: CURP
  // (18 characters with a state code and a check digit). All validated, so ordinary codes stay quiet (D64).
  const DNI_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";
  const DNI_RE = /\b(\d{8})[- ]?([A-HJ-NP-TV-Z])\b/g;
  const NIE_RE = /\b([XYZ])[- ]?(\d{7})[- ]?([A-HJ-NP-TV-Z])\b/g;
  const CURP_RE =
    /\b[A-Z][AEIOUX][A-Z]{2}\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])[HMX](?:AS|BC|BS|CC|CL|CM|CS|CH|DF|DG|GT|GR|HG|JC|MC|MN|MS|NT|NL|OC|PL|QT|QR|SP|SL|SR|TC|TS|TL|VZ|YN|ZS|NE)[B-DF-HJ-NP-TV-Z]{3}[0-9A-Z]\d\b/g;
  const CURP_CHARS = "0123456789ABCDEFGHIJKLMN\u00d1OPQRSTUVWXYZ";
  function curpValid(c) {
    let sum = 0;
    for (let i = 0; i < 17; i++) sum += CURP_CHARS.indexOf(c[i]) * (18 - i);
    return String((10 - (sum % 10)) % 10) === c[17];
  }
  // Mexico's RFC (tax ID: 3-4 letters, a date, 3 characters) and Spain's social security number (12 digits),
  // only after their label: in English, "RFC 7231" is an internet standard.
  const RFC_RE =
    /\bRFC\b(?:\s+(?:es|is))?\s*:?\s*([A-ZÑ&]{3,4}\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])[A-Z0-9]{3})\b/giu;
  const NSS_RE = /(?:\bNSS\b|seguridad\s+social)[^\n\d]{0,20}?(\d{2}[\s/-]?\d{8}[\s/-]?\d{2})(?![\d])/giu;
  // US: an ITIN (the tax number for people without an SSN) is shaped like one but starts with 9 and has its own
  // middle ranges, so it counts on its own. Tax (EIN/TIN), immigration (A-number, green card receipt) and VA file
  // numbers count after their label.
  const ITIN_RE = /\b9\d{2}[- ]?(?:5\d|6[0-5]|7\d|8[0-8]|9[0-2]|9[4-9])[- ]?\d{4}\b/g;
  const US_ID_LABELLED =
    /\b(?:ITIN|EIN|TIN|tax\s*(?:payer\s*)?id(?:entification)?(?:\s+number)?|employer\s+identification\s+number|a-?number|alien\s+(?:registration\s+)?number|uscis\s*(?:number|#)|green\s+card(?:\s+(?:number|receipt))?|va\s+(?:file|claim)\s+number)\s*(?:#|no\.?|number)?\s*(?:is|:|=)?\s*((?:[A-Z]{1,3}[\s-]?)?\d(?:[\d-]{6,12})\d)(?![\d-])/gi;
  const findNationalIds = (text) => [
    ...(text.match(ITIN_RE) || []),
    ...[...text.matchAll(US_ID_LABELLED)].map((m) => m[1]),
    ...[...text.matchAll(RFC_RE)].map((m) => m[1]),
    ...[...text.matchAll(NSS_RE)].map((m) => m[1]),
    ...(text.match(NINO_RE) || []),
    ...numberAfter(SIN_LABELS, text, (d) => d.length === 9 && luhn(d.padStart(13, "0"))),
    ...numberAfter(AADHAAR_LABELS, text, aadhaarValid),
    ...numberAfter(TFN_LABELS, text, tfnValid),
    ...[...text.matchAll(DNI_RE)].filter((m) => DNI_LETTERS[Number(m[1]) % 23] === m[2]).map((m) => m[0]),
    ...[...text.matchAll(NIE_RE)]
      .filter((m) => DNI_LETTERS[Number("XYZ".indexOf(m[1]) + m[2]) % 23] === m[3])
      .map((m) => m[0]),
    ...(text.match(CURP_RE) || []).filter(curpValid),
  ];

  // Medical record / patient numbers after a label; UK NHS numbers (10 digits, mod 11 check).
  const MRN_LABELS = [
    /\b(?:MRN|medical\s+record(?:\s+(?:number|no\.?|#))?|patient\s+(?:id|number|no\.?|#))\s*(?:is\s*)?[:#-]?\s*/gi,
  ];
  const NHS_LABELS = [/\bNHS(?:\s+(?:number|no\.?|#))?\s*(?:is\s*)?[:#-]?\s*/gi];
  function nhsValid(d) {
    if (!/^\d{10}$/.test(d)) return false;
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += Number(d[i]) * (10 - i);
    const check = (11 - (sum % 11)) % 11;
    return check !== 10 && check === Number(d[9]);
  }
  const findMedicalRecords = (text) => [...idAfter(MRN_LABELS, text), ...numberAfter(NHS_LABELS, text, nhsValid)];

  // India's Aadhaar (12 digits, Verhoeff check) and Australia's Tax File Number (9 digits, weighted check),
  // after their label.
  const AADHAAR_LABELS = [/\b(?:aadhaar|aadhar|UIDAI?)(?:\s+(?:card\s+)?(?:number|no\.?|#))?\s*(?:is\s*)?[:#-]?\s*/gi];
  const TFN_LABELS = [/\b(?:TFN|tax\s+file\s+number)\s*(?:is\s*)?[:#-]?\s*/gi];
  const VERHOEFF_D = [
    "0123456789",
    "1234067895",
    "2340178956",
    "3401289567",
    "4012395678",
    "5987604321",
    "6598710432",
    "7659821043",
    "8765932104",
    "9876543210",
  ];
  const VERHOEFF_P = [
    "0123456789",
    "1576283094",
    "5803796142",
    "8916043527",
    "9453126870",
    "4286573901",
    "2793806415",
    "7046913258",
  ];
  function verhoeffValid(d) {
    let c = 0;
    [...d].reverse().forEach((ch, i) => {
      c = Number(VERHOEFF_D[c][Number(VERHOEFF_P[i % 8][Number(ch)])]);
    });
    return c === 0;
  }
  const aadhaarValid = (d) => /^[2-9]\d{11}$/.test(d) && verhoeffValid(d);
  const TFN_WEIGHTS = [1, 4, 3, 7, 5, 8, 6, 9, 10];
  const tfnValid = (d) =>
    /^\d{9}$/.test(d) && [...d].reduce((s, ch, i) => s + Number(ch) * TFN_WEIGHTS[i], 0) % 11 === 0;
  // Australian Medicare card: 10 digits (or 11 with the person's number), first 2-6, check digit 9th.
  const AU_MEDICARE_LABELS = [/\bmedicare(?:\s+card)?(?:\s+(?:number|no\.?|#))?\s*(?:is\s*)?[:#-]?\s*/gi];
  const MEDICARE_WEIGHTS = [1, 3, 7, 9, 1, 3, 7, 9];
  const auMedicareValid = (d) =>
    /^[2-6]\d{9,10}$/.test(d) &&
    [...d.slice(0, 8)].reduce((s, ch, i) => s + Number(ch) * MEDICARE_WEIGHTS[i], 0) % 10 === Number(d[8]);

  // Your public IP, when you say it's yours ("my home IP is 73.162.44.201"); private ranges are internal_ip.
  const MY_IP_RE =
    /\b(?:my|our)\s+(?:home\s+|public\s+|router\s+|wan\s+|external\s+)?ip(?:\s+address)?\s*(?:is|:|=)\s*((?:\d{1,3}\.){3}\d{1,3})\b/gi;
  const findMyIps = (text) =>
    [...text.matchAll(MY_IP_RE)]
      .map((m) => m[1])
      .filter(
        (ip) =>
          ip.split(".").every((n) => Number(n) <= 255) &&
          !/^(?:10|127|0)\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[01])\.|^169\.254\./.test(ip),
      );

  // ---------- Crypto wallets ----------

  // BIP-39 English word list (the official list; sha256 of the newline-joined list 2f5eed53…dbda).
  const BIP39 = new Set(
    `abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve
      acid acoustic acquire across act action actor actress actual adapt add addict address adjust admit adult
      advance advice aerobic affair afford afraid again age agent agree ahead aim air airport aisle alarm album
      alcohol alert alien all alley allow almost alone alpha already also alter always amateur amazing among amount
      amused analyst anchor ancient anger angle angry animal ankle announce annual another answer antenna antique
      anxiety any apart apology appear apple approve april arch arctic area arena argue arm armed armor army around
      arrange arrest arrive arrow art artefact artist artwork ask aspect assault asset assist assume asthma athlete
      atom attack attend attitude attract auction audit august aunt author auto autumn average avocado avoid awake
      aware away awesome awful awkward axis baby bachelor bacon badge bag balance balcony ball bamboo banana banner
      bar barely bargain barrel base basic basket battle beach bean beauty because become beef before begin behave
      behind believe below belt bench benefit best betray better between beyond bicycle bid bike bind biology bird
      birth bitter black blade blame blanket blast bleak bless blind blood blossom blouse blue blur blush board boat
      body boil bomb bone bonus book boost border boring borrow boss bottom bounce box boy bracket brain brand brass
      brave bread breeze brick bridge brief bright bring brisk broccoli broken bronze broom brother brown brush
      bubble buddy budget buffalo build bulb bulk bullet bundle bunker burden burger burst bus business busy butter
      buyer buzz cabbage cabin cable cactus cage cake call calm camera camp can canal cancel candy cannon canoe
      canvas canyon capable capital captain car carbon card cargo carpet carry cart case cash casino castle casual
      cat catalog catch category cattle caught cause caution cave ceiling celery cement census century cereal
      certain chair chalk champion change chaos chapter charge chase chat cheap check cheese chef cherry chest
      chicken chief child chimney choice choose chronic chuckle chunk churn cigar cinnamon circle citizen city civil
      claim clap clarify claw clay clean clerk clever click client cliff climb clinic clip clock clog close cloth
      cloud clown club clump cluster clutch coach coast coconut code coffee coil coin collect color column combine
      come comfort comic common company concert conduct confirm congress connect consider control convince cook cool
      copper copy coral core corn correct cost cotton couch country couple course cousin cover coyote crack cradle
      craft cram crane crash crater crawl crazy cream credit creek crew cricket crime crisp critic crop cross crouch
      crowd crucial cruel cruise crumble crunch crush cry crystal cube culture cup cupboard curious current curtain
      curve cushion custom cute cycle dad damage damp dance danger daring dash daughter dawn day deal debate debris
      decade december decide decline decorate decrease deer defense define defy degree delay deliver demand demise
      denial dentist deny depart depend deposit depth deputy derive describe desert design desk despair destroy
      detail detect develop device devote diagram dial diamond diary dice diesel diet differ digital dignity dilemma
      dinner dinosaur direct dirt disagree discover disease dish dismiss disorder display distance divert divide
      divorce dizzy doctor document dog doll dolphin domain donate donkey donor door dose double dove draft dragon
      drama drastic draw dream dress drift drill drink drip drive drop drum dry duck dumb dune during dust dutch
      duty dwarf dynamic eager eagle early earn earth easily east easy echo ecology economy edge edit educate effort
      egg eight either elbow elder electric elegant element elephant elevator elite else embark embody embrace
      emerge emotion employ empower empty enable enact end endless endorse enemy energy enforce engage engine
      enhance enjoy enlist enough enrich enroll ensure enter entire entry envelope episode equal equip era erase
      erode erosion error erupt escape essay essence estate eternal ethics evidence evil evoke evolve exact example
      excess exchange excite exclude excuse execute exercise exhaust exhibit exile exist exit exotic expand expect
      expire explain expose express extend extra eye eyebrow fabric face faculty fade faint faith fall false fame
      family famous fan fancy fantasy farm fashion fat fatal father fatigue fault favorite feature february federal
      fee feed feel female fence festival fetch fever few fiber fiction field figure file film filter final find
      fine finger finish fire firm first fiscal fish fit fitness fix flag flame flash flat flavor flee flight flip
      float flock floor flower fluid flush fly foam focus fog foil fold follow food foot force forest forget fork
      fortune forum forward fossil foster found fox fragile frame frequent fresh friend fringe frog front frost
      frown frozen fruit fuel fun funny furnace fury future gadget gain galaxy gallery game gap garage garbage
      garden garlic garment gas gasp gate gather gauge gaze general genius genre gentle genuine gesture ghost giant
      gift giggle ginger giraffe girl give glad glance glare glass glide glimpse globe gloom glory glove glow glue
      goat goddess gold good goose gorilla gospel gossip govern gown grab grace grain grant grape grass gravity
      great green grid grief grit grocery group grow grunt guard guess guide guilt guitar gun gym habit hair half
      hammer hamster hand happy harbor hard harsh harvest hat have hawk hazard head health heart heavy hedgehog
      height hello helmet help hen hero hidden high hill hint hip hire history hobby hockey hold hole holiday hollow
      home honey hood hope horn horror horse hospital host hotel hour hover hub huge human humble humor hundred
      hungry hunt hurdle hurry hurt husband hybrid ice icon idea identify idle ignore ill illegal illness image
      imitate immense immune impact impose improve impulse inch include income increase index indicate indoor
      industry infant inflict inform inhale inherit initial inject injury inmate inner innocent input inquiry insane
      insect inside inspire install intact interest into invest invite involve iron island isolate issue item ivory
      jacket jaguar jar jazz jealous jeans jelly jewel job join joke journey joy judge juice jump jungle junior junk
      just kangaroo keen keep ketchup key kick kid kidney kind kingdom kiss kit kitchen kite kitten kiwi knee knife
      knock know lab label labor ladder lady lake lamp language laptop large later latin laugh laundry lava law lawn
      lawsuit layer lazy leader leaf learn leave lecture left leg legal legend leisure lemon lend length lens
      leopard lesson letter level liar liberty library license life lift light like limb limit link lion liquid list
      little live lizard load loan lobster local lock logic lonely long loop lottery loud lounge love loyal lucky
      luggage lumber lunar lunch luxury lyrics machine mad magic magnet maid mail main major make mammal man manage
      mandate mango mansion manual maple marble march margin marine market marriage mask mass master match material
      math matrix matter maximum maze meadow mean measure meat mechanic medal media melody melt member memory
      mention menu mercy merge merit merry mesh message metal method middle midnight milk million mimic mind minimum
      minor minute miracle mirror misery miss mistake mix mixed mixture mobile model modify mom moment monitor
      monkey monster month moon moral more morning mosquito mother motion motor mountain mouse move movie much
      muffin mule multiply muscle museum mushroom music must mutual myself mystery myth naive name napkin narrow
      nasty nation nature near neck need negative neglect neither nephew nerve nest net network neutral never news
      next nice night noble noise nominee noodle normal north nose notable note nothing notice novel now nuclear
      number nurse nut oak obey object oblige obscure observe obtain obvious occur ocean october odor off offer
      office often oil okay old olive olympic omit once one onion online only open opera opinion oppose option
      orange orbit orchard order ordinary organ orient original orphan ostrich other outdoor outer output outside
      oval oven over own owner oxygen oyster ozone pact paddle page pair palace palm panda panel panic panther paper
      parade parent park parrot party pass patch path patient patrol pattern pause pave payment peace peanut pear
      peasant pelican pen penalty pencil people pepper perfect permit person pet phone photo phrase physical piano
      picnic picture piece pig pigeon pill pilot pink pioneer pipe pistol pitch pizza place planet plastic plate
      play please pledge pluck plug plunge poem poet point polar pole police pond pony pool popular portion position
      possible post potato pottery poverty powder power practice praise predict prefer prepare present pretty
      prevent price pride primary print priority prison private prize problem process produce profit program project
      promote proof property prosper protect proud provide public pudding pull pulp pulse pumpkin punch pupil puppy
      purchase purity purpose purse push put puzzle pyramid quality quantum quarter question quick quit quiz quote
      rabbit raccoon race rack radar radio rail rain raise rally ramp ranch random range rapid rare rate rather
      raven raw razor ready real reason rebel rebuild recall receive recipe record recycle reduce reflect reform
      refuse region regret regular reject relax release relief rely remain remember remind remove render renew rent
      reopen repair repeat replace report require rescue resemble resist resource response result retire retreat
      return reunion reveal review reward rhythm rib ribbon rice rich ride ridge rifle right rigid ring riot ripple
      risk ritual rival river road roast robot robust rocket romance roof rookie room rose rotate rough round route
      royal rubber rude rug rule run runway rural sad saddle sadness safe sail salad salmon salon salt salute same
      sample sand satisfy satoshi sauce sausage save say scale scan scare scatter scene scheme school science
      scissors scorpion scout scrap screen script scrub sea search season seat second secret section security seed
      seek segment select sell seminar senior sense sentence series service session settle setup seven shadow shaft
      shallow share shed shell sheriff shield shift shine ship shiver shock shoe shoot shop short shoulder shove
      shrimp shrug shuffle shy sibling sick side siege sight sign silent silk silly silver similar simple since sing
      siren sister situate six size skate sketch ski skill skin skirt skull slab slam sleep slender slice slide
      slight slim slogan slot slow slush small smart smile smoke smooth snack snake snap sniff snow soap soccer
      social sock soda soft solar soldier solid solution solve someone song soon sorry sort soul sound soup source
      south space spare spatial spawn speak special speed spell spend sphere spice spider spike spin spirit split
      spoil sponsor spoon sport spot spray spread spring spy square squeeze squirrel stable stadium staff stage
      stairs stamp stand start state stay steak steel stem step stereo stick still sting stock stomach stone stool
      story stove strategy street strike strong struggle student stuff stumble style subject submit subway success
      such sudden suffer sugar suggest suit summer sun sunny sunset super supply supreme sure surface surge surprise
      surround survey suspect sustain swallow swamp swap swarm swear sweet swift swim swing switch sword symbol
      symptom syrup system table tackle tag tail talent talk tank tape target task taste tattoo taxi teach team tell
      ten tenant tennis tent term test text thank that theme then theory there they thing this thought three thrive
      throw thumb thunder ticket tide tiger tilt timber time tiny tip tired tissue title toast tobacco today toddler
      toe together toilet token tomato tomorrow tone tongue tonight tool tooth top topic topple torch tornado
      tortoise toss total tourist toward tower town toy track trade traffic tragic train transfer trap trash travel
      tray treat tree trend trial tribe trick trigger trim trip trophy trouble truck true truly trumpet trust truth
      try tube tuition tumble tuna tunnel turkey turn turtle twelve twenty twice twin twist two type typical ugly
      umbrella unable unaware uncle uncover under undo unfair unfold unhappy uniform unique unit universe unknown
      unlock until unusual unveil update upgrade uphold upon upper upset urban urge usage use used useful useless
      usual utility vacant vacuum vague valid valley valve van vanish vapor various vast vault vehicle velvet vendor
      venture venue verb verify version very vessel veteran viable vibrant vicious victory video view village
      vintage violin virtual virus visa visit visual vital vivid vocal voice void volcano volume vote voyage wage
      wagon wait walk wall walnut want warfare warm warrior wash wasp waste water wave way wealth weapon wear weasel
      weather web wedding weekend weird welcome west wet whale what wheat wheel when where whip whisper wide width
      wife wild will win window wine wing wink winner winter wire wisdom wise wish witness wolf woman wonder wood
      wool word work world worry worth wrap wreck wrestle wrist write wrong yard year yellow you young youth zebra
      zero zone zoo`
      .trim()
      .split(/\s+/),
  );
  // 12+ list words in a row (numbering, commas and line breaks allowed between): a seed phrase.
  function findSeedPhrases(text) {
    const found = [];
    let run = [];
    let lastEnd = -1;
    // Twelve number words ("one one one one…", a card read out) are a number, not a seed phrase.
    const allNumbers = () => run.every((w) => ALL_WORDS[text.slice(w.start, w.end).toLowerCase()] !== undefined);
    const close = () => {
      if (run.length >= 12 && !allNumbers()) found.push(text.slice(run[0].start, run.at(-1).end));
      run = [];
    };
    for (const m of text.matchAll(/[A-Za-z]+/g)) {
      const w = { start: m.index, end: m.index + m[0].length };
      const gapOk = lastEnd < 0 || /^[\s,;.)\-\d]*$/.test(text.slice(lastEnd, w.start));
      if (!BIP39.has(m[0].toLowerCase()) || !gapOk) close();
      if (BIP39.has(m[0].toLowerCase())) run.push(w);
      lastEnd = w.end;
    }
    close();
    return found;
  }
  // A raw private key (64 hex, or a Bitcoin WIF key) right after "private key" / "wallet key".
  const CRYPTO_KEY_RE =
    /\b(?:private|priv|wallet|secret)\s*key\b[\s:="'-]{0,6}((?:0x)?[0-9a-fA-F]{64}|[5KL][1-9A-HJ-NP-Za-km-z]{50,51})\b/gi;
  const findCryptoSecrets = (text) => [...findSeedPhrases(text), ...[...text.matchAll(CRYPTO_KEY_RE)].map((m) => m[1])];

  // ---------- Developer secrets: connection strings, JWTs, internal addresses ----------

  // scheme://user:password@host… (only when a real-looking password is inside)
  const CONN_RE =
    /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?|mssql|sqlserver|oracle|ftp|sftp|smtp|https?):\/\/[^\s:/@]+:([^\s@/]+)@[^\s"'<>]+/gi;
  const PLACEHOLDER_PASSWORDS = new Set([
    "password",
    "pass",
    "passwd",
    "pwd",
    "secret",
    "xxx",
    "xxxx",
    "changeme",
    "***",
    "****",
  ]);
  function findConnectionStrings(text) {
    return [...text.matchAll(CONN_RE)]
      .filter((m) => !PLACEHOLDER_PASSWORDS.has(m[1].toLowerCase()) && !/^[<{$[%]/.test(m[1]) && !isPlaceholder(m[1]))
      .map((m) => m[0].replace(/[.,;)\]]+$/, ""));
  }

  // header.payload.signature, both JSON parts base64url ("eyJ…").
  const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/g;

  // Private network ranges: 10/8, 172.16/12, 192.168/16. Not part of a longer dotted number (versions).
  const IP_RE = /(?<![\d.])(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}(?![\d.]*\d)/g;
  const findInternalIPs = (text) =>
    (text.match(IP_RE) || []).filter((ip) => ip.split(".").every((o) => Number(o) <= 255));

  // Names on internal-only domains: build-01.corp, printer.local, api.internal.
  const HOST_RE =
    /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){1,8}(?:internal|corp|local|lan|intranet|localdomain|home\.arpa)\b(?![.-]?\w)/gi;

  // ---------- Your vault: things you told Clotr to protect ----------
  // Words and phrases (your name, family names, employer, watch-list terms) are known only
  // by fingerprint (salted hash of the lowercased phrase), so they never sit in storage as
  // text. Account/ID formats like "AB-######" are stored as formats (# digit, @ letter),
  // never an actual number. Phone/email/address entries are value fingerprints, matched
  // in content.js against what the regular patterns find.

  let vault = null; // { salt, words: Map(fp → type), maxWords, shapes: [{ type, re }] }
  let vaultHits = { text: null, hits: [] };

  function shapeToRegExp(shape) {
    const body = [...shape]
      .map((ch) => (ch === "#" ? "\\d" : ch === "@" ? "[A-Za-z]" : ch.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&")))
      .join("");
    return new RegExp(String.raw`(?<![\w-])${body}(?![\w-])`, "gi");
  }

  // entries: the stored vault ([{ kind: "word"|"shape"|"value", type, fp?, words?, shape? }]).
  function setVault(v) {
    vaultHits = { text: null, hits: [] };
    const entries = v?.entries || [];
    const words = entries.filter((e) => e.kind === "word" && e.fp);
    const shapes = entries.filter((e) => e.kind === "shape" && /[#@].*[#@]/.test(e.shape || ""));
    if (!words.length && !shapes.length) {
      vault = null;
      return;
    }
    vault = {
      salt: v.salt,
      words: new Map(words.map((e) => [e.fp, e.type])),
      maxWords: Math.min(4, Math.max(1, ...words.map((e) => e.words || 1))),
      shapes: shapes.map((e) => ({ type: e.type, re: shapeToRegExp(e.shape) })),
    };
  }

  // Every vault hit in the text, computed once per text for all vault categories.
  function vaultMatches(text) {
    if (vaultHits.text === text) return vaultHits.hits;
    const hits = [];
    if (vault.words.size && vault.salt) {
      const fingerprint = globalThis.Clotr.fingerprint; // from detector.js, loaded next
      const words = [...text.matchAll(/[\p{L}\p{N}]+(?:['’._-](?!s\b)[\p{L}\p{N}]+)*/gu)].map((m) => ({
        start: m.index,
        end: m.index + m[0].length,
      }));
      for (let i = 0; i < words.length; i++) {
        for (let n = 1; n <= vault.maxWords && i + n <= words.length; n++) {
          const span = text.slice(words[i].start, words[i + n - 1].end);
          const type =
            vault.words.get(fingerprint(vault.salt, "watch_list", span)) ||
            (/[^\x00-\x7f]/.test(span) && vault.words.get(fingerprint(vault.salt, "watch_list_accented", span))); // saved before 0.9.67
          if (type) hits.push({ type, span });
        }
      }
    }
    for (const { type, re } of vault.shapes) for (const m of text.match(re) || []) hits.push({ type, span: m });
    vaultHits = { text, hits };
    return hits;
  }

  const findVault = (type) => (text) =>
    vault
      ? vaultMatches(text)
          .filter((h) => h.type === type)
          .map((h) => h.span)
      : [];

  // ---------- Passwords and secrets, found by the words around them ----------

  // "password: hunter2", "DB_PASSWORD=…", "\"token\": \"…\"", "PIN: 4821"
  // Also .env-style names around the keyword: DB_PASSWORD=, STRIPE_WEBHOOK_SECRET_KEY=.
  // The name prefix is bounded (at most 4 parts like DB_PROD_): unbounded, it backtracked
  // quadratically on hostile "a-a-a-…" text (ReDoS fuzz caught it in CI).
  const LABELLED_SECRET =
    /\b(?:[A-Za-z0-9]{1,30}[_-]){0,4}(?:password|passwd|pwd|pass|pw|passcode|passphrase|pin|secret|client_secret|token|access_token|auth_token|api[_-]?key|contrase(?:ñ|n)a|clave)(?:_[A-Za-z0-9]+)*["']?\s*[:=]\s*["']?([^\s"',;]+)/gi;
  // HTTP headers in pasted curl commands and code: "Authorization: Bearer …", "Basic …", "Token …".
  const AUTH_HEADER =
    /\b(?:proxy-)?authorization["']?\s*[:=]\s*["']?(?:bearer|basic|token|apikey)\s+([A-Za-z0-9._~+/=-]{12,})/gi;
  // "my password is Fluffy123", "the wifi password is sunflower" (how people write to a person)
  // Also misspelled ("pasword", "passwrod") and said with what it's for ("my password for netflix is …").
  const TOLD_SECRET =
    /\b(?:(?:my|the|our|his|her|their|your)\s+)?(?:wi-?fi\s+|email\s+|bank\s+|computer\s+|phone\s+)?(?:pa?ss?(?:w(?:or|ro|ar)d|owrd|wrd|wd)|pw|pwd|passcode|passphrase|pin(?:\s+(?:number|code))?)(?:\s+(?:for|to|on|at|of)\s+(?:(?:my|the|our|his|her|their|your)\s+)?[A-Za-z\d.'-]+(?:\s+[A-Za-z\d.'-]+)?)?\s+(?:is|was)\s*:?\s*["'“‘]?([^\s"'”’,;!?]+)/gi;
  // Spanish: "mi contraseña es Gato2024!", "la contraseña del wifi es sol-y-luna" (D64).
  const TOLD_SECRET_ES =
    /(?<![\p{L}])(?:(?:mi|la|el|tu|su|nuestra)\s+)?(?:contrase(?:ñ|n)a|clave|pin)(?:\s+(?:del?|de\s+(?:la|mi|tu|su)|para(?:\s+(?:el|la|mi|tu|su))?)\s+[\p{L}\d-]+){0,2}\s+(?:es|era)\s*:?\s*["'“‘]?([^\s"'”’,;!?]+)/giu;
  // Answers to account-recovery questions work like passwords: "my mother's maiden name is Smith",
  // "the answer to my security question is Rover", "el apellido de soltera de mi madre es García".
  const TOLD_ANSWER =
    /\b(?:mother'?s\s+maiden\s+name|maiden\s+name|memorable\s+(?:word|information|answer|phrase)|first\s+pet'?s\s+name|answer\s+to\s+(?:my|the)\s+security\s+question|security\s+(?:question\s+)?answer)(?:\s*\([^()\n]{1,30}\))?\s+(?:is|was)\s*:?\s*["'“‘]?([\p{L}][\p{L}'-]{1,40})/giu;
  const TOLD_ANSWER_ES =
    /(?<![\p{L}])(?:apellido\s+de\s+soltera(?:\s+de\s+mi\s+madre)?|nombre\s+de\s+mi\s+primera\s+mascota|respuesta\s+(?:de|a\s+la\s+pregunta\s+de)\s+seguridad)\s+(?:es|era)\s*:?\s*["'“‘]?([\p{L}][\p{L}'-]{1,40})/giu;
  // "…and the password Summer2024", "pw Fluffy!23": a password word right before a value that looks like one.
  const BARE_SECRET =
    /(?<![\p{L}])(?:pa?ss?(?:w(?:or|ro|ar)d|owrd|wrd|wd)|passcode|pw|pwd|contrase(?:ñ|n)a)\s+["'“‘]?([^\s"'”’,;]{4,64})/giu;
  // "login: jdoe@gmail.com / Fluffy!23": a login shared as a pair.
  const LOGIN_PAIR =
    /\b(?:login|log-?in|sign[- ]?in|credentials|creds)\b[^\n]{0,20}?\s["'“‘]?[^\s/|"']{3,64}\s*[/|]\s*["'“‘]?([^\s"'”’,;/]{4,64})(?![^\s"'”’,;])/gi; // a "/" means a path, not a password
  // Codes that open a home, a card or a phone: "the gate code is 1234", "my ATM pin 4821", "the passcode to my
  // phone is 482913", "the safe combination is 12-34-56". "zip code", "error code" and friends stay quiet.
  const CODE_TOLD =
    /\b(?:(?:gate|alarm|garage|door|lock\s*box|locker|lock|keypad|safe|building|entry|house|atm|debit(?:\s+card)?|credit\s+card|card|phone|iphone|bank)\s+(?:code|combination|combo|passcode|pin)|passcode|combination|pin(?=\s+(?:number|code|#))|my\s+pin)(?:\s+(?:number|code))?(?:\s+(?:to|for|on|of)\s+(?:my|the|our|his|her)\s+[\p{L}-]+)?\s*(?:is|was|:|=)?\s*["'“‘]?(\d{3,10}#?|\d{1,3}(?:-\d{1,3}){2,3}|\d{1,2}(?: \d{1,2}){2,3})(?![\d-]| \d)/giu;
  // Sign-in codes sent by text or email: "the verification code they texted me is 482913", "my one-time code: 552 019",
  // "they asked for the code 739201" (what a scam caller wants). Error codes, zip codes and "sent the code" stay quiet.
  const LOGIN_CODE = new RegExp(
    String.raw`(?<![\p{L}\d])(?:(?:verification|one[- ]time|login|log-?in|sign[- ]?in|two[- ]factor|authentication|auth|access)\s+(?:code|pin|passcode)|(?:otp|2fa|mfa)(?:\s+(?:code|pin))?)(?![\p{L}])[^\n\d]{0,30}?(?:\b(?:is|was)\b)?\s*[:=]?\s*["'“‘]?(?<!(?<![\p{L}])(?:in|since|by|from|of|until|before|after|at|to|about|around|every)\s+)(?<![\p{L}\d])(?!(?:19|20)\d\d(?!\d))(\d{4,8}|\d{3}[\s-]\d{3})(?![\p{L}\d-]|\s\d)|(?<![\p{L}])(?:(?:texted|sent|messaged|emailed|gave)\s+(?:me|us|him|her)\s+(?:(?:the|a|that|this|my)\s+)?|asked\s+(?:me\s+)?for\s+(?:the|my|a|that)\s+)(?:\p{L}+\s+)?code\s*(?:(?:is|was)\s*)?[:=]?\s*["'“‘]?(?<!(?<![\p{L}])(?:in|since|by|from|of|until|before|after|at|to|about|around|every)\s+)(?<![\p{L}\d])(?!(?:19|20)\d\d(?!\d))(\d{4,8}|\d{3}[\s-]\d{3})(?![\p{L}\d-]|\s\d)`,
    "giu",
  );
  // Spanish: "el código de verificación es 482913", "me mandaron un código por SMS: 552019", "me pidieron el código 739201".
  const LOGIN_CODE_ES =
    /(?<![\p{L}\d])(?:(?:c[oó]digo|clave|pin)\s+(?:de\s+(?:verificaci[oó]n|acceso|un\s+solo\s+uso|inicio\s+de\s+sesi[oó]n)|sms|otp)|c[oó]digo\s+que\s+me\s+(?:lleg[oó]|mandaron|enviaron|dieron|pidieron)|(?:me\s+(?:mandaron|enviaron|dieron|pidieron|lleg[oó])|pidieron)\s+(?:el|un|mi|ese|este)\s+c[oó]digo(?:\s+(?:por|de)\s+[\p{L}]+)?)(?![\p{L}])(?:\s+que\s+me\s+(?:lleg[oó]|mandaron|enviaron|dieron|pidieron))?(?:\s+(?:por|de)\s+[\p{L}]+)?\s*(?:\b(?:es|era)\b)?\s*:?\s*["'“‘]?(?<!(?<![\p{L}])(?:en|desde|hasta|de|del|a|al|antes|despu[eé]s|por|para|cada)\s+)(?<![\p{L}\d])(?!(?:19|20)\d\d(?!\d))(\d{4,8}|\d{3}[\s-]\d{3})(?![\p{L}\d-]|\s\d)/giu;
  // A card's security code ("the CVV is 123", "security code on the back is 4821") and remote-access codes
  // ("the AnyDesk code is 123 456 789"): what a fake support call asks for.
  const CARD_CODE =
    /(?<![\p{L}])(?:cvv2?|cvc2?|(?:card\s+)?security\s+code|c[oó]digo\s+de\s+seguridad(?:\s+de\s+(?:la|mi)\s+tarjeta)?)(?:\s+(?:on\s+the\s+back|number))?["']?\s*(?:is|es|:|=)?\s*["']?(\d{3,4})(?![\d/-])/giu;
  // Spanish: "el código de AnyDesk es 123 456 789", "el código del portal es 4821".
  const CODE_TOLD_ES =
    /(?<![\p{L}])(?:c[oó]digo|clave|id|pin)\s+(?:de\s+la|del|de)\s+(?:any\s*desk|team\s*viewer|acceso\s+remoto|puerta|portal|alarma|garaje|caja\s+fuerte|edificio|casa|cajero|tarjeta)\s*(?:es|era|:)?\s*["']?(\d{3}[\s-]?\d{3}[\s-]?\d{3,4}|\d{3,10}#?)(?![\d-])/giu;
  const REMOTE_CODE =
    /\b(?:any\s*desk|team\s*viewer|remote\s+(?:access|support|desktop)|quick\s*assist|ultra\s*viewer|rust\s*desk)(?:\s+(?:id|code|number|address|password|pin))?\s*(?:is|:|=)?\s*["']?(\d{3}[\s-]?\d{3}[\s-]?\d{3,4}|\d{6,10})(?![\d-])/gi;
  // Two-factor backup codes and recovery keys: "backup codes are 1234 5678, 2345 6789", "BitLocker recovery key
  // is 123456-234567-…". The codes after the label, as one list; it must contain a digit ("…is lost" isn't one).
  const RECOVERY_CODES =
    /(?<![\p{L}])(?:(?:backup|recovery|2fa|two[- ]factor|mfa)\s+(?:codes?|keys?)|(?:c[oó]digos?|claves?)\s+de\s+(?:respaldo|recuperaci[oó]n))(?![\p{L}])(?:\s+(?:are|is|was|were|es|son|era|eran))?\s*:?\s*((?:[A-Za-z0-9]{3,8}(?:-[A-Za-z0-9]{3,8}){0,7}(?:\s*[,;]\s*|\s+|$)){1,16})/giu;
  // Session cookies in pasted requests ("Cookie: sessionid=…", "Set-Cookie: SID=…", curl -b connect.sid=…): whoever
  // has one is logged in as you. Only cookies named like a session or login, with a long random value.
  const SESSION_COOKIE =
    /(?<![\w.-])((?:__(?:Secure|Host)-)?(?:next-auth\.session-token|connect\.sid|phpsessid|jsessionid|asp\.net_sessionid|laravel_session|[\w.-]*sess(?:ion)?(?:[_-]?(?:id|token|key))?|sid|ssid|auth(?:[_-]?token)?|access[_-]?token|refresh[_-]?token|remember[_-]?(?:me|token)|login[_-]?token))=([^\s;,"']{16,4096})/gi;
  // "my password is my dog's name Rex2019": when the word right after "is" isn't the password, the first
  // password-looking word (letters with digits or symbols) shortly after is.
  const LATER_SECRET = /(?<![\p{L}\d])(?=[^\s]*\p{L})(?=[^\s]*[\d!@#$%^&*])[^\s"'”’,;]{4,64}/u;
  // A passphrase: 3-6 plain words that end the sentence ("the wifi password is purple monkey dishwasher.").
  // Everyday words ("the", "every", "required", "cada"…) mean it's a sentence about the password instead.
  const PASSPHRASE = /^\s*["'“‘]?(\p{L}{3,12}(?:[\s-]+\p{L}{3,12}){2,5})(?=["'”’]?\s*(?:$|[.!?,;\n]))/u;
  const EVERYDAY_WORDS = new Set(
    (
      "the an this that these those here there what where which who how click link " +
      "and or but to of in on for with at by from is are was were be been it you we they he she my your our " +
      "his her their not no too very so just really can will would should have has had do does did when then than because if all " +
      "any some every since working work letters numbers characters long short hard easy remember change reset yesterday today " +
      "tomorrow morning night login account email required before after again enough now still though anyway " +
      "y o pero de del en con por para es son era fue mi tu su muy también cuando porque todos todas cada"
    ).split(" "),
  );
  // Words that describe a password rather than being one.
  const NOT_A_SECRET = new Set(
    (
      "required incorrect wrong invalid expired weak strong short long too not the a an " +
      "being changed reset forgotten lost correct same different case sensitive saved stored empty blank missing " +
      "needed optional hidden secure safe new old mine yours here there this that what where " +
      "printed written taped stuck kept shown listed fine okay working broken locked " +
      "separate expiring expires expired temporary unique complicated complex simple easy hard personal " +
      "incorrecta correcta segura nueva vieja débil fuerte larga corta mía tuya igual distinta obligatoria la el una muy"
    ).split(" "),
  );

  function findSecrets(text) {
    const found = [];
    // Returns whether `raw` was taken as a secret.
    const add = (raw, needsComplexity, minLength = 4) => {
      const v = raw.replace(/[.)\]}>]+$/, "");
      if (v.length < minLength || v.length > 128 || NOT_A_SECRET.has(v.toLowerCase())) return false;
      if (/^[*•x.#-]+$/i.test(v) || /^[<{$[%(]/.test(v) || isPlaceholder(v)) return false; // masked, template, placeholder
      // Code that reads the secret from somewhere else: process.env.X, os.environ[…], config.x.
      if (
        /^(?:process\.env|os\.environ|os\.getenv|import\.meta\.env|env|config|settings|secrets|vars|ENV|request|req|params|args|form|input|self|this|getpass|prompt)\b[.[(]/.test(
          v,
        )
      )
        return false;
      if (/[[(]$/.test(v)) return false; // code that continues on the next token: request.form['…'], getpass(
      // End-of-sentence punctuation isn't part of a password: "a good password manager?" is a question.
      const core = v.replace(/[?!:]+$/, "");
      if (
        needsComplexity &&
        !(/\d/.test(core) || /[^A-Za-z0-9]/.test(core) || (/[a-z]/.test(core) && /[A-Z]/.test(core)))
      )
        return false;
      // A recognizable key after the label is reported by its own pattern.
      if (PATTERNS.some((p) => p.secret && p.regex && new RegExp(p.regex.source).test(v))) return false;
      found.push(v);
      return true;
    };
    const passphraseAt = (pos) => {
      const p = PASSPHRASE.exec(text.slice(pos, pos + 90));
      const words = p ? p[1].toLowerCase().split(/[\s-]+/) : [];
      // One describing word can be part of a passphrase ("correct horse battery staple"); two make it a description.
      if (!p || words.some((w) => EVERYDAY_WORDS.has(w)) || words.filter((w) => NOT_A_SECRET.has(w)).length > 1)
        return false;
      found.push(p[1]);
      return true;
    };
    const valueStart = (m) => m.index + m[0].length - m[1].length;
    // Told in words: a passphrase, the word after "is", or else the first password-looking word shortly after it.
    const told = (m) => {
      if (passphraseAt(valueStart(m))) return;
      // A PIN is digits: "my pin is loose" is about hardware.
      if (/^(?:(?:my|the|our|his|her|their|your)\s+)?pin\b/i.test(m[0]) && !/\d/.test(m[1])) return;
      if (add(m[1], false)) return;
      const later = LATER_SECRET.exec(text.slice(m.index + m[0].length, m.index + m[0].length + 40));
      if (later) add(later[0], true);
    };
    for (const m of text.matchAll(LABELLED_SECRET)) if (!add(m[1], true)) passphraseAt(valueStart(m));
    for (const m of text.matchAll(AUTH_HEADER)) add(m[1], true);
    for (const m of text.matchAll(TOLD_SECRET)) told(m);
    for (const m of text.matchAll(TOLD_SECRET_ES)) told(m);
    for (const m of text.matchAll(TOLD_ANSWER)) add(m[1], false);
    for (const m of text.matchAll(TOLD_ANSWER_ES)) add(m[1], false);
    for (const m of text.matchAll(BARE_SECRET)) add(m[1], true);
    for (const m of text.matchAll(LOGIN_PAIR)) add(m[1], true);
    for (const m of text.matchAll(CARD_CODE)) add(m[1], false, 3);
    for (const m of text.matchAll(REMOTE_CODE)) add(m[1], false);
    for (const m of text.matchAll(LOGIN_CODE)) add(m[1] ?? m[2], false);
    for (const m of text.matchAll(SESSION_COOKIE)) {
      const v = m[2];
      if (/\d/.test(v) && /[A-Za-z]/.test(v)) add(v, true); // random-looking, not "sessionid=0000000000000000"
    }
    for (const m of text.matchAll(RECOVERY_CODES)) {
      const codes = m[1].replace(/[\s,;]+$/, "");
      if (/\d/.test(codes) && codes.length >= 8) found.push(codes);
    }
    for (const m of text.matchAll(CODE_TOLD_ES)) add(m[1], false);
    for (const m of text.matchAll(LOGIN_CODE_ES)) add(m[1], false);
    for (const m of text.matchAll(CODE_TOLD)) {
      // "1-2-3" is an example; real combinations have 2-digit numbers, keypad codes 4+ digits ("1-9-7-5")
      if (
        /[- ]/.test(m[1]) &&
        !/\d\d/.test(m[1]) &&
        (m[1].split(/[- ]/).length < 4 || "0123456789".includes(m[1].replace(/[- ]/g, "")))
      )
        continue;
      add(m[1], false);
    }
    return [...new Set(found)]; // several ways of saying it can find the same value
  }

  // `group` = the Settings section: "credentials" (keys, passwords), "personal" (info about a person),
  // or "custom" (the user's own watch list).
  const PATTERNS = [
    // --- Credentials (high) ---
    // `secret: true` drops placeholder matches; `validate` adds per-pattern checks.
    {
      id: "private_key",
      group: "credentials",
      name: "Private Key",
      severity: "high",
      regex: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g,
    },
    {
      id: "aws_access_key",
      group: "credentials",
      secret: true,
      name: "AWS Access Key",
      severity: "high",
      regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    },
    {
      id: "github_token",
      group: "credentials",
      secret: true,
      name: "GitHub Token",
      severity: "high",
      regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g,
    },
    {
      id: "stripe_secret_key",
      group: "credentials",
      secret: true,
      name: "Stripe Secret Key",
      severity: "high",
      regex: /\b[sr]k_live_[A-Za-z0-9]{24,}\b/g,
    },
    {
      id: "anthropic_key",
      group: "credentials",
      secret: true,
      name: "Anthropic API Key",
      severity: "high",
      regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
      validate: (m) => looksRandom(m.replace(/^sk-ant-(?:[a-z]+\d+-)?/, "")),
    },
    {
      id: "openai_key",
      group: "credentials",
      secret: true,
      name: "OpenAI API Key",
      severity: "high",
      regex: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}/g,
      validate: (m) => looksRandom(m.replace(/^sk-(?:proj-)?/, "")),
    },
    {
      id: "google_api_key",
      group: "credentials",
      secret: true,
      name: "Google API Key",
      severity: "high",
      regex: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g, // it may end in "-" (no \b after it)
    },
    {
      id: "slack_token",
      group: "credentials",
      secret: true,
      name: "Slack Token",
      severity: "high",
      regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
    },
    // Other services people paste keys for, in one Settings row (M7): Hugging Face, npm, PyPI,
    // GitLab, SendGrid, Twilio, Mailgun, Shopify, DigitalOcean, Telegram and Discord bots, Azure
    // storage/service-bus keys, and Slack/Discord webhook URLs (anyone with the URL can post).
    {
      id: "crypto_secret",
      group: "credentials",
      name: "Crypto Wallet Seed or Key",
      severity: "high",
      find: findCryptoSecrets,
    },
    {
      id: "service_token",
      group: "credentials",
      secret: true,
      name: "Service Access Token",
      severity: "high",
      regex: new RegExp(
        [
          String.raw`\bhf_[A-Za-z0-9]{30,}\b`,
          String.raw`\bnpm_[A-Za-z0-9]{36}\b`,
          String.raw`\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}`,
          String.raw`\bglpat-[A-Za-z0-9_-]{20,}`,
          String.raw`\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b`,
          String.raw`\bSK[0-9a-fA-F]{32}\b`,
          String.raw`\bkey-[0-9a-f]{32}\b`,
          String.raw`\bshp(?:at|ca|pa|ss)_[0-9a-fA-F]{32}\b`,
          String.raw`\bdop_v1_[0-9a-f]{64}\b`,
          String.raw`\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b`,
          String.raw`\b[MN][A-Za-z0-9]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,38}\b`,
          String.raw`\b(?:AccountKey|SharedAccessKey)=[A-Za-z0-9+/]{40,88}={0,2}`,
          String.raw`https://hooks\.slack\.com/(?:services|workflows|triggers)/[A-Za-z0-9/_-]{20,120}`,
          String.raw`https://(?:ptb\.|canary\.)?discord(?:app)?\.com/api/webhooks/\d{5,25}/[A-Za-z0-9_-]{20,100}`,
        ].join("|"),
        "g",
      ),
    },

    {
      id: "connection_string",
      group: "credentials",
      name: "Database/Service Connection String",
      severity: "high",
      find: findConnectionStrings,
    },
    { id: "jwt", group: "credentials", name: "Login Token (JWT)", severity: "high", regex: JWT_RE },
    { id: "internal_ip", group: "credentials", name: "Internal IP Address", severity: "medium", find: findInternalIPs },
    { id: "internal_host", group: "credentials", name: "Internal Hostname", severity: "medium", regex: HOST_RE },
    { id: "password", group: "credentials", name: "Password or Secret", severity: "high", find: findSecrets },

    // --- Personal data ---
    // Phone, SSN and email use find() instead of a single regex, so they also catch
    // spelled-out and mixed forms ("nine three seven…", "9threeseve5…", "bob at gmail dot com").
    { id: "us_ssn", group: "personal", name: "US Social Security Number", severity: "high", find: findSSNs },
    { id: "credit_card", group: "personal", name: "Credit Card Number", severity: "high", find: findCards },
    {
      id: "stripe_publishable_key",
      group: "credentials",
      secret: true,
      name: "Stripe Publishable Key",
      severity: "medium",
      regex: /\bpk_live_[A-Za-z0-9]{24,}\b/g,
    },
    { id: "street_address", group: "personal", name: "Street Address", severity: "medium", find: findAddresses },
    {
      id: "bank_account",
      group: "personal",
      name: "Bank Account or Routing Number",
      severity: "high",
      find: (text) => [...findBankNumbers(text), ...findIbans(text)],
    },
    { id: "national_id", group: "personal", name: "National ID Number", severity: "high", find: findNationalIds },
    {
      id: "medical_record",
      group: "personal",
      name: "Medical Record Number",
      severity: "high",
      find: findMedicalRecords,
    },
    { id: "public_ip", group: "personal", name: "Your IP Address", severity: "medium", find: findMyIps },
    { id: "medicare_id", group: "personal", name: "Medicare Number", severity: "high", find: findMedicare },
    { id: "passport", group: "personal", name: "Passport Number", severity: "high", find: findPassports },
    {
      id: "drivers_license",
      group: "personal",
      name: "Driver's License Number",
      severity: "medium",
      find: findLicenses,
    },
    { id: "insurance_id", group: "personal", name: "Insurance Member ID", severity: "medium", find: findInsuranceIds },
    { id: "date_of_birth", group: "personal", name: "Date of Birth", severity: "medium", find: findBirthDates },
    { id: "phone_number", group: "personal", name: "Phone Number", severity: "medium", find: findPhones },
    { id: "my_name", group: "personal", name: "Your Name", severity: "high", find: findVault("my_name") },
    {
      id: "family_name",
      group: "personal",
      name: "Family Member's Name",
      severity: "high",
      find: findVault("family_name"),
    },
    { id: "employer", group: "personal", name: "Your Employer", severity: "medium", find: findVault("employer") },
    { id: "my_id", group: "personal", name: "Your Account/ID Number", severity: "high", find: findVault("my_id") },
    { id: "watch_list", group: "custom", name: "Watch List Item", severity: "medium", find: findVault("watch_list") },
    { id: "email", group: "personal", name: "Email Address", severity: "low", find: findEmails },
  ];
  // Names in the browser's language (English is the name written above).
  for (const p of PATTERNS) p.name = msg(`type_${p.id}`, p.name);

  globalThis.Clotr = { ...(globalThis.Clotr || {}), PATTERNS, numberRuns, isPlaceholder, setVault, addressCore, msg };
})();
