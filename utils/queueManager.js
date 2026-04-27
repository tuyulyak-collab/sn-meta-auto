/* utils/queueManager.js
 * Pure helpers around the queue data structure.
 * Used by popup.js (UI) and background.js (orchestrator).
 */

(function (root) {
  const STATUSES = Object.freeze({
    PENDING: "pending",
    RUNNING: "running",
    COMPLETED: "completed",
    FAILED: "failed",
    PAUSED: "paused",
    SKIPPED: "skipped",
  });

  function uid() {
    return "q_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  }

  function parsePromptText(text) {
    if (!text) return [];
    return String(text)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  }

  function buildPromptQueue(text, mode) {
    const prompts = parsePromptText(text);
    return prompts.map((p) => ({
      id: uid(),
      kind: "prompt",
      prompt: p,
      mode: mode || "image",
      status: STATUSES.PENDING,
      result: null,
      error: null,
    }));
  }

  function buildImageQueue(images, sharedPrompt, mode) {
    return (images || []).map((img) => ({
      id: uid(),
      kind: "image",
      prompt: img.prompt || sharedPrompt || "",
      imageDataUrl: img.dataUrl,
      imageName: img.name,
      mode: mode || "image_to_video",
      status: STATUSES.PENDING,
      result: null,
      error: null,
    }));
  }

  function nextPendingIndex(queue, fromIndex = 0) {
    for (let i = Math.max(0, fromIndex); i < queue.length; i++) {
      if (queue[i].status === STATUSES.PENDING || queue[i].status === STATUSES.PAUSED) {
        return i;
      }
    }
    return -1;
  }

  function countsByStatus(queue) {
    const out = {
      pending: 0, running: 0, completed: 0, failed: 0, paused: 0, skipped: 0,
    };
    for (const item of queue) {
      if (out[item.status] !== undefined) out[item.status] += 1;
    }
    return out;
  }

  function markStatus(queue, index, status, patch) {
    if (!queue[index]) return queue;
    queue[index] = Object.assign({}, queue[index], { status }, patch || {});
    return queue;
  }

  function resetStatuses(queue) {
    return queue.map((q) => Object.assign({}, q, {
      status: STATUSES.PENDING, result: null, error: null,
    }));
  }

  function retryFailed(queue) {
    return queue.map((q) => {
      if (q.status === STATUSES.FAILED) {
        return Object.assign({}, q, { status: STATUSES.PENDING, error: null });
      }
      return q;
    });
  }

  const api = {
    STATUSES,
    uid,
    parsePromptText,
    buildPromptQueue,
    buildImageQueue,
    nextPendingIndex,
    countsByStatus,
    markStatus,
    resetStatuses,
    retryFailed,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SNQueue = api;
})(typeof self !== "undefined" ? self : this);
