// Build-time search index. Imports the same content the docs +
// gallery pages render from, flattens to a list of search records,
// and exposes them as a single array. The Search component embeds
// this array as JSON and runs client-side fuzzy filtering — no
// external service, no runtime fetch.

import { referenceSections } from '../content/reference-sections'
import { galleryCategories, runIdOf } from '../content/gallery-demos'

export interface SearchRecord {
  /** Stable identifier used as React-style key in the result list. */
  id: string
  /** Section / page / demo title. */
  title: string
  /** One-line body excerpt — what the result is, in plain English. */
  body: string
  /** "doc" for docs pages/sections, "demo" for gallery demos. The
   *  result list groups by this. */
  type: 'doc' | 'demo'
  /** Short tag shown beside the title (e.g., "Reference", "Concept",
   *  "API", or the demo category like "Animation"). */
  tag: string
  /** Full URL relative to BASE_URL. */
  url: string
}

/**
 * Build the search index. Pure — pass a `base` so call-sites can use
 * Astro's `import.meta.env.BASE_URL` instead of hard-coding.
 */
export function buildSearchIndex(base: string): SearchRecord[] {
  const out: SearchRecord[] = []

  // ─── Top-level docs pages ───
  out.push({
    id: 'doc:overview',
    title: 'Documentation overview',
    body: 'Quick start, browse cards, and links to every docs sub-page.',
    type: 'doc',
    tag: 'Overview',
    url: `${base}/docs`,
  })
  out.push({
    id: 'doc:concepts/rtc',
    title: 'RTC + DSFUN precision',
    body: 'How X-GIS preserves f32 precision at any camera zoom by splitting Mercator-meter coordinates into f64-equivalent high-low pairs.',
    type: 'doc',
    tag: 'Concept',
    url: `${base}/docs/concepts/rtc`,
  })
  out.push({
    id: 'doc:concepts/projections',
    title: 'Projection switching',
    body: 'Seven projections, one source. Switching is a single GPU uniform write — no re-tessellation.',
    type: 'doc',
    tag: 'Concept',
    url: `${base}/docs/concepts/projections`,
  })
  out.push({
    id: 'doc:concepts/pipeline',
    title: 'Compile pipeline',
    body: 'Lexer → AST → IR → optimizer → WGSL codegen. The path from .xgis source to a frame.',
    type: 'doc',
    tag: 'Concept',
    url: `${base}/docs/concepts/pipeline`,
  })
  out.push({
    id: 'doc:api',
    title: 'JavaScript API',
    body: 'Public exports from @xgis/runtime: XGISMap, Camera, projections, loaders, compute helpers, stats, custom element.',
    type: 'doc',
    tag: 'API',
    url: `${base}/docs/api`,
  })
  out.push({
    id: 'doc:utilities',
    title: 'Utility catalog',
    body: 'Tailwind-style utility classes: colors, fills, strokes, opacity, sizes, shapes, animation, modifiers.',
    type: 'doc',
    tag: 'Utilities',
    url: `${base}/docs/utilities`,
  })
  out.push({
    id: 'doc:functions',
    title: 'Function reference',
    body: 'Every builtin: clamp, min, max, round, sqrt, pow, log, sin, cos, atan2, interpolate, step, circle, arc, polygon, linestring, plus PI / TAU constants and the zoom runtime accessor.',
    type: 'doc',
    tag: 'Language',
    url: `${base}/docs/functions`,
  })
  out.push({
    id: 'doc:expressions',
    title: 'Expressions & operators',
    body: 'Operator reference and precedence table — arithmetic, comparison, logical, coalesce ??, ternary ?:, pipe |, bracket binding, match block, filter predicate.',
    type: 'doc',
    tag: 'Language',
    url: `${base}/docs/expressions`,
  })
  out.push({
    id: 'doc:sources',
    title: 'Source types',
    body: 'GeoJSON, PMTiles, TileJSON, raster XYZ, and XGVT — required fields, options, and caveats per source kind.',
    type: 'doc',
    tag: 'Language',
    url: `${base}/docs/sources`,
  })
  out.push({
    id: 'doc:quickstart',
    title: 'Quickstart',
    body: 'Build your first xgis map in five minutes — install, declare a source + layer, mount on a canvas.',
    type: 'doc',
    tag: 'Get started',
    url: `${base}/docs/quickstart`,
  })
  out.push({
    id: 'doc:cookbook',
    title: 'Cookbook',
    body: 'Copy-paste recipes for common cartographic tasks — 3D buildings, categorical fill, zoom-fade roads, road casing, animation, layer subsetting.',
    type: 'doc',
    tag: 'Guides',
    url: `${base}/docs/cookbook`,
  })
  out.push({
    id: 'doc:mapbox',
    title: 'Mapbox migration',
    body: 'Mapbox Style Spec compatibility matrix, expression mapping (interpolate / match / coalesce / filter), conceptual differences, and converter caveats.',
    type: 'doc',
    tag: 'Guides',
    url: `${base}/docs/mapbox`,
  })

  // ─── Reference sections (one record per section so search lands
  //     on the exact heading via #anchor) ───
  for (const s of referenceSections) {
    out.push({
      id: `ref:${s.id}`,
      title: s.title,
      body: s.body,
      type: 'doc',
      tag: 'Reference',
      url: `${base}/docs/reference#${s.id}`,
    })
  }

  // ─── Anchor-level entries for the new docs pages ───
  // Each H2/H3 anchor on functions / expressions / sources / cookbook
  // / mapbox gets its own record so a query for "interpolate" or
  // "pmtiles" deep-links into the right section instead of just the
  // page top. The bodies are short keyword soups — the fuzzy filter
  // matches against title+body+tag.
  const anchorRecords: Array<{ slug: string; page: string; tag: string; title: string; body: string }> = [
    // /docs/functions
    { slug: 'math',                page: 'functions',   tag: 'Function',   title: 'Math',                  body: 'clamp min max round floor ceil abs sqrt pow exp log log10 log2 scale' },
    { slug: 'trigonometry',        page: 'functions',   tag: 'Function',   title: 'Trigonometry',          body: 'sin cos tan asin acos atan atan2 radians degrees' },
    { slug: 'stops-gates',         page: 'functions',   tag: 'Function',   title: 'Stops & gates — interpolate / step',  body: 'interpolate step zoom feature property linear gate threshold' },
    { slug: 'constants',           page: 'functions',   tag: 'Function',   title: 'Constants — PI / TAU',  body: 'PI TAU pi tau radians' },
    { slug: 'array',               page: 'functions',   tag: 'Function',   title: 'Array — length, [i] index', body: 'length array subscript index bracket' },
    { slug: 'geometry-generators', page: 'functions',   tag: 'Function',   title: 'Geometry generators — circle / arc / polygon / linestring', body: 'circle arc polygon linestring procedural geometry' },
    { slug: 'runtime-accessors',   page: 'functions',   tag: 'Function',   title: 'Runtime accessors — zoom / .field', body: 'zoom field property accessor camera state' },
    // /docs/expressions
    { slug: 'operators',                  page: 'expressions', tag: 'Operator', title: 'Operators & precedence',           body: '+ - * / % == != < > <= >= && || ! ?? . | (pipe) ?: (ternary) precedence binding' },
    { slug: 'bracketed-binding',          page: 'expressions', tag: 'Operator', title: 'Bracketed binding — utility-[expr]', body: 'utility binding expression bracket fill stroke opacity size data-driven' },
    { slug: 'match-block',                page: 'expressions', tag: 'Operator', title: 'Match block — categorical lookup', body: 'match block categorical case lookup value mapping' },
    { slug: 'filter-predicate',           page: 'expressions', tag: 'Operator', title: 'Filter predicate',                 body: 'filter predicate boolean layer feature' },
    { slug: 'field-modifier-conditional-fill', page: 'expressions', tag: 'Operator', title: 'Field-modifier conditional fill',  body: 'modifier field property prefix conditional' },
    // /docs/sources
    { slug: 'geojson',  page: 'sources', tag: 'Source', title: 'geojson — full file load',     body: 'geojson source file URL load tiled' },
    { slug: 'pmtiles',  page: 'sources', tag: 'Source', title: 'pmtiles — single archive',     body: 'pmtiles archive byte-range MVT vector source-layer' },
    { slug: 'tilejson', page: 'sources', tag: 'Source', title: 'tilejson — XYZ MVT manifest',  body: 'tilejson manifest XYZ MVT vector tile server openfreemap' },
    { slug: 'raster',   page: 'sources', tag: 'Source', title: 'raster — XYZ tile server',     body: 'raster XYZ tile server PNG JPG OSM basemap' },
    { slug: 'xgvt',     page: 'sources', tag: 'Source', title: 'xgvt — pre-tessellated binary',body: 'xgvt binary pre-tessellated byte-range native format' },
    // /docs/cookbook
    { slug: '3d-buildings',           page: 'cookbook', tag: 'Recipe', title: 'Extruded 3D buildings',         body: 'fill-extrusion-height height render_height building 3d extrude' },
    { slug: 'categorical-fill',       page: 'cookbook', tag: 'Recipe', title: 'Categorical fill from a property', body: 'match continent category property fill color discrete' },
    { slug: 'zoom-fade',              page: 'cookbook', tag: 'Recipe', title: 'Zoom-fade road widths',          body: 'zoom interpolate stroke width fade road' },
    { slug: 'data-driven-stroke',     page: 'cookbook', tag: 'Recipe', title: 'Data-driven stroke width',       body: 'stroke width feature property pipe clamp' },
    { slug: 'multi-stroke-road-casing', page: 'cookbook', tag: 'Recipe', title: 'Road casing (two stacked strokes)', body: 'road casing stroke layer stack outline' },
    { slug: 'preset',                 page: 'cookbook', tag: 'Recipe', title: 'Reusable utility stacks (preset)', body: 'preset apply utility stack reuse' },
    { slug: 'animation-pulse',        page: 'cookbook', tag: 'Recipe', title: 'Pulsing opacity animation',      body: 'animation pulse keyframes opacity infinite' },
    { slug: 'filter-by-zoom',         page: 'cookbook', tag: 'Recipe', title: 'Hide a layer below a zoom threshold', body: 'minzoom maxzoom zoom threshold layer visibility' },
    { slug: 'mvt-layer-subset',       page: 'cookbook', tag: 'Recipe', title: 'Restrict PMTiles decoding to source-layers', body: 'pmtiles layers subset mvt source-layer decode worker' },
    // /docs/mapbox
    { slug: 'mental-model',         page: 'mapbox', tag: 'Mapbox', title: 'Mental model differences',  body: 'mapbox imperative declarative gl js maplibre' },
    { slug: 'converter',            page: 'mapbox', tag: 'Mapbox', title: 'Using the converter',       body: 'convert style.json mapbox openfreemap import preset' },
    { slug: 'compatibility',        page: 'mapbox', tag: 'Mapbox', title: 'Compatibility matrix',      body: 'mapbox compatibility supported lossy unsupported symbol layer text' },
    { slug: 'expression-mapping',   page: 'mapbox', tag: 'Mapbox', title: 'Expression mapping',        body: 'mapbox expression interpolate match coalesce filter mapping' },
    { slug: 'caveats',              page: 'mapbox', tag: 'Mapbox', title: 'Caveats & gotchas',         body: 'mapbox symbol cors curve roundtrip exponential' },
    // /docs/api — every JS export gets its own anchor record so a query
    // for "XGISMap" / "setProjection" / "getCamera" / "loadGeoJSON" lands
    // directly on the entry.
    { slug: 'core',          page: 'api', tag: 'API', title: 'Core',                       body: 'XGISMap run getCamera setProjection map class' },
    { slug: 'xgismap',       page: 'api', tag: 'API', title: 'XGISMap',                    body: 'XGISMap class constructor canvas WebGPU' },
    { slug: 'xgismap-run',   page: 'api', tag: 'API', title: 'XGISMap.run',                body: 'run compile source baseUrl render loop' },
    { slug: 'xgismap-getcamera',   page: 'api', tag: 'API', title: 'XGISMap.getCamera',    body: 'getCamera live mutate lon lat zoom bearing pitch' },
    { slug: 'xgismap-setprojection', page: 'api', tag: 'API', title: 'XGISMap.setProjection',  body: 'setProjection switch mercator orthographic uniform write' },
    { slug: 'camera',        page: 'api', tag: 'API', title: 'Camera',                     body: 'Camera class lon lat zoom bearing pitch zoomAt MVP' },
    { slug: 'projections',   page: 'api', tag: 'API', title: 'Projections',                body: 'mercator equirectangular naturalEarth orthographic stereographic getProjection' },
    { slug: 'mercator',      page: 'api', tag: 'API', title: 'mercator',                   body: 'Web Mercator EPSG 3857 default projection' },
    { slug: 'equirectangular', page: 'api', tag: 'API', title: 'equirectangular',          body: 'plate carrée latitude direct y projection' },
    { slug: 'naturalearth',  page: 'api', tag: 'API', title: 'naturalEarth',               body: 'pseudo-cylindrical natural earth low-distortion' },
    { slug: 'orthographic',  page: 'api', tag: 'API', title: 'orthographic',               body: 'globe view orthographic hemispherical back-face cull' },
    { slug: 'getprojection', page: 'api', tag: 'API', title: 'getProjection',              body: 'getProjection look up name args projection' },
    { slug: 'loaders',       page: 'api', tag: 'API', title: 'Loaders',                    body: 'loadGeoJSON loadPMTilesSource attachPMTilesSource lonLatToMercator' },
    { slug: 'loadgeojson',   page: 'api', tag: 'API', title: 'loadGeoJSON',                body: 'loadGeoJSON fetch xgvt auto-detect FeatureCollection' },
    { slug: 'loadpmtilessource',   page: 'api', tag: 'API', title: 'loadPMTilesSource',    body: 'loadPMTilesSource streaming PMTiles backend header range' },
    { slug: 'attachpmtilessource', page: 'api', tag: 'API', title: 'attachPMTilesSource',  body: 'attachPMTilesSource catalog source backend wire' },
    { slug: 'lonlattomercator', page: 'api', tag: 'API', title: 'lonLatToMercator',        body: 'lonLatToMercator project coordinate web mercator meters' },
    { slug: 'gpu-compute',   page: 'api', tag: 'API', title: 'GPU compute',                body: 'ComputeDispatcher createColorRampTexture availableRamps WebGPU compute' },
    { slug: 'computedispatcher', page: 'api', tag: 'API', title: 'ComputeDispatcher',      body: 'ComputeDispatcher WebGPU compute pipeline dispatch workgroups' },
    { slug: 'createcolorramptexture', page: 'api', tag: 'API', title: 'createColorRampTexture', body: 'color ramp texture viridis magma plasma 1d gradient' },
    { slug: 'availableramps', page: 'api', tag: 'API', title: 'availableRamps',            body: 'availableRamps list color ramp names' },
    { slug: 'stats-diagnostics', page: 'api', tag: 'API', title: 'Stats + diagnostics',    body: 'StatsPanel StatsTracker FPS draw call triangle' },
    { slug: 'statspanel',    page: 'api', tag: 'API', title: 'StatsPanel',                 body: 'StatsPanel on-screen FPS draw call overlay' },
    { slug: 'statstracker',  page: 'api', tag: 'API', title: 'StatsTracker',               body: 'StatsTracker singleton frame stats' },
    { slug: 'custom-element', page: 'api', tag: 'API', title: 'Custom element',            body: 'XGISMapElement registerXGISElement web components x-gis-map' },
    { slug: 'xgismapelement', page: 'api', tag: 'API', title: 'XGISMapElement',            body: 'XGISMapElement custom element web component shadow root' },
    { slug: 'registerxgiselement', page: 'api', tag: 'API', title: 'registerXGISElement',  body: 'register custom element x-gis-map global' },
  ]
  for (const a of anchorRecords) {
    out.push({
      id: `anchor:${a.page}/${a.slug}`,
      title: a.title,
      body: a.body,
      type: 'doc',
      tag: a.tag,
      url: `${base}/docs/${a.page}#${a.slug}`,
    })
  }

  // ─── Gallery demos (every card becomes one record) ───
  // Mirror the production gallery's devOnly filter — search results
  // should reflect what's visible on the page they link to.
  const includeDevOnly = import.meta.env.DEV
  for (const cat of galleryCategories) {
    for (const d of cat.demos) {
      if (!includeDevOnly && d.devOnly) continue
      out.push({
        id: `demo:${d.id}`,
        title: d.title,
        body: d.body,
        type: 'demo',
        tag: cat.title,
        url: `${base}/examples#${d.id}`,
      })
    }
  }

  return out
}

/** Returns a JSON-encoded string suitable for embedding in an
 *  Astro `<script type="application/json">` block. */
export function buildSearchIndexJSON(base: string): string {
  return JSON.stringify(buildSearchIndex(base))
}
