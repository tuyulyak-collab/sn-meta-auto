/* utils/downloader.js
 * Filename pattern rendering + chrome.downloads.download wrapper.
 * Pattern tokens:
 *   {type}   → "image" | "video"
 *   {index}  → zero-padded 3-digit index (e.g. 001)
 *   {date}   → YYYY-MM-DD
 *   {time}   → HH-MM-SS
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
    return { date: `${yyyy}-${mm}-${dd}`, time: `${hh}-${mi}-${ss}`, ts: String(now.getTime()) };
  }

  function inferExt(url, type) {
    try {
      const u = new URL(url);
      const m = u.pathname.match(/\.([a-zA-Z0-9]{1,5})(?:$|[?#])/);
      if (m) return m[1].toLowerCase();
    } catch (_) { /* ignore */ }
    if (type === "video") return "mp4";
    return "png";
  }

  function sanitize(name) {
    return String(name || "")
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/\s+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 180) || "file";
  }

  function renderFilename(pattern, { type, index, url }) {
    const dp = dateParts();
    const ext = inferExt(url, type);
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
    const trimmed = String(subfolder || "").trim();
    const sub = sanitize(trimmed || "SN_Meta_Auto") || "SN_Meta_Auto";
    return `${sub}/${filename}`;
  }

  function downloadOne({ url, filename, conflictAction = "uniquify" }) {
    return new Promise((resolve, reject) => {
      try {
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

  const api = { pad, dateParts, inferExt, sanitize, renderFilename, buildFullPath, downloadOne };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SNDownloader = api;
})(typeof self !== "undefined" ? self : this);
