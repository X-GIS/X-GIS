// ═══ Re-export shim — UniformRing moved to @xgis/engine (#991 P2) ═══
//
// The growable per-draw uniform ring buffer is a backend-neutral (RHI-only) GPU
// utility, so it now lives in @xgis/engine (engine/src/render/uniform-ring.ts).
// Map's renderers import it from '@xgis/engine' — or, unchanged, from this path
// and via @xgis/map's PUBLIC surface (re-exported through map/src/index.ts) for
// consumers that import { UniformRing } from '@xgis/map' (e.g. the runtime
// spec-wiring tests). The lone `../__profile__/perf-marks` coupling stays in map:
// the two construction sites (vector-tile-renderer.ts, frame-renderer.ts) supply
// onGrowStart/onGrowEnd callbacks that fire the perf-marks. Retire at the EPIC
// close-out once those consumers import from '@xgis/engine'.

export { UniformRing } from '@xgis/engine'
