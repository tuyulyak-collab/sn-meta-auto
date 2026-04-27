/* SN Stock Keyword Optimizer — background service worker
 *
 * Acts as a thin message broker between the popup and the content script.
 * Most of the heavy lifting happens in scripts/popup.js (UI + scoring) and
 * scripts/contentScript.js (page DOM access). This worker exists so the
 * extension follows the standard MV3 layout and so we have a single place
 * to add cross-tab logic later.
 */

const ADOBE_STOCK_HOST_PATTERN = /(^|\.)stock\.adobe\.com$/i;

function isAdobeStockUrl(url) {
  try {
    const u = new URL(url);
    return ADOBE_STOCK_HOST_PATTERN.test(u.hostname);
  } catch (e) {
    return false;
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    // Seed default settings.
    chrome.storage.local.get(["sn_settings"], (res) => {
      if (!res || !res.sn_settings) {
        chrome.storage.local.set({
          sn_settings: {
            defaultLocale: "en_US",
            defaultContentType: "vector",
            maxKeywords: 49,
            topPriority: 10,
            backendUrl: "",
            apiMode: "local",
          },
        });
      }
    });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;

  if (msg.type === "SN_PING") {
    sendResponse({ ok: true, ts: Date.now() });
    return true;
  }

  if (msg.type === "SN_IS_ADOBE_STOCK") {
    const url = msg.url || (sender.tab && sender.tab.url) || "";
    sendResponse({ ok: true, isAdobeStock: isAdobeStockUrl(url) });
    return true;
  }

  return false;
});
