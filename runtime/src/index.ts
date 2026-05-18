export { XGISMap } from './engine/map'
export { StatsPanel, StatsTracker, type RenderStats } from './engine/stats'
export { Camera } from './engine/projection/camera'
export { MapRenderer } from './engine/render/renderer'
export { loadGeoJSON, lonLatToMercator } from './loader/geojson'
export {
  injectPolarCaps, findClampBoundarySpans, synthesizeCapRing, vertexOnClampBoundary,
  type CapSpan,
} from './loader/polar-cap-detect'
export {
  synthesizePolarCaps, projectionNeedsPolarCaps,
  type PolarCapOptions, type PolarCapFeatureCollection,
} from './data/polar-cap-synth'
export {
  RUNTIME_CAPABILITIES, runtimeCapability, runtimeGaps,
  type RuntimeCapability,
} from './capabilities'
export {
  // Function-style API (back-compat with prior versions)
  loadPMTilesSource, attachPMTilesSource,
  fetchPMTilesVectorLayerFields, fetchPMTilesVectorLayerSchema,
  // Class-based API
  VectorTileLoader, VectorTileSource,
  PMTilesArchiveSource, TileJSONSource,
  // Types
  type PMTilesSourceOptions, type VectorLayerInfo, type VectorTileFormat,
} from './loader/vector-tile-loader'
export { XGISMapElement, registerXGISElement } from './web/component'
export { mercator, equirectangular, naturalEarth, orthographic, getProjection } from './engine/projection/projection'
export { ComputeDispatcher, type ComputeTask } from './engine/gpu/compute'
export { createColorRampTexture, createRampSampler, availableRamps } from './engine/color-ramp'
