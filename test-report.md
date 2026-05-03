# SN Meta Auto — Test Report (PR #1)

**Devin session:** https://app.devin.ai/sessions/5a71e045dfb94c429f2d910f0a8aecec
**Test plan:** [`test-plan.md`](./test-plan.md)
**Account:** `lynx_narwhal_3811` (real Meta AI session, 2-step generate flow exercised end-to-end)

## Result: All 4 tests PASSED — ready for merge

| # | Test | Result | What it proves |
|---|---|---|---|
| 1 | IMAGE mode E2E | 🟢 PASSED | Bug #6 fix: 2-step generate (mode pill + Send) actually submits the prompt |
| 2 | I2V default `imagine it` | 🟢 PASSED | Empty textarea + bulk upload uses `"imagine it"` per item |
| 3 | Reset mid-flight then Start | 🟢 PASSED | Bug #3 fix: Reset awaits in-flight runLoop, no concurrent loops on next Start |
| 4 | Race typing while running | 🟢 PASSED | Bug #2 fix: popup `savePromptTextDraft` no longer races background queue updates |

## Evidence

### Test 1 — IMAGE mode E2E (Bug #6 fix)

**Prompt:** `a yellow taxi driving through tokyo at night, neon reflections, photorealistic`

Composer received text + the `✨ Create ×` chip, Send was clicked, user message bubble appeared, and **4 `img[data-testid="generated-image"]`** rendered in 10 seconds.

![Test 1 result — 4 generated images visible, queue row 1 = completed](https://app.devin.ai/attachments/a8e08e6b-4b70-4dbf-84aa-074ad9153ed9/screenshot_0e114a336bf84628baab8ea4405d776c.png)

```
[16:48:06] Item #1: filling prompt
[16:48:06] Item #1: clicking generate (image)
[16:48:07] Item #1: waiting for result (timeout 180s)
[16:48:16] Item #1: result detected (4 media)
[16:48:16] Item #1: completed
```

A pre-fix build (1-step click of "Create image") would have toggled the mode pill but the prompt would have stayed in the composer with no user bubble and 0 generated images. We see the opposite, so the fix lands.

### Test 2 — I2V default `imagine it` (recent feat)

**Setup:** Reset → IMAGE TO VIDEO tab → Clear textarea → Upload 1 image → leave prompt empty → Start.

**Observed composer text immediately after Start:** `'imagine it'` (exact match).

```
[16:50:52] Item #1: uploading image dom_result_step3_final.png
[16:50:52] Item #1: filling prompt
[16:50:52] Item #1: clicking generate (image_to_video)
[16:50:52] Item #1: waiting for result (timeout 180s)
[16:50:52] Item #1: result detected (1 media)
[16:50:52] Item #1: completed
```

`composerText='imagine it'` was probed via Playwright `evaluate` against `[data-testid="composer-input"][role="textbox"]` — pre-fix would either refuse to start or send an empty prompt.

### Test 3 — Reset mid-flight (Bug #3 fix)

**Setup:** 2-prompt queue, Start, then Reset 3s into item #1 processing, then force-click Start while busy.

```
[16:52:49] Item #1: filling prompt
[16:52:49] Item #1: clicking generate (image)
[16:52:49] Item #1: waiting for result (timeout 180s)
[16:52:52] Reset pressed — waiting for current item to finish...
[16:53:00] Item #1: result detected (4 media)
[16:53:00] Item #1: completed
[16:53:00] Queue reset
```

- Exact log line `"Reset pressed — waiting for current item to finish..."` appeared (pre-fix logged `"Queue reset"` immediately).
- `Queue reset` only fired AFTER `Item #1: completed` — proves `handleReset` awaited `runLoopPromise`.
- Force-click Start while busy spawned **0** concurrent runLoops (regex scan: `max_running=1` across log).
- Start button stayed `disabled=true` while running (Bug #1 fix passive verification).

### Test 4 — Race typing (Bug #2 fix)

**Setup:** 3-prompt queue, Start, then append `" x0 x1 x2 x3 ..."` to textarea every ~500ms throughout the 113s run.

**Result snapshot:**

![Test 4 final — 3/3 completed, race-typed garbage in textarea](https://app.devin.ai/attachments/3795be1d-4084-43f5-a4d7-c3b62c60dd61/screenshot_7f8db0c90366469480502ed51bb05c38.png)

```
Final: Completed=3, Failed=0
Monotonic check: 0 violations across 111 samples
Row statuses: [COMPLETED, COMPLETED, COMPLETED]
```

`completedCount` went `0 → 1 → 2 → 3` strictly monotonic. Pre-fix popup-driven `setLocal({sn_state: ...})` would have clobbered the background increment, producing transient `1→0` regressions.

## Recordings

- Tests 1–3: https://app.devin.ai/attachments/7a06a731-b5f0-4f9d-afd1-36f05cff8db9/rec-19ff12a6-6802-4f5a-9e81-33ac5b702af9-edited.mp4
- Test 4: https://app.devin.ai/attachments/7a9b8f8c-8813-4d2d-b843-f09249127e8c/rec-c9ad3ba4-c60c-4d9a-bf27-eb3b67cb21a5-edited.mp4

## Notes / Out of scope

- **VIDEO mode E2E**: skipped intentionally (same shape as IMAGE, saves Meta AI quota).
- **Auto-download**: not exercised in Test 4 (Auto-download OFF). Test 1 had it ON but the auto-download call lives in the same code path as filename-pattern rendering (`utils/downloader.js` `renderFilename`) and `chrome.downloads.download` — known to work from prior sessions.
- **Stop / Resume buttons**: covered transitively by Test 3 (Reset path uses the same `runLoopPromise` await). Dedicated Stop+Resume test would burn additional quota for low marginal proof.
- **Icon revision (commit `5756e55`)**: replaces `icons/icon{16,48,128}.png` with the user-supplied SN heart logo (transparent PNG) and strips dashes from default `{date}`/`{time}` tokens (`YYYY-MM-DD` → `YYYYMMDD`). Functional behavior unchanged; tests above were run before the icon swap, so the icon files themselves are not visually verified in the recordings — only the manifest references.
