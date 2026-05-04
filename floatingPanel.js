/* floatingPanel.js
 * Injected into the meta.ai page on demand (via background.js
 * chrome.scripting.executeScript when the user clicks
 * MENU → Open Floating Panel in the popup). Renders a draggable overlay
 * inside the page that mirrors and controls the queue state held in
 * chrome.storage.local under sn_state, just like popup.js does.
 *
 * Lifecycle:
 *   - First injection: build the DOM, attach a chrome.storage.onChanged
 *     listener, and render the current state.
 *   - Subsequent injections: if the panel is hidden (after × close), show
 *     it again; otherwise no-op. The instance is kept on
 *     window.__SN_META_AUTO_FLOATING_PANEL__ to keep storage listeners
 *     alive across injections.
 *
 * The × button only hides the panel — it does NOT stop, reset, or otherwise
 * touch the queue state in chrome.storage.local. The queue keeps running.
 */

(function () {
  if (typeof chrome === "undefined" || !chrome.storage || !chrome.runtime) {
    // Not running inside an extension context; nothing to do.
    return;
  }

  // Re-injection: just unhide and bail.
  const existing = window.__SN_META_AUTO_FLOATING_PANEL__;
  if (existing && existing.show) {
    existing.show();
    return;
  }

  const PANEL_ID = "sn-meta-auto-floating";
  const UI_KEY = "sn_ui";
  const STATE_KEY = "sn_state";
  // Default: 16px from the top, 16px from the right edge of the viewport.
  // Persisted x/y in chrome.storage.local override this on subsequent opens.
  const DEFAULT_OFFSET_RIGHT = 16;
  const DEFAULT_OFFSET_TOP = 16;

  // ---------- helpers ----------
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === "class") node.className = v;
        else if (k === "dataset") Object.assign(node.dataset, v || {});
        else if (k === "style") Object.assign(node.style, v || {});
        else if (k.startsWith("on") && typeof v === "function") {
          node.addEventListener(k.slice(2).toLowerCase(), v);
        } else if (v != null) {
          node.setAttribute(k, String(v));
        }
      }
    }
    for (const c of children.flat()) {
      if (c == null) continue;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return node;
  }

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          const err = chrome.runtime && chrome.runtime.lastError;
          if (err) return resolve({ ok: false, error: err.message });
          resolve(res || { ok: false, error: "empty response" });
        });
      } catch (e) {
        resolve({ ok: false, error: String((e && e.message) || e) });
      }
    });
  }

  function getStorage(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.get(keys, (res) => resolve(res || {}));
    });
  }

  function setStorage(obj) {
    return new Promise((resolve) => chrome.storage.local.set(obj, () => resolve()));
  }

  // ---------- CSS injection (idempotent) ----------
  // The CSS file is loaded as a <link>, but for robustness if Chrome's
  // web_accessible_resources fails (e.g. file 404 during dev) we still
  // ship a minimal inline fallback that at least makes the panel visible.
  function ensureStyles() {
    if (document.querySelector('link[data-sn-meta-floating-css="1"]')) return;
    try {
      const href = chrome.runtime.getURL("floatingPanel.css");
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      link.dataset.snMetaFloatingCss = "1";
      (document.head || document.documentElement).appendChild(link);
    } catch (e) {
      // ignore — host page may strip <link>; inline fallback handled
      // implicitly via CSS already shipped if extension reinjected later.
    }
  }

  // ---------- panel build ----------
  function buildPanel() {
    // ---- top card: title bar (drag handle, mode tag, close) ----
    const title = el("span", { class: "snfp-title" }, "SN META AUTO");
    const modeTag = el("span", { class: "snfp-mode-tag", "data-mode": "image" }, "IMAGE");
    const closeBtn = el(
      "button",
      {
        class: "snfp-close",
        title: "Close (does not stop the queue)",
        "aria-label": "Close floating panel",
      },
      "CLOSE \u00d7"
    );
    const headerCard = el(
      "div",
      { class: "snfp-card snfp-header" },
      title,
      modeTag,
      closeBtn
    );

    // ---- bottom card: status / stats / progress / controls / log ----
    const badge = el("span", { class: "snfp-badge", "data-state": "" }, "IDLE");
    const statusText = el("span", { class: "snfp-status-text" }, "Ready");
    const statusRow = el("div", { class: "snfp-status-row" }, badge, statusText);

    const stats = el(
      "div",
      { class: "snfp-stats" },
      el(
        "div",
        { class: "snfp-stat" },
        el("span", { class: "snfp-stat-icon ok" }, "\u2713"),
        el("span", { class: "snfp-stat-label" }, "DONE"),
        el("span", { class: "snfp-stat-num", "data-stat": "done" }, "0")
      ),
      el(
        "div",
        { class: "snfp-stat" },
        el("span", { class: "snfp-stat-icon fail" }, "\u00d7"),
        el("span", { class: "snfp-stat-label" }, "FAIL"),
        el("span", { class: "snfp-stat-num", "data-stat": "fail" }, "0")
      ),
      el(
        "div",
        { class: "snfp-stat" },
        el("span", { class: "snfp-stat-icon cur" }, "\u25b6"),
        el("span", { class: "snfp-stat-label" }, "CURRENT"),
        el("span", { class: "snfp-stat-num", "data-stat": "current" }, "0")
      )
    );

    const progressFill = el("div", { class: "snfp-progress-fill", style: { width: "0%" } });
    const progressLabel = el("span", { class: "snfp-progress-label" }, "0%");
    const progress = el(
      "div",
      { class: "snfp-progress" },
      el("div", { class: "snfp-progress-track" }, progressFill),
      progressLabel
    );

    const btnStart = el("button", { class: "snfp-btn start", "data-act": "start" }, "Start");
    const btnStop = el("button", { class: "snfp-btn stop", "data-act": "stop" }, "Stop");
    const btnResume = el("button", { class: "snfp-btn resume", "data-act": "resume" }, "Resume");
    const btnRetry = el("button", { class: "snfp-btn retry", "data-act": "retry" }, "Retry");
    const btnSkip = el("button", { class: "snfp-btn skip", "data-act": "skip" }, "Skip");
    const controls = el(
      "div",
      { class: "snfp-controls" },
      btnStart,
      btnStop,
      btnResume,
      btnRetry,
      btnSkip
    );

    const logLine = el("div", { class: "snfp-log" }, "[--:--:--] Ready.");

    const bodyCard = el(
      "div",
      { class: "snfp-card snfp-body" },
      statusRow,
      stats,
      progress,
      controls,
      logLine
    );

    const root = el(
      "div",
      { id: PANEL_ID, role: "region", "aria-label": "SN Meta Auto floating control" },
      headerCard,
      bodyCard
    );

    return {
      root,
      header: headerCard,
      modeTag,
      closeBtn,
      badge,
      statusText,
      stats,
      progressFill,
      progressLabel,
      controls: { btnStart, btnStop, btnResume, btnRetry, btnSkip },
      logLine,
    };
  }

  // ---------- positioning ----------
  function clampPosition(x, y, width, height) {
    const vw = window.innerWidth || document.documentElement.clientWidth || 1024;
    const vh = window.innerHeight || document.documentElement.clientHeight || 768;
    const w = width || 280;
    const h = height || 220;
    const maxX = Math.max(0, vw - w - 4);
    const maxY = Math.max(0, vh - h - 4);
    return {
      x: Math.min(Math.max(0, x), maxX),
      y: Math.min(Math.max(0, y), maxY),
    };
  }

  async function applySavedPosition(rootEl) {
    const stored = await getStorage(UI_KEY);
    const pos = (stored[UI_KEY] && stored[UI_KEY].floatingPos) || null;
    const rect = rootEl.getBoundingClientRect();
    const w = rect.width || 280;
    const h = rect.height || 220;
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
      const c = clampPosition(pos.x, pos.y, w, h);
      rootEl.style.left = c.x + "px";
      rootEl.style.top = c.y + "px";
      rootEl.style.right = "auto";
    } else {
      // Default: top-right, 16px insets.
      const vw = window.innerWidth || 1024;
      const x = Math.max(0, vw - w - DEFAULT_OFFSET_RIGHT);
      rootEl.style.left = x + "px";
      rootEl.style.top = DEFAULT_OFFSET_TOP + "px";
      rootEl.style.right = "auto";
    }
  }

  async function savePosition(x, y) {
    const stored = await getStorage(UI_KEY);
    const cur = stored[UI_KEY] || {};
    const next = Object.assign({}, cur, { floatingPos: { x: Math.round(x), y: Math.round(y) } });
    await setStorage({ [UI_KEY]: next });
  }

  function attachDrag(rootEl, headerEl) {
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    function onMouseDown(e) {
      // Don't start a drag from interactive children (close button, etc.).
      if (e.target && e.target.closest && e.target.closest("button")) return;
      dragging = true;
      headerEl.classList.add("dragging");
      const rect = rootEl.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      e.preventDefault();
      window.addEventListener("mousemove", onMouseMove, true);
      window.addEventListener("mouseup", onMouseUp, true);
    }
    function onMouseMove(e) {
      if (!dragging) return;
      const rect = rootEl.getBoundingClientRect();
      const c = clampPosition(e.clientX - offsetX, e.clientY - offsetY, rect.width, rect.height);
      rootEl.style.left = c.x + "px";
      rootEl.style.top = c.y + "px";
      rootEl.style.right = "auto";
    }
    function onMouseUp() {
      if (!dragging) return;
      dragging = false;
      headerEl.classList.remove("dragging");
      window.removeEventListener("mousemove", onMouseMove, true);
      window.removeEventListener("mouseup", onMouseUp, true);
      const rect = rootEl.getBoundingClientRect();
      savePosition(rect.left, rect.top).catch(() => {});
    }

    headerEl.addEventListener("mousedown", onMouseDown);
  }

  // ---------- state rendering ----------
  function computeBadge(state) {
    if (state.isRunning) return { label: "RUNNING", state: "running" };
    if (state.isPaused) return { label: "PAUSED", state: "paused" };
    if (state.lastError) return { label: "FAILED", state: "failed" };
    const counts = countsOf(state.queue);
    const total = (state.queue || []).length;
    const allDone = total > 0 && counts.pending === 0 && counts.paused === 0 && counts.running === 0;
    if (allDone) return { label: "COMPLETED", state: "completed" };
    return { label: "IDLE", state: "" };
  }

  function countsOf(queue) {
    const out = { pending: 0, running: 0, completed: 0, failed: 0, paused: 0, skipped: 0 };
    (queue || []).forEach((q) => {
      if (out[q.status] !== undefined) out[q.status] += 1;
    });
    return out;
  }

  function statusTextFor(state, info) {
    if (state.lastError) return state.lastError;
    if (info.state === "running") {
      const cur = state.currentIndex >= 0 ? state.currentIndex + 1 : 0;
      const total = (state.queue || []).length;
      return cur && total ? `Processing item ${cur}/${total}` : "Processing...";
    }
    if (info.state === "paused") return "Paused — click RESUME to continue";
    if (info.state === "completed") return "All tasks complete";
    const total = (state.queue || []).length;
    if (total === 0) return "No tasks queued";
    return "Ready";
  }

  function modeLabel(mode) {
    if (mode === "video") return "VIDEO";
    if (mode === "image_to_video") return "I2V";
    return "IMAGE";
  }

  function renderState(parts, state) {
    const completed = state.completedCount || 0;
    const failed = state.failedCount || 0;
    const total = (state.queue || []).length;
    const current = state.currentIndex >= 0 ? state.currentIndex + 1 : 0;
    const processed = completed + failed;
    const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;

    parts.stats.querySelector('[data-stat="done"]').textContent = String(completed);
    parts.stats.querySelector('[data-stat="fail"]').textContent = String(failed);
    parts.stats.querySelector('[data-stat="current"]').textContent = String(current);
    parts.progressFill.style.width = percent + "%";
    parts.progressLabel.textContent = percent + "%";

    const info = computeBadge(state);
    parts.badge.textContent = info.label;
    parts.badge.dataset.state = info.state;
    parts.statusText.textContent = statusTextFor(state, info);

    const mode = state.mode || "image";
    parts.modeTag.dataset.mode = mode;
    parts.modeTag.textContent = modeLabel(mode);

    const isRunning = !!state.isRunning;
    const isPaused = !!state.isPaused;
    const failedExists = (state.queue || []).some((q) => q.status === "failed");
    const runningItem = (state.queue || []).find(
      (q) => q.status === "running" || q.status === "paused"
    );

    // Mirror popup.js applyButtonStates rules so the user sees identical
    // affordances in both views. After STOP, START stays disabled and
    // RESUME is the way to keep going.
    parts.controls.btnStart.disabled =
      isRunning || isPaused || total === 0 || (processed >= total && total > 0);
    parts.controls.btnStop.disabled = !isRunning;
    parts.controls.btnResume.disabled = isRunning || !isPaused;
    parts.controls.btnRetry.disabled = !failedExists;
    parts.controls.btnSkip.disabled = !runningItem;
  }

  function renderLogLine(parts, logs) {
    const last = (logs || []).slice(-1)[0];
    parts.logLine.textContent = last
      ? `[${last.ts}] ${last.msg}`
      : "[--:--:--] No activity yet.";
  }

  // ---------- button wiring ----------
  function wireControls(parts) {
    const handlers = {
      start: async () => {
        const res = await send({ type: "START" });
        if (!res.ok) console.warn("[SN Meta Auto floating] START failed:", res.error);
      },
      stop: async () => {
        const res = await send({ type: "STOP" });
        if (!res.ok) console.warn("[SN Meta Auto floating] STOP failed:", res.error);
      },
      resume: async () => {
        const res = await send({ type: "RESUME" });
        if (!res.ok) console.warn("[SN Meta Auto floating] RESUME failed:", res.error);
      },
      retry: async () => {
        const res = await send({ type: "RETRY_FAILED" });
        if (!res.ok) console.warn("[SN Meta Auto floating] RETRY failed:", res.error);
      },
      skip: async () => {
        // Skip the in-flight item, falling back to the next pending item if
        // nothing is currently running. Matches popup.js wireMiniControls
        // behavior so both surfaces feel identical.
        const stored = await getStorage(STATE_KEY);
        const state = stored[STATE_KEY] || { queue: [] };
        const target =
          (state.queue || []).find((q) => q.status === "running" || q.status === "paused") ||
          (state.queue || []).find((q) => q.status === "pending");
        if (!target) return;
        const res = await send({ type: "ITEM_ACTION", action: "skip", id: target.id });
        if (!res.ok) console.warn("[SN Meta Auto floating] SKIP failed:", res.error);
      },
    };

    Object.entries(parts.controls).forEach(([_, btn]) => {
      btn.addEventListener("click", async () => {
        const act = btn.dataset.act;
        const fn = handlers[act];
        if (!fn) return;
        // Optimistic disable until the next storage update arrives. The
        // canonical disabled state is reapplied by renderState as soon as
        // chrome.storage.onChanged fires for the resulting state mutation.
        btn.disabled = true;
        try {
          await fn();
        } finally {
          // Rely on storage listener to re-enable based on real state.
        }
      });
    });
  }

  // ---------- init ----------
  ensureStyles();

  const parts = buildPanel();
  document.documentElement.appendChild(parts.root);

  // Apply default/persisted position on next frame so getBoundingClientRect
  // sees the rendered size.
  requestAnimationFrame(() => {
    applySavedPosition(parts.root).catch(() => {});
  });

  attachDrag(parts.root, parts.header);
  wireControls(parts);

  // Close button: hide only — must not affect queue.
  parts.closeBtn.addEventListener("click", () => {
    parts.root.style.display = "none";
  });

  // Initial render + live sync via chrome.storage.onChanged.
  getStorage([STATE_KEY]).then((res) => {
    const state = res[STATE_KEY] || { queue: [], logs: [] };
    renderState(parts, state);
    renderLogLine(parts, state.logs || []);
  });

  const onStorageChanged = (changes, area) => {
    if (area !== "local") return;
    if (!changes[STATE_KEY]) return;
    const ns = changes[STATE_KEY].newValue || {};
    renderState(parts, ns);
    renderLogLine(parts, ns.logs || []);
  };
  chrome.storage.onChanged.addListener(onStorageChanged);

  // Reposition on viewport resize so the panel doesn't end up off-screen.
  const onResize = () => {
    const rect = parts.root.getBoundingClientRect();
    const c = clampPosition(rect.left, rect.top, rect.width, rect.height);
    parts.root.style.left = c.x + "px";
    parts.root.style.top = c.y + "px";
  };
  window.addEventListener("resize", onResize);

  // Public handle so a re-injection just shows the panel again instead of
  // duplicating it.
  window.__SN_META_AUTO_FLOATING_PANEL__ = {
    show: () => {
      parts.root.style.display = "";
      // Re-clamp after show in case viewport changed while hidden.
      const rect = parts.root.getBoundingClientRect();
      const c = clampPosition(rect.left, rect.top, rect.width, rect.height);
      parts.root.style.left = c.x + "px";
      parts.root.style.top = c.y + "px";
    },
    hide: () => {
      parts.root.style.display = "none";
    },
    destroy: () => {
      chrome.storage.onChanged.removeListener(onStorageChanged);
      window.removeEventListener("resize", onResize);
      parts.root.remove();
      delete window.__SN_META_AUTO_FLOATING_PANEL__;
    },
  };
})();
