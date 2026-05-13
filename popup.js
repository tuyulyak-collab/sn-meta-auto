/* popup.js — UI for SN Meta Auto */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// Runtime UI-only state
const UI = {
  mode: "image",
  images: [], // [{ dataUrl, name, prompt? }]
  scannedMedia: [],
  scannedSelection: new Set(),
  busyButtons: new Set(),
  lastState: null, // last rendered state — used by applyButtonStates after lock release
  // The popup runs in two contexts:
  //  - Regular extension popup (from toolbar click) when ?mini is absent.
  //  - Separate Chrome popup window (chrome.windows.create) when ?mini=1.
  // The mini context renders #miniView and hides <main>; the OS window itself
  // is what's draggable, so the user can park it anywhere on screen and it
  // stays open even when they click outside (unlike the toolbar popup, which
  // Chrome auto-closes on outside click).
  isMiniWindow: new URLSearchParams(location.search).get("mini") === "1",
};

// Mini popup window dimensions — small enough to keep next to meta.ai,
// large enough to fit the stats grid + 5-button control row + log line.
const MINI_WINDOW_WIDTH = 480;
const MINI_WINDOW_HEIGHT = 320;

// sn_ui storage key holds the mini window ID so a second Minimize click
// from the main popup can focus the existing mini window instead of
// spawning a duplicate.
const UI_KEY = "sn_ui";
async function loadUiPrefs() {
  return new Promise((resolve) => {
    chrome.storage.local.get(UI_KEY, (res) => resolve(res[UI_KEY] || {}));
  });
}
async function saveUiPrefs(partial) {
  const cur = await loadUiPrefs();
  const next = Object.assign({}, cur, partial);
  await new Promise((r) => chrome.storage.local.set({ [UI_KEY]: next }, r));
  return next;
}

// Re-usable senders
function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      const err = chrome.runtime.lastError;
      if (err) return resolve({ ok: false, error: err.message });
      resolve(res || { ok: false, error: "empty response" });
    });
  });
}

function toast(text, ms = 1800) {
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

// ---- anti-double-click lock ----
// withLock tracks which buttons are mid-flight in UI.busyButtons. The actual
// disabled state is always derived from the application state in
// applyButtonStates so we never override state-driven rules
// (e.g. btnStart should stay disabled while state.isRunning is true).
function withLock(btn, fn) {
  return async (...args) => {
    if (UI.busyButtons.has(btn)) { toast("Process already running"); return; }
    UI.busyButtons.add(btn);
    applyButtonStates();
    try { await fn(...args); }
    finally {
      UI.busyButtons.delete(btn);
      applyButtonStates();
    }
  };
}

// Single source of truth for button disabled states. Reads from UI.lastState
// (set by renderState) plus UI.busyButtons.
function applyButtonStates() {
  const s = UI.lastState || {};
  const start = $("#btnStart");
  const stop = $("#btnStop");
  const resume = $("#btnResume");
  // Block Start while still reading uploaded images — without this the
  // user could click Start mid-upload and end up with a queue that's
  // missing the trailing images that hadn't finished readAsDataURL yet.
  if (start) start.disabled = !!s.isRunning || UI.busyButtons.has(start) || !!UI.uploadingImages;
  if (stop) stop.disabled = !s.isRunning || UI.busyButtons.has(stop);
  if (resume) resume.disabled = !!s.isRunning || !s.isPaused || UI.busyButtons.has(resume);
  // Buttons without state-driven disabled rules: only block during in-flight call.
  ["#btnReset", "#btnRetryFailed", "#btnScanMedia", "#btnDownloadSelected", "#btnDownloadAll", "#btnDownloadAllVideos"]
    .forEach((sel) => {
      const el = $(sel);
      if (el) el.disabled = UI.busyButtons.has(el);
    });
}

// ---- rendering ----
function renderPromptCount() {
  const t = $("#promptTextarea").value;
  const count = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).length;
  $("#promptCount").textContent = String(count);
}

function renderImageCount() {
  $("#imageCount").textContent = String(UI.images.length);
  const grid = $("#imagePreviewGrid");
  grid.innerHTML = "";
  UI.images.forEach((img, i) => {
    const cell = document.createElement("div");
    cell.className = "cell";
    cell.innerHTML = `
      <img src="${img.dataUrl}" alt="" />
      <div class="meta">#${i + 1} ${escapeHtml(img.name || "")}</div>
      <button class="sn-mini-btn" data-remove="${i}" style="margin-top:4px;">Remove</button>
    `;
    grid.appendChild(cell);
  });
  grid.querySelectorAll("[data-remove]").forEach((b) => {
    b.addEventListener("click", () => {
      const i = Number(b.dataset.remove);
      UI.images.splice(i, 1);
      renderImageCount();
    });
  });
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Returns true when this media entry is downloadable through any of our
// paths (http/https direct, data: direct, or blob: routed through the
// content script's FETCH_BLOB_AS_DATA_URL handler). The old version of
// this helper rejected blob: URLs which made the "download from preview"
// feature useless for every Meta AI video preview — those are served as
// <video src="blob:..."> almost without exception.
function isDownloadable(m) {
  if (m && m.directDownloadable === true) return true;
  return /^(https?:|blob:|data:)/i.test(String((m && m.url) || ""));
}

function schemeBadge(m) {
  const scheme = (m && m.scheme) || "";
  if (scheme === "http" || scheme === "https") return "DIRECT";
  if (scheme === "blob") return "BLOB";
  if (scheme === "data") return "DATA";
  return scheme.toUpperCase() || "UNKNOWN";
}

function shortUrl(url) {
  const raw = String(url || "");
  if (/^blob:/i.test(raw)) {
    // blob:https://www.meta.ai/<uuid> — just show the host + short hash so
    // the cell footer stays readable instead of a 50-char UUID.
    try {
      const inner = raw.slice("blob:".length);
      const u = new URL(inner);
      return `blob:${u.hostname}/…`;
    } catch (_) {
      return raw.slice(0, 32) + "…";
    }
  }
  if (/^data:/i.test(raw)) {
    const m = /^data:([^;,]+)/.exec(raw);
    return `data:${(m && m[1]) || "?"}`;
  }
  try {
    const u = new URL(raw);
    const path = u.pathname.split("/").filter(Boolean).slice(-2).join("/");
    return `${u.hostname}/${path || ""}`.replace(/\/$/, "");
  } catch (_) {
    return raw.length > 80 ? raw.slice(0, 77) + "..." : raw;
  }
}

function mediaThumbHtml(m) {
  // Popup runs in its own document — blob: URLs from meta.ai's page are
  // scoped to that page's document and won't load in the popup. For video
  // we therefore prefer the captured `poster` (an https:// CDN URL) and
  // fall back to a placeholder card. For image we still inline the src
  // because most image previews use http(s) URLs that load anywhere.
  const url = String((m && m.url) || "");
  if (m && m.type === "video") {
    if (m.poster && /^https?:\/\//i.test(m.poster)) {
      return `<img src="${escapeHtml(m.poster)}" alt="video poster" />`;
    }
    if (/^https?:\/\//i.test(url)) {
      return `<video src="${escapeHtml(url)}" muted preload="metadata"></video>`;
    }
    return `<div class="sn-thumb-placeholder">VIDEO</div>`;
  }
  if (/^(https?:|data:)/i.test(url)) {
    return `<img src="${escapeHtml(url)}" alt="" />`;
  }
  return `<div class="sn-thumb-placeholder">IMG</div>`;
}

// Compute the badge label/color from raw state fields.
// Centralized so renderState (main view) and renderMiniView (mini window)
// can both reuse it without duplicating the precedence rules.
function computeBadge(state) {
  if (state.isRunning) return { label: "RUNNING", state: "running" };
  if (state.isPaused) return { label: "PAUSED", state: "paused" };
  if (state.lastError) return { label: "ERROR", state: "error" };
  const counts = countsOf(state.queue);
  const allDone = state.queue && state.queue.length && counts.pending === 0 && counts.paused === 0 && counts.running === 0;
  if (allDone) return { label: "DONE", state: "done" };
  return { label: "IDLE", state: "" };
}

function setBadge(el, info) {
  if (!el) return;
  el.textContent = info.label;
  el.dataset.state = info.state;
}

function renderState(state) {
  // counters
  $("#completedCount").textContent = String(state.completedCount || 0);
  $("#failedCount").textContent = String(state.failedCount || 0);
  $("#currentIndex").textContent = (state.currentIndex >= 0 ? String(state.currentIndex + 1) : "-");

  // badge (top-of-popup chip)
  const info = computeBadge(state);
  setBadge($("#statusBadge"), info);

  // Mini view (only rendered when this popup was opened with ?mini=1).
  if (UI.isMiniWindow) renderMiniView(state, info);

  // queue table
  const tbody = $("#queueTbody");
  tbody.innerHTML = "";
  (state.queue || []).forEach((item, i) => {
    const tr = document.createElement("tr");
    const promptLabel = item.kind === "image"
      ? (item.imageName ? `[img] ${escapeHtml(item.imageName)}` : `[img] image #${i + 1}`) + (item.prompt ? `\n${escapeHtml(item.prompt)}` : "")
      : escapeHtml(item.prompt || "");
    const resultCount = (item.result && item.result.media && item.result.media.length) || 0;
    const resultLabel = item.status === "failed"
      ? `<span style="color:var(--error)">${escapeHtml(item.error || "")}</span>`
      : (resultCount ? `${resultCount} media` : "-");

    tr.innerHTML = `
      <td>${i + 1}</td>
      <td><div class="prompt-cell">${promptLabel}</div></td>
      <td>${escapeHtml(item.mode || "")}</td>
      <td><span class="status-badge status-${item.status}">${item.status}</span></td>
      <td>${resultLabel}</td>
      <td>
        <div class="row-actions">
          <button class="sn-mini-btn" data-act="retry" data-id="${item.id}">Retry</button>
          <button class="sn-mini-btn" data-act="skip" data-id="${item.id}">Skip</button>
          <button class="sn-mini-btn" data-act="copy" data-id="${item.id}">Copy</button>
          <button class="sn-mini-btn" data-act="remove" data-id="${item.id}">X</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll("button[data-act]").forEach((b) => {
    b.addEventListener("click", async () => {
      const act = b.dataset.act;
      const id = b.dataset.id;
      if (act === "copy") {
        const state = await getState();
        const item = (state.queue || []).find((x) => x.id === id);
        if (item) {
          try { await navigator.clipboard.writeText(item.prompt || ""); toast("Prompt copied"); }
          catch (_) { toast("Copy failed"); }
        }
        return;
      }
      const res = await send({ type: "ITEM_ACTION", action: act, id });
      if (!res.ok) toast(res.error || "Action failed");
    });
  });

  // controls disabled states
  UI.lastState = state;
  applyButtonStates();
}

function countsOf(queue) {
  const out = { pending: 0, running: 0, completed: 0, failed: 0, paused: 0, skipped: 0 };
  (queue || []).forEach((q) => { if (out[q.status] !== undefined) out[q.status] += 1; });
  return out;
}

function renderLogs(logs) {
  const el = $("#logPanel");
  const recent = (logs || []).slice(-50);
  el.textContent = recent.map((l) => `[${l.ts}] ${l.msg}`).join("\n");
  el.scrollTop = el.scrollHeight;
}

function renderHistory(history) {
  const el = $("#historyList");
  el.innerHTML = "";
  (history || []).slice().reverse().forEach((h) => {
    const d = new Date(h.finishedAt || Date.now());
    const item = document.createElement("div");
    item.className = "item";
    item.innerHTML = `
      <div><strong>${escapeHtml(h.mode || "").toUpperCase()}</strong> — ${h.completed}/${h.total} completed, ${h.failed} failed</div>
      <div class="meta">${d.toLocaleString()} · folder: ${escapeHtml(h.subfolder || "")}</div>
    `;
    el.appendChild(item);
  });
}

function renderScannedMedia() {
  const grid = $("#mediaGrid");
  grid.innerHTML = "";
  UI.scannedMedia.forEach((m, i) => {
    const cell = document.createElement("div");
    cell.className = "cell";
    const downloadable = isDownloadable(m);
    cell.dataset.direct = downloadable ? "true" : "false";
    cell.dataset.scheme = (m && m.scheme) || "";
    const status = schemeBadge(m);
    // For blob URLs we now route through the content script — keep the
    // "Open in new tab" button disabled because chrome.tabs.create can't
    // resolve a page-scoped blob URL, but DO allow the download checkbox.
    const canOpenInTab = /^(https?:|data:)/i.test(String((m && m.url) || ""));
    cell.innerHTML = `
      ${mediaThumbHtml(m)}
      <label><input type="checkbox" data-sel="${i}" ${UI.scannedSelection.has(i) ? "checked" : ""} ${downloadable ? "" : "disabled"}/> ${escapeHtml(String(m.type || "media").toUpperCase())}</label>
      <div class="meta">${escapeHtml(status)}</div>
      <div class="meta" title="${escapeHtml(m.url)}">${escapeHtml(shortUrl(m.url))}</div>
      <div class="meta">${m.width || "?"}×${m.height || "?"}</div>
      <div class="sn-media-actions">
        <button class="sn-mini-btn" data-open="${i}" ${canOpenInTab ? "" : "disabled"}>Open</button>
        <button class="sn-mini-btn" data-copy="${i}">Copy URL</button>
      </div>
    `;
    grid.appendChild(cell);
  });
  grid.querySelectorAll("input[type=checkbox][data-sel]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const i = Number(cb.dataset.sel);
      if (cb.checked) UI.scannedSelection.add(i);
      else UI.scannedSelection.delete(i);
    });
  });
  grid.querySelectorAll("button[data-open]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const item = UI.scannedMedia[Number(btn.dataset.open)];
      if (!item) return;
      if (/^(https?:|data:)/i.test(String(item.url || ""))) {
        chrome.tabs.create({ url: item.url });
      }
    });
  });
  grid.querySelectorAll("button[data-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const item = UI.scannedMedia[Number(btn.dataset.copy)];
      if (!item) return;
      try {
        await navigator.clipboard.writeText(item.url || "");
        toast("URL copied");
      } catch (_) {
        toast("Copy failed");
      }
    });
  });
}

// ---- storage access ----
async function getState() {
  return new Promise((resolve) => {
    chrome.storage.local.get("sn_state", (res) => {
      resolve(res.sn_state || { queue: [], logs: [], history: [] });
    });
  });
}

async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get("sn_settings", (res) => resolve(res.sn_settings || {}));
  });
}

async function saveSettingsPartial(partial) {
  const cur = await getSettings();
  const next = Object.assign({}, cur, partial);
  await new Promise((resolve) => chrome.storage.local.set({ sn_settings: next }, resolve));
  return next;
}

async function savePromptTextDraft(text) {
  // Route through background to serialize all sn_state writes through the
  // service worker's saveState. Avoids cross-process read-modify-write races
  // that would otherwise clobber concurrent queue progress updates.
  await send({ type: "SAVE_PROMPT_TEXT", promptText: String(text || "") });
}

// ---- mode + tab switching ----
function setMode(mode) {
  UI.mode = mode;
  $$(".sn-tab").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  $("#i2vPanel").hidden = mode !== "image_to_video";
  // Header chip mirrors the active mode in both main and mini views.
  const tag = $("#modeTag");
  if (tag) {
    const labels = { image: "IMAGE", video: "VIDEO", image_to_video: "I2V" };
    tag.textContent = labels[mode] || String(mode || "").toUpperCase();
  }
}

// ---- menu + minimize ----
// applyMiniContext sets up the body class and dropdown options based on
// whether this popup is the regular toolbar popup (max view) or the
// separate Chrome popup window (mini view, ?mini=1).
function applyMiniContext() {
  document.body.classList.toggle("is-minimized", UI.isMiniWindow);
  $("#miniView").hidden = !UI.isMiniWindow;

  // Menu items:
  //   Main view  →  Minimize, Close Panel
  //   Mini view  →  Back to Main, Close Panel
  // The third item (whichever isn't applicable in this context) is hidden
  // outright via the [hidden] attribute, not just disabled, because the
  // mockup wants a tight 2-item menu in each context.
  const minimizeItem = document.querySelector('[data-menu="minimize"]');
  const backItem = document.querySelector('[data-menu="back"]');
  if (minimizeItem) minimizeItem.hidden = UI.isMiniWindow;
  if (backItem) backItem.hidden = !UI.isMiniWindow;
}

function toggleMenu(forceOpen) {
  const dd = $("#menuDropdown");
  const btn = $("#btnMenu");
  const open = forceOpen != null ? !!forceOpen : dd.hidden;
  dd.hidden = !open;
  btn.setAttribute("aria-expanded", open ? "true" : "false");
}

// Open (or focus) the mini popup window. Called from the main popup's
// MENU → Minimize. Closes the current popup so the user is left with
// only the draggable mini window.
async function openMiniWindow() {
  const ui = await loadUiPrefs();
  // If a previous mini window is still around, focus it instead of
  // spawning a duplicate. chrome.windows.get returns an error for
  // missing windows, which we treat as "open a fresh one".
  if (ui.miniWindowId) {
    const exists = await new Promise((resolve) => {
      chrome.windows.get(ui.miniWindowId, (w) => {
        resolve(!chrome.runtime.lastError && w);
      });
    });
    if (exists) {
      chrome.windows.update(ui.miniWindowId, { focused: true });
      window.close();
      return;
    }
  }
  const url = chrome.runtime.getURL("popup.html?mini=1");
  await new Promise((resolve) => {
    chrome.windows.create({
      url,
      type: "popup",
      width: MINI_WINDOW_WIDTH,
      height: MINI_WINDOW_HEIGHT,
      focused: true,
    }, async (win) => {
      if (!win) return resolve();
      await saveUiPrefs({ miniWindowId: win.id });
      // Some Chrome configurations (e.g. last session was maximized, or
      // launch flags like --start-maximized) cause windows.create to
      // ignore width/height and open the popup full-screen. Force a
      // normal-state resize as a follow-up so the user actually gets a
      // compact draggable panel.
      chrome.windows.update(win.id, {
        state: "normal",
        width: MINI_WINDOW_WIDTH,
        height: MINI_WINDOW_HEIGHT,
      }, () => {
        // swallow any "no such window" lastError if user closed it instantly
        const _e = chrome.runtime && chrome.runtime.lastError; void _e;
        resolve();
      });
    });
  });
  window.close();
}

// Mini → Main. Best effort: ask Chrome to open the toolbar popup, then
// close the mini window. chrome.action.openPopup is supported in MV3
// from Chrome 127+; on older builds it's a no-op and the user just
// re-clicks the toolbar icon — acceptable fallback.
async function backToMain() {
  await saveUiPrefs({ miniWindowId: null });
  try {
    if (chrome.action && typeof chrome.action.openPopup === "function") {
      chrome.action.openPopup();
    }
  } catch (_) { /* ignore — fallback is toolbar click */ }
  window.close();
}

// ---- mini view rendering + button wiring ----
function statusTextFor(state, info) {
  if (state.lastError) return state.lastError;
  if (info.state === "running") {
    const cur = state.currentIndex >= 0 ? state.currentIndex + 1 : 0;
    const total = (state.queue || []).length;
    return cur && total ? `Memproses item ${cur}/${total}` : "Memproses...";
  }
  if (info.state === "paused") return "Dijeda — klik RESUME untuk lanjut";
  if (info.state === "done") return "Semua tugas selesai";
  const total = (state.queue || []).length;
  if (total === 0) return "Tidak ada tugas dalam antrean";
  return "Siap menjalankan tugas";
}

function renderMiniView(state, info) {
  const completed = state.completedCount || 0;
  const failed = state.failedCount || 0;
  const total = (state.queue || []).length;
  const current = state.currentIndex >= 0 ? state.currentIndex + 1 : 0;
  const processed = completed + failed;
  const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;

  $("#miniDone").textContent = String(completed);
  $("#miniFail").textContent = String(failed);
  $("#miniCurrent").textContent = String(current);
  $("#miniProgressFill").style.width = percent + "%";
  $("#miniProgressLabel").textContent = percent + "%";

  setBadge($("#miniBadge"), info);
  $("#miniStatusText").textContent = statusTextFor(state, info);

  // Update mini control button disabled states. Mirror applyButtonStates
  // logic so the user gets the same affordances in both views.
  const isRunning = !!state.isRunning;
  const isPaused = !!state.isPaused;
  const failedExists = (state.queue || []).some((q) => q.status === "failed");
  const runningItem = (state.queue || []).find((q) => q.status === "running" || q.status === "paused");

  const miniStart = $("#miniBtnStart");
  const miniStop = $("#miniBtnStop");
  const miniResume = $("#miniBtnResume");
  const miniRetry = $("#miniBtnRetry");
  const miniSkip = $("#miniBtnSkip");
  // Start: enabled only when not running and there are queue items at all.
  // The user explicitly asked for the controls in mini view to drive the
  // existing queue, so we don't accept new prompts/images here — just
  // resume work on whatever's already in sn_state.
  if (miniStart) miniStart.disabled = isRunning || total === 0 || (processed >= total && total > 0);
  if (miniStop) miniStop.disabled = !isRunning;
  if (miniResume) miniResume.disabled = isRunning || !isPaused;
  if (miniRetry) miniRetry.disabled = !failedExists;
  if (miniSkip) miniSkip.disabled = !runningItem;
}

function renderMiniLog(logs) {
  const last = (logs || []).slice(-1)[0];
  const el = $("#miniLog");
  if (!el) return;
  if (last) el.textContent = `[${last.ts}] ${last.msg}`;
  else el.textContent = "[--:--:--] No activity yet.";
}

// ---- build queue from UI and push to background ----
async function pushQueueFromUi() {
  const text = $("#promptTextarea").value;
  const mode = UI.mode;
  let queue = [];
  if (mode === "image_to_video") {
    // I2V supports bulk image upload. The prompt is optional; if the user
    // provides nothing, fall back to "imagine it" (Meta AI's animate-this
    // default phrasing). If the user provides ONE prompt line, broadcast
    // it to all images. If they provide multiple lines, pair positionally.
    const prompts = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const I2V_DEFAULT = "imagine it";
    const shared = prompts.length === 1 ? prompts[0] : (prompts[0] || I2V_DEFAULT);
    if (UI.images.length === 0) {
      toast("Upload images first");
      return false;
    }
    const items = UI.images.map((img, i) => {
      let p = prompts.length > 1 ? (prompts[i] != null ? prompts[i] : shared) : shared;
      if (!p) p = I2V_DEFAULT;
      return { dataUrl: img.dataUrl, name: img.name, prompt: p };
    });
    const i2vQueue = items.map((img) => ({
      id: "q_" + Math.random().toString(36).slice(2, 10),
      kind: "image",
      prompt: img.prompt,
      imageDataUrl: img.dataUrl,
      imageName: img.name,
      mode,
      status: "pending",
      result: null, error: null,
    }));
    queue = i2vQueue;
  } else {
    const prompts = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (prompts.length === 0) { toast("Add prompts first"); return false; }
    queue = prompts.map((p) => ({
      id: "q_" + Math.random().toString(36).slice(2, 10),
      kind: "prompt",
      prompt: p,
      mode,
      status: "pending",
      result: null, error: null,
    }));
  }
  const res = await send({ type: "SET_QUEUE", queue, mode, promptText: text });
  if (!res.ok) {
    // Surface the failure (e.g. chrome.storage.local QUOTA_BYTES exceeded
    // when an I2V queue holds many big base64 image data URLs). Without
    // this, Start would silently do nothing and the user only sees an
    // empty queue table.
    toast(res.error || "Failed to push queue");
  }
  return res.ok;
}

// ---- init / binding ----
async function init() {
  // Decide mini-vs-main context first; some renderers branch on UI.isMiniWindow.
  applyMiniContext();

  // Load persisted state
  const [state, settings] = await Promise.all([getState(), getSettings()]);

  // textarea + promptText draft (only matters in main view, but mini view
  // also writes through main's element since it lives in the same DOM).
  if (state.promptText) $("#promptTextarea").value = state.promptText;
  renderPromptCount();
  renderState(state);
  renderLogs(state.logs);
  renderMiniLog(state.logs);
  renderHistory(state.history);

  // Mode from state
  setMode(state.mode || "image");

  // Header MENU dropdown
  $("#btnMenu").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenu();
  });
  document.addEventListener("click", (e) => {
    // Close dropdown when clicking outside.
    const dd = $("#menuDropdown");
    if (dd.hidden) return;
    if (e.target.closest && (e.target.closest("#menuDropdown") || e.target.closest("#btnMenu"))) return;
    toggleMenu(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") toggleMenu(false);
  });
  $$(".sn-menu-item").forEach((it) => {
    it.addEventListener("click", async () => {
      const action = it.dataset.menu;
      toggleMenu(false);
      if (action === "minimize") {
        // Spawn a draggable Chrome popup window in mini mode.
        await openMiniWindow();
      } else if (action === "back") {
        // Re-open the main toolbar popup, close this mini window.
        await backToMain();
      } else if (action === "close") {
        // Close popup. The run loop lives in background.js so the queue
        // keeps running — only the UI window is dismissed.
        if (UI.isMiniWindow) await saveUiPrefs({ miniWindowId: null });
        window.close();
      }
    });
  });

  // Mini view button wiring — each button drives the same queue commands
  // used by the main view, but resolved via direct send() calls so the
  // main #btnStart click handler (which would also try to push the
  // textarea queue) doesn't run from the mini context.
  if (UI.isMiniWindow) wireMiniControls();

  // Settings
  $("#inputDelay").value = settings.delaySec ?? 3;
  $("#inputMaxBatch").value = settings.maxBatch ?? 10;
  $("#inputTimeout").value = settings.timeoutSec ?? 180;
  $("#inputFilenamePattern").value = settings.filenamePattern ?? "sn_meta_{type}_{index}_{date}";
  $("#inputSubfolder").value = settings.subfolder ?? "SN_Meta_Auto";
  $("#inputStopOnError").checked = !!settings.stopOnError;
  $("#inputAutoDownload").checked = !!settings.autoDownload;

  // Settings wire-up
  const onSettingChange = async () => {
    await saveSettingsPartial({
      delaySec: Number($("#inputDelay").value) || 0,
      maxBatch: Number($("#inputMaxBatch").value) || 10,
      timeoutSec: Number($("#inputTimeout").value) || 180,
      filenamePattern: $("#inputFilenamePattern").value || "sn_meta_{type}_{index}_{date}",
      subfolder: $("#inputSubfolder").value || "SN_Meta_Auto",
      stopOnError: $("#inputStopOnError").checked,
      autoDownload: $("#inputAutoDownload").checked,
    });
  };
  ["#inputDelay","#inputMaxBatch","#inputTimeout","#inputFilenamePattern","#inputSubfolder","#inputStopOnError","#inputAutoDownload"].forEach((sel) => {
    const el = $(sel);
    el.addEventListener("change", onSettingChange);
    el.addEventListener("input", onSettingChange);
  });

  // Prompt textarea
  $("#promptTextarea").addEventListener("input", () => {
    renderPromptCount();
    clearTimeout(init._t);
    init._t = setTimeout(() => savePromptTextDraft($("#promptTextarea").value), 300);
  });
  $("#btnClearPrompts").addEventListener("click", () => {
    $("#promptTextarea").value = "";
    renderPromptCount();
    savePromptTextDraft("");
  });

  $("#btnUploadTxt").addEventListener("click", () => $("#fileTxtInput").click());
  $("#fileTxtInput").addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const text = await f.text();
    const current = $("#promptTextarea").value;
    const merged = (current && !current.endsWith("\n") ? current + "\n" : current) + text;
    $("#promptTextarea").value = merged;
    renderPromptCount();
    savePromptTextDraft(merged);
    e.target.value = "";
    toast(".TXT loaded");
  });

  // Mode tabs
  $$(".sn-tab").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));

  // Image uploads (I2V)
  $("#btnUploadImages").addEventListener("click", () => $("#fileImageInput").click());
  $("#fileImageInput").addEventListener("change", async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    UI.uploadingImages = true;
    applyButtonStates();
    try {
      // Read in parallel — sequential awaits made bulk uploads of many
      // large files unnecessarily slow and widened the race where a
      // user could click Start before all dataUrls were appended.
      const reads = await Promise.all(files.map(async (f) => ({
        dataUrl: await readAsDataUrl(f),
        name: f.name,
      })));
      for (const r of reads) UI.images.push(r);
      renderImageCount();
    } finally {
      UI.uploadingImages = false;
      e.target.value = "";
      applyButtonStates();
    }
  });
  $("#btnClearImages").addEventListener("click", () => { UI.images = []; renderImageCount(); });

  // Controls
  $("#btnStart").addEventListener("click", withLock($("#btnStart"), async () => {
    const ok = await pushQueueFromUi();
    if (!ok) return;
    const res = await send({ type: "START" });
    if (!res.ok) toast(res.error || "Start failed");
  }));
  $("#btnStop").addEventListener("click", withLock($("#btnStop"), async () => {
    const res = await send({ type: "STOP" });
    if (!res.ok) toast(res.error || "Stop failed");
  }));
  $("#btnResume").addEventListener("click", withLock($("#btnResume"), async () => {
    const res = await send({ type: "RESUME" });
    if (!res.ok) toast(res.error || "Resume failed");
  }));
  $("#btnReset").addEventListener("click", withLock($("#btnReset"), async () => {
    if (!confirm("Reset queue? This clears all progress.")) return;
    const res = await send({ type: "RESET" });
    if (!res.ok) toast(res.error || "Reset failed");
  }));
  $("#btnRetryFailed").addEventListener("click", withLock($("#btnRetryFailed"), async () => {
    const res = await send({ type: "RETRY_FAILED" });
    if (!res.ok) toast(res.error || "Retry failed");
  }));

  // Tools
  $("#btnScanMedia").addEventListener("click", withLock($("#btnScanMedia"), async () => {
    const res = await send({ type: "SCAN_MEDIA_POPUP" });
    if (!res.ok) { toast(res.error || "Scan failed"); return; }
    UI.scannedMedia = res.media || [];
    // Select every downloadable item (http/data/blob) by default — blob:
    // previews are downloadable now via the content-script fetch path.
    UI.scannedSelection = new Set(
      UI.scannedMedia
        .map((m, i) => isDownloadable(m) ? i : -1)
        .filter((i) => i >= 0)
    );
    renderScannedMedia();
    const videoCount = UI.scannedMedia.filter((m) => m && m.type === "video").length;
    toast(`Found ${UI.scannedMedia.length} media (${videoCount} video, ${UI.scannedSelection.size} downloadable)`);
  }));
  $("#btnDownloadSelected").addEventListener("click", withLock($("#btnDownloadSelected"), async () => {
    const items = Array.from(UI.scannedSelection)
      .map((i) => UI.scannedMedia[i])
      .filter((m) => m && isDownloadable(m));
    if (!items.length) { toast("Select downloadable media first"); return; }
    const settings = await getSettings();
    const res = await send({ type: "DOWNLOAD_MEDIA", items, settings });
    if (res.ok) toast(`Downloaded ${res.downloaded}/${items.length}${res.failed ? ` (${res.failed} failed)` : ""}`);
    else toast(res.error || "Download failed");
  }));
  $("#btnDownloadAll").addEventListener("click", withLock($("#btnDownloadAll"), async () => {
    if (!UI.scannedMedia.length) { toast("Scan first"); return; }
    const settings = await getSettings();
    const items = UI.scannedMedia.filter(isDownloadable);
    if (!items.length) { toast("No downloadable previews found"); return; }
    const res = await send({ type: "DOWNLOAD_MEDIA", items, settings });
    if (res.ok) toast(`Downloaded ${res.downloaded}/${items.length}${res.failed ? ` (${res.failed} failed)` : ""}`);
    else toast(res.error || "Download failed");
  }));

  // "Download All Videos" — one-click shortcut for the user's primary
  // use case (batch-saving every video preview on screen). Auto-scans
  // when the grid is empty so the user doesn't have to click Scan first.
  $("#btnDownloadAllVideos").addEventListener("click", withLock($("#btnDownloadAllVideos"), async () => {
    if (!UI.scannedMedia.length) {
      const scan = await send({ type: "SCAN_MEDIA_POPUP" });
      if (!scan.ok) { toast(scan.error || "Scan failed"); return; }
      UI.scannedMedia = scan.media || [];
      UI.scannedSelection = new Set(
        UI.scannedMedia.map((m, i) => isDownloadable(m) ? i : -1).filter((i) => i >= 0)
      );
      renderScannedMedia();
    }
    const videos = UI.scannedMedia.filter((m) => m && m.type === "video" && isDownloadable(m));
    if (!videos.length) { toast("No downloadable video previews found"); return; }
    const settings = await getSettings();
    const res = await send({ type: "DOWNLOAD_MEDIA", items: videos, settings });
    if (res.ok) toast(`Downloaded ${res.downloaded}/${videos.length} videos${res.failed ? ` (${res.failed} failed)` : ""}`);
    else toast(res.error || "Download failed");
  }));

  // Logs / history — route through background so all sn_state writes are
  // serialized in the service worker (no cross-process race with queue updates).
  $("#btnClearLogs").addEventListener("click", async () => {
    const res = await send({ type: "CLEAR_LOGS" });
    if (res.ok) renderLogs([]);
    else toast(res.error || "Clear logs failed");
  });
  $("#btnClearHistory").addEventListener("click", async () => {
    const res = await send({ type: "CLEAR_HISTORY" });
    if (res.ok) renderHistory([]);
    else toast(res.error || "Clear history failed");
  });

  // Live updates
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.sn_state) {
      const ns = changes.sn_state.newValue || {};
      renderState(ns);
      renderLogs(ns.logs || []);
      renderMiniLog(ns.logs || []);
      renderHistory(ns.history || []);
    }
  });
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "STATE_UPDATED" || msg.type === "LOG_UPDATED") {
      getState().then((s) => {
        renderState(s);
        renderLogs(s.logs || []);
        renderMiniLog(s.logs || []);
        renderHistory(s.history || []);
      });
    }
  });
}

// Mini view button handlers. Routed straight through send() rather than
// dispatching click() on the main #btnStart, because the main Start
// handler also runs pushQueueFromUi() (which expects the textarea + I2V
// uploader UI). Mini view never edits the queue — it just controls the
// already-pushed sn_state.queue.
function wireMiniControls() {
  const start = $("#miniBtnStart");
  const stop = $("#miniBtnStop");
  const resume = $("#miniBtnResume");
  const retry = $("#miniBtnRetry");
  const skip = $("#miniBtnSkip");

  if (start) start.addEventListener("click", async () => {
    start.disabled = true;
    const res = await send({ type: "START" });
    if (!res.ok) toast(res.error || "Start failed");
  });
  if (stop) stop.addEventListener("click", async () => {
    stop.disabled = true;
    const res = await send({ type: "STOP" });
    if (!res.ok) toast(res.error || "Stop failed");
  });
  if (resume) resume.addEventListener("click", async () => {
    resume.disabled = true;
    const res = await send({ type: "RESUME" });
    if (!res.ok) toast(res.error || "Resume failed");
  });
  if (retry) retry.addEventListener("click", async () => {
    retry.disabled = true;
    const res = await send({ type: "RETRY_FAILED" });
    if (!res.ok) toast(res.error || "Retry failed");
  });
  if (skip) skip.addEventListener("click", async () => {
    // Skip the currently running/paused item, falling back to the first
    // pending one if no item is in-flight (e.g. user paused before Start).
    const state = await getState();
    const target =
      (state.queue || []).find((q) => q.status === "running" || q.status === "paused") ||
      (state.queue || []).find((q) => q.status === "pending");
    if (!target) { toast("No item to skip"); return; }
    skip.disabled = true;
    const res = await send({ type: "ITEM_ACTION", action: "skip", id: target.id });
    if (!res.ok) toast(res.error || "Skip failed");
  });
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

document.addEventListener("DOMContentLoaded", init);
