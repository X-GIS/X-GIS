# Ralph Loop Run Log — Plan `lovely-launching-eagle`

This file captures the per-iteration progress of the ralph-loop run
executing the strict-spec / runtime parity plan stored at
`C:\Users\soung\.claude\plans\lovely-launching-eagle.md`. Each
iteration ended with one or more commits on `main`.

## Iteration 1
* Phase 5.1 — Oblique Mercator tile selector fix (route projType=6
  through globeVisibleTiles)
* Phase 1 — Expression spec-strict (match labels / interpolate stops
  / `in` keys literal-strict) + depth guard + substituteVars cycle
  guard
* Phase 2 — Zero-value semantics catalogue
* Phase 7.1 — Polar cap synth utility for PMTiles/TileJSON
* Phase 11 — CSS lab / lch / oklab / oklch parsers
* Phase 6 — Geodesic mesh refinement (slerp midpoint subdivide)
* Phase 9 — fill-extrusion wall-shade tightened to MapLibre defaults
* Phase 10 — Along-line min-spacing in label collision
* Phase 8.1 — natural-interaction perf helper
* Phase 12.1 — IR shape snapshots

## Iteration 2
* Phase 12.4 — synthetic-nested fixture
* Phase 12.2 — runtime capability table + tests
* CI fix — continue-on-error step-level (user-reported red X)
* Phase 7.3 — rim_alpha WGSL function + CPU mirror
* Phase 5.3 — antimeridian routing extension (ortho/azimuth/stereo)
* Phase 7.3 — rim wired into fs_fill, fs_stroke, fs_oit_translucent,
  fs_line, fs_line_max, fs_point, fs_tile (raster)
* Phase 7.4 — occlusion policy invariants test
* helper signature fix (natural-interaction setCenter)

## Iteration 3
* Phase 12.5 — test:pixel / test:perf / test:projection scripts
* Phase 4 — circle-stroke-opacity constant fold into hex alpha
* Phase 5.4 — low-zoom (z=0..3) edge tests
* Phase 8.2 — perf-projection-matrix spec scaffold
* Phase 8.4 — camera transition smoothness invariants

## Iteration 4
* Phase 8.3 — label pitch×bearing matrix scaffold (128 cells)
* Phase 8.5 — real-world scenario fixtures (4 JSONs + README)
* Phase 12.3 — compiler property × value-form matrix gate
* Phase 12.2 — spec-coverage ↔ capability drift detector
* Phase 5.3 — antimeridian routing test
* Companion: line-blur=0 zero-semantics correction (identity not
  strict-zero); geodesic-refine test signature fix; PUSHED →
  CI red X resolved

## Iteration 5
* Phase 7.3 followup — rim into fs_point + fs_tile + rim-rollout
  coverage gate
* Sky layer SKIP_REASONS + tests
* Gap matrix generator + Markdown snapshot

## Iteration 6
* world-copy enumeration gap inventory test
* Plan-progress tracker doc

## Iteration 7
* spec-coverage note backfill 1/3 (5 high/medium-impact entries)
* line-gradient specific warning (replaced generic blob)
* gap-matrix-freshness test

## Iteration 8
* spec-coverage note backfill 2/3 (11 entries)

## Iteration 9
* spec-coverage note backfill 3/3 (32 final entries — 0 remaining)
* spec-coverage-notes invariant test

## Iteration 10
* fill-extrusion-vertical-gradient + AO notes
* Stricter spec-coverage ↔ capability contradiction check (reverse
  direction)
* text-pitch-alignment=map runtime gap warning

## Iteration 11
* (consolidation)

## Iteration 12
* fill-extrusion-vertical-gradient spec-default suppression

## Iteration 13
* (consolidation)

## Iteration 14
* fill-antialias=false runtime-gap warning

## Iteration 15
* icon-overlap / icon-allow-overlap value-aware warnings

## Iteration 16
* (consolidation)

## Iteration 17
* raster-resampling value-aware warning

## Iteration 18
* SPEC_DEFAULT_NO_WARN generic helper in surfaceIgnoredPaint

## Iteration 19
* gap-matrix generator deterministic by default

## Iteration 20
* (consolidation)

## Iteration 21
* PLAN_PROGRESS refresh covering iter 14-20

## Iteration 22
* line-gradient specific gap warning (in addition to iter 7 entry)

## Iteration 23
* surfaceIgnoredPaint aggregation contract test

## Iteration 24
* step spec-strict literal-finite stop validation
* Cross-project tsconfig fix (gap-matrix-freshness move to runtime/)

## Iteration 25
* format() partial-drop semantics (Plan §1 completion)

## Iteration 26
* PLAN_PROGRESS refresh covering iter 22-25

## Iteration 27
* shape-specific line-dasharray gap warning

## Iteration 28
* scenario fixture loader helper

## Iteration 29
* synthetic-nested fixture extended with step-bucket layer

## Iteration 30
* partial-status conversion smoke matrix (13 cells)

## Iteration 31
* This log

---

## Deferred items (genuinely require multi-iteration runtime work)

These items remain genuinely incomplete and require dedicated
session work on multi-file runtime infrastructure. Each is named
explicitly with its blocker:

* **Phase 3.1 full handoff** — 4 items, all invasive runtime work:
  - `fill-antialias=false`: needs per-pipeline MSAA toggle
    (separate pipeline binding per layer for the false case)
  - `text-opacity` / `icon-opacity` zoom-interp / data-driven:
    needs per-feature alpha vertex attribute through TextStage /
    IconStage
  - `text-pitch-alignment: map`: needs text-stage ground-projection
    path (label glyphs project onto the ground plane)
  - `icon-size` data-driven: worker per-feature evaluator
* **Phase 4 atlas-dependent properties** — needs sprite atlas /
  per-feature plumbing:
  - `icon-color` (SDF icon tint): sprite-atlas sampling needs to
    multiply by per-icon RGBA before output
  - `fill-pattern` / `line-pattern` / `fill-extrusion-pattern`:
    Batch 2 bitmap atlas pipeline
  - `line-gradient`: needs `line-progress` accessor (per-fragment
    arc-length varying)
  - `icon-halo-color/width/blur`: needs SDF icon path
  - `icon-text-fit`: needs icon stretching based on text bbox
* **Phase 5.2 Equirect/NE world-copy** — needs `proj_equirectangular`
  accepting world-x offset + per-instance enumeration through vertex
  shader. Single-file flip of worldCopiesFor() would produce
  coplanar overdraw on identical vertices (pinned by world-copy-gap
  test as aggregate gate).
* **Phase 7.3 text/icon label-resolver rim** — text + icon render
  via separate 2D-screen-space composite passes; rim alpha needs
  threading at label-placement time so each label-anchor gets a
  rim factor before the atlas-sample fragment.

Each blocker is named both in spec-coverage.ts notes + this log,
so a future session picking up the work has full context without
re-doing the analysis.
