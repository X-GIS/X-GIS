// ═══ Shared WGSL: Projection Functions (DSL-emitted) ═══
//
// These were ~310 lines of hand-written WGSL template strings. Phase-0 of the
// shader-DSL plan (US-P0-4b) re-targeted them onto the in-house IR: the block
// is now EMITTED from `runtime/src/engine/shaders/dsl/projections.ts` — the SAME graph the cpu-f64
// lowering (`runtime/src/engine/shaders/dsl/cpu-projections.ts`, which replaced the deleted
// `projection-wgsl-mirror.ts`) is generated from. GPU and CPU are therefore a
// single source; the drift class is closed by construction.
//
// `WGSL_PROJECTION_CONSTS` / `WGSL_PROJECTION_FNS` keep their names + role: the
// polygon (runtime/src/engine/shaders/dsl/polygon.ts via `emitPolygonWgsl`), line
// (line-renderer-shaders), point (point-renderer-shaders), and raster
// (raster-renderer) shaders inline them. The polygon side migrated off the
// legacy `renderer-shaders.ts` template in Phase 2.5 US-008 / US-010; the
// other three still use their hand-WGSL shader strings + the same projection-
// const inline pattern.
//
// The dispatch type encoding (`proj_params.x`) is the table in
// `projection/projections-table.ts` (index == projType):
//   0 mercator · 1 equirectangular · 2 natural_earth · 3 orthographic
//   4 azimuthal_equidistant · 5 stereographic · 6 oblique_mercator · 7 globe
// `project()` / `project_geom()` / `needs_backface_cull()` / `rim_alpha()` take
// `proj_params: vec4<f32>` explicitly so each shader can pass its own uniform.
//
// To change projection math, edit the DSL graph in `runtime/src/engine/shaders/dsl/projections.ts`
// (regenerates BOTH this WGSL and the cpu-f64 lowering) and `projection.ts`
// (CPU canonical). GPU↔CPU agreement is pinned by
// `projection/projection-wgsl-consistency.test.ts` (CPU vs cpu-f64 ≤1mm) and
// `playground/e2e/_shader-math-parity.spec.ts` (executed WGSL vs cpu-f64).

export {
  getProjectionWgslConsts as WGSL_PROJECTION_CONSTS,
  getProjectionWgslFns as WGSL_PROJECTION_FNS,
} from './dsl'
