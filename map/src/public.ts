// ═══ @xgis/map — the PUBLISHED public surface ═══
//
// This file, not `index.ts`, is what npm consumers get: `package.json`'s
// `publishConfig` points the published `main`/`types` at the `dist/` bundle vite
// builds from HERE. `index.ts` stays the workspace barrel — a blanket re-export of
// map's internals that the playground, the site and the test suite import through
// the source alias. Keeping the two apart is deliberate: the public API is a small,
// curated set, and widening it must be an edit to this file rather than a side
// effect of adding an `export *` to the internal barrel.
//
// Relocated from `runtime/src/index.ts` when `@xgis/runtime` was dissolved: that
// package had become a 47-line re-export of this package plus @xgis/data /
// @xgis/geo / @xgis/rhi-webgpu, and a separate npm shell bought nothing but a name
// that kept attracting code. The exported surface below is unchanged from it.

export { XGISMap } from './map'
// #1262 — DOM overlay API anchored to geo coordinates.
export { Marker, Popup, type MarkerAnchor, type MarkerOptions, type PopupOptions } from './marker'
export { StatsPanel, StatsTracker, type RenderStats } from './stats'
export { Camera } from './camera/camera'
export { MapRendererContent } from './render/renderer'
export { FrameRenderer } from './render/frame-renderer'
export { loadGeoJSON, lonLatToMercator } from '@xgis/data'
export {
  injectPolarCaps,
  findClampBoundarySpans,
  synthesizeCapRing,
  vertexOnClampBoundary,
  type CapSpan,
} from '@xgis/data'
export {
  synthesizePolarCaps,
  projectionNeedsPolarCaps,
  type PolarCapOptions,
  type PolarCapFeatureCollection,
} from '@xgis/data'
export {
  RUNTIME_CAPABILITIES,
  runtimeCapability,
  runtimeGaps,
  type RuntimeCapability,
} from './capabilities'
export {
  // Function-style API (back-compat with prior versions)
  loadPMTilesSource,
  attachPMTilesSource,
  fetchPMTilesVectorLayerFields,
  fetchPMTilesVectorLayerSchema,
  // Class-based API
  VectorTileLoader,
  VectorTileSource,
  PMTilesArchiveSource,
  TileJSONSource,
  // Types
  type PMTilesSourceOptions,
  type VectorLayerInfo,
  type VectorTileFormat,
} from '@xgis/data'
export { XGISMapElement, registerXGISElement } from './web/component'
export { mercator, equirectangular, naturalEarth, orthographic, getProjection } from '@xgis/geo'
export { ComputeDispatcher, type ComputeTask } from '@xgis/rhi-webgpu'
export { createColorRampTexture, createRampSampler, availableRamps } from './color-ramp'
