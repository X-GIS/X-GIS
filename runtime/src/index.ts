export { XGISMap } from './engine/map'
export { StatsPanel, StatsTracker, type RenderStats } from './engine/stats'
export { Camera } from './engine/camera'
export { MapRenderer } from './engine/renderer'
export { loadGeoJSON, lonLatToMercator } from './loader/geojson'
export {
  // Function-style API (back-compat with prior versions)
  loadPMTilesSource, attachPMTilesSource,
  fetchPMTilesVectorLayerFields, fetchPMTilesVectorLayerSchema,
  // Class-based API
  VectorTileLoader, VectorTileSource,
  PMTilesArchiveSource, TileJSONSource, XGVTBinarySource,
  // Types
  type PMTilesSourceOptions, type VectorLayerInfo, type VectorTileFormat,
} from './loader/vector-tile-loader'
export { XGISMapElement, registerXGISElement } from './web/component'
export { mercator, equirectangular, naturalEarth, orthographic, getProjection } from './engine/projection'
export { ComputeDispatcher, type ComputeTask } from './engine/compute'
export { createColorRampTexture, createRampSampler, availableRamps } from './engine/color-ramp'
