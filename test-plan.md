# SN Meta Auto — Test Plan

Live verification matrix for the extension, executed against `https://www.meta.ai/` while logged in. Use this as a regression checklist whenever Meta AI changes its DOM or the extension is touched.

## Setup

1. **Load unpacked**: open `chrome://extensions`, enable Developer mode, click "Load unpacked", select the repo root.
2. **Open Meta AI** (`https://www.meta.ai/`) and log in.
3. **Pin SN Meta Auto** to the toolbar (puzzle-piece menu → pin icon).
4. Open the popup once so the service worker boots.

> If you see `service worker (Inactive)` on the chrome://extensions card, that's normal — MV3 service workers idle out after ~30s. The popup or any queue tick wakes it back up.

---

## Smoke matrix

| # | Section | What to check | Expected | Verified |
|---|---|---|---|---|
| 1 | Load | Extension card has no "Errors" badge; ID present; service worker link visible | OK | ✅ 2026-04-29 |
| 2 | Popup | Brutalism UI renders all 8 sections; status badge `IDLE` | OK | ✅ |
| 3 | DOM probe | On `meta.ai`, in the page console: `document.querySelectorAll('[data-testid="composer-input"]').length` returns `2` (one visible, one hidden) | OK | ✅ |
| 4 | Mode pills | `Create image` and `Create video` pills exist below the composer | OK | ✅ |
| 5 | Send button | `button[aria-label="Send"]` exists, `disabled` until composer has text | OK | ✅ |

---

## IMAGE mode

1. Reset queue.
2. Type 1 prompt in the textarea, e.g. `A photorealistic red apple on a rustic wooden table, soft window light, 4k`.
3. Mode tab = `IMAGE`.
4. Optionally check "Auto-download after each task".
5. Click **Start**.

**Expect:**
- Status badge → `RUNNING`.
- Logs append: `filling prompt → clicking generate (image) → waiting for result → result detected (N media) → completed`.
- Page navigates to `meta.ai/prompt/<uuid>` and Meta returns 4 images within ~10–30s.
- Queue row shows `COMPLETED` + result count.
- Status badge → `DONE`.

**Verified 2026-04-29**: 1 prompt → 4 images in ~12s, all 4 downloaded as `sn_meta_image_001..004_<date>.jpeg` to `~/Downloads/SN_Meta_Auto/`.

---

## VIDEO mode

Same steps as IMAGE, but:
- Mode tab = `VIDEO`.
- Prompt: `A jellyfish floating in deep blue ocean, cinematic underwater scene`.

**Note**: Meta AI's current "Create video" flow returns 4 still **images** with an `Animate` button each; the user (or a follow-up extension feature) must click `Animate` to get the actual video. Until then, the extension scans/downloads the image candidates. `data-testid="generated-video"` selectors remain in place for when Meta returns video directly.

**Verified 2026-04-29**: Mode pill clicked, prompt sent, 4 image candidates rendered, queue marked `COMPLETED`, badge `DONE`.

---

## IMAGE TO VIDEO (I2V)

1. Reset queue.
2. Mode tab = `IMAGE TO VIDEO`.
3. Click **Upload Images**, pick 2–3 image files. Counter shows "Images: N".
4. Leave the prompt textarea empty.
5. Click **Start**.

**Expect:**
- Each image becomes its own queue row with prompt = `imagine it` (default).
- Items run **sequentially** — only one image is uploaded + sent per turn (Meta's hard limit is 1 image/turn).
- Logs: `uploading image → filling prompt → clicking generate → waiting for result → result detected → completed`, repeated per item.

**Variations to test:**
- 1 prompt line + 3 images → all 3 share the single prompt.
- 3 prompts + 3 images → positional pairing (image 1 ↔ prompt 1, etc.).
- More prompts than images → extras are ignored.
- More images than prompts → extras get the first prompt as fallback.

---

## Stop / Resume

1. Queue 3 prompts in IMAGE mode.
2. Click **Start**.
3. While item #1 is running, click **Stop**.

**Expect:**
- Item #1 finishes (or the in-flight task completes/fails normally).
- Status badge → `IDLE` (paused). Items #2 and #3 stay `PENDING`.

4. Click **Resume**.

**Expect:** queue continues from item #2.

5. Click **Reset queue**.

**Expect:** confirmation prompt; on OK, all items cleared, `RUNNING` flag goes false, no orphaned in-flight loop.

---

## Scan Media / Download Selected / Download All

After any successful generation:
1. Click **Scan Media** in section 6.
2. The grid populates with checkboxes pre-checked. Each tile shows `IMAGE` or `VIDEO` + dimensions.

| Action | Expect |
|---|---|
| Uncheck some, click **Download Selected** | Only checked items downloaded |
| Click **Download All** | All items downloaded regardless of checkbox |

Files land in `~/Downloads/<subfolder>/` with the configured filename pattern. Default subfolder is `SN_Meta_Auto` (used even if the user clears the field).

---

## Settings sanity

| Setting | Default | Behaviour |
|---|---|---|
| Delay (s) | 3 | Inserted between queue items |
| Max batch | 10 | Hard cap per `Start` press |
| Timeout per task (s) | 180 | If completion isn't detected, item fails with `timeout` |
| Filename pattern | `sn_meta_{type}_{index}_{date}` | Tokens: `{type} {index} {date} {time} {ts} {ext}` |
| Download subfolder | `SN_Meta_Auto` | Empty / whitespace falls back to default |
| Stop on error | off | When on, queue halts on first failure |
| Auto-download | off | When on, each task downloads results immediately |

---

## Known limitations

1. **Meta's I2V cap is 1 image/turn.** The extension respects this by splitting into per-image queue items.
2. **VIDEO mode returns image candidates** until Meta's UX changes. The extension downloads what's rendered; clicking `Animate` is still manual.
3. **fbcdn URLs expire** after a few hours. Use Auto-download or download soon after the run.
4. **Lexical composer** ignores `el.value = …`. The extension sets text via `execCommand("insertText")` after focusing + clearing — verified working.
5. **`data-testid="composer-input"` matches two elements** (visible contenteditable + hidden decoy textarea). Selectors must require `role="textbox"` or `contenteditable="true"` and `isVisible()`.
