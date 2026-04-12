// ═══ Demo Definitions ═══
// Source files live in src/examples/*.xgis — single source of truth.
// Vite inlines them at build time via ?raw glob import.

const modules = import.meta.glob<string>('./examples/*.xgis', { eager: true, query: '?raw', import: 'default' })

function load(file: string): string {
  const key = `./examples/${file}`
  const src = modules[key]
  if (!src) throw new Error(`Missing example: ${key}`)
  return src
}

export interface Demo {
  name: string
  tag: string
  description: string
  source: string  // loaded from .xgis file
}

export const DEMOS: Record<string, Demo> = {
  minimal: {
    name: 'Minimal',
    tag: 'basic',
    description: 'One source, one layer — the simplest X-GIS program',
    source: load('minimal.xgis'),
  },

  dark: {
    name: 'Dark Theme',
    tag: 'basic',
    description: 'Dark fill with bright cyan borders',
    source: load('dark.xgis'),
  },

  raster: {
    name: 'Raster + Borders',
    tag: 'raster',
    description: 'OpenStreetMap tile layer with translucent country borders',
    source: load('raster.xgis'),
  },

  zoom: {
    name: 'Zoom Styles',
    tag: 'zoom',
    description: 'Opacity changes by zoom level — zoom in and out to see the effect',
    source: load('zoom.xgis'),
  },

  multi_layer: {
    name: 'Multi-Layer',
    tag: 'layer',
    description: 'Two layers from the same source with different styles, stacked over raster tiles',
    source: load('multi-layer.xgis'),
  },

  categorical: {
    name: 'Categorical Colors',
    tag: 'per-feature',
    description: 'Each country colored by name — 20 GPU-assigned colors via storage buffer',
    source: load('categorical.xgis'),
  },

  vector_tiles: {
    name: 'Vector Tiles',
    tag: 'xgvt',
    description: 'Pre-tiled .xgvt file — COG-style Range Requests, adaptive zoom levels',
    source: load('vector-tiles.xgis'),
  },

  vector_categorical: {
    name: 'VT + Categorical',
    tag: 'xgvt',
    description: 'Per-feature categorical colors on vector tiles with PropertyTable',
    source: load('vector-categorical.xgis'),
  },

  // ── CSS-like style + filter ──

  styled_world: {
    name: 'Styled World',
    tag: 'style',
    description: 'Named styles, CSS properties, and per-feature filters on Natural Earth data',
    source: load('styled-world.xgis'),
  },

  filter_gdp: {
    name: 'GDP Filter',
    tag: 'style',
    description: 'Filter countries by GDP — only high-GDP countries are rendered',
    source: load('filter-gdp.xgis'),
  },

  // ── Natural Earth ──

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

  physical_map_xgvt: {
    name: 'Physical Map (XGVT)',
    tag: 'xgvt',
    description: 'Land, rivers, and lakes — all as .xgvt vector tiles',
    source: load('physical-map-xgvt.xgis'),
  },

  physical_map_50m: {
    name: 'Physical Map 50m',
    tag: 'xgvt',
    description: 'High-detail land + ocean + rivers + lakes (50m XGVT)',
    source: load('physical-map-50m.xgis'),
  },

  states_provinces: {
    name: 'States & Provinces',
    tag: 'xgvt',
    description: '50m admin-1 boundaries with categorical colors (XGVT)',
    source: load('states-provinces.xgis'),
  },

  countries_categorical_xgvt: {
    name: 'Countries 110m (XGVT)',
    tag: 'xgvt',
    description: 'Natural Earth 110m countries as vector tiles with categorical colors',
    source: load('countries-categorical-xgvt.xgis'),
  },
}
