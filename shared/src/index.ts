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
