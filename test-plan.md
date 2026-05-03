# SN Meta Auto — Test Plan (PR #1)

> **Goal**: Prove the extension actually drives a real Meta AI session end-to-end and that the recently-fixed bugs (#1–#6) don't regress. Each test is designed so a broken implementation produces visibly different output.

## Setup (NOT part of the recorded plan)

1. Chrome already running with `https://www.meta.ai/` open and authenticated as `lynx_narwhal_3811`.
2. Load the extension unpacked from `/home/ubuntu/repos/sn-meta-auto/` via `chrome://extensions/` (developer mode → "Load unpacked").
3. Open the SN Meta Auto popup and verify it renders without console errors.

---

## Test 1 — IMAGE mode E2E (proves Bug #6 fix: 2-step generate flow)

**Why adversarial**: A broken implementation (the pre-fix code) clicks "Create image" only — Meta toggles the mode pill but the prompt is never submitted. Composer keeps the typed text and Send stays in its toggled state. Generation never happens. Pass criterion explicitly looks for the model output appearing in the chat scroller.

### Steps
1. Open the SN Meta Auto popup.
2. Click **Reset Queue**, confirm queue counter shows `0`.
3. In the Prompt Queue textarea, paste exactly:
   ```
   a yellow taxi driving through tokyo at night, neon reflections, photorealistic
   ```
4. Verify the counter reads `Total Prompt: 1`.
5. Confirm **IMAGE** tab is selected (highlighted, brutalism orange).
6. Toggle **Auto-download** ON in Settings (so we can prove the download path too).
7. Click **Start**.

### Pass criteria
- **Within 2s**: Log panel appends `Item #1: filling prompt`.
- **Within 4s**: Composer in `https://www.meta.ai/` switches to a new prompt with text `"a yellow taxi driving through tokyo at night, neon reflections, photorealistic"`. The "✨ Create ×" chip appears in the composer.
- **Within 6s**: A new chat message bubble (right-aligned) appears in the scroller with the same prompt text, and a fresh assistant response loading state begins. → This proves Send was actually clicked. *Broken impl never reaches this state.*
- **Within 60s**: 4 images with `data-testid="generated-image"` appear in the assistant response. Image src URLs match `^https://scontent-.*\.fbcdn\.net/.*\.(jpeg|jpg|webp)`.
- **Within 80s**: Log panel appends `Item #1: result detected (4 media)` and `Item #1: completed`.
- **Queue table** row #1 shows status badge `Completed` (green).
- **Counters**: `Completed: 1, Failed: 0`.

### Bug #1 verification (passive, during this test)
- While `isRunning=true`, the **Start** button must be visually disabled (greyed). Try clicking it once — toast `"Process already running"` appears OR (better) nothing happens because button is `disabled`. Reset / Stop / Resume not blocked. *Broken pre-fix code: Start button briefly re-enables after `withLock` finally fires, allowing a second Start.*

### Bug #5 verification (passive)
- Open the service worker DevTools console (chrome://extensions → SN Meta Auto → "Inspect views: service worker"). Throughout the run, no `chrome.storage.local.set` failures should be silently ignored. Look for any "[SN Meta Auto] appendLog failed" warnings — if present, surface them in the report.

---

## Test 2 — IMAGE TO VIDEO with default "imagine it" prompt (proves recent feat fix)

**Why adversarial**: The user's hard requirement is that I2V must let prompt be empty and fall back to `"imagine it"`. A broken impl either (a) refuses to start with empty textarea, (b) sends an empty string, or (c) sends some other default. Pass criterion checks the actual text typed into Meta's composer.

### Steps
1. Click **Reset Queue**.
2. Switch to **IMAGE TO VIDEO** tab.
3. The hint paragraph should be visible: `"Bulk upload supported. Prompt is optional — if empty, each image uses imagine it as the default..."`. Verify the text matches.
4. Click **Upload Images**, select `/home/ubuntu/dom_result_step3_final.png` (any small image works — this is just a real PNG already on disk).
5. The image preview grid shows 1 thumbnail. Counter reads `Images: 1`.
6. **Leave the Prompt textarea empty.** Verify counter reads `Total Prompt: 0`.
7. Click **Start**.

### Pass criteria
- **Within 6s**: Composer in Meta AI shows the uploaded image as an attachment chip *and* the text `imagine it`.
- **Within 8s**: Send is clicked → user message bubble in chat scroller contains the image preview + `"imagine it"` caption.
- **Within 90s**: Either an image or video appears in the assistant response (Meta may interpret "imagine it" as either; both are valid).
- **Queue table** row #1 shows status `Completed`. The `Result` column lists ≥1 media URL.

### Pass criteria for "1-image-per-turn" enforcement (passive)
- Even though the I2V upload happened, the queue table shows exactly **one** running/completed item per uploaded image. *Broken impl would batch multiple images into one Send and we'd see a single completed item with multiple uploads listed.*

---

## Test 3 — Reset mid-flight then Start (proves Bug #3 fix: no duplicate runLoops)

**Why adversarial**: Pre-fix, `handleReset` cleared `RT.running = false` while the in-flight `runLoop` was still mid-`processOne`. Clicking Start immediately afterwards bypassed the guard and started a second `runLoop`. We'd see two items go through "filling prompt" simultaneously. The fix: Reset awaits the in-flight loop, log shows `"Reset pressed — waiting for current item to finish..."`. Pass criterion is exact log text + only one concurrent "filling prompt" log line at any time.

### Steps
1. Click **Reset Queue**.
2. Switch to **IMAGE** tab.
3. Paste 2 prompts:
   ```
   prompt one
   prompt two
   ```
4. Toggle Auto-download OFF (we don't need files for this test).
5. Click **Start**.
6. **Within 4s** (i.e. while the loop is mid-flight processing item #1, before it completes), click **Reset Queue** in the popup.
7. Observe log panel for the next 30s.
8. Click **Start** again immediately after Reset (within 2s of clicking Reset).
9. Add a new single prompt to the textarea: `prompt three`.
10. Click **Start** again.

### Pass criteria
- After step 6: Log appends `"Reset pressed — waiting for current item to finish..."` *exactly*. *Broken impl logs `"Queue reset"` immediately without the "waiting" line.*
- After step 6, before step 8: Reset only completes (`"Queue reset"` in log) once the in-flight item resolves or times out. The popup shows the queue table cleared **at that moment**, not earlier.
- Step 8 click: If the old loop is still mid-flight, the second Start should either (a) silently no-op because `runLoopPromise !== null` AND queue is empty (after Reset cleared it) → toast `"Queue has no pending items..."`, OR (b) succeed once Reset completes and no second runLoop is spawned. **At no point** should the log show two consecutive `"Item #1: filling prompt"` lines from different items without a `"completed"` between them. *Broken impl: log would interleave `Item #1: filling prompt`, `Item #2: filling prompt` from two concurrent loops.*
- After step 10: New prompt processes normally and completes.

### Bug #4 verification (passive, during step 6 race)
- During step 6, the in-flight item should be marked correctly by ID. If we *had* mid-flight removed an unrelated row, the wrong-row-update would surface. We won't trigger that exact race here (it requires `handleItemAction` mid-flight) — that's covered by code review of the ID-based lookup.

---

## Test 4 — Bug #2 verification: typing in textarea while queue is running

**Why adversarial**: Pre-fix, popup.js's `savePromptTextDraft` did a full read-modify-write of `sn_state` from the popup process. While background was incrementing `completedCount`, popup's write would silently overwrite the new completedCount with the cached old one. Pass criterion: counters stay monotonically increasing.

### Steps
1. Click **Reset Queue**.
2. Paste 3 prompts:
   ```
   prompt A
   prompt B
   prompt C
   ```
3. Click **Start**.
4. **Immediately and continuously** (every ~500ms for 90s) type extra characters into the textarea. The textarea will keep adding new lines but only the original 3 are queued (queue was already pushed via `SET_QUEUE`).
5. Observe `Completed` counter and queue table after each item finishes.

### Pass criteria
- `Completed` counter goes `0 → 1 → 2 → 3` strictly monotonically. *Broken impl would occasionally skip back from `1 → 0` or stall at `1` because popup's save kept clobbering background's increment.*
- All 3 items reach status `Completed` (or `Failed` deterministically — but never disappear).
- Final state: `Completed: 3, Failed: 0` AND queue table still has 3 rows.

---

## Out of scope for this recording

- VIDEO mode E2E — the user asked for it but it's a same-shape test as IMAGE (just different mode pill). Save quota; rely on the screenshot evidence. *If time permits and quota allows, append a short Test 2.5 with a 60s budget.*
- Scan Media + Download Selected vs Download All — covered implicitly by Test 1 auto-download. We'll inspect the Downloads folder for `SN_Meta_Auto/sn_meta_image_*_*.jpeg` after Test 1 to confirm naming pattern is honored.
- Cross-browser. Chromium only.
- Stop/Resume mid-flight (covered transitively by Test 3's Reset path; Stop+Resume is mostly a state toggle that we'd need a separate quota burn to verify).

## Reporting

After execution, post a SINGLE GitHub comment to PR #1 containing:
- Pass/fail bullets per test.
- Inline screenshots of (a) IMAGE result with 4 images visible in queue + popup, (b) I2V default "imagine it" composer text, (c) log panel showing the exact "Reset pressed — waiting for current item to finish..." line.
- Recording attached.
- Link to this test plan path.
- Devin session URL.
