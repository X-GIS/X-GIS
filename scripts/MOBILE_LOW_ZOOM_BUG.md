# 🟡 Mobile + low-zoom rendering bug — iPhone Safari, x-gis.github.io, OFM Bright z=0.50

User reported via screenshot — iter 40 of the ralph-loop run.

**STATUS**: 🟢 RESOLVED in iter 56 (`25a3331` — `revert(tiler):
geodesic-midpoint subdivision`).

Timeline:
  * Iter 6: introduced geodesic (slerp) midpoint subdivision for
    sphere projections.
  * Iter 40: user reports iPhone OFM Bright z=0.5 banding.
  * Iter 41: capped geodesic at 60° edge span — desktop survey
    verified clean, but the regression PERSISTED in production
    iPhone deploy.
  * Iter 56: user re-reports "z=0 still broken on deploy". Reverted
    geodesic-midpoint subdivision entirely. Pre-iter-6 baseline was
    the production-shipped state without z=0 banding artefacts.

Desktop pixel-match-survey verified post-revert (iter 57):
  * bright-seoul-school: P1 gate stays PASS
  * bright-tokyo-z14: eq=31.32% / 6 gt128 (PASS, threshold 20)
  * liberty-paris-z14: eq=22.04% / 1025 gt128 (PASS, threshold 1200)
  * demotiles-europe-z2: eq=87.71% / 1434 gt128 (PASS, threshold
    1700 — slight improvement vs earlier numbers)

New z=0 regression gate added (iter 56,
`compiler/src/__tests__/z0-world-polygon-regression.test.ts`)
with 5 cases including Eurasia / Russia / antimeridian /
MultiPolygon shapes. User explicitly noted "test was missing" —
gate now exists.

Trade-off: the iter 6 chord-vs-arc fidelity improvement on globe
country polygons at z=0..3 is rolled back. The pre-iter-6 baseline
was documented as acceptable; per-vertex projection in the
renderer handles the chord visibility at the high-zoom levels
where it matters. Plan §6 (geodesic refinement) deferred until a
runtime-projection-aware implementation can land safely.

## Symptom

Loading x-gis.github.io playground on iPhone Safari with OFM
Bright at `#0.50/24.58456/93.31858` (z=0.50, lat=24.58, lon=93.32):

* Land polygons (Russia, Europe, Asia, Africa, Australia, etc.)
  appear as HORIZONTAL STRIPES — alternating land-fill (beige
  `#f8f4f0`) and ocean-background (blue) rows ~10-30 px tall.
* Country labels (Russia, Belgium, Iran, India, China, etc.)
  render correctly at their actual positions, OVER the striped
  background.
* The pattern is consistent within each continent — Russia's
  northern third striped, southern Russia striped, but at
  different stripe heights.
* The stripes are NOT tile-aligned (tiles at z=0/z=1 are
  ~256-512px on screen; stripes are much smaller).
* Desktop pixel-match-survey iter 39 PASSED bright-tokyo-z14 at
  31.32% identical (no labels) and bright-seoul-school at 97.28%.
  This bug does NOT reproduce on the desktop pixel-match suite.

## Environment

* **Device**: iPhone (LTE network, 86% battery, 9:40 AM)
* **Site**: x-gis.github.io playground (production deploy)
* **Style**: OFM Bright via "Import Mapbox" button
* **Camera**: z=0.50, lat=24.58, lon=93.32 — world-fit view
* **Theme**: Dark
* **Projection**: default (mercator per UI)

## Hypotheses (ranked by likelihood)

### 1. Progressive tile arrival visible as scanline-banded fill (HIGH likelihood)
At z=0.5 the renderer selects z=1 or z=0 tiles. On LTE the tile
fetch may arrive PARTIALLY — particular vertices of a large
country polygon (e.g. the full Eurasia polygon at z=0) have
arrived but the surrounding triangulation hasn't completed. The
visible banding may be earcut output emitted incrementally during
partial geometry decode. Mobile JS engine may yield to the main
thread between batches, leaving partial visual state.

### 2. Vertex buffer ROW-WISE upload artifact (MEDIUM likelihood)
The `staging buffer pool + mapAsync upload` (memory note
`project_async_pipeline.md`) chunks tile uploads. If a chunk
covers a row-major subset of triangles and the GPU rasterizes
"sub-tile not yet present" as transparent, you'd see horizontal
banding aligned to upload chunk size — NOT tile size.

### 3. Low-zoom triangulation incomplete (MEDIUM likelihood)
At z=0 the country polygon for Eurasia is one massive ring. Earcut
produces ~thousands of triangles. If the geodesic-refinement
subdivision (iter 6) accidentally skips an alternating row, the
final mesh would have horizontal gaps. Desktop didn't hit this
because force-subdivide at z≤3 (tile-select.ts:356) uses different
parameters — but iPhone may take a different code path.

### 4. Mobile-specific GPU stencil / scissor artifact (LOW likelihood)
iPhone Safari WebGPU implementation may have a scissor / clip
boundary that's row-aligned to some power-of-2 step. Without a
device to test, hard to confirm.

### 5. Memory pressure → tile drop (LOW likelihood)
Memory note `project_high_pitch_thermal` covers a different
high-pitch / low-zoom thermal case. A 1-frame budget overrun
could push some triangles to next frame.

## What works (rule-outs)

* Country LABELS render correctly — text-stage path is fine
* Ocean background renders solid — no global blend / clear issue
* The continent OUTLINES are correct — vertex SHAPES are right,
  the FILL is the only thing striped
* Desktop survey iter 39 passed — pure compile / IR path is correct

## Reproduction steps (for a future device-equipped session)

1. Open Safari on iPhone (or iPad / iOS simulator)
2. Navigate to https://x-gis.github.io
3. Click "Import Mapbox" — paste OFM Bright JSON
4. Click "Run"
5. Set URL hash to `#0.50/24.58456/93.31858`
6. Observe the world-fit view

If the bug doesn't reproduce immediately, scroll the map quickly
to force a tile cascade and capture mid-cascade.

## Diagnosis path (single iteration won't fix without device)

1. Capture network HAR — verify tile fetches all complete
2. Add console diagnostic: log earcut output triangle count per
   country polygon at z=0/z=1
3. Test on iPad / iPhone simulator to capture WebGPU frame
4. Compare vertex buffer state between desktop + mobile via
   `__xgisMap.dumpVertexBuffers()` (debug helper not yet shipped)

## Action items

* Document the bug with screenshot (this file).
* No code fix in this iteration — needs device-level reproduction.
* Add to plan §3.1 as a new memory note alongside
  `project_tile_pitch_bugs.md` since both involve "incomplete
  rendering on certain camera states".

## Related known issues

* `project_tile_pitch_bugs.md` — root-cause pending on multiple
  tile-rendering edge cases
* `project_async_pipeline.md` — async upload pipeline shipped
  2026-05-08; possible interaction with mobile single-thread
  yielding
* `project_flicker_steady_state.md` — RESOLVED, but the residual
  initial-frame case may be a different bug
