/* utils/storage.js
 * Thin wrapper over chrome.storage.local with defaults + helpers.
 * Used by popup.js and background.js (classic script — no ES modules).
 */

(function (root) {
  const DEFAULT_SETTINGS = {
    mode: "image",                // "image" | "video" | "image_to_video"
    delaySec: 3,
    maxBatch: 10,
    timeoutSec: 180,
    worker: 1,
    filenamePattern: "sn_meta_{type}_{index}_{date}",
    subfolder: "SN_Meta_Auto",
    stopOnError: false,
    autoDownload: false,
  };

  const DEFAULT_STATE = {
    queue: [],                    // [{ id, kind:"prompt"|"image", prompt, imageDataUrl?, imageName?, status, result?, error? }]
    currentIndex: -1,
    isRunning: false,
    isPaused: false,
    mode: "image",
    completedCount: 0,
    failedCount: 0,
    lastError: null,
    logs: [],                     // [{ ts, msg }] — keep last 50
    history: [],                  // [{ startedAt, finishedAt, total, completed, failed, mode, subfolder }]
    promptText: "",               // raw textarea content, persisted
  };

  const KEYS = {
    SETTINGS: "sn_settings",
    STATE: "sn_state",
  };

  function getLocal(keys) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.get(keys, (res) => {
          const err = chrome.runtime && chrome.runtime.lastError;
          if (err) return reject(new Error(err.message || String(err)));
          resolve(res || {});
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function setLocal(obj) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.set(obj, () => {
          // Surface chrome.storage.local errors (e.g. QUOTA_BYTES exceeded
          // when an I2V queue holds many base64 image data URLs). Silent
          // success here would let progress, logs, and history be lost.
          const err = chrome.runtime && chrome.runtime.lastError;
          if (err) return reject(new Error(err.message || String(err)));
          resolve();
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  async function getSettings() {
    const res = await getLocal(KEYS.SETTINGS);
    return Object.assign({}, DEFAULT_SETTINGS, res[KEYS.SETTINGS] || {});
  }

  async function saveSettings(partial) {
    const current = await getSettings();
    const next = Object.assign({}, current, partial || {});
    await setLocal({ [KEYS.SETTINGS]: next });
    return next;
  }

  async function getState() {
    const res = await getLocal(KEYS.STATE);
    const state = Object.assign({}, DEFAULT_STATE, res[KEYS.STATE] || {});
    if (!Array.isArray(state.queue)) state.queue = [];
    if (!Array.isArray(state.logs)) state.logs = [];
    if (!Array.isArray(state.history)) state.history = [];
    return state;
  }

  async function saveState(partial) {
    const current = await getState();
    const next = Object.assign({}, current, partial || {});
    // keep logs capped
    if (Array.isArray(next.logs) && next.logs.length > 50) {
      next.logs = next.logs.slice(-50);
    }
    await setLocal({ [KEYS.STATE]: next });
    return next;
  }

  async function resetState() {
    await setLocal({ [KEYS.STATE]: DEFAULT_STATE });
    return DEFAULT_STATE;
  }

  async function appendLog(msg) {
    // Logging must never crash the run loop on a transient storage error.
    try {
      const state = await getState();
      const ts = new Date().toTimeString().slice(0, 8);
      const entry = { ts, msg: String(msg || "") };
      const logs = (state.logs || []).concat(entry).slice(-50);
      await saveState({ logs });
      return entry;
    } catch (e) {
      try { console.warn("[SN Meta Auto] appendLog failed", e); } catch (_) {}
      return null;
    }
  }

  async function addHistory(record) {
    const state = await getState();
    const history = (state.history || []).concat(record).slice(-20);
    await saveState({ history });
    return history;
  }

  const api = {
    KEYS,
    DEFAULT_SETTINGS,
    DEFAULT_STATE,
    getSettings,
    saveSettings,
    getState,
    saveState,
    resetState,
    appendLog,
    addHistory,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.SNStorage = api;
})(typeof self !== "undefined" ? self : this);
