// Authoritative list of /docs/reference sections. Imported by
// reference.astro to render the page AND by lib/search-index.ts to
// build the build-time search index. One source of truth.

export interface ReferenceSection {
  id: string
  title: string
  body: string
  code?: string
  /** Registered playground DEMOS key. When set, the section renders
   *  a "Try this →" link to /play/demo.html?id=<demoId>. */
  demoId?: string
  /** Extra query string fragment merged into the playground URL
   *  (e.g., `proj=orthographic`). */
  demoQuery?: string
  /** Optional URL hash appended to the playground link so the
   *  demo lands at a useful camera position. Format:
   *  `zoom/lat/lon[/bearing/pitch]` (no leading `#`). Used for
   *  PMTiles demos that get rewritten to a Firenze-sample archive
   *  in production — see playground/src/demos.ts. */
  demoHash?: string
}

export const referenceSections: ReferenceSection[] = [
  {
    id: 'quick-start',
    title: 'Quick start',
    body: 'Two top-level blocks — a source that points at data, a layer that styles it. The pipe-prefixed lines are utility classes; multiple lines are concatenated into one stack.',
    demoId: 'minimal',
    code: `source world {
  type: geojson
  url: "ne_110m_countries.geojson"
}

layer countries {
  source: world
  | fill-stone-200 stroke-stone-400 stroke-1
}`,
  },
  {
    id: 'sources',
    title: 'Sources',
    body: 'A `source` block declares where data comes from. Three transports are supported. The runtime picks the loader from the `type` keyword, not the URL extension.',
    demoId: 'pmtiles_source',
    demoHash: '13/43.77/11.25',
    code: `// GeoJSON — full-file load, runtime tessellation
source land {
  type: geojson
  url: "land.geojson"
}

// XGVT — pre-tiled binary, HTTP Range Requests
source land_xgvt {
  type: geojson           // the geojson loader auto-detects .xgvt
  url: "land.xgvt"
}

// PMTiles — single archive, per-MVT-layer slicing
source pm {
  type: pmtiles
  url: "https://pmtiles.io/protomaps(vector)ODbL_firenze.pmtiles"
}

// Raster basemap — XYZ tile URL template
source basemap {
  type: raster
  url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
}`,
  },
  {
    id: 'layers',
    title: 'Layers + utility classes',
    body: 'Each `layer` references a source by name and stacks utility classes on `|` lines. Multiple `|` blocks compose left-to-right; later utilities win on conflict.',
    demoId: 'multi_layer',
    code: `layer roads {
  source: city
  | stroke-stone-400 stroke-1 opacity-90
  | stroke-dasharray-8-4
}`,
  },
  {
    id: 'modifiers',
    title: 'Zoom modifiers',
    body: 'Prefix any utility with `z<N>:` to set the value at that zoom level. The runtime interpolates between the stops at each frame, so transitions are smooth without manual animation.',
    demoId: 'zoom',
    code: `layer countries {
  source: world
  | fill-purple-400 stroke-purple-200 stroke-1
  | z2:opacity-30 z5:opacity-60 z8:opacity-90
}`,
  },
  {
    id: 'filters',
    title: 'Filters',
    body: 'Each layer can carry a `filter:` predicate. Field accessors use the `.FIELD` syntax. Multiple layers can share one source — common pattern for highlighting subsets.',
    demoId: 'filter_gdp',
    code: `// All countries as dark base
layer all {
  source: countries
  | fill-slate-900 stroke-slate-700 stroke-0.5
}

// Top economies highlighted on top
layer top_economies {
  source: countries
  filter: .GDP_MD_EST > 5000000
  | fill-yellow-500 stroke-yellow-300 stroke-2
}`,
  },
  {
    id: 'match',
    title: 'Data-driven values: match()',
    body: 'Bind feature property values to colors (or any utility value) inline. The compiler classifies each branch and routes to the GPU shader so the lookup happens per-fragment.',
    demoId: 'continent_match',
    code: `layer continents {
  source: countries
  | fill match(.CONTINENT) {
      "Africa"        -> amber-600,
      "Asia"          -> rose-500,
      "Europe"        -> sky-500,
      "North America" -> emerald-500,
      "South America" -> lime-500,
      "Oceania"       -> violet-500,
      "Antarctica"    -> slate-300,
      _               -> gray-400
    }
    stroke-slate-700 stroke-0.5
}`,
  },
  {
    id: 'background',
    title: 'Background',
    body: 'A top-level `background { ... }` block sets the canvas clear color (Mapbox-style). Renders before any layer; only the resolved fill color is consumed.',
    demoId: 'pmtiles_layered',
    demoHash: '13/43.77/11.25',
    code: `background { fill: stone-100 }

source pm {
  type: pmtiles
  url: "/world.pmtiles"
}

layer water {
  source: pm
  sourceLayer: "water"
  | fill-sky-900 stroke-sky-700 stroke-0.5
}`,
  },
  {
    id: 'presets',
    title: 'Presets — reusable utility stacks',
    body: 'A `preset` block names a utility stack you can splat into any layer with `apply-<preset>`. Layer-level utilities placed after the apply override the preset values.',
    code: `preset alert {
  | fill-red-500 stroke-black stroke-2
}

layer tracks {
  source: data
  | apply-alert opacity-80
}`,
  },
  {
    id: 'symbols',
    title: 'Symbols',
    body: 'Define point glyphs with SVG-style path strings. Reference the symbol with `shape-<name>`. Stroke and fill are signed-distance-field rendered, so shapes stay crisp at every zoom.',
    demoId: 'custom_symbol',
    code: `symbol arrow {
  path "M 0 -1 L 0.4 0.4 L 0 0.1 L -0.4 0.4 Z"
}

layer capitals {
  source: cities
  filter: .featurecla == "Admin-0 capital"
  | shape-arrow fill-emerald-400 stroke-emerald-600 stroke-1 size-16
}`,
  },
  {
    id: 'animation',
    title: 'Animation — keyframes',
    body: 'Declare a top-level `keyframes` block, then attach it to a layer with `animation-<name>`. The lifecycle modifiers all share the `animation-` prefix so they group together.',
    demoId: 'animation_pulse',
    code: `keyframes pulse {
  0%:   opacity-100
  50%:  opacity-30
  100%: opacity-100
}

layer pulsing_coast {
  source: coast
  | stroke-amber-300 stroke-3
  | animation-pulse animation-duration-1500 animation-ease-in-out animation-infinite
}`,
  },
  {
    id: 'projections',
    title: 'Projections',
    body: 'Seven projections ship in both CPU and WGSL form. Switching is a uniform write — same source, no re-tessellation. The runtime exposes them via `getProjection(name, ...args)` from `@xgis/runtime`.',
    demoId: 'physical_map',
    demoQuery: 'proj=orthographic',
    code: `// Available names (string keys for getProjection):
//
//   mercator                   — Web Mercator, the default
//   equirectangular            — flat plate carrée
//   natural_earth              — pseudo-cylindrical, low-distortion world
//   orthographic(lon, lat)     — globe view, requires center
//   azimuthal_equidistant(lon, lat)
//   stereographic(lon, lat)
//   oblique_mercator(lon, lat) — tilted Mercator centered on (lon, lat)`,
  },
  {
    id: 'js-api',
    title: 'JavaScript API',
    body: 'Call `new XGISMap(canvas)` then `await map.run(source, baseUrl)` where `source` is a `.xgis` source string and `baseUrl` resolves any relative `url:` references in your declarations. WebGPU is preferred; Canvas 2D engages as a fallback when no adapter is available.',
    demoId: 'minimal',
    code: `import { XGISMap } from "@xgis/runtime"

const canvas = document.querySelector("canvas")
const map = new XGISMap(canvas)

await map.run(\`
  source world {
    type: geojson
    url: "ne_110m_countries.geojson"
  }
  layer countries {
    source: world
    | fill-stone-200 stroke-stone-400 stroke-1
  }
\`, "/data/")`,
  },
]
