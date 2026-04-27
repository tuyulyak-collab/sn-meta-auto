# SN Stock Keyword Optimizer

A Chrome Extension (Manifest V3) for **Adobe Stock contributors**. It scans, analyzes, cleans, and reorders keywords either directly on the Adobe Stock contributor upload/edit page or via a manual paste-and-analyze panel.

> **Disclaimer.** SN Stock Keyword Optimizer is a **keyword relevance & competition helper**. It does **not** predict sales, downloads, or revenue.

---

## Features

### Two modes

1. **Current Page Mode**
   - Detects whether the active tab is on `*.stock.adobe.com`.
   - Scans the page for the title field, keyword field/textarea/contenteditable, and chip-style tags using multiple detection strategies (input, textarea, `contenteditable`, `role="textbox"`, `aria-label`, `placeholder`, `data-testid`, label associations).
   - Shows the detected title and keyword count.
   - Lets you **Analyze & Reorder** the detected keywords.
   - Lets you **Apply to Adobe Stock Page** to write the optimized order back to the keyword field. Always asks for confirmation first. Never auto-submits.
   - If detection fails, you are pointed to Manual Analyzer Mode.

2. **Manual Analyzer Mode**
   - Works anywhere — no need to be on Adobe Stock.
   - Paste a title and keywords, choose content type (Vector / Illustration / Photo / PNG), locale (`en_US` / `en_GB`), target keyword count (default 49), and top priority count (default 10).
   - Buttons: **Analyze Keywords**, **Reorder Top 49**, **Copy Keywords**, **Export CSV**, **Clear**.

### Local heuristic scoring

Each keyword is scored locally:

```
Final Score =
    Relevance Score
  + Specificity Score
  + Title Match Score
  + Buyer Intent Score
  − Generic Penalty
  − Duplicate Penalty
  − Irrelevant Penalty
```

Rules implemented:
- Maximum keyword count is **49**.
- The top **10** are flagged as the strongest, most relevant.
- Keywords matching words in the title rank higher.
- More specific phrases rank higher than broad single words.
- Exact duplicates are removed.
- Near-duplicates (simple plural / stem matches) are flagged.
- Generic words (`art`, `design`, `graphic`, `image`, `object`, `element`, `background`, `isolated`, etc.) are penalized unless they actually appear in the title.
- Stock-relevant terms (`vector`, `illustration`, `icon`, `set`, `collection`, `cartoon`, `mascot`, `pattern`) are slightly boosted only when they match the chosen content type.

### Result table

A colorful table with `Rank`, `Keyword`, `Score`, `Status`, `Reason`. Status badges:

- **Top 10** — green
- **Support** — yellow
- **Remove** — pink
- **Duplicate** — purple
- **Too Generic** — orange

### Output sections

- **Top 10 Keywords** (with copy button)
- **Final 49 Keywords** (with copy button)
- **Removed Keywords** (with copy button)
- **Notes & Suggestions**

### Settings

- Default locale (`en_US` / `en_GB`)
- Default content type (Vector / Illustration / Photo / PNG)
- Max keywords (default 49)
- Top priority keywords (default 10)
- Backend API URL (optional; placeholder for future use)
- API mode toggle: **Local Heuristic Mode** / **Backend API Mode**

If Backend API Mode is selected without a URL, the extension falls back to local mode automatically.

---

## Install (Load Unpacked)

1. Clone or download this repository.
2. Open Chrome and go to `chrome://extensions`.
3. Toggle **Developer mode** (top right).
4. Click **Load unpacked** and select this folder (`sn-stock-keyword-optimizer/`).
5. Pin the extension and click its icon to open the popup.

---

## Project structure

```
sn-stock-keyword-optimizer/
├── manifest.json          # Manifest V3
├── popup.html             # Popup UI
├── styles/
│   └── popup.css          # Soft brutalism / colorful styling
├── scripts/
│   ├── popup.js           # Popup logic, tabs, rendering
│   ├── scoring.js         # Local heuristic scoring (window.SNScoring)
│   ├── contentScript.js   # Adobe Stock page detection / scan / apply
│   └── background.js      # MV3 service worker (messaging)
├── icons/                 # 16 / 32 / 48 / 128 px icons
└── README.md
```

---

## Privacy

- All scoring happens **locally** in the popup.
- No keywords or page content are sent to any server.
- Settings are stored in `chrome.storage.local`.
- The extension never auto-submits Adobe Stock forms or clicks any submit button.
- Backend API mode is currently a placeholder; without a URL set, no network requests are made.

---

## Notes

- Adobe Stock's contributor UI changes occasionally. The content script uses multiple fallback strategies (input / textarea / contenteditable / chips / aria-label / placeholder / `data-testid` / nearby labels) but cannot guarantee detection on every UI variant. When automatic detection fails, switch to Manual Analyzer Mode.
- Chip-based keyword UIs are detected for **scanning** but `Apply to Adobe Stock Page` currently only writes back into a real input/textarea/contenteditable field; for chip-only UIs, copy the optimized keyword list and paste it manually.

---

## License

MIT (or whatever the repo owner specifies).
