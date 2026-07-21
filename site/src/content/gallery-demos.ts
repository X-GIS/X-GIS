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
      // noThumb: the OSM raster base needs browser network egress the
      // capture environment doesn't have — flip after a local capture.
      {
        id: 'multi-layer',
        title: 'Multi-layer',
        body: 'Two layers from the same source with different styles, stacked over raster tiles.',
        noThumb: true,
      },
    ],
  },
  {
    title: 'PMTiles + MVT',
    body: 'Streaming vector tiles via PMTiles archives. Each MVT source-layer styles independently.',
    demos: [
      // Defaults drop the camera onto Tokyo (a city dense enough
      // that water / landuse / roads / buildings all resolve
      // visibly at z=14). The v4 demo defaults to a wider world
      // view since `earth` is the only layer it draws.
      // pmtiles_source uses pmtiles.io's Firenze sample directly
      // (bypasses the worker), so it keeps its Florence default.
      {
        id: 'pmtiles-source',
        title: 'Single MVT source-layer',
        body: 'One PMTiles archive, one xgis layer filtering one MVT layer.',
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
      // The three import-* demos fetch and convert a remote Mapbox/MapLibre
      // style at runtime — same live-fetch settle problem as
      // openfreemap-bright above, so they keep the text-only card style.
      {
        id: 'import-mapbox-style',
        title: 'import "mapbox-style-url"',
        body: 'One-line splice import — the runtime fetches a remote Mapbox style.json, converts it, and prepends the result. Zero JS glue.',
        noThumb: true,
      },
      {
        id: 'import-maplibre-demo',
        title: 'MapLibre demo style',
        body: 'The canonical MapLibre demo style — Mapbox v8 schema, ~33 layers, vector tiles via TileJSON.',
        noThumb: true,
      },
      {
        id: 'import-mapbox-inline-geojson',
        title: 'Inline-GeoJSON import',
        body: 'A Mapbox style.json with an inline FeatureCollection in source.data — captured by the importer and auto-pushed after run().',
        defaultHash: '3.5/37/132',
        noThumb: true,
      },
      // noThumb: the protomaps API rejects non-browser egress (403) in the
      // capture environment — flip after a local capture lands the JPG.
      {
        id: 'along-path-roads',
        title: 'Along-path road labels',
        body: 'symbol-placement: line — road names rotate to follow their segment tangent instead of reading horizontally.',
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
      {
        id: 'vector-categorical',
        title: 'Categorical countries',
        body: 'Per-feature categorical colors on Natural Earth country borders.',
      },
      {
        id: 'step-and-concat',
        title: 'step() + concat()',
        body: 'N-stop step() sizes city dots into population tiers; concat() composes multi-part labels.',
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
      {
        id: 'bucket-order',
        title: 'Bucket order',
        body: 'Translucent stroke declared before opaque fill — the bucket scheduler still renders opaque first and composites the stroke on top.',
      },
      {
        id: 'line-antimeridian',
        title: 'Antimeridian line',
        body: 'A LineString authored across 180° with >180 longitudes — great-circle subdivision keeps the world-copy continuation instead of a seam streak.',
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
        body: 'Population density heatmap — 3-pass GPU (additive Gaussian splat → separable blur → density→colour ramp).',
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
      // noThumb: a labels-only scene over black — the static crop reads
      // as an empty card; the text card describes it better.
      {
        id: 'multiline-labels',
        title: 'Multiline labels',
        body: 'Long city names wrap at label-max-width with line-height and justify-center.',
        noThumb: true,
      },
      {
        id: 'layer-below-labels',
        title: 'Layer below labels',
        body: 'A translucent lake overlay stacks above the land fill while city labels stay on top — no beforeId needed.',
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
      // noThumb: protomaps 403s non-browser egress in the capture
      // environment — flip after a local capture lands the JPG.
      {
        id: 'zoom-building-color',
        title: 'Buildings by zoom',
        body: 'Protomaps buildings ramp parchment → terracotta as you zoom from city overview to street level. Opens over lower Manhattan.',
        noThumb: true,
      },
    ],
  },
  {
    title: 'Interaction & camera',
    body: 'Pointer events, hover state, selection — and the API-driven camera example ports (#1192).',
    demos: [
      {
        id: 'picking-demo',
        title: 'Picking demo',
        body: 'Hover for highlight, click to lock — over an OSM raster basemap.',
      },
      {
        id: 'mouse-position',
        title: 'Mouse position',
        body: 'Live lon/lat readout under the cursor via map.unproject() on every pointermove.',
      },
      {
        id: 'color-switcher',
        title: 'Color switcher',
        body: 'Action buttons drive the runtime setPaintProperty API on the mounted scene.',
      },
      {
        id: 'fly-to',
        title: 'Fly to',
        body: 'Action buttons call map.flyTo({center, zoom}) — Seoul, Paris, world.',
      },
      {
        id: 'fit-bounds',
        title: 'Fit bounds',
        body: 'map.fitBounds([[west, south], [east, north]]) — Australia, Western Europe, world.',
      },
      {
        id: 'jump-to-locations',
        title: 'Jump to locations',
        body: 'map.jumpTo({center, zoom}) cycling through a fixed list of world cities.',
      },
      {
        id: 'pitch-bearing',
        title: 'Pitch & bearing',
        body: 'Opens with a tilted, rotated camera — pitch 60°, bearing −45° over the Italian peninsula.',
      },
      {
        id: 'camera-around-point',
        title: 'Rotating camera',
        body: 'A requestAnimationFrame loop drives map.setBearing() around a tilted Mediterranean view — start/stop buttons.',
      },
      {
        id: 'animate-point-route',
        title: 'Animate a point along a route',
        body: 'map.updateFeature() slides a marker along an inlined SF→DC great-circle arc, one coalesced flush per frame.',
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
      // noThumb ×2: live tile fetches need browser network egress the
      // capture environment doesn't have — flip after a local capture.
      {
        id: 'satellite-map',
        title: 'Satellite map',
        body: 'Esri World Imagery as a plain raster source — note the ArcGIS {z}/{y}/{x} path order. Opens over the Palm Jumeirah.',
        noThumb: true,
      },
      {
        id: 'hillshade-terrarium',
        title: 'Hillshade · Grand Canyon',
        body: 'Shaded relief from live AWS terrain tiles — a raster-dem source (terrarium encoding) with NW illumination and a warm palette.',
        noThumb: true,
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
      {
        id: 'coastline-10m',
        title: 'Coastline (10m)',
        body: 'World coastline at 10m as stacked shadow + body line layers — a dense SDF-line stress test.',
      },
      // noThumb ×2: these demos read the gitignored ne_10m_* datasets,
      // absent from a fresh checkout — flip after a local capture (with
      // the 10m data present) lands the JPGs.
      {
        id: 'states-10m',
        title: 'States (10m)',
        body: '10m admin-1 boundaries with per-country categorical fill.',
        noThumb: true,
      },
      {
        id: 'water-hierarchy',
        title: 'Water hierarchy',
        body: 'Three-tier blue gradient for ocean, lakes, and rivers with soft glow halos.',
        noThumb: true,
      },
      // noThumb: the coverage colour-ramp GPU draw is the #1158 INC-A
      // gate-3 (headed) item — flip after a real-GPU capture lands.
      {
        id: 'coverage-bathymetry',
        title: 'S-100 bathymetry coverage',
        body: 'S-100 gridded coverage (.xgcov) — a synthetic bathymetry grid with a north→south depth ramp and a nodata hole.',
        noThumb: true,
      },
    ],
  },
  {
    title: 'Globe & 3D',
    body: 'Globe projection and per-feature polygon extrusion.',
    demos: [
      {
        id: 'globe-extrusion',
        title: 'Globe + extrusion',
        body: 'Countries extrude off the globe with per-feature population heights via fill-extrusion-height.',
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
