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

  function findGenerateButton(mode) {
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
      // svg-only send icons: look at parent form / sibling textarea
      const form = el.closest("form");
      if (form && promptEl && form.contains(promptEl)) score += 2;

      // prefer closest to prompt input
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

  async function clickGenerate(mode) {
    const btn = findGenerateButton(mode);
    if (!btn) throw new Error("Generate button not found");
    btn.click();
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

  function collectMedia() {
    const out = [];
    const seen = new Set();
    function push(type, url, node) {
      if (!url || seen.has(url)) return;
      seen.add(url);
      let w = 0, h = 0;
      try { const r = node.getBoundingClientRect(); w = Math.round(r.width); h = Math.round(r.height); } catch (_) {}
      out.push({ type, url, width: w, height: h });
    }

    // images
    for (const img of queryAllDeep("img")) {
      const src = img.currentSrc || img.src || "";
      if (!src) continue;
      if (src.startsWith("data:") && src.length < 1024) continue; // skip tiny data URIs
      // skip obvious icons
      const rect = img.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 80) continue;
      push("image", src, img);
    }
    // videos
    for (const v of queryAllDeep("video")) {
      const src = v.currentSrc || v.src || (v.querySelector("source") && v.querySelector("source").src) || "";
      if (src) push("video", src, v);
    }
    // background-image
    for (const el of queryAllDeep('[style*="background-image"]')) {
      const style = el.getAttribute("style") || "";
      const m = /url\((['"]?)([^'"\)]+)\1\)/.exec(style);
      if (m && /^https?:/.test(m[2])) {
        const rect = el.getBoundingClientRect();
        if (rect.width >= 80 && rect.height >= 80) push("image", m[2], el);
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
    findGenerateButton,
    clickGenerate,
    findFileInput,
    setFilesOnInput,
    dataUrlToFile,
    collectMedia,
    waitForCompletion,
  };
})(typeof window !== "undefined" ? window : this);
