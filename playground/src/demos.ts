// ═══ Demo Definitions ═══

export interface Demo {
  name: string
  tag: string
  description: string
  source: string
}

export const DEMOS: Record<string, Demo> = {
  minimal: {
    name: 'Minimal',
    tag: 'basic',
    description: 'One source, one layer — the simplest X-GIS program',
    source: `
source world {
  type: geojson
  url: "countries.geojson"
}

layer countries {
  source: world
  | fill-stone-200 stroke-stone-400 stroke-1
}
`,
  },

  dark: {
    name: 'Dark Theme',
    tag: 'basic',
    description: 'Dark fill with bright cyan borders',
    source: `
source world {
  type: geojson
  url: "countries.geojson"
}

layer countries {
  source: world
  | fill-slate-800 stroke-cyan-400 stroke-1 opacity-95
}
`,
  },

  raster: {
    name: 'Raster + Borders',
    tag: 'raster',
    description: 'OpenStreetMap tile layer with translucent country borders',
    source: `
source basemap {
  type: raster
  url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
}

source world {
  type: geojson
  url: "countries.geojson"
}

layer tiles {
  source: basemap
}

layer borders {
  source: world
  | fill-blue-500 opacity-20 stroke-white stroke-1
}
`,
  },

  zoom: {
    name: 'Zoom Styles',
    tag: 'zoom',
    description: 'Opacity changes by zoom level — zoom in and out to see the effect',
    source: `
source world {
  type: geojson
  url: "countries.geojson"
}

layer countries {
  source: world
  | fill-purple-400 stroke-purple-200 stroke-1
  | z2:opacity-30 z5:opacity-60 z8:opacity-90
}
`,
  },

  multi_layer: {
    name: 'Multi-Layer',
    tag: 'layer',
    description: 'Two layers from the same source with different styles, stacked over raster tiles',
    source: `
source basemap {
  type: raster
  url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
}

source world {
  type: geojson
  url: "countries.geojson"
}

layer tiles {
  source: basemap
}

layer fill {
  source: world
  | fill-orange-200 opacity-40
}

layer borders {
  source: world
  | stroke-red-500 stroke-2 opacity-80
}
`,
  },

  categorical: {
    name: 'Categorical Colors',
    tag: 'per-feature',
    description: 'Each country colored by name — 20 GPU-assigned colors via storage buffer',
    source: `
source world {
  type: geojson
  url: "countries.geojson"
}

layer countries {
  source: world
  | fill categorical(name) stroke-slate-700 stroke-1 opacity-95
}
`,
  },

  vector_tiles: {
    name: 'Vector Tiles',
    tag: 'xgvt',
    description: 'Pre-tiled .xgvt file — COG-style Range Requests, adaptive zoom levels',
    source: `
source world {
  type: geojson
  url: "countries.xgvt"
}

layer countries {
  source: world
  | fill-emerald-700 stroke-emerald-900 stroke-1
}
`,
  },

  vector_categorical: {
    name: 'VT + Categorical',
    tag: 'xgvt',
    description: 'Per-feature categorical colors on vector tiles with PropertyTable',
    source: `
source world {
  type: geojson
  url: "countries.xgvt"
}

layer countries {
  source: world
  | fill categorical(name) stroke-slate-700 stroke-1 opacity-95
}
`,
  },

  // ── Natural Earth examples ──

  ocean_land: {
    name: 'Ocean + Land',
    tag: 'natural-earth',
    description: 'Ocean and land polygons — two layers with contrasting fill colors',
    source: `
source ocean {
  type: geojson
  url: "ne_110m_ocean.geojson"
}

source land {
  type: geojson
  url: "ne_110m_land.geojson"
}

layer ocean {
  source: ocean
  | fill-sky-900
}

layer land {
  source: land
  | fill-emerald-800 stroke-emerald-600 stroke-1
}
`,
  },

  rivers_lakes: {
    name: 'Rivers + Lakes',
    tag: 'natural-earth',
    description: 'Global rivers (lines) and lakes (polygons) overlay on countries',
    source: `
source countries {
  type: geojson
  url: "ne_110m_countries.geojson"
}

source rivers {
  type: geojson
  url: "ne_110m_rivers.geojson"
}

source lakes {
  type: geojson
  url: "ne_110m_lakes.geojson"
}

layer bg {
  source: countries
  | fill-stone-800 stroke-stone-700 stroke-1
}

layer lakes {
  source: lakes
  | fill-sky-600 stroke-sky-400 stroke-1
}

layer rivers {
  source: rivers
  | stroke-sky-400 stroke-1
}
`,
  },

  coastline: {
    name: 'Coastline',
    tag: 'natural-earth',
    description: 'World coastline — line-only rendering with no fill',
    source: `
source coast {
  type: geojson
  url: "ne_110m_coastline.geojson"
}

layer coastline {
  source: coast
  | stroke-amber-400 stroke-2
}
`,
  },

  physical_map: {
    name: 'Physical Map',
    tag: 'natural-earth',
    description: 'Land, rivers, and lakes — dark ocean background',
    source: `
source land {
  type: geojson
  url: "ne_110m_land.geojson"
}

source rivers {
  type: geojson
  url: "ne_110m_rivers.geojson"
}

source lakes {
  type: geojson
  url: "ne_110m_lakes.geojson"
}

layer land {
  source: land
  | fill-stone-800 stroke-slate-600 stroke-1
}

layer lakes {
  source: lakes
  | fill-sky-700
}

layer rivers {
  source: rivers
  | stroke-sky-600 stroke-1
}
`,
  },

  physical_map_xgvt: {
    name: 'Physical Map (XGVT)',
    tag: 'xgvt',
    description: 'Land, rivers, and lakes — all as .xgvt vector tiles',
    source: `
source land {
  type: geojson
  url: "ne_110m_land.xgvt"
}

source rivers {
  type: geojson
  url: "ne_110m_rivers.xgvt"
}

source lakes {
  type: geojson
  url: "ne_110m_lakes.xgvt"
}

layer land {
  source: land
  | fill-stone-800 stroke-slate-600 stroke-1
}

layer lakes {
  source: lakes
  | fill-sky-700
}

layer rivers {
  source: rivers
  | stroke-sky-600 stroke-1
}
`,
  },

  countries_categorical_xgvt: {
    name: 'Countries 110m (XGVT)',
    tag: 'xgvt',
    description: 'Natural Earth 110m countries as vector tiles with categorical colors',
    source: `
source world {
  type: geojson
  url: "ne_110m_countries.xgvt"
}

layer countries {
  source: world
  | fill categorical(NAME) stroke-slate-600 stroke-1 opacity-95
}
`,
  },
}
