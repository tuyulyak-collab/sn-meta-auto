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
  if (start) start.disabled = !!s.isRunning || UI.busyButtons.has(start);
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

function renderState(state) {
  // counters
  $("#completedCount").textContent = String(state.completedCount || 0);
  $("#failedCount").textContent = String(state.failedCount || 0);
  $("#currentIndex").textContent = (state.currentIndex >= 0 ? String(state.currentIndex + 1) : "-");

  // badge
  const badge = $("#statusBadge");
  if (state.isRunning) { badge.textContent = "RUNNING"; badge.dataset.state = "running"; }
  else if (state.isPaused) { badge.textContent = "PAUSED"; badge.dataset.state = "paused"; }
  else if (state.lastError) { badge.textContent = "ERROR"; badge.dataset.state = "error"; }
  else {
    const counts = countsOf(state.queue);
    const allDone = state.queue && state.queue.length && counts.pending === 0 && counts.paused === 0 && counts.running === 0;
    if (allDone) { badge.textContent = "DONE"; badge.dataset.state = "done"; }
    else { badge.textContent = "IDLE"; badge.dataset.state = ""; }
  }

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
    const id = `scan_${i}`;
    const cell = document.createElement("div");
    cell.className = "cell";
    const thumb = m.type === "video"
      ? `<video src="${m.url}" muted preload="metadata"></video>`
      : `<img src="${m.url}" alt="" />`;
    cell.innerHTML = `
      ${thumb}
      <label><input type="checkbox" data-sel="${i}" ${UI.scannedSelection.has(i) ? "checked" : ""}/> ${m.type.toUpperCase()}</label>
      <div class="meta">${m.width || "?"}×${m.height || "?"}</div>
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
  return res.ok;
}

// ---- init / binding ----
async function init() {
  // Load persisted state
  const [state, settings] = await Promise.all([getState(), getSettings()]);

  // textarea + promptText draft
  if (state.promptText) $("#promptTextarea").value = state.promptText;
  renderPromptCount();
  renderState(state);
  renderLogs(state.logs);
  renderHistory(state.history);

  // Mode from state
  setMode(state.mode || "image");

  // Settings
  $("#inputDelay").value = settings.delaySec ?? 3;
  $("#inputMaxBatch").value = settings.maxBatch ?? 10;
  $("#inputTimeout").value = settings.timeoutSec ?? 180;
  // Filename pattern + subfolder use placeholders for the defaults so a fresh
  // install shows the hint text. Only pre-fill when the user has saved a
  // non-default value previously.
  $("#inputFilenamePattern").value = settings.filenamePattern && settings.filenamePattern !== "sn_meta_{type}_{index}_{date}" ? settings.filenamePattern : "";
  $("#inputSubfolder").value = settings.subfolder && settings.subfolder !== "SN_Meta_Auto" ? settings.subfolder : "";
  $("#inputStopOnError").checked = !!settings.stopOnError;
  $("#inputAutoDownload").checked = !!settings.autoDownload;

  // Settings wire-up
  const onSettingChange = async () => {
    await saveSettingsPartial({
      delaySec: Number($("#inputDelay").value) || 0,
      maxBatch: Number($("#inputMaxBatch").value) || 10,
      timeoutSec: Number($("#inputTimeout").value) || 180,
      // Persist the user's actual input (or empty); downloader fallbacks to
      // the documented defaults when the field is empty / whitespace.
      filenamePattern: $("#inputFilenamePattern").value.trim(),
      subfolder: $("#inputSubfolder").value.trim(),
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
    for (const f of files) {
      const dataUrl = await readAsDataUrl(f);
      UI.images.push({ dataUrl, name: f.name });
    }
    renderImageCount();
    e.target.value = "";
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

  // Open the user's default Downloads folder in the OS file explorer.
  // Chrome extensions can't pick a folder outside Downloads, but they can at
  // least surface the existing one so the user can navigate to the configured
  // subfolder.
  const btnOpenDownloads = $("#btnOpenDownloads");
  if (btnOpenDownloads) {
    btnOpenDownloads.addEventListener("click", () => {
      try {
        if (chrome.downloads && typeof chrome.downloads.showDefaultFolder === "function") {
          chrome.downloads.showDefaultFolder();
        } else {
          toast("chrome.downloads.showDefaultFolder is unavailable");
        }
      } catch (e) {
        toast("Failed to open Downloads folder");
      }
    });
  }

  // Tools
  $("#btnScanMedia").addEventListener("click", withLock($("#btnScanMedia"), async () => {
    const res = await send({ type: "SCAN_MEDIA_POPUP" });
    if (!res.ok) { toast(res.error || "Scan failed"); return; }
    UI.scannedMedia = res.media || [];
    UI.scannedSelection = new Set(UI.scannedMedia.map((_, i) => i)); // select all by default
    renderScannedMedia();
    toast(`Found ${UI.scannedMedia.length} media`);
  }));
  $("#btnDownloadSelected").addEventListener("click", withLock($("#btnDownloadSelected"), async () => {
    const items = Array.from(UI.scannedSelection).map((i) => UI.scannedMedia[i]).filter(Boolean);
    if (!items.length) { toast("Select media first"); return; }
    const settings = await getSettings();
    const res = await send({ type: "DOWNLOAD_MEDIA", items, settings });
    if (res.ok) toast(`Downloaded ${res.downloaded}/${items.length}`);
    else toast(res.error || "Download failed");
  }));
  $("#btnDownloadAll").addEventListener("click", withLock($("#btnDownloadAll"), async () => {
    if (!UI.scannedMedia.length) { toast("Scan first"); return; }
    const settings = await getSettings();
    const res = await send({ type: "DOWNLOAD_MEDIA", items: UI.scannedMedia, settings });
    if (res.ok) toast(`Downloaded ${res.downloaded}/${UI.scannedMedia.length}`);
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
