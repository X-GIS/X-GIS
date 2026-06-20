// ═══ Demo Definitions — Natural Earth basemaps (ocean/land/rivers/lakes/coastline/states). ═══
// Faithful per-category fragment of the single DEMOS record (assembled in
// ../demos.ts, which preserves the original insertion order). Demo .xgis
// sources load via the shared loader; ids are unchanged (URL nav depends on
// them). Append-only: a new demo in this category is added HERE.

import { load, type Demo } from './loader'

export const DEMOS_NATURAL_EARTH: Record<string, Demo> = {
  ocean_land: {
    name: 'Ocean + Land',
    tag: 'natural-earth',
    description: 'Ocean and land polygons — two layers with contrasting fill colors',
    source: load('ocean-land.xgis'),
  },

  rivers_lakes: {
    name: 'Rivers + Lakes',
    tag: 'natural-earth',
    description: 'Global rivers (lines) and lakes (polygons) overlay on countries',
    source: load('rivers-lakes.xgis'),
  },

  coastline: {
    name: 'Coastline',
    tag: 'natural-earth',
    description: 'World coastline — line-only rendering with no fill',
    source: load('coastline.xgis'),
  },

  physical_map: {
    name: 'Physical Map',
    tag: 'natural-earth',
    description: 'Land, rivers, and lakes — dark ocean background',
    source: load('physical-map.xgis'),
  },

  physical_map_50m: {
    name: 'Physical Map 50m',
    tag: 'natural-earth',
    description: 'High-detail land + ocean + rivers + lakes at 50m resolution',
    source: load('physical-map-50m.xgis'),
  },

  states_provinces: {
    name: 'States & Provinces',
    tag: 'natural-earth',
    description: '50m admin-1 boundaries with categorical colors',
    source: load('states-provinces.xgis'),
  },
}
