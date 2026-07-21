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
   *  Used for the PMTiles demos: their sources cover specific places
   *  (the pmtiles.io Firenze sample, or the protomaps v4 API that the
   *  demo loader rewrites the retired demo-bucket URL to — see
   *  playground/src/demos/loader.ts URL_REWRITES), so without a hash
   *  the user lands at the global default and sees nothing. Format
   *  matches the playground URL hash: `zoom/lat/lon[/bearing/pitch]`. */
  defaultHash?: string
  /** Hide the card from the production gallery while keeping it in
   *  the playground for local dev. Used for demos whose interesting
   *  content depends on something only the dev environment provides
   *  (e.g., the protomaps v4 daily basemap proxied via vite — no
   *  CORS-enabled v4 archive to point at in production). */
  devOnly?: boolean
  /** Standalone demo URL — bypasses the unified `demo.html?id=…`
   *  runner. Used for demos that need bespoke JS glue (e.g.
   *  `addOverlay()` calls after `map.run()`) that doesn't fit the
   *  declarative `.xgis`-source-only contract of demos.ts. */
  standaloneUrl?: string
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
      {
        id: 'minimal',
        title: 'Minimal',
        body: 'Natural Earth countries with one fill + stroke layer.',
      },
      {
        id: 'ocean-land',
        title: 'Ocean & land',
        body: 'Two GeoJSON layers stacked — water under land.',
      },
      {
        id: 'dark',
        title: 'Dark theme',
        body: 'Same data, slate palette and translucent strokes.',
      },
      {
        id: 'styled-world',
        title: 'Styled world',
        body: 'Multi-layer composition with subtle gradients.',
      },
      {
        id: 'inline-data',
        runId: 'inline_data',
        title: 'Inline GeoJSON',
        body: 'GeoJSON embedded directly in the source via `data: { … }` — no url fetch, no separate file.',
      },
    ],
  },
  {
    title: 'PMTiles + MVT',
    body: 'Streaming vector tiles straight from a PMTiles archive — no tile server, each MVT source-layer styled independently.',
    demos: [
      // Defaults drop the camera onto Tokyo (a city dense enough
      // that water / landuse / roads / buildings all resolve
      // visibly at z=14). The v4 demo defaults to a wider world
      // view since `earth` is the only layer it draws.
      // pmtiles_source uses pmtiles.io's Firenze sample directly
      // (bypasses the worker), so it keeps its Florence default.
      {
        id: 'pmtiles-source',
        title: 'Florence, one archive',
        body: 'A single PMTiles file streamed over HTTP range requests — one layer picks the buildings out of the MVT.',
        defaultHash: '13/43.77/11.25',
      },
      {
        id: 'pmtiles-layered',
        title: 'Per-layer styling',
        body: 'water / landuse / roads / buildings each driven by its own MVT slice.',
        defaultHash: '14/35.68/139.76',
      },
      {
        id: 'osm-style',
        runId: 'osm_style',
        title: 'OSM-style cartography',
        body: 'Per-kind landuse + road hierarchy + extruded buildings (3D walls visible at high pitch).',
        defaultHash: '17/40.7580/-73.9855/0/75',
      },
      {
        id: 'pmtiles-only-landuse',
        title: 'Landuse slice',
        body: 'Filter a PMTiles archive down to a single MVT layer.',
        defaultHash: '12/35.68/139.76',
      },
      {
        id: 'pmtiles-protomaps-v4',
        runId: 'pmtiles_v4',
        title: 'Protomaps v4',
        body: 'Protomaps v4 daily world basemap — earth source-layer + vector_layers metadata.',
        defaultHash: '3/30/0',
      },
      {
        id: 'import-maplibre-demo',
        runId: 'import_maplibre_demo',
        title: 'Import a MapLibre style',
        body: 'One `import` line swallows the canonical MapLibre demo style — 33 layers of Mapbox v8 JSON converted on the fly.',
        noThumb: true,
      },
      // `noThumb: true`: openfreemap-bright's 119-layer style takes
      // longer than the capture spec's 20 s tile-settle to render the
      // first visible frame, so the captured JPG comes out as the
      // background fill. Until either the capture path is fixed (longer
      // settle window for this demo) or a hand-curated screenshot is
      // committed, fall back to the live-only card style — same path
      // pmtiles-labels / text-overlay use.
      {
        id: 'openfreemap-bright',
        runId: 'openfreemap_bright',
        title: 'OpenFreeMap · Bright',
        body: 'Live OpenFreeMap "bright" Mapbox style, run through the /convert pipeline. 119 layers from a real-world cartographic style.',
        defaultHash: '14/35.68/139.76',
        noThumb: true,
      },
    ],
  },
  {
    title: 'Data-driven styling',
    body: 'Bind feature properties to colors, sizes, and opacity through match(), filters, and gradients.',
    demos: [
      {
        id: 'continent-match',
        title: 'match() per continent',
        body: 'fill match(.CONTINENT) { ... } — one branch per category.',
      },
      {
        id: 'continent-outlines',
        title: 'Continent outlines',
        body: 'Same match-table approach driving stroke color.',
      },
      {
        id: 'filter-gdp',
        title: 'GDP filter',
        body: 'Multiple layers, each with a `filter:` predicate over the same source.',
      },
      {
        id: 'gdp-gradient',
        title: 'GDP gradient',
        body: 'Continuous color ramp from a numeric property.',
      },
      {
        id: 'income-match',
        title: 'Income match()',
        body: 'Categorical mapping for World Bank income tiers.',
      },
      {
        id: 'population-gradient',
        title: 'Population gradient',
        body: 'Choropleth from population numbers.',
      },
      {
        id: 'megacities',
        title: 'Megacities',
        body: 'Filter cities by population, render with sized symbols.',
      },
      {
        id: 'categorical',
        title: 'Generic categorical',
        body: 'Cleanest match() example — each region one color.',
      },
    ],
  },
  {
    title: 'Lines & strokes',
    body: 'Stroke widths, dash arrays, line caps and joins, signed-distance-field rendering.',
    demos: [
      {
        id: 'bold-borders',
        title: 'Bold borders',
        body: 'Heavy stroke on a thin fill for poster-style maps.',
      },
      {
        id: 'dashed-borders',
        title: 'Dashed borders',
        body: 'stroke-dasharray on country boundaries.',
      },
      { id: 'dashed-lines', title: 'Dashed lines', body: 'Multiple dash patterns side-by-side.' },
      {
        id: 'layered-borders',
        title: 'Layered borders',
        body: 'Stack multiple stroke widths to fake casing.',
      },
      { id: 'line-offset', title: 'Line offset', body: 'Parallel lines via stroke-offset.' },
      { id: 'line-styles', title: 'Line styles', body: 'Cap, join, dash combinations gallery.' },
      { id: 'pattern-lines', title: 'Pattern lines', body: 'Shape glyphs repeated along a line.' },
      {
        id: 'stroke-align',
        title: 'Stroke align',
        body: 'inset / outset / center stroke alignment.',
      },
      {
        id: 'translucent-lines',
        title: 'Translucent lines',
        body: 'Line opacity via the offscreen MAX-blend pass.',
      },
      {
        id: 'multi-layer-line',
        title: 'Multi-layer line',
        body: 'Casing + body + centerline composed as three layers.',
      },
    ],
  },
  {
    title: 'Symbols & points',
    body: 'Point glyphs from SVG path strings or built-in shapes, sized and colored from data.',
    demos: [
      {
        id: 'custom-symbol',
        title: 'Custom symbol',
        body: 'symbol arrow { path "..." } and shape-arrow.',
      },
      {
        id: 'custom-shapes',
        title: 'Built-in shapes',
        body: 'Circle / square / triangle / arrow primitives.',
      },
      {
        id: 'gradient-points',
        title: 'Gradient points',
        body: 'Per-point color from a numeric property.',
      },
      {
        id: 'populated-places',
        title: 'Populated places',
        body: 'City labels sized by population.',
      },
      {
        id: 'procedural-circles',
        title: 'Procedural circles',
        body: 'Generated point grid with ramped colors.',
      },
      {
        id: 'sdf-points',
        title: 'SDF points',
        body: 'Signed-distance-field point rendering — crisp at any zoom.',
      },
      {
        id: 'shape-gallery',
        title: 'Shape gallery',
        body: 'Side-by-side comparison of every built-in symbol.',
      },
      {
        id: 'heatmap',
        title: 'Heatmap',
        body: 'World population as glowing density — a 3-pass GPU pipeline splats, blurs, and colour-ramps thousands of city points.',
      },
      {
        id: 'heatmap-ramp',
        title: 'Heatmap, custom ramp',
        body: 'The same density field through an authored inferno palette — heatmap-color bakes your interpolate() stops into the GPU LUT.',
      },
    ],
  },

  {
    title: 'Text labels',
    body: 'SDF text rendering — anchor strings to lon/lat from feature properties or imperatively from app code.',
    demos: [
      // These two are STANDALONE pages (playground/examples/*.html) that
      // don't load through demo.html?id=…. They exist to demo the SDF
      // text pipeline end-to-end and are the source of truth for the
      // /docs/utilities label-* family + the /docs/cookbook recipes.
      // The gallery links route directly to the standalone page so the
      // user sees the working result instead of a 404.
      {
        id: 'labels',
        title: 'Auto labels (GeoJSON)',
        body: 'label-["{.name}"] resolves text from each feature\'s properties — Mapbox text-field equivalent.',
        standaloneUrl: 'examples/labels.html',
        noThumb: true,
      },
      {
        id: 'text-overlay',
        title: 'Imperative overlay',
        body: 'map.addOverlay({text, anchor, color, halo}) — text labels added from app code, re-projected every frame.',
        standaloneUrl: 'examples/text-overlay.html',
        noThumb: true,
      },
      {
        id: 'pmtiles-labels',
        title: 'PMTiles labels (MVT)',
        body: 'Same label-["{.name}"] utility against PMTiles vector-tile features — properties surface from the MVT decode worker. Florence Duomo at z=14.',
        defaultHash: '14/43.7733/11.2558',
        noThumb: true,
      },
    ],
  },
  {
    title: 'Animation',
    body: 'Time-driven property tweening declared via top-level `keyframes` blocks.',
    demos: [
      {
        id: 'animation-pulse',
        title: 'Pulse',
        body: 'opacity 100 → 30 → 100 every 1.5s with ease-in-out.',
      },
      {
        id: 'animation-showcase',
        title: 'Multi-property',
        body: 'fill color, stroke color, dash offset, all animating in parallel.',
      },
    ],
  },
  {
    title: 'Zoom behavior',
    body: 'Zoom-conditional utilities and level-of-detail switching.',
    demos: [
      {
        id: 'zoom',
        title: 'Zoom-driven opacity',
        body: 'opacity-[interpolate(zoom, 2, 30, 5, 60, 8, 90)] — linearly blended.',
      },
      {
        id: 'zoom-lod',
        title: 'LOD switching',
        body: 'Different layers active at different zoom ranges.',
      },
    ],
  },
  {
    title: 'Camera & interaction',
    body: 'Drive the camera from code, react to the pointer — the MapLibre camera API ported to the globe.',
    demos: [
      {
        id: 'picking-demo',
        title: 'Picking',
        body: 'Hover highlights the country under the cursor, click locks it — GPU pick buffer, no geometry queries.',
      },
      {
        id: 'fly-to',
        title: 'Fly to',
        body: 'Cinematic camera arcs between world cities — flyTo() with easing, one button per destination.',
      },
      {
        id: 'fit-bounds',
        title: 'Fit bounds',
        body: 'fitBounds() frames a bounding box in one call — jump between continents and let the camera do the math.',
      },
      {
        id: 'jump-to-locations',
        title: 'Jump to locations',
        body: 'Instant jumpTo() teleports with per-stop zoom, bearing and pitch.',
      },
      {
        id: 'pitch-bearing',
        title: 'Pitch & bearing',
        body: 'Tilt to 60° and spin the map — the camera pose axes behind every 3D view.',
      },
      {
        id: 'color-switcher',
        title: 'Live restyling',
        body: 'Swap layer colours from buttons while the map runs — imperative restyling without a reload.',
      },
      {
        id: 'mouse-position',
        title: 'Mouse position',
        body: 'Screen → lon/lat unprojection under the cursor, live on every pointer move.',
      },
    ],
  },
  {
    title: 'Terrain & 3D',
    body: 'Real elevation data shaded on the GPU, satellite imagery, and buildings extruded on the globe.',
    demos: [
      {
        id: 'hillshade-terrarium',
        runId: 'hillshade_terrarium',
        title: 'Grand Canyon relief',
        body: 'Live AWS terrain tiles shaded in the fragment shader — a raster-dem source, Sobel normals, and warm authored light.',
        noThumb: true,
      },
      {
        id: 'hillshade-multidir',
        runId: 'hillshade_multidir',
        title: 'Multidirectional relief',
        body: 'The USGS four-light look: hillshade-method multidirectional averages lights at 225/270/315/355° so every ridge reads.',
        noThumb: true,
      },
      {
        id: 'satellite-map',
        runId: 'satellite_map',
        title: 'Satellite imagery',
        body: 'Esri World Imagery over Palm Jumeirah — a raster source with a {z}/{y}/{x} URL template.',
        noThumb: true,
      },
      {
        id: 'globe-extrusion',
        runId: 'globe_extrusion',
        title: '3D globe extrusion',
        body: 'Country polygons extruded by population on the true 3D globe — fill-extrusion heights riding an orthographic Earth.',
      },
    ],
  },
  {
    title: 'Raster basemaps',
    body: 'XYZ tile URL templates as a base layer under vector content.',
    demos: [
      { id: 'raster', title: 'Raster only', body: 'OSM tiles via the {z}/{x}/{y} template.' },
      {
        id: 'raster-overlay',
        title: 'Vector overlay',
        body: 'Basemap + a translucent country fill on top.',
      },
    ],
  },
  {
    title: 'Geographic compositions',
    body: 'Multi-source compositions modeled after print cartography.',
    demos: [
      {
        id: 'physical-map',
        title: 'Physical map',
        body: 'Land + ocean + rivers + lakes + coastline at default resolution.',
      },
      {
        id: 'physical-map-10m',
        title: 'Physical map (10m)',
        body: 'Higher-detail Natural Earth at 1:10m scale.',
      },
      {
        id: 'physical-map-50m',
        title: 'Physical map (50m)',
        body: 'Mid-detail variant; faster initial load than 10m.',
      },
      {
        id: 'night-map',
        title: 'Night map',
        body: 'Dark navigation palette with subtle hierarchy.',
      },
      {
        id: 'rivers-lakes',
        title: 'Rivers & lakes',
        body: 'Hydro layers separated for independent styling.',
      },
      {
        id: 'rivers-10m',
        title: 'Rivers (10m)',
        body: 'Detailed river network from Natural Earth 10m.',
      },
      {
        id: 'states-provinces',
        title: 'States & provinces',
        body: 'Sub-national admin boundaries.',
      },
      {
        id: 'coastline',
        title: 'Coastline',
        body: 'Single coastline polyline at default resolution.',
      },
    ],
  },
  {
    title: 'Real-world data',
    body: 'Public origin-destination data, processed the way real geo-viz work demands: a 345MB raw CSV aggregated OFFLINE to a tiny binary, decoded in-browser, and rendered live. This is the @xgis/pipeline story end-to-end.',
    demos: [
      {
        id: 'seoul-arc-hero',
        title: '수도권 생활이동 flow-map',
        body: 'Real Seoul OD data (OA-22300, 5.2M rows/day) as origin→destination flow-lines pulsing over the day. 345MB raw → a 26KB .odb decoded in the browser.',
        standaloneUrl: 'seoul-arc-hero.html',
        noThumb: true,
      },
      {
        id: 'seoul-odb-hero',
        title: '생활이동 inflow bubbles',
        body: 'The same .odb payload, summed to per-자치구 inflow bubbles — the compact-binary source-loader path rendered on the real GPU.',
        standaloneUrl: 'seoul-odb-hero.html',
        noThumb: true,
      },
      {
        id: 'seoul-arc-multiday',
        title: '생활이동 multi-day (date×hour)',
        body: 'Three real OA-22300 days on one date×hour scrubber — proving the n-day timeline. 1247 days is the same UI, just more fixtures behind the slider.',
        standaloneUrl: 'seoul-arc-multiday.html',
        noThumb: true,
      },
    ],
  },
]

export const featuredDemos: Demo[] = [
  {
    id: 'minimal',
    runId: 'minimal',
    title: 'The simplest map',
    body: 'One source, one layer — copy this, change the URL, you have a map.',
  },
  {
    id: 'pmtiles-layered',
    runId: 'pmtiles_layered',
    title: 'Streaming PMTiles',
    body: 'Four MVT layers from one archive — water, landuse, roads, buildings.',
    defaultHash: '14/35.68/139.76',
  },
  {
    id: 'animation-showcase',
    runId: 'animation_showcase',
    title: 'Live animation',
    body: 'Three keyframe blocks driving fill, stroke, and dash offset together.',
  },
]

/** Resolve a demo's runId — most are id with hyphens → underscores. */
export function runIdOf(d: Demo): string {
  return d.runId ?? d.id.replace(/-/g, '_')
}
