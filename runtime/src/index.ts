export { XGISMap } from '@xgis/map'
// #1262 — DOM overlay API anchored to geo coordinates.
export { Marker, Popup, type MarkerAnchor, type MarkerOptions, type PopupOptions } from '@xgis/map'
export { StatsPanel, StatsTracker, type RenderStats } from '@xgis/map'
export { Camera } from '@xgis/map'
export { MapRendererContent } from '@xgis/map'
export { FrameRenderer } from '@xgis/map'
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
export { createColorRampTexture, createRampSampler, availableRamps } from '@xgis/map'
