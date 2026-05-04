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

// Trim a URL down to host + last path segment for log lines so a giant CDN
// URL with query params doesn't dominate the popup log. Falls back to a
// fixed-length slice if URL parsing fails (blob:, data:, etc.).
function shortUrl(u) {
  if (!u) return "";
  try {
    const x = new URL(u);
    const last = x.pathname.split("/").filter(Boolean).pop() || "";
    return last ? `${x.host}/…/${last}` : x.host;
  } catch (_) {
    return String(u).slice(0, 64);
  }
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

  // 4) Wait for completion. In I2V mode, force `requiredType: "video"` so the
  // wait sticks until a real <video> source appears. Without this, Meta AI's
  // <img> poster/thumbnail (.jpg) — which mounts ~hundreds of ms BEFORE the
  // <video> element — fires the completion early and the auto-download grabs
  // the poster JPG instead of the MP4. Symptom users see: "downloaded a JPG
  // instead of MP4 for most items".
  const itemMode = item.mode || state.mode;
  const requiredType = itemMode === "image_to_video" ? "video"
    : itemMode === "video" ? "video"
    : itemMode === "image" ? "image"
    : null;
  await log(`Item #${index + 1}: waiting for result (timeout ${settings.timeoutSec}s)`);
  const wait = await sendToTab(tab.id, {
    type: "WAIT_COMPLETION",
    baselineUrls: baseline,
    timeoutMs: Math.max(5, Number(settings.timeoutSec || 180)) * 1000,
    requiredType,
  });
  if (!wait.ok) {
    return { ok: false, error: wait.error || "Timeout waiting for result" };
  }

  const producedAll = (wait.payload && wait.payload.media) || [];
  // In I2V (and VIDEO) mode, drop any non-video media that may have slipped
  // through (e.g. a sibling poster <img> co-mounted with the <video>). The
  // user explicitly requested "auto-download .mp4 only" for I2V — we honor
  // that by filtering here, regardless of what the page exposes.
  let produced = requiredType
    ? producedAll.filter((m) => m.type === requiredType)
    : producedAll;
  await log(
    `Item #${index + 1}: result detected (` +
    `${produced.length}${requiredType ? ` ${requiredType}` : " media"}` +
    `${producedAll.length !== produced.length ? `, ${producedAll.length - produced.length} skipped` : ""})`
  );

  // 4b) Settle window for video downloads. Meta AI mounts the <video>
  // element a moment before its src settles to the final .mp4 — at the
  // exact instant `result detected` fires, currentSrc can still point to
  // a poster jpg, a blob preview, or the user's uploaded seed image. We
  // pause for `videoSettleSec`, re-scan, and pick the latest fresh video
  // URL. Without this, auto-download grabs whatever URL the <video> was
  // wearing at mount time. (User-reported bug: "auto-download i2v muncul
  // setelah result detected" — i.e. it fires too early.)
  if (settings.autoDownload && requiredType === "video" && produced.length) {
    const settleMs = Math.max(0, Number(settings.videoSettleSec ?? 3)) * 1000;
    if (settleMs > 0) {
      await log(`Item #${index + 1}: video detected, settling ${settleMs}ms before download`);
      await sleep(settleMs);
      try {
        const rescan = await sendToTab(tab.id, { type: "SCAN_MEDIA" });
        if (rescan && rescan.ok && Array.isArray(rescan.media)) {
          const baselineSet = new Set(baseline);
          const freshVideos = rescan.media
            .filter((m) => m.type === "video")
            .filter((m) => !baselineSet.has(m.url));
          if (freshVideos.length) {
            produced = freshVideos;
            await log(`Item #${index + 1}: post-settle: ${freshVideos.length} video URL(s) ready for download`);
          } else {
            await log(`Item #${index + 1}: post-settle re-scan returned no fresh videos, keeping original URL(s)`);
          }
        }
      } catch (e) {
        await log(`Item #${index + 1}: post-settle re-scan failed — ${(e && e.message) || e}`);
      }
    }
  }

  // 5) Auto-download if enabled
  if (settings.autoDownload && produced.length) {
    for (let i = 0; i < produced.length; i++) {
      const m = produced[i];
      // Hard guard: when the queue item asked for a video, refuse to
      // download a URL whose ext is unambiguously an image. inferExt would
      // happily save such a URL with a .mp4 filename and still produce a
      // jpg on disk, since chrome.downloads writes whatever the server
      // returns. Skipping with a warning is safer than silently saving the
      // wrong file.
      if (requiredType === "video" && D.urlLooksLikeImage(m.url)) {
        await log(`Item #${index + 1}: refused to download non-video URL (${shortUrl(m.url)}) for a video task`);
        continue;
      }
      try {
        const filename = D.renderFilename(settings.filenamePattern, {
          type: m.type,
          index: index + 1,
          url: m.url,
        });
        const path = D.buildFullPath(settings.subfolder, filename);
        await D.downloadOne({ url: m.url, filename: path });
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

    // The previous I2V "max 10 per run" cap forced the user to manually
    // click Resume after every 10 items. That's gone now — the queue
    // auto-continues until it's empty or the user requests Stop. The
    // `delaySec` setting still spaces out individual items so we don't
    // hammer Meta AI's UI; that's the only rate control we honor in the
    // happy path. Real failures still fall through to the failed/stopOnError
    // branch below, which preserves the existing behavior.
    while (!RT.stopRequested) {
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

      broadcast({ type: "STATE_UPDATED" });

      if (RT.stopRequested) break;

      // Is there more to do this run?
      const peek = await S.getState();
      if (Q.nextPendingIndex(peek.queue, 0) < 0) break;

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

// Re-open the toolbar popup. Called by the floating panel's close (×)
// button so closing the overlay automatically returns the user to the
// main menu. chrome.action.openPopup() is gated by Chrome:
//   - It must be reachable from a user gesture (the click in the page
//     doesn't propagate as a background-script user gesture, so this can
//     fail silently on older Chrome — best-effort).
//   - Available on stable Chrome 127+ for extensions.
// On failure we fall back to setting a "1" badge as a soft cue, so the
// user knows to click the toolbar icon themselves.
async function handleOpenPopup() {
  try {
    if (chrome.action && typeof chrome.action.openPopup === "function") {
      await chrome.action.openPopup();
      return { ok: true };
    }
  } catch (e) {
    // fall through to badge fallback
  }
  try {
    if (chrome.action && chrome.action.setBadgeText) {
      await chrome.action.setBadgeBackgroundColor({ color: "#FF4D00" });
      await chrome.action.setBadgeText({ text: "1" });
      // Auto-clear after 5s so the badge doesn't linger forever.
      setTimeout(() => {
        try { chrome.action.setBadgeText({ text: "" }); } catch (_) {}
      }, 5000);
    }
  } catch (_) { /* nothing else we can do */ }
  return { ok: false, error: "openPopup unsupported on this Chrome — click the toolbar icon" };
}

// Inject the floating overlay into the active meta.ai tab. Called from
// the popup's MENU → Open Floating Panel. The injected script is
// idempotent: if the panel already exists in the page, it just shows it
// again instead of duplicating.
async function handleOpenFloatingPanel() {
  const tab = await findMetaTab();
  if (!tab) return { ok: false, error: "Meta AI tab not found. Open https://www.meta.ai/ first." };
  // Make sure the page is meta.ai (chrome.scripting.executeScript will
  // refuse on non-host_permissions URLs, but we want a friendly error).
  if (!/^https:\/\/(?:[^/]*\.)?meta\.ai\//.test(tab.url || "")) {
    return { ok: false, error: "Open https://www.meta.ai/ first, then re-open the floating panel." };
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["floatingPanel.js"],
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
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
  for (let i = 0; i < items.length; i++) {
    const m = items[i];
    try {
      const filename = D.renderFilename(st.filenamePattern, {
        type: m.type || "image",
        index: i + 1,
        url: m.url,
      });
      const path = D.buildFullPath(st.subfolder, filename);
      await D.downloadOne({ url: m.url, filename: path });
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
  OPEN_FLOATING_PANEL: handleOpenFloatingPanel,
  OPEN_POPUP: handleOpenPopup,
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
