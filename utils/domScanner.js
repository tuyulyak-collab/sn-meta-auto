/* utils/domScanner.js
 * Loaded first in the content_scripts array so helpers are available to content.js.
 * Exposes window.SNDom with robust findPromptInput, setPromptText,
 * findGenerateButton, scanMedia, and completion detection helpers.
 */

(function (root) {
  const PROMPT_KEYWORDS = [
    "ask meta ai", "message meta ai", "describe", "prompt",
    "what do you want to create", "imagine", "type a message",
  ];

  const GENERIC_SEND_KEYWORDS = ["generate", "create", "send", "submit", "go"];
  const MODE_KEYWORDS = {
    image: ["image", "imagine", "picture", "create image", "generate image"],
    video: ["video", "animate", "create video", "generate video"],
    image_to_video: ["animate", "image to video", "video"],
  };

  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    if (el.closest('[aria-hidden="true"]')) return false;
    return true;
  }

  function isEnabled(el) {
    if (!el) return false;
    if (el.disabled) return false;
    if (el.getAttribute("aria-disabled") === "true") return false;
    return true;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function elText(el) {
    if (!el) return "";
    return (el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.textContent || "").toLowerCase().trim();
  }

  // Walk the DOM including open shadow roots
  function* walkAll(root) {
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (!node) continue;
      yield node;
      if (node.shadowRoot) stack.push(node.shadowRoot);
      const children = node.children ? Array.from(node.children) : [];
      for (const c of children) stack.push(c);
    }
  }

  function queryAllDeep(selector) {
    const out = [];
    try {
      for (const node of walkAll(document)) {
        if (node.querySelectorAll) {
          node.querySelectorAll(selector).forEach((el) => out.push(el));
        }
      }
    } catch (e) {
      // fallback
      document.querySelectorAll(selector).forEach((el) => out.push(el));
    }
    // de-dup
    return Array.from(new Set(out));
  }

  function distance(a, b) {
    try {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const dx = (ra.left + ra.width / 2) - (rb.left + rb.width / 2);
      const dy = (ra.top + ra.height / 2) - (rb.top + rb.height / 2);
      return Math.sqrt(dx * dx + dy * dy);
    } catch (_) {
      return Number.POSITIVE_INFINITY;
    }
  }

  function findPromptInput() {
    // Fast path: Meta AI exposes the live composer as a contenteditable
    // div with data-testid="composer-input" + role="textbox". (Note: a
    // hidden TEXTAREA also exists with the same testid — we explicitly
    // require the visible role=textbox / contenteditable variant.)
    for (const el of queryAllDeep('[data-testid="composer-input"][role="textbox"], [data-testid="composer-input"][contenteditable="true"]')) {
      if (isVisible(el) && isEnabled(el)) return el;
    }

    const candidates = [];

    // textareas
    for (const el of queryAllDeep("textarea")) {
      if (isVisible(el) && isEnabled(el)) candidates.push({ el, score: 3 });
    }

    // contenteditable
    for (const el of queryAllDeep('[contenteditable="true"], [contenteditable=""]')) {
      if (isVisible(el) && isEnabled(el)) candidates.push({ el, score: 4 });
    }

    // role=textbox
    for (const el of queryAllDeep('[role="textbox"]')) {
      if (isVisible(el) && isEnabled(el)) candidates.push({ el, score: 5 });
    }

    // text inputs as weak fallback
    for (const el of queryAllDeep('input[type="text"], input:not([type])')) {
      if (isVisible(el) && isEnabled(el)) candidates.push({ el, score: 1 });
    }

    // boost by matching placeholder/aria-label keywords
    for (const c of candidates) {
      const t = elText(c.el);
      for (const kw of PROMPT_KEYWORDS) {
        if (t.includes(kw)) c.score += 5;
      }
      const rect = c.el.getBoundingClientRect();
      // bias toward wider fields (prompt boxes are usually wide)
      if (rect.width > 280) c.score += 1;
      // bias toward bottom of viewport (chat input usually at bottom)
      if (rect.top > window.innerHeight * 0.55) c.score += 2;
    }

    // if active element is editable, prefer it
    const ae = document.activeElement;
    if (ae && (ae.tagName === "TEXTAREA" || ae.getAttribute("contenteditable") === "true" || ae.getAttribute("role") === "textbox")) {
      candidates.push({ el: ae, score: 10 });
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.length ? candidates[0].el : null;
  }

  function fireInputEvents(el) {
    try {
      el.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
      el.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
      el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "a" }));
      el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "a" }));
    } catch (_) { /* ignore */ }
  }

  async function setPromptText(text) {
    const el = findPromptInput();
    if (!el) throw new Error("Prompt field not found");
    el.focus();
    await sleep(40);

    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      // Set via native setter to bypass React/Framework value tracking
      const proto = el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value");
      if (setter && setter.set) setter.set.call(el, "");
      fireInputEvents(el);
      if (setter && setter.set) setter.set.call(el, String(text));
      fireInputEvents(el);
    } else {
      // contenteditable
      el.innerHTML = "";
      // Use execCommand to play nicely with Lexical/ProseMirror-ish editors
      try {
        const sel = window.getSelection();
        sel && sel.removeAllRanges();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel && sel.addRange(range);
        document.execCommand && document.execCommand("insertText", false, String(text));
      } catch (_) {
        el.textContent = String(text);
      }
      fireInputEvents(el);
    }

    // verification
    const current = (el.value != null ? el.value : el.textContent) || "";
    if (!current.includes(String(text).slice(0, Math.min(12, text.length)))) {
      // last-resort: textContent set
      try {
        el.textContent = String(text);
        fireInputEvents(el);
      } catch (_) { /* ignore */ }
    }
    return el;
  }

  // Find the Meta AI "Send" button (paper-plane icon, aria-label="Send").
  // Disabled until the composer is non-empty; only enabled state is returned.
  function findSendButton() {
    for (const el of queryAllDeep('button[aria-label="Send"], [role="button"][aria-label="Send"]')) {
      if (isVisible(el)) return el;
    }
    return null;
  }

  // Find the mode pill button ("Create image" / "Create video") that
  // toggles the composer into image/video generation mode. Clicking it
  // does NOT generate — it adds a "Create" chip to the composer; the
  // actual submission still requires clicking the Send button.
  function findModePill(mode) {
    const want = (mode === "video" || mode === "image_to_video") ? "create video" : "create image";
    for (const el of queryAllDeep('button, [role="button"]')) {
      if (!isVisible(el) || !isEnabled(el)) continue;
      const t = (el.innerText || "").trim().toLowerCase();
      if (t === want) return el;
    }
    return null;
  }

  // Heuristic: is the requested mode pill already active in the composer?
  // Active mode shows a "Create" chip with a dismiss "×" inside the
  // composer area. We detect by searching the composer's ancestors for
  // the "create" + "×" text combination.
  function isModeActive() {
    const composer = findPromptInput();
    if (!composer) return false;
    let parent = composer;
    for (let i = 0; i < 10 && parent; i++) {
      const t = (parent.innerText || "").toLowerCase();
      if (t.includes("create") && (t.includes("\u00d7") || t.includes(" x "))) return true;
      parent = parent.parentElement;
    }
    return false;
  }

  // Legacy keyword-based scorer kept for fallback / scan-style matches.
  function findGenerateButton(mode) {
    // Prefer the actual Meta AI submission button when the mode pill is
    // already active. clickGenerate handles the 2-step flow itself; this
    // function exists for old call sites and tests.
    const send = findSendButton();
    if (send && isEnabled(send)) return send;

    const promptEl = findPromptInput();
    const modeKws = (MODE_KEYWORDS[mode] || []).slice();
    const keywords = modeKws.concat(GENERIC_SEND_KEYWORDS);

    const out = [];
    for (const el of queryAllDeep('button, [role="button"], input[type="submit"]')) {
      if (!isVisible(el) || !isEnabled(el)) continue;
      const t = elText(el);
      let score = 0;
      for (const kw of keywords) {
        if (t === kw) score += 4;
        else if (t.includes(kw)) score += 2;
      }
      const form = el.closest("form");
      if (form && promptEl && form.contains(promptEl)) score += 2;
      if (promptEl) {
        const d = distance(el, promptEl);
        if (d < 220) score += 3;
        else if (d < 500) score += 1;
      }
      if (score > 0) out.push({ el, score, d: promptEl ? distance(el, promptEl) : 0 });
    }
    out.sort((a, b) => (b.score - a.score) || (a.d - b.d));
    return out.length ? out[0].el : null;
  }

  // 2-step generate flow on Meta AI:
  //   (a) Click the mode pill ("Create image" / "Create video") to put
  //       the composer in that mode — this only adds a "Create" chip,
  //       it does NOT submit the prompt.
  //   (b) Click the Send button (aria-label="Send") to actually submit.
  // For text-only chat (no image/video), step (a) is skipped.
  async function clickGenerate(mode) {
    const wantsMedia = mode === "image" || mode === "video" || mode === "image_to_video";
    if (wantsMedia && !isModeActive()) {
      const pill = findModePill(mode);
      if (pill) {
        pill.click();
        await sleep(300);
      } else {
        // Could not find pill — fall back to legacy heuristic so we don't
        // strand the user on UI variants we haven't seen.
        const legacy = findGenerateButton(mode);
        if (legacy) {
          legacy.click();
          return true;
        }
        throw new Error("Mode pill (Create image/video) not found");
      }
    }

    // Wait briefly for Send to enable (Meta toggles disabled→enabled
    // once the composer has non-empty content + a mode chip).
    let send = findSendButton();
    for (let i = 0; i < 10; i++) {
      if (send && isEnabled(send)) break;
      await sleep(150);
      send = findSendButton();
    }
    if (!send) throw new Error("Send button not found");
    if (!isEnabled(send)) throw new Error("Send button is disabled (composer empty?)");
    send.click();
    return true;
  }

  function findFileInput() {
    for (const el of queryAllDeep('input[type="file"]')) {
      // Note: hidden file inputs can still be dispatched DataTransfer to, but not always.
      return el;
    }
    return null;
  }

  // Sets files on a file input via DataTransfer. Returns true if the input accepted it.
  function setFilesOnInput(input, files) {
    try {
      const dt = new DataTransfer();
      files.forEach((f) => dt.items.add(f));
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } catch (e) {
      return false;
    }
  }

  function dataUrlToFile(dataUrl, filename) {
    const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || "");
    if (!m) throw new Error("Invalid data URL");
    const mime = m[1];
    const bin = atob(m[2]);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new File([arr], filename || "upload", { type: mime });
  }

  function classifyMediaUrl(url) {
    const raw = String(url || "").trim();
    if (!raw) return { scheme: "", directDownloadable: false, reason: "empty_url" };
    if (/^https?:\/\//i.test(raw)) {
      return { scheme: raw.split(":", 1)[0].toLowerCase(), directDownloadable: true, reason: "direct_http" };
    }
    if (/^blob:/i.test(raw)) {
      return { scheme: "blob", directDownloadable: false, reason: "blob_url_not_downloadable_from_extension" };
    }
    if (/^data:/i.test(raw)) {
      return { scheme: "data", directDownloadable: false, reason: "data_url_skipped" };
    }
    return { scheme: "other", directDownloadable: false, reason: "unsupported_url_scheme" };
  }

  function pickMediaUrl(node) {
    if (!node) return "";
    const directAttrs = ["currentSrc", "src", "href", "poster"];
    for (const attr of directAttrs) {
      const val = node[attr] || "";
      if (val && classifyMediaUrl(val).directDownloadable) return val;
    }
    if (node.querySelector) {
      const source = node.querySelector("source[src]");
      if (source) return pickMediaUrl(source);
    }
    const anyVal = directAttrs.map((attr) => node[attr] || "").find(Boolean);
    if (anyVal) return anyVal;
    return "";
  }

  function mediaNameFromNode(node) {
    if (!node) return "";
    return (
      node.getAttribute("alt") ||
      node.getAttribute("aria-label") ||
      node.getAttribute("title") ||
      node.getAttribute("data-testid") ||
      ""
    ).trim();
  }

  function looksLikeMediaHref(url) {
    try {
      const u = new URL(url, location.href);
      return /\.(mp4|webm|mov|m4v|jpg|jpeg|png|webp|gif)(?:$|[?#])/i.test(u.pathname);
    } catch (_) {
      return false;
    }
  }

  function collectMedia() {
    const out = [];
    const seen = new Set();
    function push(type, url, node, source) {
      if (!url || seen.has(url)) return;
      seen.add(url);
      let w = 0, h = 0;
      try { const r = node.getBoundingClientRect(); w = Math.round(r.width); h = Math.round(r.height); } catch (_) {}
      const info = classifyMediaUrl(url);
      out.push({
        type,
        url,
        width: w,
        height: h,
        source: source || "",
        label: mediaNameFromNode(node),
        scheme: info.scheme,
        directDownloadable: info.directDownloadable,
        reason: info.reason,
      });
    }

    // High-confidence selectors first: Meta AI tags generated media with
    // data-testid="generated-image" / "generated-video" — these are
    // strictly the model output, not avatars or UI icons.
    for (const img of queryAllDeep('img[data-testid="generated-image"]')) {
      const src = pickMediaUrl(img);
      if (src) push("image", src, img);
    }
    for (const v of queryAllDeep('video[data-testid="generated-video"], [data-testid="generated-video"] video')) {
      const src = pickMediaUrl(v);
      if (src) push("video", src, v, "generated-video");
    }

    // images (fallback for non-tagged variants)
    for (const img of queryAllDeep("img")) {
      const src = pickMediaUrl(img);
      if (!src) continue;
      if (src.startsWith("data:") && src.length < 1024) continue; // skip tiny data URIs
      // skip obvious icons
      const rect = img.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 80) continue;
      push("image", src, img, "img");
    }
    // videos
    for (const v of queryAllDeep("video")) {
      const src = pickMediaUrl(v);
      if (src) push("video", src, v, "video");
    }
    // direct media links that Meta exposes in the page
    for (const a of queryAllDeep("a[href]")) {
      const href = a.href || "";
      if (!looksLikeMediaHref(href)) continue;
      const extIsVideo = /\.(mp4|webm|mov|m4v)(?:$|[?#])/i.test(new URL(href, location.href).pathname);
      push(extIsVideo ? "video" : "image", href, a, "link");
    }
    // background-image
    for (const el of queryAllDeep('[style*="background-image"]')) {
      const style = el.getAttribute("style") || "";
      const m = /url\((['"]?)([^'"\)]+)\1\)/.exec(style);
      if (m && /^https?:/.test(m[2])) {
        const rect = el.getBoundingClientRect();
        if (rect.width >= 80 && rect.height >= 80) push("image", m[2], el, "background-image");
      }
    }
    return out;
  }

  // Returns a promise that resolves when a likely generation completion is detected
  // or rejects after `timeoutMs`.
  function waitForCompletion({ timeoutMs = 180000, baselineMediaUrls = [] } = {}) {
    return new Promise((resolve, reject) => {
      const baseline = new Set(baselineMediaUrls);
      let done = false;

      function finish(reason, payload) {
        if (done) return;
        done = true;
        try { mo.disconnect(); } catch (_) {}
        clearInterval(poll);
        clearTimeout(timer);
        resolve({ reason, payload: payload || null });
      }

      function check() {
        const media = collectMedia();
        const fresh = media.filter((m) => !baseline.has(m.url));
        if (fresh.length > 0) {
          return finish("media_detected", { media: fresh });
        }
      }

      const mo = new MutationObserver(() => { check(); });
      try {
        mo.observe(document.documentElement, {
          childList: true, subtree: true, attributes: true,
          attributeFilter: ["src", "style", "aria-busy"],
        });
      } catch (_) { /* ignore */ }

      const poll = setInterval(check, 1200);
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        try { mo.disconnect(); } catch (_) {}
        clearInterval(poll);
        reject(new Error("Timeout waiting for result"));
      }, Math.max(5000, timeoutMs));
    });
  }

  root.SNDom = {
    isVisible,
    isEnabled,
    sleep,
    findPromptInput,
    setPromptText,
    findSendButton,
    findModePill,
    isModeActive,
    findGenerateButton,
    clickGenerate,
    findFileInput,
    setFilesOnInput,
    dataUrlToFile,
    classifyMediaUrl,
    collectMedia,
    waitForCompletion,
  };
})(typeof window !== "undefined" ? window : this);
