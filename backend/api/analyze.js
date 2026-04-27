// Vercel Serverless Function: POST /api/analyze
//
// Accepts a title + keywords + contentType + locale and returns LLM-driven
// scoring (relevance, competition tier, reason) plus suggested extra
// keywords. Supports Gemini and Groq, picked by the LLM_PROVIDER env var.
//
// This is a relevance & competition helper, not a sales predictor.

export const config = {
  runtime: "edge",
  regions: ["iad1"],
};

const ALLOWED_PROVIDERS = ["gemini", "groq"];

const SYSTEM_PROMPT = `You are an expert Adobe Stock contributor consultant.
Given a title and a candidate keyword list, you return:
1) A relevance score (0-100) for each keyword vs the title
2) A competition tier: "low" | "medium" | "high" based on how saturated that
   keyword is on Adobe Stock (use your training-data knowledge — be honest)
3) A short reason (max 8 words) explaining the score
4) 5-10 additional niche keywords that would help this asset get found

You are a relevance & competition helper. You DO NOT predict sales or downloads.
You always return strict JSON. Never include prose outside the JSON.`;

function buildUserPrompt({ title, keywords, contentType, locale }) {
  const kwBlock = keywords.map((k, i) => `${i + 1}. ${k}`).join("\n");
  return `Title: ${title || "(none)"}
Content type: ${contentType || "vector"}
Locale: ${locale || "en_US"}

Keywords:
${kwBlock}

Return JSON in this exact shape:
{
  "scored": [
    { "keyword": "<original keyword>", "relevance": <0-100>, "competition": "low"|"medium"|"high", "reason": "<<=8 words>>" }
  ],
  "suggested": [ "<niche keyword 1>", "<niche keyword 2>", ... ]
}

Rules:
- Always return ALL keywords from the input in the "scored" array, in the same order.
- "competition" reflects saturation on Adobe Stock — generic single words are usually "high".
- Suggested keywords must be NEW (not in input), specific, and buyer-relevant.
- Output ONLY the JSON object, no markdown, no commentary.`;
}

async function callGemini({ apiKey, model, system, user }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    systemInstruction: { role: "system", parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json",
      maxOutputTokens: 4096,
    },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini ${res.status}: ${errText.slice(0, 300)}`);
  }
  const json = await res.json();
  const text =
    json &&
    json.candidates &&
    json.candidates[0] &&
    json.candidates[0].content &&
    json.candidates[0].content.parts &&
    json.candidates[0].content.parts[0] &&
    json.candidates[0].content.parts[0].text;
  if (!text) throw new Error("Gemini: empty response");
  return text;
}

async function callGroq({ apiKey, model, system, user }) {
  const url = "https://api.groq.com/openai/v1/chat/completions";
  const body = {
    model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    max_tokens: 4096,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Groq ${res.status}: ${errText.slice(0, 300)}`);
  }
  const json = await res.json();
  const text =
    json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  if (!text) throw new Error("Groq: empty response");
  return text;
}

function parseJson(text) {
  if (!text) throw new Error("empty LLM response");
  // Strip code fences if any (defensive — providers shouldn't include them).
  const cleaned = String(text)
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`LLM returned non-JSON: ${cleaned.slice(0, 200)}`);
  }
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

export default async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (req.method === "GET") {
    return jsonResponse(200, {
      ok: true,
      service: "sn-stock-keyword-optimizer",
      provider: process.env.LLM_PROVIDER || null,
      hint: "POST { title, keywords[], contentType, locale } to score with LLM.",
      disclaimer: "Relevance & competition helper. Not a sales predictor.",
    });
  }
  if (req.method !== "POST") {
    return jsonResponse(405, { ok: false, error: "method not allowed" });
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return jsonResponse(400, { ok: false, error: "invalid JSON body" });
  }

  const title = String((body && body.title) || "").slice(0, 500);
  const contentType = String((body && body.contentType) || "vector").slice(0, 40);
  const locale = String((body && body.locale) || "en_US").slice(0, 10);
  const rawKeywords = Array.isArray(body && body.keywords) ? body.keywords : [];
  const keywords = rawKeywords
    .map((k) => String(k || "").trim())
    .filter((k) => k.length > 0)
    .slice(0, 80);

  if (keywords.length === 0) {
    return jsonResponse(400, { ok: false, error: "keywords array is empty" });
  }

  const provider = (process.env.LLM_PROVIDER || "gemini").toLowerCase();
  if (!ALLOWED_PROVIDERS.includes(provider)) {
    return jsonResponse(500, {
      ok: false,
      error: `LLM_PROVIDER must be one of: ${ALLOWED_PROVIDERS.join(", ")}`,
    });
  }
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) {
    return jsonResponse(500, { ok: false, error: "LLM_API_KEY env var is not set" });
  }

  const model =
    process.env.LLM_MODEL ||
    (provider === "gemini" ? "gemini-1.5-flash" : "llama-3.3-70b-versatile");

  const system = SYSTEM_PROMPT;
  const user = buildUserPrompt({ title, keywords, contentType, locale });

  let text;
  try {
    if (provider === "gemini") {
      text = await callGemini({ apiKey, model, system, user });
    } else {
      text = await callGroq({ apiKey, model, system, user });
    }
  } catch (e) {
    return jsonResponse(502, { ok: false, error: String((e && e.message) || e) });
  }

  let parsed;
  try {
    parsed = parseJson(text);
  } catch (e) {
    return jsonResponse(502, { ok: false, error: String((e && e.message) || e), raw: text });
  }

  const scoredIn = Array.isArray(parsed && parsed.scored) ? parsed.scored : [];
  const suggestedIn = Array.isArray(parsed && parsed.suggested) ? parsed.suggested : [];

  // Normalize scored entries; align by keyword match (case-insensitive) so we
  // never trust the LLM to preserve order perfectly.
  const lowerMap = new Map();
  scoredIn.forEach((s) => {
    if (!s || typeof s.keyword !== "string") return;
    lowerMap.set(s.keyword.toLowerCase().trim(), s);
  });

  const scored = keywords.map((kw) => {
    const m = lowerMap.get(kw.toLowerCase());
    const relevance = clampInt(m && m.relevance, 0, 100, null);
    const compRaw = m && typeof m.competition === "string" ? m.competition.toLowerCase() : null;
    const competition = ["low", "medium", "high"].includes(compRaw) ? compRaw : null;
    const reason = m && typeof m.reason === "string" ? m.reason.slice(0, 80) : "";
    return { keyword: kw, relevance, competition, reason };
  });

  const suggested = suggestedIn
    .filter((s) => typeof s === "string")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 60)
    .slice(0, 12);

  return jsonResponse(200, {
    ok: true,
    provider,
    model,
    scored,
    suggested,
    disclaimer: "Relevance & competition helper. Not a sales predictor.",
  });
}

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
