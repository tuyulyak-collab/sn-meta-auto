/* content.js
 * Injected on meta.ai pages. Receives commands from background/popup and
 * performs DOM-level operations using helpers from window.SNDom.
 */

(function () {
  if (window.__SN_META_AUTO_CONTENT__) return;
  window.__SN_META_AUTO_CONTENT__ = true;

  const DOM = window.SNDom;
  if (!DOM) {
    console.warn("[SN Meta Auto] SNDom helpers missing.");
    return;
  }

  function log(...args) {
    try { console.debug("[SN Meta Auto]", ...args); } catch (_) {}
  }

  async function handleFillPrompt(msg) {
    await DOM.setPromptText(msg.text || "");
    return { ok: true };
  }

  async function handleClickGenerate(msg) {
    await DOM.clickGenerate(msg.mode || "image");
    return { ok: true };
  }

  async function handleScanMedia() {
    const media = DOM.collectMedia();
    return { ok: true, media };
  }

  async function handleWaitCompletion(msg) {
    const baseline = Array.isArray(msg.baselineUrls) ? msg.baselineUrls : [];
    const timeout = Number(msg.timeoutMs) || 180000;
    try {
      const res = await DOM.waitForCompletion({ timeoutMs: timeout, baselineMediaUrls: baseline });
      return { ok: true, reason: res.reason, payload: res.payload };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  async function handleUploadImage(msg) {
    const input = DOM.findFileInput();
    if (!input) {
      return { ok: false, error: "File input not found. Please upload the image manually, then press Resume." };
    }
    try {
      const file = DOM.dataUrlToFile(msg.dataUrl, msg.filename || "image.png");
      const ok = DOM.setFilesOnInput(input, [file]);
      if (!ok) throw new Error("setFilesOnInput rejected");
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  // Service workers can't resolve page-scoped blob: URLs (and `data:` URLs
  // larger than ~2MB stress chrome.runtime.sendMessage size limits when
  // routed through the SW). The content script lives in the same document
  // as the page, so it CAN fetch blob URLs — we read the blob, turn it
  // into a base64 data URL, and hand it back to the background so the
  // existing chrome.downloads.download pipeline (filename pattern +
  // subfolder) works unchanged.
  async function handleFetchBlobAsDataUrl(msg) {
    const url = String((msg && msg.url) || "");
    if (!url) return { ok: false, error: "missing url" };
    try {
      const res = await fetch(url);
      if (!res.ok) return { ok: false, error: `fetch failed: HTTP ${res.status}` };
      const blob = await res.blob();
      if (!blob || !blob.size) {
        // MediaSource-backed blob URLs (HLS / MSE streams) typically yield
        // a zero-byte response here. The caller will surface this so the
        // user sees a clear "this preview is a stream, not a file" reason.
        return { ok: false, error: "Blob is empty (likely a MediaSource stream — not a downloadable file)." };
      }
      const dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onerror = () => reject(new Error("FileReader failed"));
        fr.onload = () => resolve(String(fr.result || ""));
        fr.readAsDataURL(blob);
      });
      return {
        ok: true,
        dataUrl,
        mimeType: blob.type || "",
        size: blob.size,
      };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  async function handlePing() {
    return {
      ok: true,
      url: location.href,
      title: document.title,
      hasPromptInput: !!DOM.findPromptInput(),
    };
  }

  const HANDLERS = {
    PING: handlePing,
    FILL_PROMPT: handleFillPrompt,
    CLICK_GENERATE: handleClickGenerate,
    SCAN_MEDIA: handleScanMedia,
    WAIT_COMPLETION: handleWaitCompletion,
    UPLOAD_IMAGE: handleUploadImage,
    FETCH_BLOB_AS_DATA_URL: handleFetchBlobAsDataUrl,
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type || !HANDLERS[msg.type]) return false;
    log("recv", msg.type);
    Promise.resolve()
      .then(() => HANDLERS[msg.type](msg))
      .then((res) => sendResponse(res))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true; // async
  });

  log("content script ready");
})();
