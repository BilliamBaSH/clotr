// Dev tool (not shipped): does an AI site send what you type BEFORE you press Send?
// Run it as an init script (for example with Puppeteer's evaluateOnNewDocument),
// so it runs before the site's own code. It wraps every way a page can send data (fetch,
// XMLHttpRequest, sendBeacon, WebSocket) and records any outgoing body containing the probe.
//
// How to use (M8, 2026-09-24):
// 1. Load the site with this script injected; focus the chat box.
// 2. Type (don't send): "zqxprobe1234 please call me at 937-555-0147 tomorrow".
// 3. Wait ~10 s, then read `window.__hits` (should be []) and `window.__sends` (requests seen).
// 4. Positive control: press Enter once; the real send must appear in `window.__hits`,
//    which proves the monitor sees this site's traffic.
// Limits: requests from service workers, other frames, or compressed bodies (CompressionStream)
// are not visible here.
(() => {
  const M = /zqxprobe|555-0147|5550147/i;
  window.__sends = 0;
  window.__hits = [];
  const text = (b) => {
    try {
      if (b == null) return "";
      if (typeof b === "string") return b;
      if (b instanceof URLSearchParams) return b.toString();
      if (b instanceof FormData) {
        let s = "";
        for (const [k, v] of b) s += `${k}=${v}&`;
        return s;
      }
      if (b instanceof Blob) return "[blob]";
      if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) return new TextDecoder().decode(b);
      return String(b);
    } catch {
      return "";
    }
  };
  const note = (kind, url, body) => {
    window.__sends++;
    let s = text(body);
    try {
      s += decodeURIComponent(s);
    } catch {
      /* not URL-encoded */
    }
    if (M.test(s) || M.test(String(url))) window.__hits.push(`${kind} ${String(url).slice(0, 120)}`);
  };
  const f = window.fetch;
  window.fetch = function (input, init) {
    note("fetch", (input && input.url) || input, init && init.body);
    return f.apply(this, arguments);
  };
  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) {
    this.__u = u;
    return open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (b) {
    note("xhr", this.__u, b);
    return send.apply(this, arguments);
  };
  const beacon = navigator.sendBeacon.bind(navigator);
  navigator.sendBeacon = function (u, b) {
    note("beacon", u, b);
    return beacon(u, b);
  };
  const ws = WebSocket.prototype.send;
  WebSocket.prototype.send = function (b) {
    note("websocket", this.url, b);
    return ws.apply(this, arguments);
  };
})();
