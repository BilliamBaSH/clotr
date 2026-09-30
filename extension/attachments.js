// Clotr — reading attached files as text, on this computer (content script).
// Loaded after detector.js (it uses xmlToText, findPdfStreams and pdfPageText) and before
// content.js, which calls Clotr.readAttachment(file) when a file is attached, dropped or pasted.
//
// Everything here reads files that could be hostile, so each format has hard caps: file size,
// text inflated per part and in total, number of parts. Reading stops at a cap; an unreadable
// file gives null (the message is never held for it: fail open, D30).
(() => {
  "use strict";

  const { xmlToText, findPdfStreams, pdfPageText } = globalThis.Clotr;

  const TEXT_FILE =
    /\.(?:txt|csv|tsv|md|json|jsonl|log|env|ini|conf|cfg|toml|ya?ml|xml|sql|js|mjs|ts|py|rb|go|java|cs|php|sh|ps1|html?)$/i;
  const OFFICE_FILE = /\.(?:docx|docm|xlsx|xlsm|pptx|pptm|odt|ods|odp)$/i;
  // The parts of an Office/OpenDocument zip that hold the document's text.
  const OFFICE_PART =
    /^(?:word\/(?:document|header\d*|footer\d*|footnotes|comments)\.xml|xl\/(?:sharedStrings|worksheets\/sheet\d+)\.xml|ppt\/(?:slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml|content\.xml)$/;

  const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;
  const MAX_DOC_BYTES = 20 * 1024 * 1024; // Office and PDF files
  const MAX_PART_TEXT = 2 * 1024 * 1024;
  const MAX_TOTAL_TEXT = 2 * 1024 * 1024; // like plain-text files: checking more would stall the page
  const MAX_OFFICE_PARTS = 60;
  const MAX_PDF_STREAMS = 400;

  const latin1 = new TextDecoder("latin1");
  const utf8 = new TextDecoder();

  // Decompresses with the browser's own DecompressionStream ("deflate-raw" in zips, "deflate" in
  // PDFs), stopping at `cap` bytes (zip bombs) and keeping what was read if the data is corrupt.
  async function inflateCapped(bytes, format, cap) {
    if (typeof DecompressionStream !== "function") return null;
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format)).getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.length;
        if (size >= cap) {
          reader.cancel().catch(() => {});
          break;
        }
      }
    } catch {
      /* truncated or corrupt: keep what was read */
    }
    const out = new Uint8Array(Math.min(size, cap));
    let at = 0;
    for (const c of chunks) {
      const n = Math.min(c.length, out.length - at);
      out.set(c.subarray(0, n), at);
      at += n;
      if (at >= out.length) break;
    }
    return out;
  }

  // Office documents (.docx/.xlsx/.pptx and OpenDocument) are zip files of XML: walk the zip's
  // central directory, unpack only the text parts, and turn their XML into plain text.
  async function officeText(file) {
    if (file.size > MAX_DOC_BYTES) return null;
    const buf = new Uint8Array(await file.arrayBuffer());
    const view = new DataView(buf.buffer);
    let eocd = -1; // end of central directory, within the last 64 KB
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return null;
    const count = Math.min(view.getUint16(eocd + 10, true), MAX_OFFICE_PARTS * 20);
    let p = view.getUint32(eocd + 16, true);
    let total = 0;
    let parts = 0;
    let text = "";
    for (let n = 0; n < count && p + 46 <= buf.length && parts < MAX_OFFICE_PARTS && total < MAX_TOTAL_TEXT; n++) {
      if (view.getUint32(p, true) !== 0x02014b50) break;
      const method = view.getUint16(p + 10, true);
      const csize = view.getUint32(p + 20, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      const local = view.getUint32(p + 42, true);
      const name = utf8.decode(buf.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      if (!OFFICE_PART.test(name) || local + 30 > buf.length || view.getUint32(local, true) !== 0x04034b50) continue;
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const packed = buf.subarray(start, Math.min(buf.length, start + csize));
      const cap = Math.min(MAX_PART_TEXT, MAX_TOTAL_TEXT - total);
      const data =
        method === 0 ? packed.subarray(0, cap) : method === 8 ? await inflateCapped(packed, "deflate-raw", cap) : null;
      if (!data) continue;
      parts++;
      total += data.length;
      text += `${xmlToText(utf8.decode(data))}\n`;
    }
    return text;
  }

  // PDFs: unpack the page streams (FlateDecode, capped), then read the text-showing operators
  // through the fonts' ToUnicode maps (detector.js). Scanned images have no text: nothing to find.
  async function pdfText(file) {
    if (file.size > MAX_DOC_BYTES) return null;
    const buf = new Uint8Array(await file.arrayBuffer());
    const raw = latin1.decode(buf);
    if (!raw.startsWith("%PDF")) return null;
    const streams = [];
    let total = 0;
    let unsized = 0;
    for (const { dict, start } of findPdfStreams(raw)) {
      if (streams.length >= MAX_PDF_STREAMS || total >= MAX_TOTAL_TEXT) break;
      const len = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
      // No /Length: look for "endstream" at most 2 MB ahead, and only for 50 such streams (hostile files).
      if (!len && ++unsized > 50) continue;
      const end = len ? start + Number(len[1]) : raw.slice(start, start + 2 * 1024 * 1024).indexOf("endstream") + start;
      if (end <= start || end > buf.length) continue;
      if (/\/Subtype\s*\/(?:Image|XML)|\/Type\s*\/XRef|\/(?:DCT|JPX|CCITTFax|JBIG2)Decode/.test(dict)) continue;
      let data = buf.subarray(start, end);
      if (/\/FlateDecode/.test(dict))
        data = await inflateCapped(data, "deflate", Math.min(MAX_PART_TEXT, MAX_TOTAL_TEXT - total));
      else if (/\/Filter/.test(dict)) continue; // other encodings: skip
      if (!data) continue;
      total += data.length;
      streams.push(latin1.decode(data));
    }
    return pdfPageText(streams);
  }

  // The text of an attached file, or null if it isn't a kind Clotr reads (or can't be read).
  async function readAttachment(file) {
    try {
      if (OFFICE_FILE.test(file.name)) return await officeText(file);
      if (/\.pdf$/i.test(file.name) || file.type === "application/pdf") return await pdfText(file);
      if (file.size <= MAX_TEXT_FILE_BYTES && (TEXT_FILE.test(file.name) || /^text\/|json/.test(file.type)))
        return await file.text();
    } catch {
      /* unreadable: skip it */
    }
    return null;
  }

  Object.assign(globalThis.Clotr, { readAttachment });
})();
