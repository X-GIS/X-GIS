// @xgis/shared — cross-package pure helpers imported by both @xgis/runtime
// (engine) and @xgis/compiler (tiler). Keep everything here DEPENDENCY-FREE.
// The single planetary-constants authority (EARTH / activeBody / makeBody);
// ecef and every consumer package resolve their radius/world-extent from it.
export * from './body'
export * from './ecef'
export * from './quantize'
// Cross-cutting content/data utils extracted from runtime/src/engine (P3): logging,
// debug flags, and the safety guards — dependency-free, used by @xgis/map + @xgis/data.
export * from './log'
export * from './safety'
// Generic concurrency-scheduling primitive (zero-dep, 3DTilesRenderer port). Used by
// both @xgis/data (pmtiles fetch scheduling) and @xgis/map (GPU upload scheduling), so
// it lives here at the shared LCA rather than coupling map→data for a generic queue.
export * from './priority-queue'
// Dev-only invariant checks (devAssert / devAssertClose / devWatch) — import.meta.env.DEV
// gated, stripped from any `vite build`. Lives at the shared LCA so @xgis/engine
// (UniformBlock) and @xgis/map can both assert without importing the runtime.
export * from './dev-assert'
// Generic 4×4 matrix ops (column-major) — content-blind linear algebra relocated
// from @xgis/engine (#781) so @xgis/geo / @xgis/map / @xgis/data share one impl.
export * from './mat4'
// The single "is this a phone-class viewport?" authority — one definition of
// "mobile" shared by @xgis/map (GPU-upload budget + per-frame cap) and
// @xgis/data (MVT worker-fleet ceiling), so width-only heuristics can't diverge.
export * from './viewport-class'
