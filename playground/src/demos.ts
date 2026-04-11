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
}
