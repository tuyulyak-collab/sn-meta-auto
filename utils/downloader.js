/* utils/downloader.js
 * Filename pattern rendering + chrome.downloads.download wrapper.
 * Pattern tokens:
 *   {type}   → "image" | "video"
 *   {index}  → zero-padded 3-digit index (e.g. 001)
 *   {date}   → YYYYMMDD
 *   {time}   → HHMMSS
 *   {ts}     → unix ms
 *   {ext}    → file extension (inferred from URL or type)
 */

(function (root) {
  function pad(n, w = 3) {
    const s = String(n);
    return s.length >= w ? s : "0".repeat(w - s.length) + s;
  }

  function dateParts(now = new Date()) {
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const hh = String(now.getHours()).padStart(2, "0");
    const mi = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    return { date: `${yyyy}${mm}${dd}`, time: `${hh}${mi}${ss}`, ts: String(now.getTime()) };
  }

  function mimeToExt(mime) {
    const m = String(mime || "").toLowerCase().split(";")[0].trim();
    const map = {
      "video/mp4": "mp4",
      "video/webm": "webm",
      "video/quicktime": "mov",
      "video/x-m4v": "m4v",
      "image/jpeg": "jpg",
      "image/jpg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
      "image/gif": "gif",
    };
    return map[m] || "";
  }

  function inferExt(url, type, mimeType) {
    const raw = String(url || "");
    if (/^data:/i.test(raw)) {
      const m = /^data:([^;,]+)/i.exec(raw);
      const mt = (m && m[1]) || mimeType || "";
      const guessed = mimeToExt(mt);
      if (guessed) return guessed;
    }
    try {
      const u = new URL(raw);
      const m = u.pathname.match(/\.([a-zA-Z0-9]{1,5})(?:$|[?#])/);
      if (m) return m[1].toLowerCase();
    } catch (_) { /* ignore */ }
    if (mimeType) {
      const guessed = mimeToExt(mimeType);
      if (guessed) return guessed;
    }
    if (type === "video") return "mp4";
    if (type === "image") return "jpg";
    return "bin";
  }

  function sanitize(name) {
    return String(name || "")
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/\s+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 180) || "file";
  }

  function renderFilename(pattern, { type, index, url, mimeType }) {
    const dp = dateParts();
    const ext = inferExt(url, type, mimeType);
    const tokens = {
      "{type}": type || "media",
      "{index}": pad(index || 0, 3),
      "{date}": dp.date,
      "{time}": dp.time,
      "{ts}": dp.ts,
      "{ext}": ext,
    };
    let out = String(pattern || "sn_meta_{type}_{index}_{date}");
    for (const k in tokens) {
      out = out.split(k).join(tokens[k]);
    }
    out = sanitize(out);
    if (!/\.[a-zA-Z0-9]{1,5}$/.test(out)) out += "." + ext;
    return out;
  }

  function buildFullPath(subfolder, filename) {
    const sub = sanitize(subfolder || "SN_Meta_Auto");
    return `${sub}/${filename}`;
  }

  // Returns whether the URL can be handed to chrome.downloads.download as-is.
  //   - http/https/data: downloadable directly from the service worker.
  //   - blob: NOT directly downloadable from the service worker (blob URLs
  //     are document-scoped, the SW can't resolve them) — but our content
  //     script can fetch and convert them to a data URL on our behalf.
  //     Callers should check `needsContentScript` and route through the
  //     content script's FETCH_BLOB_AS_DATA_URL handler before invoking
  //     chrome.downloads.download.
  function canDownloadUrl(url) {
    const raw = String(url || "").trim();
    if (!raw) return { ok: false, scheme: "", needsContentScript: false, reason: "Empty URL." };
    if (/^https?:\/\//i.test(raw)) return { ok: true, scheme: "http", needsContentScript: false, reason: "direct_http" };
    if (/^data:/i.test(raw)) return { ok: true, scheme: "data", needsContentScript: false, reason: "data_url" };
    if (/^blob:/i.test(raw)) return { ok: true, scheme: "blob", needsContentScript: true, reason: "blob_via_content_script" };
    return { ok: false, scheme: "other", needsContentScript: false, reason: "Unsupported media URL scheme." };
  }

  function downloadOne({ url, filename, conflictAction = "uniquify" }) {
    return new Promise((resolve, reject) => {
      try {
        const check = canDownloadUrl(url);
        if (!check.ok) return reject(new Error(check.reason));
        // chrome.downloads.download can't resolve page-scoped blob: URLs
        // from the service worker. Callers must convert them to a data
        // URL first via the content script's FETCH_BLOB_AS_DATA_URL
        // handler (see background.js resolveDownloadUrl).
        if (check.needsContentScript) {
          return reject(new Error("blob: URLs must be fetched via content script before downloading"));
        }
        chrome.downloads.download({ url, filename, conflictAction, saveAs: false }, (id) => {
          const err = chrome.runtime && chrome.runtime.lastError;
          if (err) return reject(new Error(err.message || String(err)));
          if (!id && id !== 0) return reject(new Error("No download id"));
          resolve(id);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  const api = { pad, dateParts, inferExt, mimeToExt, sanitize, renderFilename, buildFullPath, canDownloadUrl, downloadOne };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SNDownloader = api;
})(typeof self !== "undefined" ? self : this);
