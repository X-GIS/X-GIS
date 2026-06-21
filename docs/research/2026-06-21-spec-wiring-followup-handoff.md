# Spec-wiring corpus follow-up — handoff (2026-06-21)

Follow-up to PR #484 (`feat/spec-wiring-test-corpus`, 48 fail-before-proven
per-property render-wiring tests). Closes the remaining CPU-observable
`supported`-but-untested gaps named in that PR's "deferred (follow-up)" list.

## Delivered — 8 new wiring tests (19 tests, all non-vacuous)

Each follows the corpus methodology: drive the REAL renderer/helper against the
WebGPU/CPU stub (GPU-free), intercept the exact uniform-slot / buffer / flag the
property controls, assert a value that TRACKS the prop. Proven non-vacuous by
applying the documented break-recipe CENTRALLY → confirming the targeted RED →
reverting.

| Test file | Property | Wire observed | Break → RED |
|---|---|---|---|
| `fill-extrusion-height-wiring` | fill-extrusion-height | `uniformF32[39]` ← currentExtrudeHeight (vtr:3788) | `uf[39]=0` ✓ |
| `fill-extrusion-base-wiring` | fill-extrusion-base | `uniformF32[45]` ← currentExtrudeBase (vtr:3841) | `uf[45]=0` ✓ |
| `fill-extrusion-vertical-gradient-wiring` | fill-extrusion-vertical-gradient | `uniformF32[59]` ← currentFillVerticalGradient (vtr:3726) | constant 1 (opt-out case fails) ✓ |
| `fill-extrusion-translate-wiring` | fill-extrusion-translate | `uniformF32[46/47]` ← currentFillTranslateNdc{X,Y} (vtr:3854) | `uf[46]=0` ✓ |
| `fill-extrusion-translate-anchor-wiring` | fill-extrusion-translate-anchor | `rotateTranslateForAnchor` bearing-rotation (vtr:109) | always-passthrough (map case fails) ✓ |
| `raster-saturation-wiring` | raster-saturation | raster uniform `raster_color0.w` = slot 27 (raster-renderer:314) | last elem 0 ✓ |
| `raster-contrast-wiring` | raster-contrast | raster uniform `raster_color1.x` = slot 28 (raster-renderer:316) | first elem 0 ✓ |
| `raster-resampling-wiring` | raster-resampling | active `sampler` field === nearestSampler after setResampling(true) (raster-renderer:205) | force linear (nearest case fails) ✓ |

## One source change (behaviour-neutral)

`runtime/src/engine/render/vector-tile-renderer.ts:109` — added `export` to the
pure helper `rotateTranslateForAnchor` so the translate-anchor rotation wire is
unit-testable directly. 1-line diff, zero behavioural change, pinned-tsc clean.

## Deferred (documented, not silently dropped)

- **fill-extrusion-pattern** — Stage-2 pipeline-SELECTION (`extrudedPatternActive`
  routes to a different `GPURenderPipeline`), not a CPU-observable value slot. The
  shared `fs_fill_pattern` UV uniform (slot 46/47) is already covered by
  `pattern-uv-clobber.test.ts` for the ground path. A faithful extruded-pattern
  wiring test needs GPURenderPipeline-binding interception → follow-up.
- **heatmap-radius / -weight / -intensity / -opacity** — ALREADY COVERED by
  `heatmap-data-path.test.ts` (params[0]=intensity, params[1]=opacity,
  feat[0]=radius, feat[1]=weight). No new test needed. (heatmap-color is
  `partial`, out of scope.)
- **fill-extrusion-color / -opacity** — share fill's `uniformF32[16..19]` slots;
  already proven by `fill-color-wiring.test.ts` (the extrude path resolves colour
  identically; wall_shade is applied GPU-side, downstream of the uniform). Not a
  distinct CPU-observable wire.

## ⚠️ Two PRE-EXISTING baselines found on the branch (NOT introduced here)

1. **Wrong TypeScript on PATH.** `npx tsc` resolves a stray global **6.0.3**;
   package.json pins **5.6.3**. TS 6.0 flags `ArrayBuffer`/`SharedArrayBuffer`
   lib-split + `baseUrl` (TS5101) across the repo (e.g. `map.ts:3010`,
   `line-join-wiring.test.ts:61` — both COMMITTED). The pinned compiler is clean:
   the canonical gate is `node node_modules/typescript/bin/tsc --noEmit -p
   runtime/tsconfig.json` → **exit 0**. Recommend pinning tsc invocation in
   scripts/CI (or aligning the global) so `npx tsc` doesn't mislead.

2. **arch-ratchet red at HEAD:** `architecture-invariants.test.ts` →
   `shader-dsl/shaders/polygon.ts: 1213 > ceiling 1211`. polygon.ts is unchanged
   by this work (identical on disk and at HEAD; fails with my export stashed).
   Pre-existing god-file over its locked ceiling — needs a 2-line extraction OR a
   documented ceiling bump. Out of scope for the test corpus; surfaced for a
   decision.

## Status

Stories complete + verified on disk (8 files / 19 tests pass; pinned-tsc exit 0).
Merged to main via the `test/spec-wiring-followup` branch. Baseline #2
(polygon.ts arch-ratchet) is a pre-existing CI red independent of this work and
is left for a separate decision.
