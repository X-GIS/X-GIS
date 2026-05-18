# X-GIS Plan Execution Progress

Tracking commit-by-commit execution of the strict-spec + runtime
parity plan (`C:\Users\soung\.claude\plans\lovely-launching-eagle.md`).

## Phases completed

| Phase | Title | Status | Key commits |
|---|---|---|---|
| 1 | Expression spec-strict + depth/cycle guards | **done** | match labels / interpolate stops / `in` keys literal-strict; MAX_EXPR_DEPTH=256; substituteVars WeakSet; WGSL MatchBlock select-chain; format partial-drop |
| 2 | Defaults single source + zero-semantics | **done** | spec/zero-semantics.ts catalogue; oracle.ts already-existing single-source-of-truth confirmed |
| 5.1 | Oblique Mercator tile selector fix | **done** | route projType=6 through globeVisibleTiles, prefetch path matches main selector |
| 5.3 | Antimeridian routing for ortho/azimuth/stereo | **done** | extend heuristic from projType {1,2} to {1..5}; CPU mirror test |
| 5.4 | Low-zoom (z=0..3) tile selection envelope | **done** | 6 invariants on globeVisibleTiles bounded behaviour |
| 6 | Geodesic mesh refinement | **done** | slerp midpoint for triangles spanning >5° arc; lonLatDegToMM helper |
| 7.1 | Polar cap synth for PMTiles/TileJSON | **done** | synthesizePolarCaps utility + projectionNeedsPolarCaps + tests |
| 7.3 | rim_alpha rollout (renderer side) | **done** | WGSL rim_alpha function + wired into fs_fill / fs_stroke / fs_oit_translucent / fs_line(_max) / fs_point / fs_tile; coverage gate test |
| 7.4 | Occlusion policy invariants | **done** | depth-state policy table tests + rim-cull parity check |
| 8.1 | natural-interaction perf helper | **done** | rAF-paced pan/zoom/rotate/pitch sequence runner + stats |
| 8.2 | perf-projection-matrix scaffold | **done** | 32-cell perf sweep spec emitting REPORT.md |
| 8.3 | label-pitch-bearing matrix scaffold | **done** | 128-cell screenshot sweep |
| 8.4 | Camera transition smoothness invariants | **done** | 5 matrix-derivative bounded checks |
| 8.5 | Scenario fixtures | **done** | 4 JSON fixtures + README |
| 9 | fill-extrusion lighting partial | **partial** | wall-shade tightened to MapLibre defaults (base 0.6 / roof 1.0 + roof bonus); full normal-based diffuse + Mapbox light deferred |
| 10 | Line-follow label along-line spacing | **partial** | CollisionItem.lineId + anchorDistancePx + greedy gate; hysteresis deferred |
| 11 | CSS lab/lch/oklab/oklch | **done** | full CSS Color Module 4 parsers via D50→D65 Bradford + sRGB gamma |
| 12.1 | IR snapshot tests | **done** | per-fixture inline snapshots for 4 production styles |
| 12.2 | Capability table + drift gate | **done** | runtime/capabilities.ts + spec-coverage-runtime-drift.test.ts |
| 12.3 | Compiler property × value-form matrix | **done** | 25-cell compile-clean gate |
| 12.4 | Synthetic nested fixture | **done** | nested case-in-interpolate + let-binding + format-spans + `in` |
| 12.5 | Test scripts | **done** | test:pixel / test:perf / test:projection / test:e2e |

## Companion fixes

| Commit | Why |
|---|---|
| CI step-level `continue-on-error` | User-reported red X on commit dashboards. Moved from job-level (workflow success but job failure) to step-level (job success). |
| natural-interaction setCenter signature | XGISMap.setCenter takes (lon, lat) two scalars, not an array. |
| geodesic test signature | compileGeoJSONToTiles takes options object, not positional. |
| line-blur=0 zero-semantics correction | identity, not strict-zero (the 0.5px AA floor is the implicit edge AA, not blur). |
| Sky layer explicit skip | Added to SKIP_REASONS so the converter emits a // SKIPPED comment instead of falling through. |
| circle-stroke-opacity constant fold | Folds into stroke-color hex alpha (Plan §4 partial). |
| Gap matrix generator | Cross-references spec-coverage + capabilities into a Markdown gap matrix. |

## Plan items genuinely not yet done

Each requires invasive multi-iteration runtime work blocked behind
specific infrastructure:

* **Phase 3.1 full handoff (4 items)**
  - `fill-antialias=false`: needs per-pipeline MSAA toggle (separate
    pipeline binding per layer for the false case).
  - `text-opacity` / `icon-opacity` zoom-interp / data-driven: needs
    per-feature alpha vertex attribute through IconStage / TextStage.
  - `text-pitch-alignment: map`: needs label-stage ground projection.
  - `icon-size` data-driven: worker per-feature evaluator.
* **Phase 4 atlas-dependent properties**
  - `icon-color` (SDF tint): sprite-atlas sampling needs to multiply
    by per-icon RGBA before output.
  - `fill-pattern` / `line-pattern` / `fill-extrusion-pattern`:
    needs Batch 2 bitmap atlas plumbing.
  - `line-gradient`: needs `line-progress` accessor (per-fragment
    arc-length varying).
  - `icon-halo-color/width/blur`: needs SDF icon path (currently
    only PNG sprite icons supported).
  - `icon-text-fit`: needs icon stretching based on text bbox.
* **Phase 5.2 Equirect/NE world-copy**
  - Needs `proj_equirectangular_d` accepting a world-x offset +
    per-instance enumeration through the vertex shader. Single-file
    flip of worldCopiesFor() would produce coplanar overdraw on
    identical vertices — pinned by world-copy-gap.test.ts as an
    aggregate gate.
* **Phase 7.3 text/icon label-resolver rim**
  - Text + icon render via separate 2D-screen-space composite passes;
    rim alpha needs threading at label-placement time so each
    label-anchor gets a rim factor before the atlas-sample fragment.
