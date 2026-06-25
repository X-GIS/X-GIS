<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-03 -->

# shaders

## Purpose
Thin re-export layer that surfaces DSL-emitted WGSL snippets and CPU-side GPU math helpers under stable names. All three files delegate their WGSL strings to the DSL graphs in `./dsl/` — the actual WGSL is generated from `@xgis/shader-dsl` IR graphs (`dsl/projections.ts`, `dsl/log-depth.ts`, `dsl/sdf.ts`). Renderers in `engine/render/*` string-concatenate these exports into their inline pipeline shaders at build time.

## Key Files
| File | Description |
|------|-------------|
| `projection.ts` | Re-exports `WGSL_PROJECTION_CONSTS` / `WGSL_PROJECTION_FNS` from `shader-dsl`. WGSL is DSL-emitted (Phase 0, US-P0-4b) from `runtime/src/engine/shaders/dsl/projections.ts`, eliminating the former hand-written ~310-line template. Encodes projTypes 0–7 (mercator/equirect/natural_earth/ortho/azimuthal/stereo/oblique/globe). `project()`, `project_geom()`, `needs_backface_cull()`, `rim_alpha()` all accept `proj_params: vec4<f32>`. |
| `log-depth.ts` | Re-exports `WGSL_LOG_DEPTH_FNS` from `shader-dsl` plus the CPU helpers `computeLogDepthFc(far)` and `simulateLogDepthZ(viewW, far)`. Log-depth vertex formula: `z_clip = log2(w+1) * fc * w`; fragment overrides `@builtin(frag_depth)`. `fc` is packed into the uniform ring once per frame (reuses former DSFUN `_pad0` slot). |
| `sdf.ts` | Re-exports six named DSL-emitted SDF snippets (`WGSL_DIST_TO_SEGMENT`, `WGSL_DIST_TO_QUADRATIC`, `WGSL_DIST_TO_CUBIC`, `WGSL_WINDING_LINE`, `WGSL_SDF_SHAPE`, `WGSL_SHAPE_STRUCTS`) plus the convenience aggregate `WGSL_SDF_ALL`. Consumed by `line-renderer-shaders.ts` for shield / shape rendering. |

## For AI Agents

### Working In This Directory
- **Do not edit WGSL here.** These files are re-export shims. Projection math lives in `dsl/projections.ts` (regenerates both the WGSL and the cpu-f64 lowering `dsl/cpu-projections.ts`). Log-depth WGSL lives in `dsl/log-depth.ts`. SDF WGSL lives in `dsl/sdf.ts`.
- `computeLogDepthFc` and `simulateLogDepthZ` in `log-depth.ts` are the only CPU-side functions here; they are the canonical CPU reference pinned by `log-depth.test.ts`. Any change must preserve `fc = 1 / log2(far + 1)`.
- projType dispatch encoding (`proj_params.x`) is authoritative in `projection/projections-table.ts` (index == projType). The WGSL `project()` switch must stay in sync with that table.
- WGSL identifiers must be globally unique across all concatenated snippets — no reserved words. This is enforced by `wgsl-reserved-words.test.ts` in this directory.
- CPU↔GPU parity is a documented recurring divergence point. The drift class is closed by construction (single DSL source), but any manual edit to a DSL graph must re-run parity tests before merging.

### Testing Requirements
- `wgsl-reserved-words.test.ts` — asserts no WGSL reserved identifiers appear in the emitted strings.
- `engine/projection/projection-wgsl-consistency.test.ts` — CPU canonical vs cpu-f64 lowering ≤1 mm across all projTypes.
- `playground/e2e/_shader-math-parity.spec.ts` — executed WGSL vs cpu-f64 (real GPU, SwiftShader in CI).
- `log-depth.test.ts` (elsewhere in engine) — monotonicity + bounds of `simulateLogDepthZ`.

### Common Patterns
- All WGSL exports are plain `string` constants re-exported from `shader-dsl`. Renderers inline them via template literal concatenation at pipeline-build time — no runtime cost.
- CPU helpers (`computeLogDepthFc`, `simulateLogDepthZ`) are plain functions; import them wherever the uniform ring is packed or tests simulate log-depth math.

## Dependencies

### Internal
- `./dsl` — all WGSL string generation (graphs authored on `@xgis/shader-dsl`). No other internal imports.

### External
- None.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
