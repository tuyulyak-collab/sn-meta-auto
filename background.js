/* background.js (service worker, type: module)
 * Orchestrates the queue and owns long-running state.
 * Imports shared utils via importScripts.
 */

try {
  self.importScripts(
    "utils/storage.js",
    "utils/queueManager.js",
    "utils/downloader.js"
  );
} catch (e) {
  console.error("[SN Meta Auto] importScripts failed", e);
}

const S = self.SNStorage;
const Q = self.SNQueue;
const D = self.SNDownloader;

// In-memory runtime flags (mirror persistent state.isRunning/isPaused)
const RT = {
  running: false,
  stopRequested: false,
  currentTabId: null,
};

// Tracks the in-flight runLoop() promise so handleReset can await it
// before clearing the queue. This prevents (a) two concurrent runLoop
// instances and (b) processOne mid-flight clobbering the cleared
// queue back into storage via S.saveState.
let runLoopPromise = null;

function startRunLoop() {
  if (runLoopPromise) return runLoopPromise;
  runLoopPromise = (async () => {
    try { await runLoop(); }
    catch (e) { console.error("[SN Meta Auto bg] runLoop crashed", e); }
    finally { runLoopPromise = null; }
  })();
  return runLoopPromise;
}

function now() { return new Date().toISOString().slice(11, 19); }

async function log(msg) {
  console.debug("[SN Meta Auto bg]", msg);
  await S.appendLog(msg);
  broadcast({ type: "LOG_UPDATED" });
}

function broadcast(payload) {
  try {
    const p = chrome.runtime.sendMessage(payload, () => {
      // swallow lastError when no popup is listening
      const _err = chrome.runtime && chrome.runtime.lastError;
      void _err;
    });
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch (_) { /* popup may be closed */ }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function findMetaTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ url: ["https://www.meta.ai/*", "https://*.meta.ai/*"] }, (tabs) => {
      const active = (tabs || []).find((t) => t.active) || (tabs || [])[0];
      resolve(active || null);
    });
  });
}

function sendToTab(tabId, message) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, message, (res) => {
        const err = chrome.runtime && chrome.runtime.lastError;
        if (err) return resolve({ ok: false, error: err.message });
        resolve(res || { ok: false, error: "empty response" });
      });
    } catch (e) {
      resolve({ ok: false, error: String((e && e.message) || e) });
    }
  });
}

async function ensureContentScript(tabId) {
  // Try a ping; if it fails, inject the scripts programmatically.
  const ping = await sendToTab(tabId, { type: "PING" });
  if (ping && ping.ok) return true;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["utils/domScanner.js", "content.js"],
    });
    const ping2 = await sendToTab(tabId, { type: "PING" });
    return !!(ping2 && ping2.ok);
  } catch (e) {
    console.warn("[SN Meta Auto bg] inject failed", e);
    return false;
  }
}

async function getMetaTabOrFail() {
  const tab = await findMetaTab();
  if (!tab) {
    throw new Error("Meta AI tab not found. Open https://www.meta.ai/ first.");
  }
  RT.currentTabId = tab.id;
  const ok = await ensureContentScript(tab.id);
  if (!ok) throw new Error("Failed to inject content script into meta.ai tab.");
  return tab;
}

// Centralized download dispatcher. Hides the difference between URLs the
// service worker can fetch directly (http/https/data) and blob: URLs that
// must be resolved by the content script first. Used by both the auto-
// download path inside processOne and the manual handleDownloadMedia
// path so the two never drift out of sync.
//
// Returns the final URL string to hand to chrome.downloads.download and a
// `mimeType` hint that lets renderFilename pick a sensible extension when
// the source URL is a blob/data: URL with no path-based extension.
async function resolveDownloadUrl(url, tabId) {
  const raw = String(url || "");
  const check = D.canDownloadUrl(raw);
  if (!check.ok) throw new Error(check.reason);
  if (!check.needsContentScript) return { url: raw, mimeType: "" };
  // blob: URL — hand off to the content script in the Meta AI tab so it
  // can fetch the blob (blob URLs are document-scoped) and return a data
  // URL that the SW can hand to chrome.downloads.download.
  let targetTabId = tabId;
  if (!targetTabId) {
    const tab = await findMetaTab();
    if (!tab) throw new Error("Meta AI tab not found. Open https://www.meta.ai/ first.");
    const okInject = await ensureContentScript(tab.id);
    if (!okInject) throw new Error("Content script not available in meta.ai tab.");
    targetTabId = tab.id;
  }
  const res = await sendToTab(targetTabId, { type: "FETCH_BLOB_AS_DATA_URL", url: raw });
  if (!res || !res.ok) throw new Error((res && res.error) || "Failed to fetch blob");
  return { url: res.dataUrl, mimeType: res.mimeType || "" };
}

async function processOne(state, settings, index) {
  const item = state.queue[index];
  if (!item) return { ok: false, error: "No item at index" };
  // Capture the item ID so post-processing in runLoop can find this exact
  // item even if the user removed/reordered queue entries during the run.
  const itemId = item.id;

  // Mark RUNNING by ID against the LATEST queue (don't write back the
  // cached pre-call snapshot — that would clobber concurrent
  // handleItemAction or handleReset writes).
  {
    const fresh = await S.getState();
    const i = fresh.queue.findIndex((q) => q.id === itemId);
    if (i >= 0) {
      fresh.queue[i] = Object.assign({}, fresh.queue[i], { status: Q.STATUSES.RUNNING });
      await S.saveState({ queue: fresh.queue, currentIndex: i });
    }
  }
  broadcast({ type: "STATE_UPDATED" });

  const tab = await getMetaTabOrFail();

  // Baseline media for completion detection
  const scanBefore = await sendToTab(tab.id, { type: "SCAN_MEDIA" });
  const baseline = (scanBefore && scanBefore.ok && scanBefore.media) ? scanBefore.media.map((m) => m.url) : [];

  // 1) If image-to-video and we have an image data URL, try to upload it first.
  // NOTE: Meta AI's I2V flow accepts a maximum of 1 image per turn — uploading
  // 5+ images in a single turn causes Meta to silently drop everything past
  // the first. Each queue item therefore performs its own upload + Send,
  // i.e. 10 input images => 10 sequential turns (not one turn with 10
  // attachments). This is enforced by the queue structure: each I2V queue
  // entry has exactly one imageDataUrl.
  if (item.kind === "image" && item.imageDataUrl) {
    await log(`Item #${index + 1}: uploading image ${item.imageName || ""}`);
    const up = await sendToTab(tab.id, {
      type: "UPLOAD_IMAGE",
      dataUrl: item.imageDataUrl,
      filename: item.imageName || `image_${index + 1}.png`,
    });
    if (!up.ok) {
      await log(`Item #${index + 1}: upload failed — ${up.error}`);
      // Do not immediately fail; user may have uploaded manually.
    }
  }

  // 2) Fill prompt
  await log(`Item #${index + 1}: filling prompt`);
  const fill = await sendToTab(tab.id, { type: "FILL_PROMPT", text: item.prompt || "" });
  if (!fill.ok) {
    return { ok: false, error: fill.error || "Prompt field not found" };
  }

  // 3) Click generate
  await log(`Item #${index + 1}: clicking generate (${item.mode})`);
  const clk = await sendToTab(tab.id, { type: "CLICK_GENERATE", mode: item.mode || state.mode });
  if (!clk.ok) {
    return { ok: false, error: clk.error || "Generate button not found" };
  }

  // 4) Wait for completion
  await log(`Item #${index + 1}: waiting for result (timeout ${settings.timeoutSec}s)`);
  const wait = await sendToTab(tab.id, {
    type: "WAIT_COMPLETION",
    baselineUrls: baseline,
    timeoutMs: Math.max(5, Number(settings.timeoutSec || 180)) * 1000,
  });
  if (!wait.ok) {
    return { ok: false, error: wait.error || "Timeout waiting for result" };
  }

  const produced = (wait.payload && wait.payload.media) || [];
  await log(`Item #${index + 1}: result detected (${produced.length} media)`);

  // 5) Auto-download if enabled. Uses resolveDownloadUrl so blob: previews
  // (the common case for video output) get fetched via the content script
  // first; http/data URLs pass through unchanged.
  if (settings.autoDownload && produced.length) {
    for (let i = 0; i < produced.length; i++) {
      const m = produced[i];
      try {
        const resolved = await resolveDownloadUrl(m.url, tab.id);
        const filename = D.renderFilename(settings.filenamePattern, {
          type: m.type,
          index: index + 1,
          url: m.url,
          mimeType: resolved.mimeType,
        });
        const path = D.buildFullPath(settings.subfolder, filename);
        await D.downloadOne({ url: resolved.url, filename: path });
        await log(`Item #${index + 1}: downloaded ${path}`);
      } catch (e) {
        await log(`Item #${index + 1}: download failed — ${(e && e.message) || e}`);
      }
    }
  }

  return { ok: true, itemId, result: { media: produced } };
}

async function runLoop() {
  if (RT.running) return;
  RT.running = true;
  RT.stopRequested = false;

  try {
    const state0 = await S.getState();
    const settings = await S.getSettings();

    if (Q.nextPendingIndex(state0.queue, 0) < 0) {
      await log("Queue complete — no pending items.");
      return;
    }

    const isI2V = state0.mode === "image_to_video";
    const maxThisRun = isI2V ? Math.max(1, Number(settings.maxBatch || 10)) : Number.POSITIVE_INFINITY;
    let runCount = 0;

    while (!RT.stopRequested && runCount < maxThisRun) {
      const freshState = await S.getState();
      const idx = Q.nextPendingIndex(freshState.queue, 0);
      if (idx < 0) break;

      // Capture the item ID up-front so we can look it up after processOne
      // even if the queue was reordered/removed during the call.
      const itemId = freshState.queue[idx].id;

      const res = await processOne(freshState, settings, idx).catch((e) => ({
        ok: false, itemId, error: String((e && e.message) || e),
      }));

      const latest = await S.getState();
      const latestIdx = latest.queue.findIndex((q) => q.id === itemId);

      if (latestIdx < 0) {
        // Item was removed (or queue cleared via Reset) while we were
        // processing it. Nothing to update; just continue.
        await log(`Item ${itemId}: vanished from queue during processing — skipping update`);
      } else if (res.ok) {
        Q.markStatus(latest.queue, latestIdx, Q.STATUSES.COMPLETED, { result: res.result, error: null });
        await S.saveState({
          queue: latest.queue,
          completedCount: (latest.completedCount || 0) + 1,
        });
        await log(`Item #${latestIdx + 1}: completed`);
      } else {
        Q.markStatus(latest.queue, latestIdx, Q.STATUSES.FAILED, { error: res.error || "unknown error" });
        await S.saveState({
          queue: latest.queue,
          failedCount: (latest.failedCount || 0) + 1,
          lastError: res.error || "unknown error",
        });
        await log(`Item #${latestIdx + 1}: FAILED — ${res.error}`);
        if (settings.stopOnError) {
          await log("Stop-on-error enabled. Halting.");
          RT.stopRequested = true;
          break;
        }
      }

      runCount += 1;
      broadcast({ type: "STATE_UPDATED" });

      if (RT.stopRequested) break;

      // Is there more to do this run?
      const peek = await S.getState();
      if (Q.nextPendingIndex(peek.queue, 0) < 0) break;
      if (runCount >= maxThisRun) break;

      const d = Math.max(0, Number(settings.delaySec || 3));
      if (d > 0) {
        await log(`Waiting ${d}s before next item...`);
        await sleep(d * 1000);
      }
    }
  } finally {
    const state = await S.getState();
    const counts = Q.countsByStatus(state.queue);
    const allDone = counts.pending === 0 && counts.running === 0 && counts.paused === 0;

    await S.saveState({
      isRunning: false,
      // If we stopped for any reason but work remains, mark as paused so Resume works
      isPaused: !allDone,
      currentIndex: allDone ? -1 : state.currentIndex,
    });

    if (allDone && state.queue.length > 0) {
      await S.addHistory({
        startedAt: state.startedAt || null,
        finishedAt: Date.now(),
        total: state.queue.length,
        completed: counts.completed,
        failed: counts.failed,
        mode: state.mode,
        subfolder: (await S.getSettings()).subfolder,
      });
    }

    RT.running = false;
    RT.stopRequested = false;
    broadcast({ type: "STATE_UPDATED" });
  }
}

async function handleStart() {
  const state = await S.getState();
  const counts = Q.countsByStatus(state.queue);
  if (counts.pending === 0 && counts.paused === 0) {
    return { ok: false, error: "Queue has no pending items. Add prompts or click Reset." };
  }
  if (RT.running) return { ok: false, error: "Process already running" };
  await S.saveState({ isRunning: true, isPaused: false, startedAt: Date.now() });
  await log("Start pressed");
  startRunLoop();
  return { ok: true };
}

async function handleStop() {
  RT.stopRequested = true;
  await S.saveState({ isPaused: true });
  await log("Stop requested — will pause after current item");
  return { ok: true };
}

async function handleResume() {
  if (RT.running) return { ok: false, error: "Process already running" };
  await S.saveState({ isPaused: false, isRunning: true });
  await log("Resume pressed");
  startRunLoop();
  return { ok: true };
}

async function handleReset() {
  // If a runLoop is mid-flight, signal it to stop and wait for it to
  // finish before clearing storage. This prevents two issues:
  //   1. Duplicate concurrent runLoops if the user clicks Start right
  //      after Reset (the old loop's finally would later clear
  //      RT.running, dropping the guard for the new loop).
  //   2. processOne in the old loop clobbering the cleared queue back
  //      into storage via S.saveState (which merges into current state).
  // Do NOT touch RT.running here — the loop's finally block owns it.
  if (runLoopPromise) {
    RT.stopRequested = true;
    await log("Reset pressed — waiting for current item to finish...");
    try { await runLoopPromise; } catch (_) { /* loop's finally still ran */ }
  }
  await S.saveState({
    queue: [],
    currentIndex: -1,
    isRunning: false,
    isPaused: false,
    completedCount: 0,
    failedCount: 0,
    lastError: null,
  });
  await log("Queue reset");
  broadcast({ type: "STATE_UPDATED" });
  return { ok: true };
}

async function handleSetQueue(payload) {
  const state = await S.getState();
  await S.saveState({
    queue: payload.queue || [],
    mode: payload.mode || state.mode,
    currentIndex: -1,
    completedCount: 0,
    failedCount: 0,
    lastError: null,
    isPaused: false,
    isRunning: false,
    promptText: payload.promptText != null ? payload.promptText : state.promptText,
  });
  await log(`Queue set (${(payload.queue || []).length} items, mode=${payload.mode || state.mode})`);
  broadcast({ type: "STATE_UPDATED" });
  return { ok: true };
}

async function handleRetryFailed() {
  const state = await S.getState();
  const next = Q.retryFailed(state.queue || []);
  await S.saveState({ queue: next, failedCount: 0, lastError: null });
  await log("Retry failed — marked as pending");
  broadcast({ type: "STATE_UPDATED" });
  return { ok: true };
}

async function handleItemAction({ action, id }) {
  const state = await S.getState();
  const queue = state.queue.slice();
  const idx = queue.findIndex((x) => x.id === id);
  if (idx < 0) return { ok: false, error: "Item not found" };
  if (action === "remove") {
    queue.splice(idx, 1);
  } else if (action === "retry") {
    queue[idx] = Object.assign({}, queue[idx], { status: Q.STATUSES.PENDING, error: null });
  } else if (action === "skip") {
    queue[idx] = Object.assign({}, queue[idx], { status: Q.STATUSES.SKIPPED });
  }
  await S.saveState({ queue });
  broadcast({ type: "STATE_UPDATED" });
  return { ok: true };
}

async function handleScanMediaForPopup() {
  const tab = await findMetaTab();
  if (!tab) return { ok: false, error: "Meta AI tab not found" };
  const ok = await ensureContentScript(tab.id);
  if (!ok) return { ok: false, error: "Content script not available" };
  const res = await sendToTab(tab.id, { type: "SCAN_MEDIA" });
  return res;
}

async function handleSavePromptText({ promptText }) {
  // Single-process write through saveState so concurrent queue progress
  // updates from the run loop don't get clobbered by popup keystrokes.
  await S.saveState({ promptText: String(promptText == null ? "" : promptText) });
  return { ok: true };
}

async function handleClearLogs() {
  await S.saveState({ logs: [] });
  broadcast({ type: "STATE_UPDATED" });
  return { ok: true };
}

async function handleClearHistory() {
  await S.saveState({ history: [] });
  broadcast({ type: "STATE_UPDATED" });
  return { ok: true };
}

async function handleDownloadMedia({ items, settings }) {
  const st = settings || (await S.getSettings());
  let ok = 0, fail = 0;
  // Resolve the Meta AI tab once so blob: URLs reuse the same content
  // script connection instead of re-querying tabs.query per item.
  const tab = await findMetaTab();
  let tabId = null;
  if (tab) {
    const okInject = await ensureContentScript(tab.id);
    if (okInject) tabId = tab.id;
  }
  for (let i = 0; i < items.length; i++) {
    const m = items[i];
    try {
      const resolved = await resolveDownloadUrl(m.url, tabId);
      const filename = D.renderFilename(st.filenamePattern, {
        type: m.type || "image",
        index: i + 1,
        url: m.url,
        mimeType: resolved.mimeType,
      });
      const path = D.buildFullPath(st.subfolder, filename);
      await D.downloadOne({ url: resolved.url, filename: path });
      ok += 1;
      await log(`Downloaded ${path}`);
    } catch (e) {
      fail += 1;
      await log(`Download failed for ${m.url} — ${(e && e.message) || e}`);
    }
  }
  return { ok: true, downloaded: ok, failed: fail };
}

const HANDLERS = {
  START: handleStart,
  STOP: handleStop,
  RESUME: handleResume,
  RESET: handleReset,
  SET_QUEUE: handleSetQueue,
  RETRY_FAILED: handleRetryFailed,
  ITEM_ACTION: handleItemAction,
  SCAN_MEDIA_POPUP: handleScanMediaForPopup,
  DOWNLOAD_MEDIA: handleDownloadMedia,
  SAVE_PROMPT_TEXT: handleSavePromptText,
  CLEAR_LOGS: handleClearLogs,
  CLEAR_HISTORY: handleClearHistory,
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return false;
  const fn = HANDLERS[msg.type];
  if (!fn) return false;
  Promise.resolve()
    .then(() => fn(msg))
    .then((res) => sendResponse(res))
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true;
});

chrome.runtime.onInstalled.addListener(async () => {
  // initialize defaults
  await S.getSettings();
  await S.getState();
  await log("Extension installed / updated");
});
