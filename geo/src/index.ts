// @xgis/geo — pure cartography / projection math. Depends ONLY on @xgis/shared.
// Extracted from engine/src/projection + engine/src/gpu/world-scale in #781 (3c)
// so @xgis/engine stays content-blind (geo-free). Consumed by @xgis/data and
// @xgis/map; the engine never imports it — geo and engine are siblings on shared.
export * from './projection'
export * from './projections-table'
export * from './world-scale'
export * from './globe'
