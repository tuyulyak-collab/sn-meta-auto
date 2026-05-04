/* popup.js — UI for SN Meta Auto */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// Runtime UI-only state. The popup is now a single-context UI — the old
// PR #6 "separate Chrome popup window via chrome.windows.create({?mini=1})"
// has been replaced by the injected floating overlay (see floatingPanel.js).
const UI = {
  mode: "image",
  images: [], // [{ dataUrl, name, prompt? }]
  scannedMedia: [],
  // Selection is keyed by URL rather than array index so that flipping the
  // media-type filter (which hides rows from .scannedMedia) doesn't silently
  // toggle which items "Download Selected" will act on.
  scannedSelection: new Set(),
  // Active client-side filter for the media scanner: "all" | "image" | "video".
  mediaFilter: "all",
  busyButtons: new Set(),
  lastState: null, // last rendered state — used by applyButtonStates after lock release
};

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
  // After STOP the queue is paused: START stays disabled (RESUME is the
  // correct affordance for resuming a paused queue without rebuilding it).
  if (start) start.disabled = !!s.isRunning || !!s.isPaused || UI.busyButtons.has(start) || !!UI.uploadingImages;
  if (stop) stop.disabled = !s.isRunning || UI.busyButtons.has(stop);
  if (resume) resume.disabled = !!s.isRunning || !s.isPaused || UI.busyButtons.has(resume);
  // Buttons without state-driven disabled rules: only block during in-flight call.
  ["#btnReset", "#btnRetryFailed", "#btnScanMedia", "#btnDownloadSelected", "#btnDownloadAll"]
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

// Compute the badge label/color from raw state fields. Centralized so
// the popup and the injected floating panel can reuse the same precedence.
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

// Filter the scanned media list by the active type filter. Hidden items
// keep their selection state so toggling the filter doesn't lose it.
function visibleScannedMedia() {
  if (UI.mediaFilter === "all") return UI.scannedMedia;
  return UI.scannedMedia.filter((m) => m.type === UI.mediaFilter);
}

function renderScannedMedia() {
  const grid = $("#mediaGrid");
  grid.innerHTML = "";
  const visible = visibleScannedMedia();
  visible.forEach((m) => {
    const cell = document.createElement("div");
    cell.className = "cell";
    // Video cells preview live: autoplay muted in a loop so the user
    // can scrub-by-glance which mp4 is which without clicking through.
    // `playsinline` keeps it in the cell on iOS; `muted` is required for
    // autoplay to fire under Chrome's autoplay policy. `disablepictureinpicture`
    // and the empty controlsList stop accidental fullscreen/PiP from a
    // stray click, since the cell already has a checkbox label on top.
    const thumb = m.type === "video"
      ? `<video src="${m.url}" autoplay loop muted playsinline preload="auto" disablepictureinpicture controlslist="nodownload nofullscreen noremoteplayback"></video>`
      : `<img src="${m.url}" alt="" />`;
    const checked = UI.scannedSelection.has(m.url) ? "checked" : "";
    cell.innerHTML = `
      ${thumb}
      <label><input type="checkbox" data-url="${escapeHtml(m.url)}" ${checked}/> ${m.type.toUpperCase()}</label>
      <div class="meta">${m.width || "?"}×${m.height || "?"}</div>
    `;
    grid.appendChild(cell);
  });
  grid.querySelectorAll("input[type=checkbox][data-url]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const url = cb.dataset.url;
      if (cb.checked) UI.scannedSelection.add(url);
      else UI.scannedSelection.delete(url);
    });
  });
  const counter = $("#mediaCount");
  if (counter) {
    const total = UI.scannedMedia.length;
    counter.textContent = visible.length === total
      ? `${total} item${total === 1 ? "" : "s"}`
      : `${visible.length}/${total} shown`;
  }
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
  // Header chip reflects the current mode tag.
  const tag = $("#modeTag");
  if (tag) {
    const labels = { image: "IMAGE", video: "VIDEO", image_to_video: "I2V" };
    tag.textContent = labels[mode] || String(mode || "").toUpperCase();
  }
}

// ---- menu ----
function toggleMenu(forceOpen) {
  const dd = $("#menuDropdown");
  const btn = $("#btnMenu");
  const open = forceOpen != null ? !!forceOpen : dd.hidden;
  dd.hidden = !open;
  btn.setAttribute("aria-expanded", open ? "true" : "false");
}

// Open the floating overlay inside the active meta.ai tab. The actual
// inject + show is done by background.js → chrome.scripting.executeScript;
// the popup just kicks it off and stays open so the user can keep editing
// the queue while the panel runs alongside.
async function openFloatingPanel() {
  const res = await send({ type: "OPEN_FLOATING_PANEL" });
  if (!res.ok) {
    toast(res.error || "Failed to open floating panel");
    return;
  }
  toast("Floating panel opened on meta.ai");
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
  // Load persisted state
  const [state, settings] = await Promise.all([getState(), getSettings()]);

  if (state.promptText) $("#promptTextarea").value = state.promptText;
  renderPromptCount();
  renderState(state);
  renderLogs(state.logs);
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
      if (action === "open-floating") {
        // Inject the floating overlay into the meta.ai tab. Popup stays open
        // so the user can keep editing the queue alongside the panel.
        await openFloatingPanel();
      } else if (action === "close") {
        // Close popup. The run loop lives in background.js so the queue
        // keeps running — only the popup UI is dismissed.
        window.close();
      }
    });
  });

  // Settings. The previous "Max batch (I2V)" knob has been removed because
  // the run loop no longer hard-stops at 10 items — I2V auto-continues
  // through the whole queue. Existing settings.maxBatch values are still
  // tolerated by storage.js DEFAULT_SETTINGS but no longer surfaced here.
  $("#inputDelay").value = settings.delaySec ?? 3;
  $("#inputTimeout").value = settings.timeoutSec ?? 180;
  $("#inputFilenamePattern").value = settings.filenamePattern ?? "sn_meta_{type}_{index}_{date}";
  $("#inputSubfolder").value = settings.subfolder ?? "SN_Meta_Auto";
  $("#inputStopOnError").checked = !!settings.stopOnError;
  $("#inputAutoDownload").checked = !!settings.autoDownload;
  // videoSettleSec: how long the run loop waits after a <video> appears in
  // I2V mode before grabbing the URL for auto-download. Meta AI mounts the
  // <video> element a moment before the actual mp4 src settles, and a
  // poster <img> for the user's *input* image can co-exist briefly. Giving
  // the page a few seconds to settle and re-scanning is the most reliable
  // way to ensure the downloaded URL is the generated mp4, not a poster
  // jpg or the user's uploaded seed image.
  $("#inputVideoSettle").value = settings.videoSettleSec ?? 3;

  // Settings wire-up
  const onSettingChange = async () => {
    await saveSettingsPartial({
      delaySec: Number($("#inputDelay").value) || 0,
      timeoutSec: Number($("#inputTimeout").value) || 180,
      filenamePattern: $("#inputFilenamePattern").value || "sn_meta_{type}_{index}_{date}",
      subfolder: $("#inputSubfolder").value || "SN_Meta_Auto",
      stopOnError: $("#inputStopOnError").checked,
      autoDownload: $("#inputAutoDownload").checked,
      videoSettleSec: Math.max(0, Number($("#inputVideoSettle").value) || 0),
    });
  };
  ["#inputDelay","#inputTimeout","#inputFilenamePattern","#inputSubfolder","#inputStopOnError","#inputAutoDownload","#inputVideoSettle"].forEach((sel) => {
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
    // Select all visible items by default. Visibility is determined by the
    // current type filter; switching filter later doesn't drop selections
    // because we key the Set by URL (see scannedSelection comment).
    UI.scannedSelection = new Set(visibleScannedMedia().map((m) => m.url));
    renderScannedMedia();
    toast(`Found ${UI.scannedMedia.length} media`);
  }));
  $("#btnDownloadSelected").addEventListener("click", withLock($("#btnDownloadSelected"), async () => {
    // Operate on the currently-visible+selected intersection so the user's
    // intent ("download what's checked in this view") is preserved across
    // filter changes.
    const visible = visibleScannedMedia();
    const items = visible.filter((m) => UI.scannedSelection.has(m.url));
    if (!items.length) { toast("Select media first"); return; }
    const settings = await getSettings();
    const res = await send({ type: "DOWNLOAD_MEDIA", items, settings });
    if (res.ok) toast(`Downloaded ${res.downloaded}/${items.length}`);
    else toast(res.error || "Download failed");
  }));
  $("#btnDownloadAll").addEventListener("click", withLock($("#btnDownloadAll"), async () => {
    // "Download All" respects the active filter — if the user has "Videos
    // only" picked, this downloads only the videos. The button label stays
    // generic so the row doesn't grow when the filter changes.
    const items = visibleScannedMedia();
    if (!items.length) { toast(UI.scannedMedia.length ? "Nothing matches the active filter" : "Scan first"); return; }
    const settings = await getSettings();
    const res = await send({ type: "DOWNLOAD_MEDIA", items, settings });
    if (res.ok) toast(`Downloaded ${res.downloaded}/${items.length}`);
    else toast(res.error || "Download failed");
  }));
  // Media-type filter dropdown. Changes are pure UI — no storage write,
  // no re-scan — so it's instant and survives until the popup closes.
  const mediaFilterEl = $("#mediaFilter");
  if (mediaFilterEl) {
    mediaFilterEl.value = UI.mediaFilter;
    mediaFilterEl.addEventListener("change", () => {
      UI.mediaFilter = mediaFilterEl.value || "all";
      renderScannedMedia();
    });
  }

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
      renderHistory(ns.history || []);
    }
  });
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "STATE_UPDATED" || msg.type === "LOG_UPDATED") {
      getState().then((s) => {
        renderState(s);
        renderLogs(s.logs || []);
        renderHistory(s.history || []);
      });
    }
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
