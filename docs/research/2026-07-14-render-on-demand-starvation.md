# Render-on-demand starvation — the held-upload deadlock (#1086), 2026-07-14

User report (globe, `openfreemap_bright`, WebGPU, `#2/20/0/0/0`): most labels missing,
the east side of Africa stuck on coarse border-less surface, and a white line along the
equator. All three collapse into one mechanism plus one geometry defect.

## The deadlock (#1086)

The map renders on demand: `renderLoop` skips `renderFrame()` unless
`shouldRenderThisFrame()` is true (map/src/map.ts:3643), and pending data work keeps it
alive through `hasPendingSourceWork()` (map.ts:3679) — fetch/decode in flight, GPU upload
queue busy, or last frame's `missedTiles > 0`.

Three facts make that predicate lie:

1. **`UploadCoordinator.enqueue` admits ≤4 slice-uploads per frame** (1 on ≤900 CSS-px
   viewports); overflow goes to `_heldUploads`, replayed only by `resetFrameCap()` —
   which runs in beginFrame, i.e. only when a frame renders
   (map/src/render/upload-coordinator.ts:257-319).
2. **`hasPending()`/`pendingCount()` counted only the visible queue** —
   `uploadQueue.running` — never `_heldUploads` (:371-378).
3. **A tile covered by an ancestor fallback is not "missed"** — `classifyTile` labels it
   `parent-fallback`, not `pending`, so `missedTiles` reads 0 once coarse ancestors cover
   the viewport.

An 80-layer style pushes ~80 slice-uploads per tile through `onTileLoaded → uploadTile`
(vector-tile-renderer.ts:541 — which notably does NOT invalidate), so on a fresh load
nearly everything transits `_heldUploads`. The moment fetches settle, the visible queue
momentarily drains (it self-runs on microtasks), and ancestors cover the screen — all
three signals read false **while the held buffer is full**. The loop stops; the replay
site never runs again; every held slice freezes forever. Upload order is
distance-prioritized, so the frozen tail is exactly the tiles far from the camera — the
east half at a Greenwich-centered camera. Labels place inside `renderFrame`, so
late-decoded tiles' labels never get a placement frame either.

`#1077` (draw fallback ancestors on the drape path) did not cause this — it unmasked it.
The same freeze pre-#1077 rendered as a blank hemisphere (that was the #1076 report);
post-#1077 it renders as a plausible-looking, permanently-coarse, label-poor map.

## Evidence chain (probes on main @ 97256a5, headless SwiftShader + relay)

- Label-pixel counts at the same camera across runs: 6980 → 2138 → 76 → 0 — a
  per-run race (how much converged before the loop stopped), not a code gradient.
- Network tally: 18 tile fetches, all HTTP 200, zero failures — data arrives; it just
  never finishes decoding/uploading.
- Frame trace (`captureNextFrameTrace`): 46/46 labels `placed`, zero dropped — the label
  pipeline is innocent; missing labels were never submitted because their tiles never
  entered the catalog before the freeze.
- Time series, no interaction: `catalogLoading=15, missed=90, pendingUp=4` frozen for
  10+ s stretches. Forced `invalidate()` frames: `catalogLoading 15→0` immediately,
  held uploads replay, `gpuUnique` climbs — frames are the only missing ingredient.
- Liveness: an injected self-perpetuating rAF counter ticked 5× in 18 s on this box
  (headless rAF starvation — an amplifier, not the cause; the deadlock itself is
  machine-independent). `running=true, shouldRender=true→false` transitions match.
- Screenshot-pumped run on the same commit: catalog 18/18, missed 90→5, and the full
  east label set (Turkey/Iran/Egypt/Ethiopia/Kenya/Oman...) renders — label px 7138 vs
  the 6980 healthy baseline. Same code, frames supplied, everything converges.

## The equator line (#1087)

Fallback tiles draw as per-tile-quantized ECEF chord meshes. Neighbors reconstruct the
shared lat-0 edge through different `dequantScale/dequantHalf` lattices → ±ε mismatch →
a 1-px dashed background-colored crack along the projected equator arc (visible over
ocean; ×5 crops show water 174,207,226 interrupted by 211-248 near-background pixels).
The deadlock made the fallback state — and thus the crack — permanent; after pumped
convergence the line vanishes except over the residual missed=5 cells. Fix directions:
shared-edge lattice welding or skirts; obsoleted on the drape path by #599.

## Fix

One-point: count `_heldUploads` in `hasPending()`/`pendingCount()` so the loop stays
alive until the upload pipeline truly converges (branch
`claude/fix-upload-held-starvation`, fail-before coordinator test). Follow-ups: #1087
(seam), #1088 (rAF-coupled pipeline + ≤900px budget cliff).

## Method notes (recurring)

- The probe box's rAF starvation invalidates naive "wait N seconds" probes — pump frames
  via repeated `page.screenshot()` (each forces a compositor BeginFrame) when emulating
  a healthy foreground machine.
- `getTileLoadDiagnostic()` + `getPendingUploadCount()` + `captureNextFrameTrace()` from
  `window.__xgisMap` decompose fetch/decode/upload/placement in one page.evaluate — use
  them before theorizing.
