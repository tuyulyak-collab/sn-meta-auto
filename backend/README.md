# SN Stock Keyword Optimizer — Backend (Vercel + Gemini / Groq)

A tiny Vercel **Edge serverless function** that takes a title + keywords from the Chrome extension and returns LLM-driven scoring (relevance + competition tier) plus suggested niche keywords.

It supports **Gemini** (Google AI Studio) **or** **Groq** (Llama 3.3 70B), picked by an env var. Pick whichever has more free quota for you.

> This is a **relevance & competition helper**, not a sales predictor.

---

## 1. Get an API key (one of these)

### Option A — Google Gemini (recommended, no credit card)
1. Open https://aistudio.google.com/apikey
2. Sign in with a Google account
3. Click **Create API key**, copy the value
4. Free tier (`gemini-1.5-flash`): 15 req/min, ~1500 req/day, 1M input tokens/min

### Option B — Groq (faster inference, no credit card)
1. Open https://console.groq.com/keys
2. Sign up (free, no card)
3. Click **Create API Key**, copy the value (starts with `gsk_`)
4. Free tier (`llama-3.3-70b-versatile`): 30 req/min, ~14k req/day

---

## 2. Sign up Vercel (free)

Open https://vercel.com/signup and sign in with the **same GitHub account** that owns `tuyulyak-collab/sn-stock-keyword-optimizer`. No credit card needed for the Hobby plan.

---

## 3. Import the repo into Vercel

1. From your Vercel dashboard → **Add New… → Project**
2. Pick the `tuyulyak-collab/sn-stock-keyword-optimizer` repo (click **Import**)
3. **Important**: in the Configure Project screen:
   - **Root Directory** → click **Edit** → set to `backend`
   - **Framework Preset** → leave as `Other`
   - **Build / Output Settings** → leave defaults (no build needed)
4. Expand **Environment Variables** and add **either**:
   - For Gemini:
     - `LLM_PROVIDER` = `gemini`
     - `LLM_API_KEY` = your Gemini key
     - (optional) `LLM_MODEL` = `gemini-1.5-flash`
   - For Groq:
     - `LLM_PROVIDER` = `groq`
     - `LLM_API_KEY` = your Groq key
     - (optional) `LLM_MODEL` = `llama-3.3-70b-versatile`
5. Click **Deploy**.
6. After deploy completes, copy the production URL (e.g. `https://sn-stock-keyword-optimizer-abc.vercel.app`).

---

## 4. Wire it into the Chrome extension

Open the extension popup → **Settings** tab:

- **Backend API URL** → paste the URL from step 3.6, **without** trailing slash
  (e.g. `https://sn-stock-keyword-optimizer-abc.vercel.app`)
- **API Mode** → switch to **Backend API Mode**
- Click **Save Settings**

Now in the **Manual Analyzer** tab (or **Current Page** after a scan), click **Auto-Score with LLM** to call the backend. The result table will show a new **Competition** column (low/medium/high badges) and a **Suggested Keywords** section with niche additions from the LLM.

If the backend is unreachable or `LLM_API_KEY` is wrong, the extension automatically falls back to the local heuristic scorer.

---

## 5. (Optional) Local development

```bash
cd backend
npm install -g vercel    # one-time
vercel dev               # runs at http://localhost:3000

# Set env vars in .env.local:
echo "LLM_PROVIDER=gemini" > .env.local
echo "LLM_API_KEY=your_key_here" >> .env.local
```

Then point the extension's **Backend API URL** at `http://localhost:3000`.

---

## API contract

### `POST /api/analyze`

Request:
```json
{
  "title": "Cute cartoon cat sitting on a colorful pillow",
  "keywords": ["cat", "cute cat", "kawaii cat illustration", "..."],
  "contentType": "vector",
  "locale": "en_US"
}
```

Response (200):
```json
{
  "ok": true,
  "provider": "gemini",
  "model": "gemini-1.5-flash",
  "scored": [
    { "keyword": "cat", "relevance": 60, "competition": "high", "reason": "broad single word" },
    { "keyword": "cute cat", "relevance": 88, "competition": "high", "reason": "matches title" },
    { "keyword": "kawaii cat illustration", "relevance": 95, "competition": "low", "reason": "specific niche" }
  ],
  "suggested": ["chibi cat sticker", "pastel pillow vector", "..."],
  "disclaimer": "Relevance & competition helper. Not a sales predictor."
}
```

### `GET /api/analyze`
Health check (returns service info + currently-configured provider).

---

## Limits & guardrails

- Hard caps on input: title ≤ 500 chars, keywords ≤ 80 entries.
- Edge runtime, ~10s timeout — well within Vercel Hobby limits.
- LLM responses are aligned by keyword (case-insensitive) so order and length always match the input.
- All endpoints return permissive CORS (extension popup origin = `chrome-extension://...`).

---

## Privacy

- The backend is stateless. It does **not** persist titles, keywords, or LLM responses.
- The only outbound request is to your chosen LLM provider, using the `LLM_API_KEY` you configured.
- The extension never sends data to the backend in **Local Heuristic Mode**.
