// Authoritative list of /examples gallery cards. Imported by
// examples.astro to render the page AND by lib/search-index.ts to
// build the build-time search index. One source of truth.

export interface Demo {
  /** Filename (without .xgis) — used for the GitHub source link. */
  id: string
  /** Registered playground demo key. Defaults to
   *  `id.replace(/-/g, '_')` (matches most entries in
   *  playground/src/demos.ts). Specify explicitly when divergent. */
  runId?: string
  title: string
  body: string
  /** Set true to suppress the JPG thumbnail (text-only fallback). */
  noThumb?: boolean
  /** Optional URL hash (no leading `#`) appended to the playground
   *  link so a deep-clicked demo lands at a useful camera position.
   *  Used for the PMTiles demos because the deployed playground
   *  substitutes the dev-proxy world archive with a Firenze sample
   *  (~5 km × 5 km in Tuscany) — without a hash the user lands at
   *  the global default and sees nothing. Format matches the
   *  playground URL hash: `zoom/lat/lon[/bearing/pitch]`. */
  defaultHash?: string
}

export interface Category {
  title: string
  body: string
  demos: Demo[]
}

export const galleryCategories: Category[] = [
  {
    title: 'Basics',
    body: 'Single source, single layer — the smallest possible map.',
    demos: [
      { id: 'minimal',     title: 'Minimal',     body: 'Natural Earth countries with one fill + stroke layer.' },
      { id: 'ocean-land',  title: 'Ocean & land', body: 'Two GeoJSON layers stacked — water under land.' },
      { id: 'dark',        title: 'Dark theme',   body: 'Same data, slate palette and translucent strokes.' },
      { id: 'styled-world', title: 'Styled world', body: 'Multi-layer composition with subtle gradients.' },
    ],
  },
  {
    title: 'PMTiles + MVT',
    body: 'Streaming vector tiles via PMTiles archives. Each MVT source-layer styles independently.',
    demos: [
      // The Firenze sample (used in production) covers Tuscany at
      // ~5 km × 5 km, so the default hash drops the camera onto the
      // city. In dev these still work — the world archive simply
      // renders the Firenze area zoomed in.
      { id: 'pmtiles-source',         title: 'Single MVT source-layer', body: 'One PMTiles archive, one xgis layer filtering one MVT layer.', defaultHash: '13/43.77/11.25' },
      { id: 'pmtiles-layered',        title: 'Per-layer styling',       body: 'water / landuse / roads / buildings each driven by its own MVT slice.', defaultHash: '13/43.77/11.25' },
      { id: 'pmtiles-only-landuse',   title: 'Landuse slice',           body: 'Filter a PMTiles archive down to a single MVT layer.', defaultHash: '13/43.77/11.25' },
      { id: 'pmtiles-protomaps-v4',   runId: 'pmtiles_v4',              title: 'Protomaps v4',            body: 'Protomaps v4 schema — vector_layers metadata + per-layer minzoom.', defaultHash: '13/43.77/11.25' },
    ],
  },
  {
    title: 'Vector tiles (XGVT binary)',
    body: 'Pre-tessellated GeoJSON in a single binary file, streamed via HTTP Range Requests.',
    demos: [
      { id: 'vector-tiles',               title: 'XGVT basics',           body: 'Compiled .xgvt loaded with HTTP Range Requests.' },
      { id: 'vector-categorical',         title: 'Categorical fill',      body: 'Per-feature color from feature properties.' },
      { id: 'countries-categorical-xgvt', title: 'Countries categorical', body: 'Categorical world map sourced from .xgvt.' },
      { id: 'physical-map-xgvt',          title: 'Physical map',          body: 'Multi-layer physical Earth from compiled tiles.' },
    ],
  },
  {
    title: 'Data-driven styling',
    body: 'Bind feature properties to colors, sizes, and opacity through match(), filters, and gradients.',
    demos: [
      { id: 'continent-match',     title: 'match() per continent',     body: 'fill match(.CONTINENT) { ... } — one branch per category.' },
      { id: 'continent-outlines',  title: 'Continent outlines',        body: 'Same match-table approach driving stroke color.' },
      { id: 'filter-gdp',          title: 'GDP filter',                body: 'Multiple layers, each with a `filter:` predicate over the same source.' },
      { id: 'gdp-gradient',        title: 'GDP gradient',              body: 'Continuous color ramp from a numeric property.' },
      { id: 'income-match',        title: 'Income match()',            body: 'Categorical mapping for World Bank income tiers.' },
      { id: 'population-gradient', title: 'Population gradient',       body: 'Choropleth from population numbers.' },
      { id: 'megacities',          title: 'Megacities',                body: 'Filter cities by population, render with sized symbols.' },
      { id: 'categorical',         title: 'Generic categorical',       body: 'Cleanest match() example — each region one color.' },
    ],
  },
  {
    title: 'Lines & strokes',
    body: 'Stroke widths, dash arrays, line caps and joins, signed-distance-field rendering.',
    demos: [
      { id: 'bold-borders',      title: 'Bold borders',      body: 'Heavy stroke on a thin fill for poster-style maps.' },
      { id: 'dashed-borders',    title: 'Dashed borders',    body: 'stroke-dasharray on country boundaries.' },
      { id: 'dashed-lines',      title: 'Dashed lines',      body: 'Multiple dash patterns side-by-side.' },
      { id: 'layered-borders',   title: 'Layered borders',   body: 'Stack multiple stroke widths to fake casing.' },
      { id: 'line-offset',       title: 'Line offset',       body: 'Parallel lines via stroke-offset.' },
      { id: 'line-styles',       title: 'Line styles',       body: 'Cap, join, dash combinations gallery.' },
      { id: 'pattern-lines',     title: 'Pattern lines',     body: 'Shape glyphs repeated along a line.' },
      { id: 'stroke-align',      title: 'Stroke align',      body: 'inset / outset / center stroke alignment.' },
      { id: 'translucent-lines', title: 'Translucent lines', body: 'Line opacity via the offscreen MAX-blend pass.' },
      { id: 'multi-layer-line',  title: 'Multi-layer line',  body: 'Casing + body + centerline composed as three layers.' },
    ],
  },
  {
    title: 'Symbols & points',
    body: 'Point glyphs from SVG path strings or built-in shapes, sized and colored from data.',
    demos: [
      { id: 'custom-symbol',       title: 'Custom symbol',       body: 'symbol arrow { path "..." } and shape-arrow.' },
      { id: 'custom-shapes',       title: 'Built-in shapes',     body: 'Circle / square / triangle / arrow primitives.' },
      { id: 'gradient-points',     title: 'Gradient points',     body: 'Per-point color from a numeric property.' },
      { id: 'populated-places',    title: 'Populated places',    body: 'City labels sized by population.' },
      { id: 'procedural-circles',  title: 'Procedural circles',  body: 'Generated point grid with ramped colors.' },
      { id: 'sdf-points',          title: 'SDF points',          body: 'Signed-distance-field point rendering — crisp at any zoom.' },
      { id: 'shape-gallery',       title: 'Shape gallery',       body: 'Side-by-side comparison of every built-in symbol.' },
    ],
  },
  {
    title: 'Animation',
    body: 'Time-driven property tweening declared via top-level `keyframes` blocks.',
    demos: [
      { id: 'animation-pulse',    title: 'Pulse',             body: 'opacity 100 → 30 → 100 every 1.5s with ease-in-out.' },
      { id: 'animation-showcase', title: 'Multi-property',    body: 'fill color, stroke color, dash offset, all animating in parallel.' },
    ],
  },
  {
    title: 'Zoom behavior',
    body: 'Zoom-conditional utilities and level-of-detail switching.',
    demos: [
      { id: 'zoom',     title: 'Zoom modifier',  body: 'z2:opacity-30 z5:opacity-60 z8:opacity-90 — interpolated.' },
      { id: 'zoom-lod', title: 'LOD switching',  body: 'Different layers active at different zoom ranges.' },
    ],
  },
  {
    title: 'Interaction',
    body: 'Pointer events, hover state, selection.',
    demos: [
      { id: 'picking-demo', title: 'Picking demo', body: 'Hover for highlight, click to lock — over an OSM raster basemap.' },
    ],
  },
  {
    title: 'Raster basemaps',
    body: 'XYZ tile URL templates as a base layer under vector content.',
    demos: [
      { id: 'raster',         title: 'Raster only',    body: 'OSM tiles via the {z}/{x}/{y} template.' },
      { id: 'raster-overlay', title: 'Vector overlay', body: 'Basemap + a translucent country fill on top.' },
    ],
  },
  {
    title: 'Geographic compositions',
    body: 'Multi-source compositions modeled after print cartography.',
    demos: [
      { id: 'physical-map',     title: 'Physical map',      body: 'Land + ocean + rivers + lakes + coastline at default resolution.' },
      { id: 'physical-map-10m', title: 'Physical map (10m)', body: 'Higher-detail Natural Earth at 1:10m scale.' },
      { id: 'physical-map-50m', title: 'Physical map (50m)', body: 'Mid-detail variant; faster initial load than 10m.' },
      { id: 'night-map',        title: 'Night map',         body: 'Dark navigation palette with subtle hierarchy.' },
      { id: 'rivers-lakes',     title: 'Rivers & lakes',    body: 'Hydro layers separated for independent styling.' },
      { id: 'rivers-10m',       title: 'Rivers (10m)',      body: 'Detailed river network from Natural Earth 10m.' },
      { id: 'states-provinces', title: 'States & provinces', body: 'Sub-national admin boundaries.' },
      { id: 'coastline',        title: 'Coastline',         body: 'Single coastline polyline at default resolution.' },
    ],
  },
]

export const featuredDemos: Demo[] = [
  { id: 'minimal',            runId: 'minimal',
    title: 'The simplest map',
    body: 'One source, one layer — copy this, change the URL, you have a map.' },
  { id: 'pmtiles-layered',    runId: 'pmtiles_layered',
    title: 'Streaming PMTiles',
    body: 'Four MVT layers from one archive — water, landuse, roads, buildings.',
    defaultHash: '13/43.77/11.25' },
  { id: 'animation-showcase', runId: 'animation_showcase',
    title: 'Live animation',
    body: 'Three keyframe blocks driving fill, stroke, and dash offset together.' },
]

/** Resolve a demo's runId — most are id with hyphens → underscores. */
export function runIdOf(d: Demo): string {
  return d.runId ?? d.id.replace(/-/g, '_')
}
