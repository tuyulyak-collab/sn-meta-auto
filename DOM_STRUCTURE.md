# Meta AI DOM Structure — for SN Meta Auto

Capture taken on **2026-04-28** from `https://www.meta.ai/` while logged in as `lynx_narwhal_3811` (yupi176@choco.la). The structure below is what the extension's `utils/domScanner.js` targets.

> Notes
> - Meta AI uses Tailwind utility classes; the class names below are unstable and should NOT be relied on. Use `data-testid`, `aria-label`, `role`, and tag/text instead.
> - There are TWO things tagged `data-testid="composer-input"`. One is a **hidden** `<textarea>` (placeholder="Ask Meta AI…"). The other is the **visible** Lexical contenteditable. The selector must explicitly require `role="textbox"` or `contenteditable="true"` to skip the hidden textarea.
> - Generated images/videos carry `data-testid="generated-image"` / `"generated-video"` — these are the strongest selectors for completion detection and the Scan / Download tools.
> - **The Generate flow is two steps.** Clicking "Create image" or "Create video" only toggles the composer into that mode (adds a "✨ Create ×" chip). Actual generation still requires clicking the **Send** button (aria-label="Send"). The old extension code skipped step 2.

---

## 1. Page-level layout

```
<html>
  <body>
    <main data-slot="flexbox" class="flex flex-col grow relative overflow-hidden">
      ├─ sticky header (top-0, h-14)
      ├─ chat scroller (overflow-y-auto, container: chat-scroller)
      │   ├─ user message bubble (right-aligned)
      │   └─ assistant response  ← contains generated media
      └─ composer (sticky bottom)
          ├─ contenteditable div (the visible prompt input)
          ├─ hidden <textarea> (decoy, same data-testid)
          ├─ chip area (mode pills: "Create", "Web search", etc.)
          ├─ "Add attachment" button + <input type="file"> (sibling)
          ├─ mode pills row: "Analyze this", "Discover products", "Do something fun", "Create image", "Create video"
          └─ "Send" button (aria-label="Send", paper-plane icon)
  </body>
</html>
```

Sidebar (left) is `<aside>` with "New chat", "Search", "Vibes", "Create", "History". Not used by the extension.

---

## 2. Prompt input (composer)

### Visible element (USE THIS one)

```html
<div
  class="outline-none undefined"
  contenteditable="true"
  data-testid="composer-input"
  role="textbox"
  spellcheck="true"
  data-lexical-editor="true"
  style="user-select: text; white-space: pre-wrap; word-break: break-word;"
>
  <p dir="auto"><br></p>
</div>
```

Where:
- `role="textbox"` — primary attribute, stable.
- `data-testid="composer-input"` — stable but ALSO present on the hidden textarea below.
- `data-lexical-editor="true"` — Meta uses Facebook's Lexical editor. Plain `el.value = ...` does NOT update Lexical state; you must use `document.execCommand("insertText", false, text)` after focusing + selecting all text, or dispatch `InputEvent` with `inputType="insertText"`.

### Hidden decoy

```html
<div class="absolute inset-0 z-10 hidden">
  <textarea
    class="h-full w-full resize-none border-0 bg-transparent p-0 outline-none"
    style="field-sizing: content;"
    autofocus
    placeholder="Ask Meta AI..."
    data-testid="composer-input"
  ></textarea>
</div>
```

The `<div class="…hidden">` parent ensures `getBoundingClientRect()` returns 0×0. Filter by `isVisible(el)` to ignore.

### Selector strategy in `domScanner.js`

```js
function findPromptInput() {
  // Fast path: visible composer (Lexical contenteditable variant)
  for (const el of queryAllDeep(
    '[data-testid="composer-input"][role="textbox"], '
    + '[data-testid="composer-input"][contenteditable="true"]'
  )) {
    if (isVisible(el) && isEnabled(el)) return el;
  }
  // …fallback heuristic for placeholder keywords + visibility scoring
}
```

### Setting text on Lexical

`setPromptText()` in `utils/domScanner.js`:
1. Focus the element.
2. `el.innerHTML = ""` to clear (Lexical re-syncs internally).
3. `document.execCommand("insertText", false, text)` — Lexical listens for the resulting `beforeinput` event and updates its model.
4. Dispatch `input` + `change` events as belt-and-braces.

---

## 3. Mode pills (NOT generate buttons)

Below the composer, a row of pill buttons:

```html
<button class="…h-8 px-3 hover:enabled:bg-fill-secondary-elevated…">
  <svg>…icon…</svg>
  Create image
</button>
<button class="…h-8 px-3…">
  <svg>…icon…</svg>
  Create video
</button>
```

| Mode pill | Inner text | Bounding box (x,y,w,h) |
|---|---|---|
| Image | `Create image` | `(947, 533, 110, 32)` |
| Video | `Create video` | `(1065, 533, 105, 32)` |

**Behavior**: Clicking these does NOT submit the prompt. It activates the mode and adds a chip into the composer:

```html
<!-- after clicking "Create image" -->
<div class="… chip …">
  <svg class="text-accent">✨</svg>
  Create
  <button aria-label="Cancel">×</button>
</div>
```

The previously-disabled Send button now becomes enabled.

### Detecting active mode

```js
function isModeActive() {
  const composer = findPromptInput();
  let parent = composer;
  for (let i = 0; i < 10 && parent; i++) {
    const t = (parent.innerText || "").toLowerCase();
    if (t.includes("create") && t.includes("×")) return true;
    parent = parent.parentElement;
  }
  return false;
}
```

---

## 4. Send button (THIS is the actual submit)

```html
<button
  aria-label="Send"
  class="…size-8 rounded-round text-text-on-accent…"
  disabled  <!-- only when composer is empty -->
>
  <svg viewBox="0 0 32 32"><!-- paper-plane icon --></svg>
</button>
```

- `aria-label="Send"` — stable.
- `disabled` toggles to `false` once composer has text (and a mode chip if applicable).
- Position: rightmost button in the composer row. Bounding box ~`(1250, 455, 32, 32)`.

### Generate flow (two-step)

```js
async function clickGenerate(mode) {
  // Step 1 — toggle the mode pill if not already active
  if ((mode === "image" || mode === "video" || mode === "image_to_video") && !isModeActive()) {
    const pill = findModePill(mode);  // matches innerText.trim().toLowerCase() === "create image" / "create video"
    pill.click();
    await sleep(300);
  }
  // Step 2 — wait for Send to enable, then click
  let send = findSendButton();
  for (let i = 0; i < 10; i++) {
    if (send && isEnabled(send)) break;
    await sleep(150);
    send = findSendButton();
  }
  if (!send) throw new Error("Send button not found");
  if (!isEnabled(send)) throw new Error("Send button disabled (composer empty?)");
  send.click();
}
```

---

## 5. File upload (for IMAGE TO VIDEO and image attachments)

```html
<button aria-label="Add attachment" class="…size-8 rounded-round…">
  <svg>+</svg>
</button>
<input
  type="file"
  multiple
  accept="image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,video/mp4,video/quicktime,application/pdf,…"
  style="display: none;"
>
```

- The `<input type="file">` exists in DOM but is `display:none`.
- It's a sibling/descendant of the "Add attachment" button.
- Programmatic upload via `DataTransfer` (`input.files = dt.files; input.dispatchEvent(new Event("change"))`) WORKS — the page picks up the file. Tested successfully.
- Accept list is broad — plenty of formats including `image/heic` and `application/pdf`. For Image-to-Video, only the image MIME types are usable.

---

## 6. Generated media (results)

After the Send button is clicked, the response renders ~30s later as a grid of 4 images (or 1 video). Each image:

```html
<img
  data-testid="generated-image"
  alt="A photorealistic red apple on a rustic wooden table, …"  <!-- Meta rewrites the prompt -->
  class="outline-fill-divider rounded-12 absolute inset-0 h-full max-h-full w-full max-w-full object-cover…"
  src="https://scontent-sea5-1.xx.fbcdn.net/o1/v/t0/f2/m247/AQ…jpeg?_nc_ht=…"
>
```

Each image is wrapped in:

```
<div class="grid gap-2 grid-cols-2 md:grid-cols-4">
  <div class="relative">
    <div class="group/media-item bg-bg-secondary rounded-12 relative max-h-full min-h-0 min-w-0">
      <div class="relative [content-visibility:auto]">
        <img data-testid="generated-image" …>
      </div>
    </div>
  </div>
  …repeat 4 times…
</div>
```

### URL pattern

- Host: `scontent-{region}.xx.fbcdn.net` (the same Facebook CDN as Instagram/Facebook)
- Path: `/o1/v/t0/f2/m{nnn}/AQ…{base64-ish}.jpeg`
- Query: `?_nc_ht=…&_nc_gid=…&…` (signed URL, not a permanent link — expires after some hours)

**Implication for downloads**: `chrome.downloads.download({ url })` works because the CDN returns the file with proper CORS/Content-Disposition. The extension's `utils/downloader.js` should NOT need a CORS proxy. The default filename Chrome derives from the URL is gibberish — that's why we explicitly pass `filename: "SN_Meta_Auto/sn_meta_image_001_<date>.jpeg"`.

### Selector in `collectMedia()`

```js
// High-confidence first
for (const img of queryAllDeep('img[data-testid="generated-image"]')) {
  push("image", img.src, img);
}
for (const v of queryAllDeep('video[data-testid="generated-video"], [data-testid="generated-video"] video')) {
  const src = v.currentSrc || v.src || (v.querySelector("source") && v.querySelector("source").src) || "";
  push("video", src, v);
}
// Fallback for any non-tagged result media
for (const img of queryAllDeep("img")) { /* size + non-data-uri filter */ }
```

---

## 7. Result action buttons (Download / Share)

Each generated image has an in-line "Download" button (next to "Share"):

```html
<button aria-label="Download" class="…size-8…">
  <svg>↓</svg>
</button>
<button aria-label="Share" class="…size-8…">
  <svg>↗</svg>
</button>
```

Layout: 4 images → 4 Download buttons + 4 Share buttons appear in the action row. The extension does NOT need to click these — it builds the download list from `data-testid="generated-image"` srcs and uses `chrome.downloads.download()` directly. But these buttons are useful proof-of-life if you ever want to test the Download path manually.

For text responses, the assistant message has:
- `aria-label="Copy response"` — copy text
- `aria-label="Share"` — share

---

## 8. Loading / busy state

While the model is generating (~30s for image, ~60-90s for video):

- The Send button briefly shows a stop/cancel icon (re-enabled disabled state).
- The assistant message bubble appears with skeleton placeholders for the 4 images.
- DOM mutation: a `<div role="img" aria-busy="true">` may appear (couldn't confirm in this probe — the result was fast).

The extension's `waitForCompletion()` uses a `MutationObserver` watching for `src`/`style`/`aria-busy` attribute changes plus a 1.2s polling fallback. The completion criterion is "first new media URL not in baseline" — this matched the 4 fbcdn `data-testid="generated-image"` elements within ~30s in our probe.

Timeout fallback: 180s (configurable via `settings.timeoutSec`).

---

## 9. Conversation list / sidebar (NOT used by extension)

```html
<aside>
  <button aria-label="Toggle Sidebar"></button>
  <button>Search</button>
  <button>Vibes</button>
  <button>Create</button>
  <span>History</span>
  <!-- conversation rows -->
</aside>
```

Only relevant if we ever add a "scan all conversations" feature. Currently out of scope.

---

## 10. Known edge cases & future tweaks

1. **OTP every login from a fresh IP.** Meta AI's auth flow on `auth.meta.com` enforces an email one-time code if the IP/UA is new. Save a browser profile to skip this on every Devin run (org config now includes `$FILE_BROWSER_PROFILE_ENV_VAR`).
2. **Lexical state vs `el.value`.** Setting `textContent` on the contenteditable div does NOT trigger Lexical's internal model update. The extension uses `document.execCommand("insertText")` after focus + selection — verified working.
3. **Mode chip can be dismissed** by clicking the `×` inside it. The extension's `isModeActive()` heuristic detects the chip + dismiss "×". If Meta changes that to e.g. an SVG-only close button, the heuristic needs adjustment.
4. **Send button enables only when** composer has text AND (if mode is Create) the chip is set. The extension waits up to 1.5s for Send to enable; longer hangs throw "Send button disabled (composer empty?)".
5. **`data-testid` is the most stable selector** — Tailwind classes change between Meta deploys; aria-labels are localized (English only in our probe).
6. **fbcdn URLs expire.** A signed URL might return 403 hours later. The extension downloads immediately on completion if `Auto-download` is on; otherwise, the user should download soon after the batch.
7. **Hidden textarea trap.** Future Meta refactors may remove the hidden decoy, in which case `findPromptInput()`'s fast path still works. If they reverse the visibility (hidden contenteditable, visible textarea), the heuristic falls through to keyword scoring.
