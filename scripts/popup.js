/* SN Stock Keyword Optimizer — popup logic
 *
 * Wires up tabs, runs the local heuristic scorer, renders results, and
 * coordinates with the content script for Current Page mode.
 */
(function () {
  "use strict";

  const DEFAULT_SETTINGS = {
    defaultLocale: "en_US",
    defaultContentType: "vector",
    maxKeywords: 49,
    topPriority: 10,
    backendUrl: "",
    apiMode: "local",
  };

  const ADOBE_STOCK_HOST_PATTERN = /(^|\.)stock\.adobe\.com$/i;

  let state = {
    settings: { ...DEFAULT_SETTINGS },
    activeTab: "current",
    currentPage: {
      tabId: null,
      url: "",
      detected: false,
      scanned: null,
      analysis: null,
    },
    manual: {
      analysis: null,
    },
  };

  // ---------- Storage ----------
  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(["sn_settings"], (res) => {
        const s = (res && res.sn_settings) || {};
        state.settings = { ...DEFAULT_SETTINGS, ...s };
        resolve(state.settings);
      });
    });
  }

  function saveSettings(next) {
    state.settings = { ...state.settings, ...next };
    return new Promise((resolve) => {
      chrome.storage.local.set({ sn_settings: state.settings }, () => resolve(state.settings));
    });
  }

  // ---------- Toasts ----------
  function toast(message, type) {
    const stack = document.getElementById("toast-stack");
    if (!stack) return;
    const el = document.createElement("div");
    el.className = "toast " + (type || "info");
    el.textContent = message;
    stack.appendChild(el);
    setTimeout(() => {
      el.style.transition = "opacity 0.2s ease";
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 220);
    }, 2400);
  }

  function setLoading(buttonId, loading) {
    const btn = document.getElementById(buttonId);
    if (!btn) return;
    if (loading) {
      btn.classList.add("is-loading");
      btn.disabled = true;
    } else {
      btn.classList.remove("is-loading");
      btn.disabled = false;
    }
  }

  // ---------- Tabs ----------
  function setActiveTab(name) {
    state.activeTab = name;
    document.querySelectorAll(".tab").forEach((t) => {
      const isActive = t.dataset.tab === name;
      t.classList.toggle("active", isActive);
      t.setAttribute("aria-selected", isActive ? "true" : "false");
    });
    document.querySelectorAll(".tab-panel").forEach((p) => {
      p.classList.toggle("active", p.id === "tab-" + name);
    });
  }

  // ---------- Current Page detection ----------
  function getActiveTab() {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        resolve(tabs && tabs[0] ? tabs[0] : null);
      });
    });
  }

  function isAdobeStockUrl(url) {
    try {
      const u = new URL(url);
      return ADOBE_STOCK_HOST_PATTERN.test(u.hostname);
    } catch (e) {
      return false;
    }
  }

  async function refreshPageDetection() {
    const tab = await getActiveTab();
    const dot = document.getElementById("page-status-dot");
    const text = document.getElementById("page-status-text");
    const scanBtn = document.getElementById("btn-scan");

    if (!tab) {
      dot.className = "status-dot bad";
      text.textContent = "No active tab";
      scanBtn.disabled = true;
      state.currentPage.detected = false;
      return;
    }

    state.currentPage.tabId = tab.id;
    state.currentPage.url = tab.url || "";

    const detected = isAdobeStockUrl(tab.url || "");
    state.currentPage.detected = detected;

    if (detected) {
      dot.className = "status-dot ok";
      text.textContent = "Adobe Stock page detected";
      scanBtn.disabled = false;
    } else {
      dot.className = "status-dot warn";
      text.textContent = "Adobe Stock page not detected";
      scanBtn.disabled = true;
    }
  }

  function sendToTab(tabId, message) {
    return new Promise((resolve) => {
      try {
        chrome.tabs.sendMessage(tabId, message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(response || { ok: false, error: "no response" });
          }
        });
      } catch (e) {
        resolve({ ok: false, error: String((e && e.message) || e) });
      }
    });
  }

  async function scanCurrentPage() {
    if (!state.currentPage.detected || !state.currentPage.tabId) {
      toast("Open an Adobe Stock contributor page first.", "error");
      return;
    }
    setLoading("btn-scan", true);
    try {
      const res = await sendToTab(state.currentPage.tabId, { type: "SN_SCAN_PAGE" });
      if (!res || !res.ok) {
        toast(res && res.error ? res.error : "Could not scan page.", "error");
        renderCurrentEmpty(
          "Could not detect keyword fields automatically. Please use Manual Analyzer Mode."
        );
        state.currentPage.scanned = null;
        updateCurrentButtonsEnabled();
        return;
      }
      state.currentPage.scanned = res;
      state.currentPage.analysis = null;

      const titleEl = document.getElementById("detected-title");
      const countEl = document.getElementById("detected-count");
      titleEl.textContent = res.title ? res.title : "—";
      countEl.textContent = String((res.keywords && res.keywords.length) || 0);

      if (!res.keywords || res.keywords.length === 0) {
        renderCurrentEmpty(
          "Could not detect keyword fields automatically. Please use Manual Analyzer Mode."
        );
      } else {
        renderCurrentScanned(res);
      }
      updateCurrentButtonsEnabled();
      toast("Scanned " + ((res.keywords && res.keywords.length) || 0) + " keywords.", "success");
    } catch (e) {
      toast("Scan failed: " + (e && e.message), "error");
    } finally {
      setLoading("btn-scan", false);
    }
  }

  function renderCurrentEmpty(msg) {
    const empty = document.getElementById("current-empty");
    const card = document.getElementById("current-results-card");
    const area = document.getElementById("current-results-area");
    empty.hidden = false;
    empty.innerHTML = "<p>" + escapeHtml(msg) + "</p>";
    card.hidden = true;
    area.innerHTML = "";
  }

  function renderCurrentScanned(scan) {
    const empty = document.getElementById("current-empty");
    const card = document.getElementById("current-results-card");
    const area = document.getElementById("current-results-area");
    const summary = document.getElementById("current-result-summary");
    empty.hidden = true;
    card.hidden = false;
    summary.textContent = scan.keywords.length + " detected";

    area.innerHTML = "";
    const block = document.createElement("div");
    block.className = "result-block final";
    block.innerHTML =
      '<h4>Detected keywords</h4>' +
      '<div class="kw-line">' +
      escapeHtml(scan.keywords.join(", ")) +
      "</div>";
    area.appendChild(block);
  }

  function updateCurrentButtonsEnabled() {
    const analyzeBtn = document.getElementById("btn-analyze-current");
    const applyBtn = document.getElementById("btn-apply-current");
    const scan = state.currentPage.scanned;
    analyzeBtn.disabled = !(scan && scan.keywords && scan.keywords.length > 0);
    applyBtn.disabled = !(state.currentPage.analysis && state.currentPage.analysis.finalKeywords && state.currentPage.analysis.finalKeywords.length > 0);
  }

  async function analyzeCurrent() {
    const scan = state.currentPage.scanned;
    if (!scan || !scan.keywords || scan.keywords.length === 0) {
      toast("Scan a page first.", "error");
      return;
    }
    setLoading("btn-analyze-current", true);
    try {
      let result = SNScoring.analyzeKeywords({
        title: scan.title || "",
        keywords: scan.keywords,
        contentType: state.settings.defaultContentType,
        locale: state.settings.defaultLocale,
        targetCount: state.settings.maxKeywords,
        topCount: state.settings.topPriority,
      });

      let usedBackend = false;
      if (backendActive()) {
        try {
          const llm = await callBackend({
            title: scan.title || "",
            keywords: scan.keywords,
            contentType: state.settings.defaultContentType,
            locale: state.settings.defaultLocale,
          });
          result = mergeLLMIntoLocal(result, llm);
          usedBackend = true;
        } catch (be) {
          toast(
            "Backend unavailable, using local heuristic. " + (be && be.message ? be.message : ""),
            "info"
          );
        }
      }

      state.currentPage.analysis = result;
      renderAnalysis(
        document.getElementById("current-results-area"),
        document.getElementById("current-result-summary"),
        result,
        "current"
      );
      const card = document.getElementById("current-results-card");
      card.hidden = false;
      const empty = document.getElementById("current-empty");
      empty.hidden = true;
      updateCurrentButtonsEnabled();
      toast(
        "Analyzed " +
          result.meta.totalInput +
          " keywords" +
          (usedBackend ? " (LLM-enhanced)" : "") +
          ".",
        "success"
      );
    } catch (e) {
      toast("Analysis failed: " + (e && e.message), "error");
    } finally {
      setLoading("btn-analyze-current", false);
    }
  }

  async function applyCurrent() {
    const analysis = state.currentPage.analysis;
    if (!analysis || !state.currentPage.tabId) {
      toast("Analyze keywords first.", "error");
      return;
    }
    const ok = window.confirm(
      "This will replace the current keyword order on the Adobe Stock page. Continue?"
    );
    if (!ok) return;
    setLoading("btn-apply-current", true);
    try {
      const res = await sendToTab(state.currentPage.tabId, {
        type: "SN_APPLY_KEYWORDS",
        keywords: analysis.finalKeywords,
      });
      if (res && res.ok) {
        toast("Applied " + analysis.finalKeywords.length + " keywords.", "success");
      } else {
        toast(res && res.error ? res.error : "Could not apply keywords.", "error");
      }
    } catch (e) {
      toast("Apply failed: " + (e && e.message), "error");
    } finally {
      setLoading("btn-apply-current", false);
    }
  }

  // ---------- Backend (LLM) integration ----------
  function backendActive() {
    const url = (state.settings.backendUrl || "").trim();
    return state.settings.apiMode === "backend" && /^https?:\/\//i.test(url);
  }

  function backendUrl() {
    return (state.settings.backendUrl || "").trim().replace(/\/+$/, "");
  }

  async function callBackend(payload) {
    const url = backendUrl() + "/api/analyze";
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 25000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch (e) {
        throw new Error("backend returned non-JSON: " + text.slice(0, 120));
      }
      if (!res.ok || !json || json.ok === false) {
        throw new Error((json && json.error) || "backend error " + res.status);
      }
      return json;
    } finally {
      clearTimeout(t);
    }
  }

  // Merge LLM scoring into a local-heuristic analysis result. The local
  // pipeline still drives status (top/support/remove/duplicate/too_generic),
  // but each entry gets enriched with llmRelevance + competition + llmReason.
  // We then re-rank the survivors by a blended score so LLM relevance moves
  // truly relevant keywords to the top.
  function mergeLLMIntoLocal(localResult, llmData) {
    if (!llmData || !Array.isArray(llmData.scored)) return localResult;
    const map = new Map();
    llmData.scored.forEach((s) => {
      if (!s || typeof s.keyword !== "string") return;
      map.set(s.keyword.toLowerCase().trim(), s);
    });

    const enriched = localResult.ranked.map((r) => {
      const m = map.get(String(r.keyword).toLowerCase().trim());
      if (!m) return { ...r };
      const llmRelevance = numOrNull(m.relevance);
      const competition = ["low", "medium", "high"].includes(m.competition)
        ? m.competition
        : null;
      const blend =
        llmRelevance == null
          ? r.score
          : Math.round(r.score * 0.5 + llmRelevance * 0.5);
      return {
        ...r,
        llmRelevance,
        competition,
        llmReason: typeof m.reason === "string" ? m.reason : "",
        blendedScore: blend,
      };
    });

    // Re-rank survivors (top + support) by blended score; keep duplicates /
    // too_generic / remove at the bottom in their original order.
    const survivors = enriched.filter((e) => e.status === "top" || e.status === "support");
    const others = enriched.filter((e) => e.status !== "top" && e.status !== "support");

    survivors.sort((a, b) => {
      const sa = a.blendedScore != null ? a.blendedScore : a.score;
      const sb = b.blendedScore != null ? b.blendedScore : b.score;
      if (sb !== sa) return sb - sa;
      // Tie-break: lower competition first.
      const ca = compRank(a.competition);
      const cb = compRank(b.competition);
      return ca - cb;
    });

    const topCount = state.settings.topPriority || 10;
    const ranked = [];
    survivors.forEach((e, i) => {
      const status = i < topCount ? "top" : "support";
      ranked.push({ ...e, rank: i + 1, status });
    });
    others.forEach((e) => ranked.push({ ...e }));

    const finalKeywords = survivors.map((e) => e.keyword);
    const topKeywords = finalKeywords.slice(0, topCount);

    const suggested = Array.isArray(llmData.suggested)
      ? llmData.suggested.filter((s) => typeof s === "string" && s.trim()).slice(0, 12)
      : [];

    return {
      ...localResult,
      ranked,
      topKeywords,
      finalKeywords,
      suggestedKeywords: suggested,
      llm: { provider: llmData.provider, model: llmData.model },
    };
  }

  function numOrNull(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function compRank(c) {
    if (c === "low") return 0;
    if (c === "medium") return 1;
    if (c === "high") return 2;
    return 1.5;
  }

  // ---------- Manual mode ----------
  function readManualInputs() {
    return {
      title: document.getElementById("manual-title").value || "",
      keywordsRaw: document.getElementById("manual-keywords").value || "",
      contentType: document.getElementById("manual-content-type").value,
      locale: document.getElementById("manual-locale").value,
      targetCount: clampInt(document.getElementById("manual-target").value, 1, 49, 49),
      topCount: clampInt(document.getElementById("manual-top").value, 1, 49, 10),
    };
  }

  async function analyzeManual() {
    const input = readManualInputs();
    const parsed = SNScoring.parseKeywords(input.keywordsRaw);
    if (parsed.length === 0) {
      toast("Add some keywords first.", "error");
      return;
    }
    setLoading("btn-manual-analyze", true);
    try {
      let result = SNScoring.analyzeKeywords({
        title: input.title,
        keywords: parsed,
        contentType: input.contentType,
        locale: input.locale,
        targetCount: input.targetCount,
        topCount: input.topCount,
      });

      let usedBackend = false;
      if (backendActive()) {
        try {
          const llm = await callBackend({
            title: input.title,
            keywords: parsed,
            contentType: input.contentType,
            locale: input.locale,
          });
          result = mergeLLMIntoLocal(result, llm);
          usedBackend = true;
        } catch (be) {
          toast(
            "Backend unavailable, using local heuristic. " + (be && be.message ? be.message : ""),
            "info"
          );
        }
      }

      state.manual.analysis = result;
      renderAnalysis(
        document.getElementById("manual-results-area"),
        document.getElementById("manual-result-summary"),
        result,
        "manual"
      );
      const card = document.getElementById("manual-results-card");
      card.hidden = false;
      toast(
        "Analyzed " +
          result.meta.totalInput +
          " keywords" +
          (usedBackend ? " (LLM-enhanced)" : "") +
          ".",
        "success"
      );
    } catch (e) {
      toast("Analysis failed: " + (e && e.message), "error");
    } finally {
      setLoading("btn-manual-analyze", false);
    }
  }

  function reorderManual() {
    const analysis = state.manual.analysis;
    if (!analysis) {
      analyzeManual();
      return;
    }
    document.getElementById("manual-keywords").value = analysis.finalKeywords.join(", ");
    toast("Reordered top " + analysis.finalKeywords.length + " keywords.", "success");
  }

  function copyManualKeywords() {
    const analysis = state.manual.analysis;
    const fallback = document.getElementById("manual-keywords").value;
    const text =
      analysis && analysis.finalKeywords && analysis.finalKeywords.length > 0
        ? analysis.finalKeywords.join(", ")
        : fallback;
    if (!text) {
      toast("Nothing to copy.", "error");
      return;
    }
    copyToClipboard(text)
      .then(() => toast("Copied to clipboard.", "success"))
      .catch(() => toast("Copy failed.", "error"));
  }

  function exportManualCsv() {
    const analysis = state.manual.analysis;
    if (!analysis) {
      toast("Analyze first.", "error");
      return;
    }
    const rows = [["rank", "keyword", "score", "status", "reason"]];
    analysis.ranked.forEach((r) => {
      rows.push([
        r.rank == null ? "" : String(r.rank),
        r.keyword,
        String(r.score),
        humanStatus(r.status),
        r.reason || "",
      ]);
    });
    const csv = rows
      .map((row) => row.map(csvEscape).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "sn-stock-keywords.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("Exported CSV.", "success");
  }

  function clearManual() {
    document.getElementById("manual-title").value = "";
    document.getElementById("manual-keywords").value = "";
    document.getElementById("manual-results-card").hidden = true;
    document.getElementById("manual-results-area").innerHTML = "";
    state.manual.analysis = null;
    toast("Cleared inputs.", "info");
  }

  // ---------- Settings ----------
  function applySettingsToInputs() {
    const s = state.settings;
    document.getElementById("settings-locale").value = s.defaultLocale;
    document.getElementById("settings-content-type").value = s.defaultContentType;
    document.getElementById("settings-max").value = s.maxKeywords;
    document.getElementById("settings-top").value = s.topPriority;
    document.getElementById("settings-api-url").value = s.backendUrl || "";
    document
      .querySelectorAll('input[name="api-mode"]')
      .forEach((r) => (r.checked = r.value === s.apiMode));

    document.getElementById("manual-content-type").value = s.defaultContentType;
    document.getElementById("manual-locale").value = s.defaultLocale;
    document.getElementById("manual-target").value = s.maxKeywords;
    document.getElementById("manual-top").value = s.topPriority;

    updateModePill();
  }

  function updateModePill() {
    const pill = document.getElementById("mode-pill");
    if (!pill) return;
    pill.hidden = !backendActive();
  }

  function readSettingsInputs() {
    const apiModeEl = document.querySelector('input[name="api-mode"]:checked');
    return {
      defaultLocale: document.getElementById("settings-locale").value,
      defaultContentType: document.getElementById("settings-content-type").value,
      maxKeywords: clampInt(document.getElementById("settings-max").value, 1, 49, 49),
      topPriority: clampInt(document.getElementById("settings-top").value, 1, 49, 10),
      backendUrl: document.getElementById("settings-api-url").value.trim(),
      apiMode: apiModeEl ? apiModeEl.value : "local",
    };
  }

  async function handleSaveSettings() {
    const next = readSettingsInputs();
    if (next.apiMode === "backend" && !next.backendUrl) {
      toast("Backend API mode is selected but no URL is set. Falling back to local mode.", "info");
      next.apiMode = "local";
    }
    await saveSettings(next);
    applySettingsToInputs();
    toast("Settings saved.", "success");
  }

  async function handleResetSettings() {
    await saveSettings({ ...DEFAULT_SETTINGS });
    applySettingsToInputs();
    toast("Settings reset.", "info");
  }

  // ---------- Rendering analysis ----------
  function renderAnalysis(rootEl, summaryEl, result, mode) {
    rootEl.innerHTML = "";
    summaryEl.textContent =
      result.meta.keptCount + " kept • " + result.meta.removedCount + " removed";

    rootEl.appendChild(buildResultsTable(result));

    rootEl.appendChild(
      buildBlock("top", "Top " + result.topKeywords.length + " Keywords", result.topKeywords.join(", "), [
        { label: "Copy Top " + result.topKeywords.length, value: result.topKeywords.join(", ") },
      ])
    );

    rootEl.appendChild(
      buildBlock(
        "final",
        "Final " + result.finalKeywords.length + " Keywords",
        result.finalKeywords.join(", "),
        [
          {
            label: "Copy Final " + result.finalKeywords.length,
            value: result.finalKeywords.join(", "),
          },
        ]
      )
    );

    if (result.removedKeywords && result.removedKeywords.length > 0) {
      rootEl.appendChild(
        buildBlock(
          "removed",
          "Removed Keywords (" + result.removedKeywords.length + ")",
          result.removedKeywords.join(", "),
          [{ label: "Copy Removed", value: result.removedKeywords.join(", ") }]
        )
      );
    }

    if (result.suggestedKeywords && result.suggestedKeywords.length > 0) {
      rootEl.appendChild(
        buildBlock(
          "suggested",
          "Suggested Keywords (" + result.suggestedKeywords.length + ") — from LLM",
          result.suggestedKeywords.join(", "),
          [
            { label: "Copy Suggestions", value: result.suggestedKeywords.join(", ") },
            {
              label: "Append to Keywords",
              value: result.suggestedKeywords.join(", "),
              action: (val) => {
                const ta = document.getElementById("manual-keywords");
                if (!ta) return;
                const existing = ta.value.trim();
                ta.value = existing ? existing + ", " + val : val;
                toast("Appended " + result.suggestedKeywords.length + " suggestions.", "success");
              },
            },
          ]
        )
      );
    }

    rootEl.appendChild(buildNotesBlock(result.notes));
  }

  function buildResultsTable(result) {
    const wrap = document.createElement("div");
    const hasLLM = !!(result.llm && result.ranked.some((r) => r.competition || r.llmRelevance != null));
    const table = document.createElement("table");
    table.className = "results-table";
    let head =
      "<thead><tr>" +
      '<th class="col-rank">#</th>' +
      "<th>Keyword</th>" +
      '<th class="col-score">Score</th>';
    if (hasLLM) {
      head += '<th class="col-comp">Comp.</th>';
    }
    head +=
      '<th class="col-status">Status</th>' +
      '<th class="col-reason">Reason</th>' +
      "</tr></thead>";
    table.innerHTML = head;
    const tbody = document.createElement("tbody");
    result.ranked.forEach((r) => {
      const tr = document.createElement("tr");
      const reasonText = combineLocalLlmReason(r.reason, r.llmReason);
      let row =
        '<td class="col-rank">' +
        (r.rank == null ? "—" : r.rank) +
        "</td>" +
        "<td>" +
        escapeHtml(r.keyword) +
        "</td>" +
        '<td class="col-score">' +
        (r.blendedScore != null ? r.blendedScore : r.score) +
        "</td>";
      if (hasLLM) {
        row += '<td class="col-comp">' + competitionBadgeHtml(r.competition) + "</td>";
      }
      row +=
        '<td class="col-status">' +
        statusBadgeHtml(r.status) +
        "</td>" +
        '<td class="col-reason">' +
        escapeHtml(reasonText) +
        "</td>";
      tr.innerHTML = row;
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  function combineLocalLlmReason(local, llm) {
    const a = (local || "").trim();
    const b = (llm || "").trim();
    if (a && b) return a + " • LLM: " + b;
    return a || b || "";
  }

  function competitionBadgeHtml(c) {
    if (c === "low") return '<span class="badge badge-comp-low">Low</span>';
    if (c === "medium") return '<span class="badge badge-comp-med">Medium</span>';
    if (c === "high") return '<span class="badge badge-comp-high">High</span>';
    return '<span class="badge badge-comp-na">—</span>';
  }

  function buildBlock(kind, title, kwLine, copyButtons) {
    const block = document.createElement("div");
    block.className = "result-block " + kind;
    const h4 = document.createElement("h4");
    h4.textContent = title;
    block.appendChild(h4);

    const line = document.createElement("div");
    line.className = "kw-line";
    line.textContent = kwLine || "(none)";
    block.appendChild(line);

    if (copyButtons && copyButtons.length > 0) {
      const row = document.createElement("div");
      row.className = "copy-row";
      copyButtons.forEach((b) => {
        const btn = document.createElement("button");
        btn.className = "btn btn-secondary";
        btn.type = "button";
        btn.textContent = b.label;
        btn.addEventListener("click", () => {
          if (typeof b.action === "function") {
            b.action(b.value);
            return;
          }
          if (!b.value) {
            toast("Nothing to copy.", "error");
            return;
          }
          copyToClipboard(b.value)
            .then(() => toast("Copied.", "success"))
            .catch(() => toast("Copy failed.", "error"));
        });
        row.appendChild(btn);
      });
      block.appendChild(row);
    }
    return block;
  }

  function buildNotesBlock(notes) {
    const block = document.createElement("div");
    block.className = "result-block notes";
    const h4 = document.createElement("h4");
    h4.textContent = "Notes & Suggestions";
    block.appendChild(h4);
    const ul = document.createElement("ul");
    ul.className = "notes-list";
    (notes || []).forEach((n) => {
      const li = document.createElement("li");
      li.textContent = n;
      ul.appendChild(li);
    });
    block.appendChild(ul);
    return block;
  }

  function statusBadgeHtml(status) {
    switch (status) {
      case "top":
        return '<span class="badge badge-top">Top 10</span>';
      case "support":
        return '<span class="badge badge-support">Support</span>';
      case "remove":
        return '<span class="badge badge-remove">Remove</span>';
      case "duplicate":
        return '<span class="badge badge-duplicate">Duplicate</span>';
      case "too_generic":
        return '<span class="badge badge-generic">Too Generic</span>';
      default:
        return '<span class="badge">' + escapeHtml(status || "") + "</span>";
    }
  }

  function humanStatus(s) {
    switch (s) {
      case "top":
        return "Top 10";
      case "support":
        return "Support";
      case "remove":
        return "Remove";
      case "duplicate":
        return "Duplicate";
      case "too_generic":
        return "Too Generic";
      default:
        return s || "";
    }
  }

  // ---------- Utilities ----------
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function csvEscape(v) {
    const s = String(v == null ? "" : v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function clampInt(v, min, max, def) {
    const n = parseInt(v, 10);
    if (Number.isNaN(n)) return def;
    return Math.max(min, Math.min(max, n));
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise((resolve, reject) => {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        ok ? resolve() : reject(new Error("execCommand failed"));
      } catch (e) {
        reject(e);
      }
    });
  }

  // ---------- Wire-up ----------
  document.addEventListener("DOMContentLoaded", async () => {
    await loadSettings();
    applySettingsToInputs();

    document.querySelectorAll(".tab").forEach((t) => {
      t.addEventListener("click", () => setActiveTab(t.dataset.tab));
    });

    // Current Page
    document.getElementById("btn-scan").addEventListener("click", scanCurrentPage);
    document.getElementById("btn-analyze-current").addEventListener("click", analyzeCurrent);
    document.getElementById("btn-apply-current").addEventListener("click", applyCurrent);

    // Manual
    document.getElementById("btn-manual-analyze").addEventListener("click", analyzeManual);
    document.getElementById("btn-manual-reorder").addEventListener("click", reorderManual);
    document.getElementById("btn-manual-copy").addEventListener("click", copyManualKeywords);
    document.getElementById("btn-manual-export").addEventListener("click", exportManualCsv);
    document.getElementById("btn-manual-clear").addEventListener("click", clearManual);

    // Settings
    document.getElementById("btn-settings-save").addEventListener("click", handleSaveSettings);
    document.getElementById("btn-settings-reset").addEventListener("click", handleResetSettings);

    await refreshPageDetection();
  });
})();
