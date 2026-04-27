/* SN Stock Keyword Optimizer — local heuristic scoring
 *
 * Exposes window.SNScoring with:
 *   parseKeywords(input) -> string[]
 *   analyzeKeywords({ title, keywords, contentType, locale, targetCount, topCount }) -> AnalysisResult
 *
 * Scoring is heuristic only. This is a relevance & competition helper,
 * NOT a sales prediction tool.
 */
(function (global) {
  "use strict";

  // ---------- Word lists ----------

  // Generic words penalized unless they actually appear in the title or are
  // legitimately core to the asset (handled via title-match logic).
  const GENERIC_WORDS = new Set([
    "art",
    "design",
    "graphic",
    "graphics",
    "image",
    "images",
    "object",
    "objects",
    "element",
    "elements",
    "background",
    "backgrounds",
    "isolated",
    "abstract",
    "modern",
    "creative",
    "concept",
    "idea",
    "stock",
    "picture",
    "pictures",
    "photo",
    "photos",
    "decorative",
    "decoration",
    "beautiful",
    "nice",
  ]);

  // Adobe-Stock-specific terms. They are kept (and slightly boosted) only when
  // the contentType matches; otherwise neutral.
  const STOCK_TERMS = {
    vector: ["vector", "vectors", "illustration", "icon", "icons", "set", "collection", "clipart"],
    illustration: [
      "illustration",
      "illustrations",
      "drawing",
      "cartoon",
      "mascot",
      "character",
      "set",
      "collection",
      "art",
    ],
    photo: ["photo", "photograph", "photography", "photographic", "shot", "image"],
    png: ["png", "transparent", "isolated", "cutout", "clipart", "sticker"],
  };

  // High-intent buyer words — usually surface why someone would pay for the asset.
  const BUYER_INTENT_WORDS = new Set([
    "logo",
    "branding",
    "brand",
    "template",
    "poster",
    "banner",
    "flyer",
    "card",
    "invitation",
    "wedding",
    "birthday",
    "holiday",
    "christmas",
    "halloween",
    "easter",
    "valentine",
    "valentines",
    "newyear",
    "thanksgiving",
    "wallpaper",
    "tshirt",
    "t-shirt",
    "sticker",
    "icon",
    "ui",
    "ux",
    "infographic",
    "presentation",
    "pattern",
    "seamless",
    "mascot",
    "mockup",
    "label",
    "packaging",
  ]);

  // Common English stop words — used for title-match parsing.
  const STOP_WORDS = new Set([
    "a",
    "an",
    "and",
    "or",
    "of",
    "the",
    "in",
    "on",
    "at",
    "for",
    "to",
    "with",
    "from",
    "by",
    "as",
    "is",
    "it",
    "this",
    "that",
    "these",
    "those",
    "be",
    "are",
    "was",
    "were",
    "but",
    "if",
    "than",
    "so",
    "into",
    "over",
    "under",
    "between",
  ]);

  // ---------- Helpers ----------

  function parseKeywords(input) {
    if (!input) return [];
    if (Array.isArray(input)) {
      return input
        .map((k) => normalizeRaw(String(k)))
        .filter((k) => k.length > 0);
    }
    return String(input)
      .split(/[,;\n\t]+/)
      .map(normalizeRaw)
      .filter((k) => k.length > 0);
  }

  function normalizeRaw(s) {
    return String(s || "")
      .replace(/\u00A0/g, " ")
      .trim()
      .replace(/\s+/g, " ");
  }

  function normalizeKey(s) {
    return normalizeRaw(s).toLowerCase();
  }

  // Strip simple plural 's' / 'es' for near-duplicate detection.
  function stem(word) {
    const w = word.toLowerCase();
    if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
    if (w.length > 3 && w.endsWith("es")) return w.slice(0, -2);
    if (w.length > 3 && w.endsWith("s")) return w.slice(0, -1);
    return w;
  }

  function tokenize(s) {
    return normalizeKey(s)
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
  }

  function titleTokenSet(title) {
    const tokens = tokenize(title);
    const set = new Set();
    tokens.forEach((t) => {
      set.add(t);
      set.add(stem(t));
    });
    return set;
  }

  // ---------- Scoring ----------

  function scoreKeyword(rawKw, ctx) {
    const kw = normalizeRaw(rawKw);
    const lower = kw.toLowerCase();
    const tokens = lower.split(/[^a-z0-9]+/).filter(Boolean);

    let relevance = 0;
    let specificity = 0;
    let titleMatch = 0;
    let buyerIntent = 0;
    let genericPenalty = 0;
    let irrelevantPenalty = 0;

    const reasons = [];

    // --- Relevance: presence + length sanity ---
    if (tokens.length === 0) {
      irrelevantPenalty += 50;
      reasons.push("empty/invalid");
    } else {
      relevance += 10;
    }

    // --- Specificity ---
    // Multi-word phrases tend to be more specific.
    if (tokens.length === 1) {
      specificity += 4;
    } else if (tokens.length === 2) {
      specificity += 12;
      reasons.push("multi-word");
    } else if (tokens.length === 3) {
      specificity += 16;
      reasons.push("specific phrase");
    } else if (tokens.length >= 4) {
      // Long phrases can be too narrow.
      specificity += 8;
      reasons.push("long phrase");
    }

    // Single-character or super short words are weak.
    if (kw.length <= 2) {
      irrelevantPenalty += 20;
      reasons.push("too short");
    }

    // --- Title match ---
    if (ctx.titleTokens.size > 0) {
      let matched = 0;
      for (const t of tokens) {
        if (ctx.titleTokens.has(t) || ctx.titleTokens.has(stem(t))) matched++;
      }
      if (matched > 0) {
        titleMatch += 10 + matched * 6;
        reasons.push(matched === tokens.length ? "matches title" : "partial title match");
      }
    }

    // --- Buyer intent ---
    let intentHits = 0;
    for (const t of tokens) {
      if (BUYER_INTENT_WORDS.has(t)) intentHits++;
    }
    if (intentHits > 0) {
      buyerIntent += intentHits * 5;
      reasons.push("buyer intent");
    }

    // --- Stock-term boost (only when matches contentType) ---
    const stockTerms = STOCK_TERMS[ctx.contentType] || [];
    let stockHits = 0;
    for (const t of tokens) {
      if (stockTerms.includes(t)) stockHits++;
    }
    if (stockHits > 0) {
      buyerIntent += stockHits * 3;
      reasons.push("stock-term (" + ctx.contentType + ")");
    }

    // --- Generic penalty ---
    let genericHits = 0;
    for (const t of tokens) {
      if (GENERIC_WORDS.has(t)) genericHits++;
    }
    if (genericHits > 0) {
      // Soften penalty if the generic word is justified by the title.
      const inTitle = tokens.some((t) => ctx.titleTokens.has(t) || ctx.titleTokens.has(stem(t)));
      const factor = inTitle ? 4 : 9;
      genericPenalty += genericHits * factor;
      reasons.push(inTitle ? "generic (in title)" : "generic word");
    }

    // --- Irrelevant penalty: numbers-only, weird symbols ---
    if (/^\d+$/.test(lower.replace(/[^a-z0-9]/g, ""))) {
      irrelevantPenalty += 25;
      reasons.push("numeric only");
    }

    if (/[^\w\s\-']/.test(kw)) {
      irrelevantPenalty += 5;
      reasons.push("symbols");
    }

    const score =
      relevance + specificity + titleMatch + buyerIntent - genericPenalty - irrelevantPenalty;

    return {
      keyword: kw,
      score: Math.round(score),
      breakdown: {
        relevance,
        specificity,
        titleMatch,
        buyerIntent,
        genericPenalty,
        irrelevantPenalty,
      },
      reasons,
      tokens,
    };
  }

  // ---------- Analysis pipeline ----------

  function analyzeKeywords(opts) {
    const title = (opts && opts.title) || "";
    const rawList = parseKeywords((opts && opts.keywords) || []);
    const contentType = (opts && opts.contentType) || "vector";
    const locale = (opts && opts.locale) || "en_US";
    const targetCount = clampInt(opts && opts.targetCount, 1, 49, 49);
    const topCount = clampInt(opts && opts.topCount, 1, targetCount, 10);

    const titleTokens = titleTokenSet(title);
    const ctx = { contentType, locale, titleTokens };

    // Score each, dedupe, mark near-duplicates.
    const seenExact = new Map(); // normalized -> first index
    const seenStem = new Map(); // stem-key -> first index
    const enriched = [];

    rawList.forEach((kw, idx) => {
      const norm = normalizeKey(kw);
      const stemKey = norm.split(/[^a-z0-9]+/).filter(Boolean).map(stem).join(" ");

      const base = scoreKeyword(kw, ctx);
      let status = null; // "duplicate" | "too_generic" | null
      let reasonOverride = null;

      if (norm === "" || base.tokens.length === 0) {
        status = "remove";
        reasonOverride = "empty";
      } else if (seenExact.has(norm)) {
        status = "duplicate";
        reasonOverride = "exact duplicate of #" + (seenExact.get(norm) + 1);
      } else if (stemKey && seenStem.has(stemKey)) {
        status = "duplicate";
        reasonOverride = "near-duplicate of #" + (seenStem.get(stemKey) + 1);
      } else {
        seenExact.set(norm, idx);
        if (stemKey) seenStem.set(stemKey, idx);
      }

      // Mark "too_generic" if the score is low primarily due to generic penalty
      // and there's no title match.
      if (
        !status &&
        base.breakdown.genericPenalty >= 9 &&
        base.breakdown.titleMatch === 0 &&
        base.score < 8
      ) {
        status = "too_generic";
        reasonOverride = "generic & low relevance";
      }

      enriched.push({
        ...base,
        originalIndex: idx,
        status,
        reasonOverride,
        normalized: norm,
      });
    });

    // Rank: keep non-duplicate, non-too-generic, non-remove first by score.
    const survivors = enriched
      .filter((e) => !e.status)
      .sort((a, b) => b.score - a.score || a.originalIndex - b.originalIndex);

    const top = survivors.slice(0, topCount);
    const final49 = survivors.slice(0, targetCount);
    const supportSet = new Set(final49.map((e) => e.normalized));
    const topSet = new Set(top.map((e) => e.normalized));

    // Build full ranked list (with all entries including removed/duplicate/generic)
    // for display in the table.
    const ranked = [];

    // First add survivors in score order with rank.
    survivors.forEach((e, i) => {
      const isTop = i < topCount;
      const isFinal = i < targetCount;
      const status = isTop ? "top" : isFinal ? "support" : "remove";
      const reason = isTop
        ? "strong relevance"
        : isFinal
        ? "supporting keyword"
        : "exceeds target count";
      ranked.push({
        rank: i + 1,
        keyword: e.keyword,
        score: e.score,
        status,
        reason: combineReasons(e.reasons, reason),
        breakdown: e.breakdown,
      });
    });

    // Append non-survivors at the end (no real rank, sorted by original index).
    const nonSurvivors = enriched
      .filter((e) => e.status)
      .sort((a, b) => a.originalIndex - b.originalIndex);

    nonSurvivors.forEach((e) => {
      let status;
      if (e.status === "duplicate") status = "duplicate";
      else if (e.status === "too_generic") status = "too_generic";
      else status = "remove";
      ranked.push({
        rank: null,
        keyword: e.keyword,
        score: e.score,
        status,
        reason: e.reasonOverride || combineReasons(e.reasons, status),
        breakdown: e.breakdown,
      });
    });

    const topKeywords = top.map((e) => e.keyword);
    const finalKeywords = final49.map((e) => e.keyword);

    const removedKeywords = [];
    enriched.forEach((e) => {
      if (e.status) {
        removedKeywords.push(e.keyword);
      }
    });
    survivors.slice(targetCount).forEach((e) => removedKeywords.push(e.keyword));

    const notes = buildNotes({
      total: rawList.length,
      survivors: survivors.length,
      duplicates: enriched.filter((e) => e.status === "duplicate").length,
      tooGeneric: enriched.filter((e) => e.status === "too_generic").length,
      titlePresent: titleTokens.size > 0,
      contentType,
      targetCount,
      topCount,
    });

    return {
      meta: {
        contentType,
        locale,
        targetCount,
        topCount,
        totalInput: rawList.length,
        keptCount: finalKeywords.length,
        removedCount: removedKeywords.length,
      },
      ranked,
      topKeywords,
      finalKeywords,
      removedKeywords,
      notes,
    };
  }

  function combineReasons(reasonArr, base) {
    const arr = (reasonArr || []).filter(Boolean);
    if (base) arr.unshift(base);
    return Array.from(new Set(arr)).slice(0, 4).join(" • ");
  }

  function buildNotes(s) {
    const notes = [];
    if (!s.titlePresent) {
      notes.push(
        "No title was provided — title-based ranking was skipped. Adding a title improves accuracy."
      );
    }
    if (s.duplicates > 0) {
      notes.push("Removed " + s.duplicates + " duplicate or near-duplicate keyword(s).");
    }
    if (s.tooGeneric > 0) {
      notes.push(
        "Flagged " +
          s.tooGeneric +
          " keyword(s) as too generic. Replace them with more specific phrases when possible."
      );
    }
    if (s.survivors > s.targetCount) {
      notes.push(
        "Kept the strongest " +
          s.targetCount +
          " keyword(s); the rest were dropped to stay within the Adobe Stock limit."
      );
    }
    if (s.survivors < s.topCount) {
      notes.push(
        "Fewer than " +
          s.topCount +
          " strong keywords were found. Add more specific descriptors to fill the top slots."
      );
    }
    notes.push(
      "Result is a relevance & competition helper. It does not predict sales or downloads."
    );
    return notes;
  }

  function clampInt(v, min, max, def) {
    const n = parseInt(v, 10);
    if (Number.isNaN(n)) return def;
    return Math.max(min, Math.min(max, n));
  }

  // ---------- Export ----------
  const api = { parseKeywords, analyzeKeywords };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  global.SNScoring = api;
})(typeof self !== "undefined" ? self : this);
