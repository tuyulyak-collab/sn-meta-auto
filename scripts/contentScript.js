/* SN Stock Keyword Optimizer — content script
 *
 * Runs on Adobe Stock contributor pages. Responds to messages from the popup
 * to (a) detect title + keyword fields and (b) write a new keyword order back.
 *
 * Adobe Stock's contributor UI changes over time, so we use multiple
 * detection strategies (input, textarea, contenteditable, chips, aria-labels,
 * placeholders, data-testids, role=textbox) and never rely on a single
 * brittle selector.
 */
(function () {
  "use strict";

  const KEYWORD_LABEL_HINTS = ["keyword", "tag"];
  const TITLE_LABEL_HINTS = ["title", "asset title", "name"];

  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = el.ownerDocument && el.ownerDocument.defaultView
      ? el.ownerDocument.defaultView.getComputedStyle(el)
      : null;
    if (cs && (cs.display === "none" || cs.visibility === "hidden")) return false;
    return true;
  }

  function lower(s) {
    return String(s || "").toLowerCase();
  }

  function attrIncludes(el, attr, hints) {
    const v = lower(el.getAttribute(attr));
    if (!v) return false;
    return hints.some((h) => v.includes(h));
  }

  function nearbyLabelText(el) {
    let parts = [];
    if (el.id) {
      const lbl = document.querySelector('label[for="' + cssEscape(el.id) + '"]');
      if (lbl) parts.push(lbl.textContent || "");
    }
    let p = el.parentElement;
    let depth = 0;
    while (p && depth < 4) {
      const lbl = p.querySelector("label");
      if (lbl) parts.push(lbl.textContent || "");
      p = p.parentElement;
      depth++;
    }
    return lower(parts.join(" "));
  }

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_\-]/g, "\\$&");
  }

  function looksLikeKeywordField(el) {
    if (!visible(el)) return false;
    if (
      attrIncludes(el, "aria-label", KEYWORD_LABEL_HINTS) ||
      attrIncludes(el, "placeholder", KEYWORD_LABEL_HINTS) ||
      attrIncludes(el, "name", KEYWORD_LABEL_HINTS) ||
      attrIncludes(el, "id", KEYWORD_LABEL_HINTS) ||
      attrIncludes(el, "data-testid", KEYWORD_LABEL_HINTS) ||
      attrIncludes(el, "data-test-id", KEYWORD_LABEL_HINTS) ||
      attrIncludes(el, "data-cy", KEYWORD_LABEL_HINTS) ||
      attrIncludes(el, "class", KEYWORD_LABEL_HINTS)
    ) {
      return true;
    }
    const lbl = nearbyLabelText(el);
    if (KEYWORD_LABEL_HINTS.some((h) => lbl.includes(h))) return true;
    return false;
  }

  function looksLikeTitleField(el) {
    if (!visible(el)) return false;
    if (
      attrIncludes(el, "aria-label", TITLE_LABEL_HINTS) ||
      attrIncludes(el, "placeholder", TITLE_LABEL_HINTS) ||
      attrIncludes(el, "name", TITLE_LABEL_HINTS) ||
      attrIncludes(el, "id", TITLE_LABEL_HINTS) ||
      attrIncludes(el, "data-testid", TITLE_LABEL_HINTS) ||
      attrIncludes(el, "data-test-id", TITLE_LABEL_HINTS) ||
      attrIncludes(el, "data-cy", TITLE_LABEL_HINTS)
    ) {
      return true;
    }
    const lbl = nearbyLabelText(el);
    if (TITLE_LABEL_HINTS.some((h) => lbl.includes(h))) return true;
    return false;
  }

  function findFields() {
    const candidates = Array.from(
      document.querySelectorAll(
        'input, textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"]'
      )
    );

    let titleField = null;
    let keywordField = null;

    // Prefer textarea/contenteditable for keywords.
    const keywordCandidates = candidates.filter(looksLikeKeywordField);
    keywordField =
      keywordCandidates.find(
        (el) =>
          el.tagName === "TEXTAREA" ||
          el.getAttribute("contenteditable") !== null ||
          el.getAttribute("role") === "textbox"
      ) ||
      keywordCandidates[0] ||
      null;

    const titleCandidates = candidates.filter(looksLikeTitleField);
    titleField = titleCandidates.find((el) => el.tagName === "INPUT") || titleCandidates[0] || null;

    // Detect chip-style keyword tags.
    const chips = findKeywordChips();

    return { titleField, keywordField, chips };
  }

  function findKeywordChips() {
    // Common chip patterns: list items inside a container that is labelled
    // "keywords"/"tags". Also try generic chip class names.
    const containers = Array.from(
      document.querySelectorAll(
        '[aria-label*="keyword" i], [aria-label*="tag" i], [data-testid*="keyword" i], [data-testid*="tag" i], [class*="keyword" i], [class*="tag" i]'
      )
    ).filter(visible);

    const chips = [];
    const seen = new Set();
    for (const c of containers) {
      const items = c.querySelectorAll(
        '[role="listitem"], li, [class*="chip" i], [class*="tag" i] > span, [data-testid*="chip" i], [data-testid*="tag-item" i]'
      );
      for (const it of items) {
        if (!visible(it)) continue;
        const text = (it.textContent || "").trim();
        if (!text || text.length > 80) continue;
        if (seen.has(text)) continue;
        seen.add(text);
        chips.push({ element: it, text });
      }
    }
    return chips;
  }

  function getFieldValue(el) {
    if (!el) return "";
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return el.value || "";
    if (el.getAttribute("contenteditable") !== null || el.getAttribute("role") === "textbox") {
      return el.textContent || "";
    }
    return "";
  }

  function parseKeywordsLocal(s) {
    if (!s) return [];
    return String(s)
      .split(/[,;\n\t]+/)
      .map((k) => k.replace(/\u00A0/g, " ").trim())
      .filter((k) => k.length > 0);
  }

  function setNativeValue(el, value) {
    const proto =
      el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setContentEditable(el, value) {
    el.focus();
    // Replace all text content while triggering input events.
    el.textContent = "";
    el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    document.execCommand && document.execCommand("insertText", false, value);
    el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function applyKeywords(keywords) {
    const { keywordField, chips } = findFields();
    if (!keywordField && chips.length === 0) {
      return { ok: false, error: "No keyword field detected" };
    }
    const joined = keywords.join(", ");
    if (keywordField) {
      try {
        if (keywordField.tagName === "INPUT" || keywordField.tagName === "TEXTAREA") {
          setNativeValue(keywordField, joined);
        } else {
          setContentEditable(keywordField, joined);
        }
        return { ok: true, applied: keywords.length, mode: "field" };
      } catch (e) {
        return { ok: false, error: "Could not write to keyword field: " + (e && e.message) };
      }
    }
    return {
      ok: false,
      error:
        "Page uses chip-based keywords; automatic replacement isn't supported yet. Please paste manually.",
    };
  }

  function scanPage() {
    const { titleField, keywordField, chips } = findFields();
    const titleValue = getFieldValue(titleField);
    let keywords = [];

    if (chips.length > 0) {
      keywords = chips.map((c) => c.text);
    }
    if (keywords.length === 0 && keywordField) {
      keywords = parseKeywordsLocal(getFieldValue(keywordField));
    }

    return {
      ok: true,
      detected: Boolean(titleField || keywordField || chips.length > 0),
      title: titleValue || "",
      keywords,
      hasTitleField: Boolean(titleField),
      hasKeywordField: Boolean(keywordField),
      chipMode: chips.length > 0 && !keywordField,
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return false;
    try {
      if (msg.type === "SN_SCAN_PAGE") {
        sendResponse(scanPage());
        return true;
      }
      if (msg.type === "SN_APPLY_KEYWORDS") {
        const list = Array.isArray(msg.keywords) ? msg.keywords : [];
        sendResponse(applyKeywords(list));
        return true;
      }
      if (msg.type === "SN_PING_CONTENT") {
        sendResponse({ ok: true, host: location.host });
        return true;
      }
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
      return true;
    }
    return false;
  });
})();
