// Authoritative list of /examples gallery cards. Imported by
// examples.astro to render the page AND by lib/search-index.ts to
// build the build-time search index. One source of truth.
//
// CURATION RULE (2026-08): one card per CAPABILITY, MapLibre-style.
// The gallery is a teaching surface, not an inventory of everything the
// playground can run — a visitor should be able to scan it and find the
// one example that answers their question. So:
//   - a demo that only re-colours or re-scales an already-carded demo
//     (theme variants, 10m/50m detail variants, "the same thing with a
//     different palette") does NOT get a card;
//   - an internal regression / renderer-behaviour probe (bucket order,
//     antimeridian continuation, SDF point crispness) does NOT get a
//     card — it is a test, and it stays runnable in the playground;
//   - everything else that demonstrates a DISTINCT thing a user can
//     author gets exactly one card.
// Demos curated out are listed in `unlistedDemoIds` below; they keep
// working at /play/demo.html?id=… and in the e2e suite.

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
    body: 'The smallest maps that do something — start here and change one line.',
    demos: [
      {
        id: 'minimal',
        title: 'Minimal',
        body: 'Natural Earth countries with one fill + stroke layer.',
      },
      {
        id: 'inline-data',
        runId: 'inline_data',
        title: 'Inline GeoJSON',
        body: 'GeoJSON embedded directly in the source via `data: { … }` — no url fetch, no separate file.',
      },
      {
        id: 'dark',
        title: 'Dark theme',
        body: 'Same data, slate palette and translucent strokes.',
      },
      {
        id: 'physical-map',
        title: 'Physical map',
        body: 'Land + ocean + rivers + lakes + coastline composed from five sources — print-cartography layering.',
      },
    ],
  },
  {
    title: 'Vector tiles',
    body: 'Streaming vector tiles straight from a PMTiles archive — no tile server, each MVT source-layer styled independently.',
    demos: [
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
      // committed, fall back to the live-only card style.
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
    body: 'Bind feature properties — and the zoom level — to colors, sizes, and opacity.',
    demos: [
      {
        id: 'continent-match',
        title: 'match() per category',
        body: 'fill match(.CONTINENT) { ... } — one branch per category.',
      },
      {
        id: 'gdp-gradient',
        title: 'Continuous ramp',
        body: 'interpolate() over a numeric property — a choropleth from GDP.',
      },
      {
        id: 'filter-gdp',
        title: 'Filter a source',
        body: 'Multiple layers, each with a `filter:` predicate over the same source.',
      },
      {
        id: 'step-and-concat',
        title: 'step() + concat()',
        body: 'N-stop step() sizes city dots into population tiers; concat() composes multi-part labels.',
      },
      {
        id: 'zoom',
        title: 'Zoom-driven opacity',
        body: 'opacity-[interpolate(zoom, 2, 30, 5, 60, 8, 90)] — linearly blended.',
      },
    ],
  },
  {
    title: 'Lines & strokes',
    body: 'Dash arrays, caps and joins, offsets, casing — signed-distance-field strokes.',
    demos: [
      {
        id: 'line-styles',
        title: 'Caps, joins, dashes',
        body: 'The stroke-style gallery, side by side.',
      },
      {
        id: 'dashed-lines',
        title: 'Dash patterns',
        body: 'Multiple stroke-dasharray patterns side-by-side.',
      },
      { id: 'line-offset', title: 'Line offset', body: 'Parallel lines via stroke-offset.' },
      {
        id: 'stroke-align',
        title: 'Stroke align',
        body: 'inset / outset / center stroke alignment.',
      },
      { id: 'pattern-lines', title: 'Pattern lines', body: 'Shape glyphs repeated along a line.' },
      {
        id: 'multi-layer-line',
        title: 'Casing',
        body: 'Casing + body + centerline composed as three layers — the standard road-rendering technique.',
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
        body: 'symbol arrow { path "..." } — your own SVG path as a point glyph.',
      },
      {
        id: 'shape-gallery',
        title: 'Built-in shapes',
        body: 'Side-by-side comparison of every built-in symbol.',
      },
      {
        id: 'heatmap',
        title: 'Heatmap',
        body: 'World population as glowing density — a 3-pass GPU pipeline splats, blurs, and colour-ramps thousands of city points.',
      },
    ],
  },
  {
    title: 'Text labels',
    body: 'SDF text rendering — anchor strings to lon/lat from feature properties or imperatively from app code.',
    demos: [
      // A STANDALONE page (playground/examples/*.html) that doesn't load
      // through demo.html?id=…. It demos the SDF text pipeline
      // end-to-end and is the source of truth for the /docs/utilities
      // label-* family + the /docs/cookbook recipes.
      {
        id: 'labels',
        title: 'Auto labels (GeoJSON)',
        body: 'label-["{.name}"] resolves text from each feature\'s properties — Mapbox text-field equivalent.',
        standaloneUrl: 'examples/labels.html',
        noThumb: true,
      },
      // noThumb: the protomaps API rejects non-browser egress (403) in the
      // capture environment — flip after a local capture lands the JPG.
      {
        id: 'along-path-roads',
        title: 'Labels along a line',
        body: 'symbol-placement: line — road names rotate to follow their segment tangent instead of reading horizontally.',
        defaultHash: '14/35.68/139.76',
        noThumb: true,
      },
      {
        id: 'layer-below-labels',
        title: 'Layer below labels',
        body: 'A translucent lake overlay stacks above the land fill while city labels stay on top — no beforeId needed.',
      },
      {
        id: 'text-overlay',
        title: 'Imperative overlay',
        body: 'map.addOverlay({text, anchor, color, halo}) — text labels added from app code, re-projected every frame.',
        standaloneUrl: 'examples/text-overlay.html',
        noThumb: true,
      },
    ],
  },
  {
    title: 'Camera, interaction & animation',
    body: 'Drive the camera from code, react to the pointer, push new data while the map runs.',
    demos: [
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
        id: 'pitch-bearing',
        title: 'Pitch & bearing',
        body: 'Tilt to 60° and spin the map — the camera pose axes behind every 3D view.',
      },
      {
        id: 'mouse-position',
        title: 'Mouse position',
        body: 'Screen → lon/lat unprojection under the cursor, live on every pointer move.',
      },
      {
        id: 'picking-demo',
        title: 'Picking',
        body: 'Hover highlights the country under the cursor, click locks it — GPU pick buffer, no geometry queries.',
      },
      {
        id: 'color-switcher',
        title: 'Live restyling',
        body: 'Swap layer colours from buttons while the map runs — imperative restyling without a reload.',
      },
      {
        id: 'animate-point-route',
        title: 'Animate a point along a route',
        body: 'A Marker DOM overlay glides along an inlined SF→DC great-circle arc, one setLngLat() per frame — a screen-space reposition, no per-frame re-tile.',
      },
      // `noThumb: true`: the measure scene starts EMPTY (points/line appear
      // only after user clicks), so a build-time capture would show just the
      // dark basemap — text-only card until a scripted-click capture exists.
      {
        id: 'measure-distances',
        title: 'Measure distances',
        body: 'Click to drop measurement points — the connector line and haversine total update live through the host push API.',
        noThumb: true,
      },
      // `noThumb: true`: the scene rests EMPTY until Start is pressed —
      // same reasoning as measure-distances above.
      {
        id: 'realtime-update',
        title: 'Update a feature in realtime',
        body: 'A sensor point loops the globe every 3s via updateFeature() against an inline-declared source — Start/Stop drive it.',
        noThumb: true,
      },
      {
        id: 'animation-showcase',
        title: 'Declarative keyframes',
        body: 'fill color, stroke color, dash offset, all animating in parallel from top-level `keyframes` blocks.',
      },
    ],
  },
  {
    title: 'Raster, terrain & 3D',
    body: 'XYZ imagery, real elevation shaded on the GPU, and geometry extruded on the globe.',
    demos: [
      { id: 'raster', title: 'Raster tiles', body: 'OSM tiles via the {z}/{x}/{y} template.' },
      {
        id: 'raster-overlay',
        title: 'Vector over raster',
        body: 'Basemap + a translucent country fill on top.',
      },
      {
        id: 'satellite-map',
        runId: 'satellite_map',
        title: 'Satellite imagery',
        body: 'Esri World Imagery over Palm Jumeirah — a raster source with a {z}/{y}/{x} URL template.',
        noThumb: true,
      },
      {
        id: 'hillshade-terrarium',
        runId: 'hillshade_terrarium',
        title: 'Hillshade relief',
        body: 'Live AWS terrain tiles shaded in the fragment shader — a raster-dem source, Sobel normals, and warm authored light.',
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
    title: 'S-100 marine data',
    body: 'IHO S-100 gridded coverages read IN PLACE from HDF5 over HTTP range requests — real NOAA cells, no transcode.',
    demos: [
      // noThumb: streams a real NOAA cell over the network (no egress in the
      // capture env; needs the /opendata proxy, absent there too).
      {
        id: 's102-live',
        title: 'NOAA S-102 live bathymetry',
        body: 'A real Chesapeake Bay survey cell streamed from the NOAA Open-Data S3 bucket. The grid is UTM 18N metres, so the drape reprojects its mesh through the cell’s own CRS; sounding numerals print the exact depths straight off the grid.',
        noThumb: true,
      },
      {
        id: 's111-live',
        title: 'NOAA S-111 live currents',
        body: 'The real NOAA surface-current forecast — the official arrow portrayal plus drifting particles, with an hourly forecast scrubber, over satellite imagery.',
        noThumb: true,
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
    ],
  },
]

/** Playground demos deliberately kept OUT of the gallery — variants of a
 *  carded demo, or renderer-behaviour probes that read as tests rather
 *  than examples (see the curation rule at the top of this file). They
 *  still run at `/play/demo.html?id=<id>` and the e2e suite still drives
 *  them; they just don't earn a card.
 *
 *  The gallery drift gate (lib/gallery-drift-check.ts) requires every
 *  registered playground demo to appear EITHER as a card here or in this
 *  list, and rejects a stale entry that no longer resolves — so a new
 *  playground demo can never silently skip the gallery, and a curation
 *  decision can never silently rot. */
export const unlistedDemoIds: string[] = [
  // Palette / composition restyles of a carded demo.
  'ocean_land',
  'styled_world',
  'night_map',
  'water_hierarchy',
  'bold_borders',
  'dashed_borders',
  'layered_borders',
  'continent_outlines',
  'categorical',
  'vector_categorical',
  'income_match',
  'population_gradient',
  'gradient_points',
  'heatmap_ramp',
  'custom_shapes',
  'animation_pulse',
  'hillshade_multidir',
  'openfreemap_positron',
  // Detail-level variants of a carded composition.
  'physical_map_10m',
  'physical_map_50m',
  'coastline',
  'coastline_10m',
  'rivers_lakes',
  'rivers_10m',
  'states_provinces',
  'states_10m',
  'populated_places',
  'megacities',
  // Narrower slices of a carded demo.
  'pmtiles_only_landuse',
  'pmtiles_v4',
  'pmtiles_labels',
  'multiline_labels',
  'import_mapbox_style',
  'import_mapbox_inline_geojson',
  'satellite_ofm_overlay',
  'multi_layer',
  'zoom_lod',
  'zoom_building_color',
  'jump_to_locations',
  'camera_around_point',
  'animate_line',
  'procedural_circles',
  // Renderer-behaviour probes — regression scenes, not teaching examples.
  'vertical_labels',
  'bucket_order',
  'line_antimeridian',
  'long_chords',
  'translucent_lines',
  'sdf_points',
  // Synthetic S-100 fixtures — the live NOAA cards tell the same story
  // with real data.
  'coverage_bathymetry',
  's111_currents',
  'coops_currents',
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
