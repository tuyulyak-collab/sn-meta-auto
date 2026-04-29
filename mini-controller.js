/* mini-controller.js
 * Floating mini controller injected onto meta.ai pages.
 *
 * Responsibilities:
 *  - Render a compact bottom-right widget mirroring the popup state.
 *  - Render a tiny "SN" bubble that the user can click to restore the mini.
 *  - Listen to chrome.storage.onChanged for state/log updates so the widget
 *    stays in sync with the popup full panel without polling.
 *  - Forward control button clicks (Start/Stop/Resume/Retry/Skip) to the
 *    background service worker via chrome.runtime.sendMessage — same wire
 *    protocol as popup.js, so behaviour stays identical.
 *  - Persist visibility ("hidden" / "mini" / "bubble") in chrome.storage so
 *    the user's choice survives page reloads and tab switches.
 *
 * Visibility is driven by chrome.storage so any tab on meta.ai can react
 * consistently when the popup minimizes the controller.
 */

(function () {
  if (window.__SN_MINI_CONTROLLER__) return;
  window.__SN_MINI_CONTROLLER__ = true;

  const VIS_KEY = "sn_mini_visible";
  const STATE_KEY = "sn_state";
  const SETTINGS_KEY = "sn_settings";

  // -- DOM refs (populated in mount()) ------------------------------------
  let miniRoot = null;
  let bubbleRoot = null;
  let els = {};

  // Latest cached state so button clicks can reference current item id.
  let lastState = null;

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        if (k === "text") node.textContent = attrs[k];
        else if (k === "html") node.innerHTML = attrs[k];
        else if (k.startsWith("data-")) node.setAttribute(k, attrs[k]);
        else if (k === "title") node.title = attrs[k];
        else node[k] = attrs[k];
      }
    }
    if (Array.isArray(children)) {
      children.forEach((c) => c && node.appendChild(c));
    }
    return node;
  }

  function mount() {
    if (miniRoot) return;
    // Guard: the meta.ai SPA can replace document.body during navigation.
    // Use documentElement to survive that.
    const host = document.documentElement || document.body;
    if (!host) return;

    miniRoot = el("div", { id: "sn-mini-root", hidden: true });
    bubbleRoot = el("div", {
      id: "sn-bubble-root",
      hidden: true,
      title: "Open SN Meta Auto mini controller",
      text: "SN",
    });

    // ---- Header ----
    els.title = el("div", { className: "sn-mini-title", text: "SN META AUTO" });
    els.modeBadge = el("span", { className: "sn-mini-mode", text: "IDLE" });
    els.btnMaximize = el("button", {
      className: "sn-mini-headbtn",
      text: "MAX",
      title: "Open the full panel in a new tab",
    });
    els.btnHide = el("button", {
      className: "sn-mini-headbtn",
      text: "HIDE",
      title: "Collapse to floating bubble",
    });

    const headActions = el("div", { className: "sn-mini-head-actions" }, [
      els.btnMaximize,
      els.btnHide,
    ]);
    const head = el("div", { className: "sn-mini-head" }, [
      els.title,
      els.modeBadge,
      headActions,
    ]);

    // ---- Status row ----
    els.statusBadge = el("span", {
      className: "sn-mini-statusbadge",
      text: "IDLE",
      "data-state": "idle",
    });
    els.counts = el("span", {
      className: "sn-mini-counts",
      text: "0/0  Done 0  Fail 0",
    });
    const statusRow = el("div", { className: "sn-mini-status" }, [
      els.statusBadge,
      els.counts,
    ]);

    // ---- Progress ----
    els.progressFill = el("div", { className: "sn-mini-progress-fill" });
    els.progressLabel = el("div", {
      className: "sn-mini-progress-label",
      text: "0%",
    });
    const progress = el("div", { className: "sn-mini-progress" }, [
      els.progressFill,
      els.progressLabel,
    ]);

    // ---- Controls ----
    function ctlBtn(act, label, tip) {
      const b = el("button", {
        className: "sn-mini-btn",
        "data-act": act,
        text: label,
        title: tip,
      });
      b.disabled = true;
      return b;
    }
    els.btnStart = ctlBtn("start", "START", "Start queue");
    els.btnStop = ctlBtn("stop", "STOP", "Pause after current item");
    els.btnResume = ctlBtn("resume", "RESUME", "Resume paused queue");
    els.btnRetry = ctlBtn("retry", "RETRY", "Retry failed items");
    els.btnSkip = ctlBtn("skip", "SKIP", "Skip current item");

    const controls = el("div", { className: "sn-mini-controls" }, [
      els.btnStart,
      els.btnStop,
      els.btnResume,
      els.btnRetry,
      els.btnSkip,
    ]);

    // ---- Ticker log ----
    els.tickerText = el("span", {
      className: "sn-mini-ticker-text",
      text: "Waiting for activity\u2026",
    });
    els.ticker = el("div", { className: "sn-mini-ticker" }, [els.tickerText]);

    // ---- Assemble ----
    miniRoot.appendChild(head);
    miniRoot.appendChild(statusRow);
    miniRoot.appendChild(progress);
    miniRoot.appendChild(controls);
    miniRoot.appendChild(els.ticker);

    host.appendChild(miniRoot);
    host.appendChild(bubbleRoot);

    // ---- Wire events ----
    els.btnMaximize.addEventListener("click", () => {
      // Open the full panel in a new tab. We can't programmatically open the
      // toolbar popup, so a tab is the most reliable cross-platform option.
      const url = chrome.runtime.getURL("popup.html");
      try { window.open(url, "_blank"); } catch (_) {}
      setVisibility("hidden");
    });
    els.btnHide.addEventListener("click", () => setVisibility("bubble"));
    bubbleRoot.addEventListener("click", () => setVisibility("mini"));

    els.btnStart.addEventListener("click", () => sendBg({ type: "START" }));
    els.btnStop.addEventListener("click", () => sendBg({ type: "STOP" }));
    els.btnResume.addEventListener("click", () => sendBg({ type: "RESUME" }));
    els.btnRetry.addEventListener("click", () =>
      sendBg({ type: "RETRY_FAILED" })
    );
    els.btnSkip.addEventListener("click", () => {
      const id = currentItemId(lastState);
      if (!id) return;
      sendBg({ type: "ITEM_ACTION", action: "skip", id });
    });
  }

  function unmount() {
    try { miniRoot && miniRoot.remove(); } catch (_) {}
    try { bubbleRoot && bubbleRoot.remove(); } catch (_) {}
    miniRoot = null;
    bubbleRoot = null;
    els = {};
  }

  function sendBg(msg) {
    try {
      chrome.runtime.sendMessage(msg, () => {
        // Swallow lastError — background may be napping in MV3 SW lifecycle.
        void chrome.runtime.lastError;
      });
    } catch (_) { /* ignore */ }
  }

  function getStorage(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(keys, (res) => resolve(res || {}));
      } catch (_) { resolve({}); }
    });
  }

  function setVisibility(mode) {
    // mode = "hidden" | "mini" | "bubble"
    try { chrome.storage.local.set({ [VIS_KEY]: mode }); } catch (_) {}
    applyVisibility(mode);
  }

  function applyVisibility(mode) {
    if (!miniRoot || !bubbleRoot) return;
    if (mode === "mini") {
      miniRoot.hidden = false;
      bubbleRoot.hidden = true;
    } else if (mode === "bubble") {
      miniRoot.hidden = true;
      bubbleRoot.hidden = false;
    } else {
      miniRoot.hidden = true;
      bubbleRoot.hidden = true;
    }
  }

  function currentItemId(state) {
    if (!state || !Array.isArray(state.queue)) return null;
    const idx = Number(state.currentIndex);
    if (Number.isFinite(idx) && idx >= 0 && state.queue[idx]) {
      return state.queue[idx].id;
    }
    // Fallback: first running item
    const running = state.queue.find((q) => q && q.status === "running");
    if (running) return running.id;
    // Fallback 2: first pending — useful for "skip" before a run starts
    const pending = state.queue.find((q) => q && q.status === "pending");
    return pending ? pending.id : null;
  }

  function statusLabel(state) {
    if (!state) return "IDLE";
    if (state.isRunning && !state.isPaused) return "RUNNING";
    if (state.isPaused) return "PAUSED";
    const counts = countsByStatus(state.queue || []);
    if (counts.total > 0 && counts.failed > 0 && counts.pending === 0 && !state.isRunning) {
      return "FAILED";
    }
    if (counts.total > 0 && counts.completed + counts.skipped === counts.total) {
      return "COMPLETED";
    }
    return "IDLE";
  }

  function statusKey(label) {
    return String(label || "").toLowerCase();
  }

  function countsByStatus(queue) {
    const c = { pending: 0, running: 0, completed: 0, failed: 0, skipped: 0, paused: 0, total: queue.length };
    for (const it of queue) {
      const s = (it && it.status) || "pending";
      if (c[s] != null) c[s] += 1;
    }
    return c;
  }

  function modeLabel(mode) {
    if (mode === "image_to_video") return "I2V";
    if (mode === "video") return "VIDEO";
    return "IMAGE";
  }

  function fmtCounts(state) {
    const c = countsByStatus(state.queue || []);
    const cur = Number.isFinite(state.currentIndex) && state.currentIndex >= 0
      ? state.currentIndex + 1
      : c.completed + c.failed + c.skipped;
    return `${Math.min(cur, c.total)}/${c.total}  Done ${c.completed}  Fail ${c.failed}`;
  }

  function progressPct(state) {
    const c = countsByStatus(state.queue || []);
    if (c.total === 0) return 0;
    const done = c.completed + c.failed + c.skipped;
    return Math.round((done / c.total) * 100);
  }

  function render(state) {
    if (!miniRoot || !state) return;
    lastState = state;

    const label = statusLabel(state);
    els.statusBadge.textContent = label;
    els.statusBadge.setAttribute("data-state", statusKey(label));

    els.modeBadge.textContent = modeLabel(state.mode);

    els.counts.textContent = fmtCounts(state);

    const pct = progressPct(state);
    els.progressFill.style.width = pct + "%";
    els.progressLabel.textContent = pct + "%";

    // Buttons enable/disable
    const c = countsByStatus(state.queue || []);
    const running = !!state.isRunning && !state.isPaused;
    const paused = !!state.isPaused;
    const idle = !running && !paused;

    els.btnStart.disabled = !(idle && c.pending > 0);
    els.btnStop.disabled = !running;
    els.btnResume.disabled = !paused;
    els.btnRetry.disabled = c.failed === 0;
    els.btnSkip.disabled = !currentItemId(state);

    // Ticker — latest log entry
    const logs = Array.isArray(state.logs) ? state.logs : [];
    if (logs.length > 0) {
      const latest = logs[logs.length - 1];
      const text = `[${latest.ts || ""}] ${latest.msg || ""}`.trim();
      setTickerText(text);
    } else {
      setTickerText("Waiting for activity\u2026");
    }
  }

  function setTickerText(text) {
    if (!els.tickerText) return;
    if (els.tickerText.textContent === text) {
      // Same text — keep current marquee state to avoid restart flicker.
      return;
    }
    els.tickerText.textContent = text;
    // Decide whether to apply marquee animation. Reset class first so the
    // animation restarts when text changes.
    els.ticker.classList.remove("is-overflow");
    // Force reflow so re-adding the class restarts the animation.
    void els.ticker.offsetWidth;
    if (els.tickerText.scrollWidth > els.ticker.clientWidth) {
      els.ticker.classList.add("is-overflow");
    }
  }

  async function refreshFromStorage() {
    const data = await getStorage([STATE_KEY, VIS_KEY]);
    const state = data[STATE_KEY];
    const vis = data[VIS_KEY] || "hidden";
    applyVisibility(vis);
    if (state) render(state);
  }

  // ---- Wire storage subscription ----------------------------------------
  function onStorageChanged(changes, area) {
    if (area !== "local") return;
    if (changes[STATE_KEY]) {
      render(changes[STATE_KEY].newValue || {});
    }
    if (changes[VIS_KEY]) {
      applyVisibility(changes[VIS_KEY].newValue || "hidden");
    }
  }

  try { chrome.storage.onChanged.addListener(onStorageChanged); } catch (_) {}

  // ---- Wire runtime message subscription --------------------------------
  // popup.js sends { type: "SHOW_MINI" } when the user clicks MINIMIZE in
  // the toolbar popup. We honour it by setting visibility — which also
  // persists across reloads via storage.
  function onRuntimeMessage(msg, _sender, sendResponse) {
    if (!msg || !msg.type) return false;
    if (msg.type === "SHOW_MINI") {
      mount();
      setVisibility("mini");
      sendResponse && sendResponse({ ok: true });
      return false;
    }
    if (msg.type === "HIDE_MINI") {
      setVisibility("hidden");
      sendResponse && sendResponse({ ok: true });
      return false;
    }
    return false;
  }
  try { chrome.runtime.onMessage.addListener(onRuntimeMessage); } catch (_) {}

  // ---- Boot --------------------------------------------------------------
  function boot() {
    mount();
    refreshFromStorage();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
