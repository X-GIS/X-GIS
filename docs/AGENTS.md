<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-03 | Updated: 2026-06-23 -->

# docs/

## Purpose
Internal engineering documentation for X-GIS: coordinate-system contracts, architecture decision records, C4/module diagrams, verification strategy, the public API reference, ship-readiness assessment, roadmaps, and implementation plans. These files span all packages and are not published to the Astro site (`site/`). They orient contributors, preserve design rationale, and pin constraints that are invisible in code alone. The most safety-critical file is `COORDINATES.md` — the canonical coordinate-space contract (LL/MM/DLM/SP) that all tile-pipeline code must honour.

## Key Files

| File | Description |
|------|-------------|
| `COORDINATES.md` | **Canonical coordinate-space contract.** Defines LL/MM/DLM/SP spaces, the five cross-path invariants (fill/stroke same-space, fill-triangulation boundary == stroke endpoints, batch/on-demand equivalence, sub-tile area conservation, DSFUN reconstruction exactness), conversion-direction rules, and a checklist for adding new clip/simplify steps. Read before touching any clipping, simplification, projection, or sub-tile logic. |
| `SHIP-READINESS.md` | Synthesized production-readiness audit (2026-06-03). Verdict: NOT shippable as an npm library. Documents 8 P0 blockers ranked by severity×likelihood: packaging (`private:true`/raw-TS exports/phantom `earcut`), no LICENSE, globe-z13 OOM crash (PR #218), WebGPU-only reach (~70-75%), SSRF guard not wired to tile/TileJSON/PMTiles URLs (P0-5), decompression-bomb holes (P0-6), zero accessibility (P0-7), no lifecycle/camera events (P0-8). **Note:** P0-2 (LICENSE), P0-5, P0-6, P0-7 (a11y baseline), and P0-8 (map lifecycle/camera events) were addressed on branch `chore/ship-p0` after this doc was written. Read before any packaging, security, a11y, or event-API work. |
| `BRANCHING.md` | Trunk-based branching strategy. `main` is always green; squash-merge only; `<type>/<kebab>` branch names; no `dev` integration branch. Documents the two-tier verification gate: no-GPU CI (SwiftShader compute/compile) vs. real-GPU local (pixel-match, coverage, eyeball) — never merge on a red local gate. |
| `WEBGPU_ROADMAP.md` | Phase-by-phase plan to exploit WebGPU compute/indirect features. Phase 1 (sampled frustum tile selector) done at commit `2b37674`. Phases 2-6 pending: GPU-compute culling, indirect draw, compute sub-tile clipping, and GPU-resident tile cache. Explains why the current "upload+draw" path is functionally WebGL2-equivalent and what structural bug classes each phase eliminates. |
| `ROADMAP-3D-TEXT.md` | Phased plan for 3D polygon extrusion (side walls, per-feature heights, Lambert lighting) and the full text/symbol pipeline (SDF atlas, glyph layout, collision). Records the Phase 1 extrusion MVP state at commit `64b847c`. Early planning doc; superseded in execution by shipped work, but still useful for scope context. |
| `dsfun-refactor-plan.md` | Full vertex-format refactor: `f32 lon/lat` → tile-local Mercator-meter hi/lo f32-pair (DSFUN). Eliminates the intrinsic f32 precision ceiling at high zoom. Status: designed; Phases A (preload staging) and B (Worker parse pool) shipped; vertex format change not yet implemented. Atomic refactor — do not start partial implementation. |
| `MAPLIBRE-PARITY-PLAN.md` | MapLibre/Mapbox style-spec parity roadmap: 16 workstreams (WS-1 through WS-16) targeting 114 open spec items (~69 unsupported, ~28 partial, ~17 runtime value-form gaps). Organized by shared mechanism leverage; each workstream lists closes, current state, approach, verify method. Authority: `compiler/src/convert/spec-coverage.ts` + `runtime/src/capabilities.ts`. Updated with appendix mapping all spec entries to workstreams. |

## Subdirectories

The `docs/` tree has six documented child directories; their content is described below. None currently have their own `AGENTS.md`.

- **`adr/`** — Architecture Decision Records (MADR-style). Eight accepted ADRs covering: ECEF tile pipeline and single `u.mvp` (0001), geoid split — ellipsoid vertices / sphere camera basis (0002), shader DSL single-emit + `PROJECTIONS` table as SoT (0003), two-tier verification gate (0004), synthetic earth-surface background pass (0005), per-`projType` world-copy enumeration (0006), defined-coverage background pass + outside-band reversal (0007), external-renderer (three.js) interop contracts (0008). `adr/README.md` explains the append-only convention and MADR template.
- **`architecture/`** — C4 L1/L2 overview (`OVERVIEW.md`), module import-direction DAG and god-object inventory (`MODULES.md`), and seven Mermaid UML diagrams under `diagrams/` (class-compiler-pipeline, class-data-source-layer, class-render-subsystem, sequence-frame-render, sequence-style-load, sequence-tile-lifecycle, state-projection-modes). Also contains `design/` with god-object decomposition strategy and VTR decomposition plan.
- **`verification/`** — `STRATEGY.md` documents the two-tier gate: CI (SwiftShader, no GPU) runs vitest unit + `_shader-math-parity` / `_wgsl-compile-gate` / `_vs-clip-parity` / `_dequant-parity`; real-GPU local runs pixel-match survey, coverage black-ratio, globe render, label gates. Explains the split-vitest-run workaround for the worker-IPC timeout on CI.
- **`api/`** — `README.md` is the full `XGISMap` public API reference in Korean prose. Covers lifecycle (`run`/`load`/`destroy`), camera (`jumpTo`/`easeTo`/`flyTo`/`fitBounds` and all getters), sources/layers (`setSourceData`/`updateFeature`/`getLayer`/`setPaintProperty`), projection (`setProjection` — 8 named slots), feature pointer events (7 types: click/mouseenter/mouseleave/mousemove/pointerdown/pointerup/wheel), and picking (`pickAt`). **Note:** the doc currently says no viewport/camera events exist — `load`/`move`/`moveend`/`zoom`/`zoomend`/`idle` were shipped in `chore/ship-p0` (P0-8) and the doc lags the implementation. Also honest about: `easeTo`/`flyTo` are `jumpTo` aliases; `setStyle`/`addLayer` are warn-once no-ops.
- **`redesign/`** — `VISION.md` is the adversarially-reviewed redesign problem framing (2026-06-02). Deflated from "three-model Frame framework" to two concrete fixes (outside-band coverage + text-pitch-alignment) plus one numeric invariant. Defines CORE (mercator + globe, pixel-perfect), SHOWCASE (cylindrical family, correct), and EXPERIMENTAL (azimuthal disc, renders but not pixel-gated) tiers. Screenshot matrix = discovery tripwire, not a gate.
- **`shader-dsl/`** — Design documents for the shader DSL migration. `PHASE-2-5-IDIOM-INVENTORY.md` enumerates the 11-file WGSL emission surface and classifies emission sites into idiom buckets for the US-005 Node conversion. `PHASE-3-SCOPE.md` covers subsequent DSL phases.

## For AI Agents

### Working In This Directory
- `COORDINATES.md` is the **authoritative contract** for the tile pipeline coordinate system. Any code change that touches clipping, simplification, projection, or sub-tile generation must be verified against its five invariants and the checklist. The 2026-04-20 fill/stroke 27 km divergence bug is the canonical example of what happens when it is violated.
- `SHIP-READINESS.md` is the authoritative list of open P0 blockers. It was written 2026-06-03 before `chore/ship-p0` landed; P0-2, P0-5, P0-6, P0-7, and P0-8 are addressed on that branch. P0-1 (packaging), P0-3 (OOM crash PR #218), and P0-4 (WebGPU-only reach) remain open. Read it before any packaging, security, a11y, or event-API work to avoid duplicating diagnosed items.
- ADRs in `adr/` are **append-only**. Never edit a decided ADR to reflect a new direction — write a new ADR that supersedes it. Every ADR claim must trace to a real `file:line` or test name.
- Roadmap docs (`WEBGPU_ROADMAP.md`, `ROADMAP-3D-TEXT.md`, `dsfun-refactor-plan.md`) should be updated to mark phases done when implementation is complete, noting the commit hash, consistent with the existing phase-status pattern in `WEBGPU_ROADMAP.md`.
- `dsfun-refactor-plan.md` explicitly marks the vertex-format change as an atomic refactor. Do not start a partial implementation without a plan to complete it in a single session.
- Most files here are **read-only reference** in normal sessions. Only edit when explicitly asked to update a record or roadmap.

### Testing Requirements
- No runnable tests live in this directory.
- The five cross-path invariants from `COORDINATES.md` are enforced by `runtime/src/__tests__/tile-cross-path-invariants.test.ts`.
- The two-tier verification gates documented in `verification/STRATEGY.md` and `BRANCHING.md` are the enforcement mechanism for render-correctness.

### Common Patterns
- Roadmap docs use a consistent structure: phase name, status (`DONE` / pending), commit hash when done, and a concrete subtask list.
- The coordinate-space abbreviations `LL`, `MM`, `DLM`, `SP` are the canonical vocabulary — use them in code comments and commit messages when referring to coordinate spaces.
- ADR titles and headings stay in English; prose may be Korean (the repo mixes EN/KR).

## Dependencies

### Internal
- `runtime/src/__tests__/tile-cross-path-invariants.test.ts` — enforces `COORDINATES.md` invariants
- `runtime/src/__tests__/cross-validation.fixture.json` — regenerated by `scripts/cross-validation/generate-fixtures.py`
- `playground/e2e/` — real-GPU render gates documented in `verification/STRATEGY.md`

### External
None

<!-- MANUAL: notes below this line are preserved on regeneration -->
