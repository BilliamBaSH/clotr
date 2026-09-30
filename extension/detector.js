// Clotr — detector: runs the patterns from patterns.js
// (loaded first), decides the response for each hit, and fingerprints values.
// Classic script (content scripts can't use modules): shares via globalThis.Clotr.
(() => {
  "use strict";

  const { PATTERNS, numberRuns, isPlaceholder, addressCore } = globalThis.Clotr;

  const SEVERITY_RANK = { high: 3, medium: 2, low: 1 };

  // ---------- Text as copied from web pages, documents and chat apps (M8) ----------
  // Invisible characters, exotic spaces and dashes, full-width and other-script digits must
  // not hide a leak. The patterns see a cleaned copy; `start`/`end` map each cleaned
  // character back to the original, so a match is reported as the original text (and
  // Hide it removes the invisible characters too). Look-alike letters from other
  // alphabets are left alone: mapping them would mangle real Russian or Greek text (D51).
  const INVISIBLE =
    // eslint-disable-next-line no-misleading-character-class -- each invisible mark is matched on its own, on purpose
    /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0]/;
  const SPACE = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/;
  const DASH = /[\u2010-\u2015\u2212\u2e3a\u2e3b\ufe58\ufe63\uff0d]/;
  const ASCII = /^[\x20-\x7e]+$/;
  const DIGIT = /\p{Nd}/u;

  function digitValue(cp) {
    let zero = cp; // start of this run of decimal digits (runs are 0–9, 0–9, … in order)
    while (zero > 0 && DIGIT.test(String.fromCodePoint(zero - 1))) zero--;
    return String((cp - zero) % 10);
  }

  function cleanText(text) {
    // Plain ASCII without a URL-encoded "@" (ann%40gmail.com in a pasted link): nothing to do.
    if (!/[^\x00-\x7f]|%40/i.test(text)) return { clean: text, start: null, end: null };
    let clean = "";
    const start = [];
    const end = [];
    for (let i = 0; i < text.length;) {
      const cp = text.codePointAt(i);
      const ch = String.fromCodePoint(cp);
      let next = i + ch.length;
      let out = ch;
      if (ch === "%" && text.slice(i + 1, i + 3) === "40") {
        out = "@";
        next = i + 3;
      } else if (cp >= 0x80) {
        if (INVISIBLE.test(ch)) out = "";
        else if (SPACE.test(ch)) out = " ";
        else if (DASH.test(ch)) out = "-";
        else if (DIGIT.test(ch)) out = digitValue(cp);
        else {
          const n = ch.normalize("NFKC"); // full-width letters and symbols (＠, Ａ), ligatures
          if (ASCII.test(n)) out = n;
        }
      }
      for (let k = 0; k < out.length; k++) {
        clean += out[k];
        start.push(i);
        end.push(next);
      }
      i = next;
    }
    return { clean, start, end };
  }

  // Every pattern hit in the text: [{ ...pattern, matches: [text, …] }], most severe first.
  // A match lying inside a more severe match (the first 10 digits of an Amex card
  // read as a phone number) is dropped, so each piece of data is reported once.
  // Matches are always pieces of the original text (see cleanText).
  function detect(text) {
    const { clean, start, end } = cleanText(text);
    const results = [];
    for (const pattern of PATTERNS) {
      const raw = pattern.find ? pattern.find(clean) : clean.match(pattern.regex) || [];
      const matches = [...new Set(raw)].filter(
        (m) => (!pattern.validate || pattern.validate(m)) && !(pattern.secret && isPlaceholder(m)),
      );
      if (matches.length) results.push({ ...pattern, matches });
    }
    results.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);

    // A match inside a more severe one is reported once, as the more severe kind (a phone inside
    // a card number). Only longer strings can contain a match, so each kind's matches are kept
    // longest first and the search stops at the first one that isn't longer: a paste with
    // thousands of details isn't compared pair by pair.
    const kept = [];
    for (const r of results) {
      const stricter = kept.filter((k) => SEVERITY_RANK[k.severity] > SEVERITY_RANK[r.severity]);
      const inside = (m) =>
        stricter.some((k) => {
          for (const km of k.longestFirst) {
            if (km.length <= m.length) return false;
            if (km.includes(m)) return true;
          }
          return false;
        });
      const matches = r.matches.filter((m) => !inside(m));
      if (matches.length) kept.push({ ...r, matches, longestFirst: [...matches].sort((a, b) => b.length - a.length) });
    }
    for (const k of kept) delete k.longestFirst;
    if (!start) return kept;
    // Back to the original text: every occurrence of each cleaned match.
    const original = (m) => {
      const out = new Set();
      for (let at = clean.indexOf(m); at >= 0 && m; at = clean.indexOf(m, at + 1)) {
        out.add(text.slice(start[at], end[at + m.length - 1]));
      }
      return out.size ? [...out] : [m];
    };
    return kept.map((r) => ({ ...r, matches: [...new Set(r.matches.flatMap(original))] }));
  }

  // ---------- PDF attachments: where the streams are (M8) ----------
  // Linear and bounded, because the file is attacker-controlled: each "stream" keyword looks
  // back at most 4 KB for its dictionary, and at most 5,000 keywords are examined.
  function findPdfStreams(raw, max = 400) {
    const out = [];
    let at = 0;
    for (let seen = 0; out.length < max && seen < 5000; seen++) {
      const k = raw.indexOf("stream", at);
      if (k < 0) break;
      at = k + 6;
      if (raw.startsWith("end", k - 3)) continue; // "endstream"
      let s = k + 6;
      if (raw[s] === "\r") s++;
      if (raw[s] !== "\n") continue;
      s++;
      let e = k - 1;
      while (e > 0 && k - e < 64 && (raw[e] === " " || raw[e] === "\r" || raw[e] === "\n" || raw[e] === "\t")) e--;
      if (raw[e] !== ">" || raw[e - 1] !== ">") continue;
      let depth = 0;
      let dictStart = -1;
      for (let i = e, lo = Math.max(1, e - 4096); i >= lo;) {
        if (raw[i] === ">" && raw[i - 1] === ">") {
          depth++;
          i -= 2;
          continue;
        }
        if (raw[i] === "<" && raw[i - 1] === "<") {
          depth--;
          i -= 2;
          if (depth === 0) {
            dictStart = i + 1;
            break;
          }
          continue;
        }
        i--;
      }
      if (dictStart < 0) continue;
      out.push({ dict: raw.slice(dictStart + 2, e - 1), start: s });
    }
    return out;
  }

  // Text from PDF page streams (already unpacked): text-showing operators (Tj, TJ, ', ")
  // through the fonts' ToUnicode maps. Every repeat is bounded and blocks are found with
  // indexOf, so hostile files can't make it crawl.
  const hexToString = (hex) => {
    let s = "";
    for (let i = 0; i + 4 <= hex.length; i += 4) s += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    return s || String.fromCharCode(parseInt(hex || "20", 16));
  };
  function blocks(text, open, close, max = 200) {
    const out = [];
    for (let at = 0; out.length < max;) {
      const a = text.indexOf(open, at);
      if (a < 0) break;
      const b = text.indexOf(close, a + open.length);
      if (b < 0) break;
      out.push(text.slice(a + open.length, b));
      at = b + close.length;
    }
    return out;
  }
  function readCMap(text, map) {
    for (const block of blocks(text, "beginbfchar", "endbfchar")) {
      for (const m of block.matchAll(/<([0-9a-fA-F]{1,8})>\s{0,20}<([0-9a-fA-F]{1,64})>/g))
        map.set(m[1].toLowerCase(), hexToString(m[2]));
    }
    for (const block of blocks(text, "beginbfrange", "endbfrange")) {
      for (const m of block.matchAll(
        /<([0-9a-fA-F]{1,8})>\s{0,20}<([0-9a-fA-F]{1,8})>\s{0,20}(?:<([0-9a-fA-F]{1,64})>|\[([^\]]{0,20000})\])/g,
      )) {
        const lo = parseInt(m[1], 16);
        const hi = Math.min(parseInt(m[2], 16), lo + 5000);
        const width = m[1].length;
        const list = m[4] ? [...m[4].matchAll(/<([0-9a-fA-F]{1,64})>/g)].map((x) => hexToString(x[1])) : null;
        for (let c = lo; c <= hi; c++) {
          map.set(
            c.toString(16).padStart(width, "0").toLowerCase(),
            list ? (list[c - lo] ?? "") : String.fromCharCode(parseInt(m[3], 16) + (c - lo)),
          );
        }
      }
    }
  }
  const ESCAPES = { n: " ", r: " ", t: " ", b: "", f: "", "(": "(", ")": ")", "\\": "\\" };
  const pdfString = (s) =>
    s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (x, e) =>
      /[0-7]/.test(e[0]) ? String.fromCharCode(parseInt(e, 8)) : ESCAPES[e],
    );
  function showText(content, cmap) {
    const hex = (h) => {
      h = h.replace(/\s+/g, "").toLowerCase();
      if (cmap.size) {
        let s = "";
        for (let i = 0; i < h.length; i += 4) s += cmap.get(h.slice(i, i + 4)) ?? cmap.get(h.slice(i, i + 2)) ?? "";
        if (s) return s;
      }
      let s = "";
      for (let i = 0; i + 2 <= h.length; i += 2) s += String.fromCharCode(parseInt(h.slice(i, i + 2), 16));
      return s;
    };
    // A hand-written scanner: when a string or hex block doesn't close, skip the whole window
    // it looked at, so every character is visited a bounded number of times (hostile files).
    let out = "";
    let inArray = false;
    const n = content.length;
    for (let i = 0; i < n;) {
      const c = content[i];
      if (c === "(") {
        let j = i + 1;
        let s = "";
        while (j < n && j - i <= 4096 && content[j] !== ")") {
          if (content[j] === "\\") {
            s += content.slice(j, j + 2);
            j += 2;
          } else s += content[j++];
        }
        if (content[j] === ")") {
          out += pdfString(s);
          i = j + 1;
        } else i = j; // unclosed: skip it
        continue;
      }
      if (c === "<" && content[i + 1] !== "<") {
        let j = i + 1;
        while (j < n && j - i <= 8192 && /[0-9a-fA-F\s]/.test(content[j])) j++;
        if (content[j] === ">") {
          out += hex(content.slice(i + 1, j));
          i = j + 1;
        } else i = Math.max(j, i + 1);
        continue;
      }
      if (c === "[") inArray = true;
      else if (c === "]") inArray = false;
      else if (c === "E" && content[i + 1] === "T") out += " ; ";
      else if (
        c === "T" &&
        "Jj*dDm".includes(content[i + 1] || "") &&
        !inArray &&
        content[i + 1] !== "J" &&
        content[i + 1] !== "j"
      )
        out += " ";
      else if ((c === "'" || c === '"') && !inArray) out += " ";
      i++;
    }
    return out;
  }
  function pdfPageText(streams) {
    const cmap = new Map();
    for (const s of streams) if (s.includes("begincmap")) readCMap(s, cmap);
    return streams
      .filter((s) => !s.includes("begincmap") && /Tj|TJ/.test(s))
      .map((s) => showText(s, cmap))
      .join(" ; ");
  }

  // Office XML (docx/xlsx/pptx/OpenDocument) to text, in one linear pass: attacker-controlled
  // files can't make it crawl (the first regex version took 54 s on 600 KB of "<a <a <a…").
  const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  const BREAK_TAG = /^(?:\/(?:w:p|a:p|text:p|si|row|c)|w:br\/?|w:tab\/?)$/;
  function xmlToText(xml) {
    // Plain text is copied in runs (one slice each) and joined once at the end: appending one
    // character at a time grew faster than the input on hostile "&aaaa…" text (CI caught it).
    const parts = [];
    let run = 0; // start of the plain text not yet copied
    const n = xml.length;
    for (let i = 0; i < n;) {
      const c = xml[i];
      if (c === "<") {
        const close = xml.indexOf(">", i + 1);
        if (close < 0) {
          n > run && i > run && parts.push(xml.slice(run, i));
          return parts.join("");
        } // no more tags: the rest isn't document text
        if (i > run) parts.push(xml.slice(run, i));
        if (close - i < 64 && BREAK_TAG.test(xml.slice(i + 1, close).trim())) parts.push("\n");
        i = run = close + 1;
        continue;
      }
      if (c === "&") {
        const near = xml.slice(i + 1, i + 12).indexOf(";"); // entities are short: look no further
        const semi = near < 0 ? -1 : i + 1 + near;
        const name = semi > i && semi - i <= 10 ? xml.slice(i + 1, semi) : "";
        if (name) {
          const code =
            name[0] === "#"
              ? parseInt(
                  name[1] === "x" || name[1] === "X" ? name.slice(2) : name.slice(1),
                  name[1] === "x" || name[1] === "X" ? 16 : 10,
                )
              : NaN;
          const decoded =
            name[0] === "#"
              ? code > 0 && code < 0x110000
                ? String.fromCodePoint(code)
                : ""
              : XML_ENTITIES[name.toLowerCase()];
          if (decoded !== undefined) {
            if (i > run) parts.push(xml.slice(run, i));
            parts.push(decoded);
            i = run = semi + 1;
            continue;
          }
        }
      }
      i++;
    }
    if (n > run) parts.push(xml.slice(run));
    return parts.join("");
  }

  // ---------- What to do about a detection ----------
  // block: modal dialog, sending waits for an answer · warn: corner notice, doesn't block
  // log: counted quietly ("Just counted"). There is no "off": every detection is recorded
  // (DECISIONS D21); a stored "off" from older versions reads as "log".
  // The user can override any pattern (storage key `responses`: { [patternId]: response }).
  const RESPONSES = ["block", "warn", "log"];
  // Nothing blocks until the user chooses Block (design decision D1). Severity stays on the
  // pattern for the dashboard and badge; it no longer changes the default.
  const DEFAULT_RESPONSE = { high: "warn", medium: "warn", low: "warn" };

  function defaultResponse(patternId) {
    const p = PATTERNS.find((x) => x.id === patternId);
    return DEFAULT_RESPONSE[p?.severity] || "warn";
  }

  function responseFor(patternId, overrides) {
    const r = overrides?.[patternId] === "off" ? "log" : overrides?.[patternId];
    return RESPONSES.includes(r) ? r : defaultResponse(patternId);
  }

  // A team policy is a floor, never a ceiling (D115, changing D62): the stricter of two
  // responses wins, so a required "warn" can't downgrade someone's own "block". An
  // unrecognized response is treated as "warn" (the safe middle) rather than rejected.
  function stricter(a, b) {
    const rank = (r) => (r === "block" ? 0 : r === "log" ? 2 : 1);
    return rank(a) <= rank(b) ? (RESPONSES.includes(a) ? a : "warn") : RESPONSES.includes(b) ? b : "warn";
  }

  // ---------- Fingerprints (salted, one-way; the value itself is never stored) ----------

  // Misspelled big providers (as in patterns.js), so a typo'd address still matches your own.
  const PROVIDER_TYPOS = {
    gmial: "gmail",
    gmal: "gmail",
    gamil: "gmail",
    gmaill: "gmail",
    gnail: "gmail",
    yaho: "yahoo",
    yahooo: "yahoo",
    yahho: "yahoo",
    hotmial: "hotmail",
    hotmal: "hotmail",
    hotmai: "hotmail",
    homail: "hotmail",
    outlok: "outlook",
    outloook: "outlook",
    iclod: "icloud",
    icoud: "icloud",
  };

  // Same value however it's written: "(937) 555-5636" = "nine three seven…",
  // "Bob@Gmail.com" = "bob at gmail dot com".
  function normalize(patternId, raw) {
    const match = cleanText(raw).clean; // invisible characters and look-alike digits don't change a fingerprint
    if (patternId === "phone_number" || patternId === "us_ssn" || patternId === "credit_card") {
      // "+44 (0)20…" = "+44 20…": the bracketed trunk 0 is dropped when dialing from abroad.
      const m = patternId === "phone_number" ? match.replace(/\(\s*0\s*\)/g, "") : match;
      let d = numberRuns(m)
        .flatMap((r) => r.units)
        .map((u) => u.digits)
        .join("");
      if (patternId === "phone_number" && d.length === 11 && d[0] === "1") d = d.slice(1);
      if (patternId === "phone_number" && /^00[1-9]/.test(d)) d = d.slice(2); // 0044… = +44…
      return `${patternId}:${d}`;
    }
    if (patternId === "email") {
      const e = match
        .toLowerCase()
        .replace(/\s*[([{<]\s*at\s*[)\]}>]\s*|\s+(?:at|arroba)\s+|\s*@\s*/g, "@")
        .replace(/\s*[([{<]\s*(?:dot|punto)\s*[)\]}>]\s*|\s+(?:dot|punto)\s+|\s*\.\s*/g, ".")
        .replace(/\s+/g, "");
      // "janedoe at yahoo" is janedoe@yahoo.com, and "bob at gmial dot com" is bob@gmail.com.
      const full = /@[a-z0-9-]+$/.test(e) ? `${e}.com` : e;
      return `email:${full.replace(/@([a-z]+)\.com$/, (m, host) => `@${PROVIDER_TYPOS[host] || host}.com`)}`;
    }
    // ID formats match either case ("ab-123456" = "AB-123456"), so their fingerprints do too (D23).
    if (patternId === "my_id") return `my_id:${match.toLowerCase().trim()}`;
    // Your words match with or without accents ("José García" = "Jose Garcia"). Entries saved before 0.9.67
    // kept the accents; "watch_list_accented" reproduces that form so they still match as typed.
    const words = () => match.toLowerCase().replace(/\s+/g, " ").trim();
    if (patternId === "watch_list") return `watch_list:${words().normalize("NFD").replace(/\p{M}/gu, "")}`;
    if (patternId === "watch_list_accented") return `watch_list:${words()}`;
    // The same person or employer however it's typed, for history repeats and the reply check.
    if (patternId === "my_name" || patternId === "family_name" || patternId === "employer") {
      return `${patternId}:${words().normalize("NFD").replace(/\p{M}/gu, "")}`;
    }
    // Addresses too match with or without accents ("Calle Alcalá 45" = "calle alcala 45"); entries saved before
    // 0.9.68 kept the accents, and "street_address_accented" reproduces that form.
    if (patternId === "street_address" || patternId === "street_address_accented") {
      const core = addressCore(match) || words();
      return `street_address:${patternId === "street_address" ? core.normalize("NFD").replace(/\p{M}/gu, "") : core}`;
    }
    return `${patternId}:${match}`;
  }

  // Synchronous SHA-256 (hex), so a send can be checked the instant Enter is pressed.
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
    0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
    0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
    0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
    0xc67178f2,
  ]);
  function sha256(str) {
    const bytes = new TextEncoder().encode(str);
    const len = Math.ceil((bytes.length + 9) / 64) * 64;
    const msg = new Uint8Array(len);
    msg.set(bytes);
    msg[bytes.length] = 0x80;
    const view = new DataView(msg.buffer);
    view.setUint32(len - 8, Math.floor(bytes.length / 0x20000000));
    view.setUint32(len - 4, (bytes.length * 8) >>> 0);
    const h = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    const w = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < len; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i++) {
        const t1 = hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i];
        const t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
        hh = g;
        g = f;
        f = e;
        e = (d + t1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (t1 + t2) >>> 0;
      }
      h[0] += a;
      h[1] += b;
      h[2] += c;
      h[3] += d;
      h[4] += e;
      h[5] += f;
      h[6] += g;
      h[7] += hh;
    }
    return Array.from(h, (x) => x.toString(16).padStart(8, "0")).join("");
  }

  // 16 hex chars of SHA-256(salt + normalized value).
  const fingerprint = (salt, patternId, match) => sha256(salt + normalize(patternId, match)).slice(0, 16);

  // Hide it: every found item replaced by a label naming its kind ("[REDACTED PHONE NUMBER]").
  function redact(text, results) {
    let out = text;
    for (const r of results) {
      for (const m of r.matches) out = out.split(m).join(`[REDACTED ${r.name.toUpperCase()}]`);
    }
    return out;
  }

  // ---------- Generalize instead of remove (pre-release Batch 3) ----------
  // A coarser version of a detail that still helps the conversation: a birth date keeps its month and year
  // ("March 1948"), an address its town ("Springfield"). null when there's nothing safe to keep.
  const MONTHS = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12,
    ene: 1,
    abr: 4,
    ago: 8,
    dic: 12, // Spanish where it differs
  };
  const monthOf = (word) => MONTHS[word.slice(0, 3).toLowerCase()] ?? null;

  function birthMonthYear(match) {
    const iso = /\b(1[89]\d\d|20\d\d)-(\d{1,2})-(\d{1,2})\b/.exec(match);
    if (iso) return { year: +iso[1], month: +iso[2] };
    const num = /\b(\d{1,2})[/.-](\d{1,2})[/.-](1[89]\d\d|20\d\d)\b/.exec(match);
    if (num) {
      const [a, b] = [+num[1], +num[2]];
      // Day and month can only be told apart when one of them is over 12; otherwise keep just the year.
      const month = a > 12 && b <= 12 ? b : b > 12 && a <= 12 ? a : null;
      return { year: +num[3], month };
    }
    const year = /\b(1[89]\d\d|20\d\d)\b/.exec(match);
    if (!year) return null;
    const word = /\b([a-záéíóú]{3,})\b/gi;
    let month = null;
    for (let m; !month && (m = word.exec(match));) month = monthOf(m[1]);
    return { year: +year[1], month };
  }

  function townOf(match) {
    const parts = match.split(",").map((p) => p.trim());
    if (parts.length < 2) return null;
    const town = parts[1]
      .replace(/\s+[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/, "") // UK postcode
      .replace(/\s*\b\d{5}(-\d{4})?$/, "") // US ZIP
      .replace(/\s+[A-Z]{2}$/, "") // US state
      .replace(/^\d{4,5}\s+/, "") // a postal code before the town (Spain, much of Europe)
      .trim();
    return /^[\p{L}][\p{L} .'-]{0,39}$/u.test(town) ? town : null;
  }

  function generalForm(patternId, match, locale = "en-US") {
    if (patternId === "date_of_birth") {
      const d = birthMonthYear(match);
      if (!d) return null;
      if (!d.month || d.month > 12) return String(d.year);
      const date = new Date(Date.UTC(d.year, d.month - 1, 15));
      return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(date);
    }
    if (patternId === "street_address") return townOf(match);
    return null;
  }

  // The items that have a general form, for the choice that offers it.
  function generalForms(results, locale) {
    return results.flatMap((r) =>
      r.matches.map((m) => ({ id: r.id, general: generalForm(r.id, m, locale) })).filter((g) => g.general),
    );
  }

  // Like redact(), but a detail with a general form is swapped for it; the rest is hidden as before.
  function generalize(text, results, locale) {
    let out = text;
    for (const r of results) {
      for (const m of r.matches) {
        out = out.split(m).join(generalForm(r.id, m, locale) ?? `[REDACTED ${r.name.toUpperCase()}]`);
      }
    }
    return out;
  }

  globalThis.Clotr = {
    ...globalThis.Clotr,
    SEVERITY_RANK,
    detect,
    redact,
    generalize,
    generalForms,
    RESPONSES,
    defaultResponse,
    responseFor,
    stricter,
    normalize,
    cleanText,
    findPdfStreams,
    pdfPageText,
    xmlToText,
    sha256,
    fingerprint,
  };
})();
