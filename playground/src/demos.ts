// ═══ Demo Definitions ═══
// Source files live in src/examples/*.xgis — single source of truth.
// Vite inlines them at build time via ?raw glob import.

const modules = import.meta.glob<string>('./examples/*.xgis', { eager: true, query: '?raw', import: 'default' })

// Production URL rewrites for .xgis sources.
//
// In dev (`bun run dev`) the .xgis sources reference
// `/pmtiles-proxy/protomaps/v4.pmtiles`. Vite proxies that path to
// demo-bucket.protomaps.com so the browser sees a same-origin
// response (the protomaps demo bucket rejects CORS preflight, so
// direct fetches from any other origin fail).
//
// In production (GH Pages, no proxy server) we substitute the dev
// proxy URL with the protomaps API TileJSON endpoint. The runtime's
// pmtiles-source loader detects `.json` URLs and switches to the
// XYZ MVT-tile-server fetcher path (added with this change), so the
// same demo .xgis sources work both ways without code changes.
//
// The API key below is restricted in the protomaps dashboard to
// CORS Origin = https://x-gis.github.io, so it can't be reused from
// any other domain even if the bundled JS is mirrored.
const PROD_PROTOMAPS_API_KEY = '360aa6108dc73d2e'

const PROD_URL_REWRITES: Array<[RegExp, string]> = import.meta.env.PROD
  ? [
      [
        /\/pmtiles-proxy\/protomaps\/v4\.pmtiles/g,
        `https://api.protomaps.com/tiles/v4.json?key=${PROD_PROTOMAPS_API_KEY}`,
      ],
    ]
  : []

function load(file: string): string {
  const key = `./examples/${file}`
  let src = modules[key]
  if (!src) throw new Error(`Missing example: ${key}`)
  for (const [pattern, replacement] of PROD_URL_REWRITES) {
    src = src.replace(pattern, replacement)
  }
  return src
}

export interface Demo {
  name: string
  tag: string
  description: string
  source: string  // loaded from .xgis file
  /** When true, demo-runner enables runtime picking and installs a
   *  hover/click overlay panel that shows the hit feature's name +
   *  coordinate. Used by interactive picking demos and any fixture
   *  that wants to expose live event feedback for manual testing. */
  picking?: boolean
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

  picking_demo: {
    name: 'Picking + Events',
    tag: 'event',
    description: 'Hover (desktop) or tap (mobile) a country to see its name, coordinate, and feature ID. Demonstrates layer.addEventListener.',
    source: load('picking-demo.xgis'),
    picking: true,
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

  pmtiles_source: {
    name: 'PMTiles (MVT)',
    tag: 'xgvt',
    description: 'MVT-in-PMTiles archive — drop sample.pmtiles into playground/public to render',
    source: load('pmtiles-source.xgis'),
  },

  pmtiles_labels: {
    name: 'PMTiles labels',
    tag: 'xgvt',
    description: 'SDF text labels from MVT places — `label-["{.name}"]` on a vector-tile source-layer',
    source: load('pmtiles-labels.xgis'),
  },

  multiline_labels: {
    name: 'Multiline labels',
    tag: 'basic',
    description: 'Long city names wrap at label-max-width with line-height + justify-center',
    source: load('multiline-labels.xgis'),
  },

  pmtiles_v4: {
    name: 'PMTiles — protomaps v4',
    tag: 'xgvt',
    description: 'Production protomaps daily world basemap (~6 GB, 176M tiles, z=0..15)',
    source: load('pmtiles-protomaps-v4.xgis'),
  },

  pmtiles_layered: {
    name: 'PMTiles — per-layer styling',
    tag: 'xgvt',
    description: 'Same v4 archive split into water/landuse/roads/buildings, each styled independently. Navigate to a city: #14/35.68/139.76 (Tokyo)',
    source: load('pmtiles-layered.xgis'),
  },

  openfreemap_bright: {
    name: 'OpenFreeMap — Bright (converted)',
    tag: 'xgvt',
    description: 'Live OpenFreeMap "bright" Mapbox style, run through the /convert pipeline. 93 layers, OpenMapTiles schema (water, landuse, building, transportation, …). Use this to stress-test pitched / panned views against a real-world style. Navigate to a city: #14/35.68/139.76 (Tokyo), #14/40.78/-73.97 (Manhattan).',
    source: load('openfreemap-bright.xgis'),
  },

  pmtiles_only_landuse: {
    name: 'PMTiles — landuse only (diag)',
    tag: 'xgvt',
    description: 'Diagnostic — single MVT layer (landuse) rendered alone in green. Used to isolate stripe artefacts.',
    source: load('pmtiles-only-landuse.xgis'),
  },

  osm_style: {
    name: 'OSM-style cartography',
    tag: 'xgvt',
    description: 'Richer cartographic rendering on protomaps v4: per-kind landuse + road hierarchy (minor/secondary/primary/highway/rail) + buildings. Navigate to a city: #14/35.68/139.76 (Tokyo), #14/40.78/-73.97 (Manhattan).',
    source: load('osm-style.xgis'),
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

  // ── Data-driven styling (match/gradient) ──

  continent_match: {
    name: 'Continent Match',
    tag: 'data-driven',
    description: 'Each continent a distinct color using match() — GPU if-else chain per feature',
    source: load('continent-match.xgis'),
  },

  gdp_gradient: {
    name: 'GDP Gradient',
    tag: 'data-driven',
    description: 'GDP heatmap using gradient() — linear interpolation from blue to red via mix()',
    source: load('gdp-gradient.xgis'),
  },

  income_match: {
    name: 'Income Groups',
    tag: 'data-driven',
    description: 'World Bank income classification using match() — 5 categories with fallback',
    source: load('income-match.xgis'),
  },

  population_gradient: {
    name: 'Population Gradient',
    tag: 'data-driven',
    description: 'Population density gradient — yellow (small) to purple (1.4B) via GPU mix()',
    source: load('population-gradient.xgis'),
  },

  gradient_points: {
    name: 'Gradient Points',
    tag: 'point',
    description: 'Population tiers — blue (small), amber (medium), rose (mega) with data-driven sizes',
    source: load('gradient-points.xgis'),
  },

  custom_shapes: {
    name: 'Custom Shapes',
    tag: 'point',
    description: 'Built-in SDF shapes (star, diamond, etc.) via GPU storage buffer — real-time distance field',
    source: load('custom-shapes.xgis'),
  },

  shape_gallery: {
    name: 'Shape Gallery',
    tag: 'point',
    description: 'Multiple shapes by population — star (mega), diamond (large), triangle (small)',
    source: load('shape-gallery.xgis'),
  },

  custom_symbol: {
    name: 'Custom Symbol',
    tag: 'point',
    description: 'User-defined arrow and flag symbols via SVG path in symbol{} blocks',
    source: load('custom-symbol.xgis'),
  },

  // ── Procedural geometry ──

  procedural_circles: {
    name: 'Population Circles',
    tag: 'point',
    description: 'Data-driven SDF circles — per-feature radius from sqrt(pop_max), evaluated on CPU',
    source: load('procedural-circles.xgis'),
  },

  sdf_points: {
    name: 'SDF Points',
    tag: 'point',
    description: 'Billboard markers (8px) + flat coverage (300km) — right-click drag to pitch and compare',
    source: load('sdf-points.xgis'),
  },

  // ── SDF Line Renderer (Phase 1–5) ──

  line_styles: {
    name: 'Line Styles',
    tag: 'line',
    description: 'Variable stroke width with round joins and caps — SDF line renderer',
    source: load('line-styles.xgis'),
  },

  dashed_lines: {
    name: 'Dashed Lines',
    tag: 'line',
    description: 'Simple dash array (20px on / 10px off) with cross-tile phase continuity',
    source: load('dashed-lines.xgis'),
  },

  pattern_lines: {
    name: 'Pattern Lines',
    tag: 'line',
    description: 'Imported symbol library — composite dash + railway-tie pattern + arrow cap',
    source: load('pattern-lines.xgis'),
  },

  multi_layer_line: {
    name: 'Multi-layer Line (regression)',
    tag: 'line',
    description: 'Two layers on one source — solid red + dashed blue. Regression guard for dynamic uniform offsets.',
    source: load('multi-layer-line.xgis'),
  },

  line_offset: {
    name: 'Line Offset',
    tag: 'line',
    description: 'Parallel offset rails — left-shifted red and right-shifted blue around a center coastline. Joins stay tight via offset-aware miter geometry.',
    source: load('line-offset.xgis'),
  },

  translucent_lines: {
    name: 'Translucent Lines',
    tag: 'line',
    description: 'Two transparent stroke layers stacked on coastline. Offscreen + MAX blend kills within-layer alpha accumulation so corners never darken.',
    source: load('translucent-lines.xgis'),
  },

  stroke_align: {
    name: 'Stroke Alignment',
    tag: 'line',
    description: 'GDI+-style center / inset / outset alignment. Three parallel coastlines shifted by half-width. Corners stay connected via offset-aware miter.',
    source: load('stroke-align.xgis'),
  },

  // ── 10m detail — finest Natural Earth tier ──

  physical_map_10m: {
    name: 'Physical Map 10m',
    tag: '10m',
    description: 'Finest-grain Natural Earth physical map: 10m ocean, land, rivers, lakes. Capillary river network, every major bay and lake — zoom in to see the difference against 50m.',
    source: load('physical-map-10m.xgis'),
  },

  states_10m: {
    name: 'States 10m',
    tag: '10m',
    description: '10m admin-1 boundaries with per-country categorical fill. Sharper state borders than 50m — useful for detailed views of US, Brazil, India, Australia.',
    source: load('states-10m.xgis'),
  },

  rivers_10m: {
    name: 'Rivers 10m',
    tag: '10m',
    description: 'Full 10m river network over dark land. Major basins resolve into hundreds of named tributaries at high zoom. Thick cyan strokes against deep green land.',
    source: load('rivers-10m.xgis'),
  },

  zoom_lod: {
    name: 'Zoom LOD',
    tag: 'zoom',
    description: 'Progressive level-of-detail: 110m coastline at low zoom, 50m land + major rivers at mid zoom, full 10m land + river network at high zoom. Opacity modifiers cross-fade between tiers.',
    source: load('zoom-lod.xgis'),
  },

  populated_places: {
    name: 'Populated Places',
    tag: 'point',
    description: 'World cities over 10m states background. Pin size scales with POP_MAX via gradient(). Uses the populated-places Point dataset (bulk tiler now produces point-only tiles correctly).',
    source: load('populated-places.xgis'),
  },

  night_map: {
    name: 'Night Map',
    tag: '10m',
    description: 'Dark indigo land with warm amber rivers and lakes. Two-layer glow + body stroke gives each river a soft halo. Demonstrates how color + opacity choices produce distinct visual identities from the same geometry.',
    source: load('night-map.xgis'),
  },

  // ── Thematic / composition demos ──

  continent_outlines: {
    name: 'Continent Outlines',
    tag: 'thematic',
    description: 'Each continent colored by match(.CONTINENT) with heavy matching outlines — distinct hue per landmass with a darker halo stroke.',
    source: load('continent-outlines.xgis'),
  },

  dashed_borders: {
    name: 'Dashed Borders',
    tag: 'thematic',
    description: 'Translucent sky-blue country fill with dashed white borders. Mixes polygon fill with stroke-dasharray-8-4 line styling.',
    source: load('dashed-borders.xgis'),
  },

  coastline_10m: {
    name: 'Coastline 10m',
    tag: '10m',
    description: 'World coastline at 10m resolution, rendered as two stacked line layers — dark shadow stroke + bright cyan body. No polygon fill. Stress test for dense SDF line vertices.',
    source: load('coastline-10m.xgis'),
  },

  water_hierarchy: {
    name: 'Water Hierarchy',
    tag: '10m',
    description: 'Three-tier blue gradient for ocean, lakes, and rivers. Glow halos on both lakes and rivers give soft water-body ambience against neutral land.',
    source: load('water-hierarchy.xgis'),
  },

  raster_overlay: {
    name: 'Raster + 10m Borders',
    tag: 'raster',
    description: 'OpenStreetMap basemap with translucent white 10m state boundaries overlaid. Demonstrates raster + vector composition and offscreen MAX-blend compositing over imagery.',
    source: load('raster-overlay.xgis'),
  },

  bold_borders: {
    name: 'Bold Borders',
    tag: 'thematic',
    description: 'High-contrast flat country fill with double-stroke outlines: thick black shadow behind, bright amber foreground. Presentation-ready styling.',
    source: load('bold-borders.xgis'),
  },

  megacities: {
    name: 'Megacities',
    tag: 'point',
    description: 'Populated places filtered by POP_MAX > 5M. Each city shown as a glowing 500 km halo + billboard pin whose size scales linearly up to 30M population.',
    source: load('megacities.xgis'),
  },

  layered_borders: {
    name: 'Layered Borders',
    tag: 'zoom',
    description: 'Three-tier admin borders: bold countries (always visible), 50m states (fade in at z3), 10m states (fade in at z6). Drillable hierarchy via zoom-opacity modifiers.',
    source: load('layered-borders.xgis'),
  },

  bucket_order: {
    name: 'Bucket Order (regression)',
    tag: 'line',
    description: 'Translucent yellow coast declared BEFORE opaque country fill. Bucket scheduler must render opaque first and composite the translucent stroke on top, regardless of declaration order.',
    source: load('bucket-order.xgis'),
  },

  animation_pulse: {
    name: 'Animation: pulse (PR 1)',
    tag: 'animation',
    description: 'Keyframes block + animation-pulse modifier. Amber coastline fades 100 → 30 → 100 every 1.5s with ease-in-out. First landing of the X-GIS animation system.',
    source: load('animation-pulse.xgis'),
  },

  animation_showcase: {
    name: 'Animation: showcase (PR 3)',
    tag: 'animation',
    description: 'Full property coverage — fill/stroke color morph, dash-offset marching, cross-property keyframes. Countries heat up, coastline marches, land outline cycles amber↔sky.',
    source: load('animation-showcase.xgis'),
  },

  // ── Test fixtures ─────────────────────────────────────────────
  // Minimum-data e2e fixtures. Each isolates a single feature so
  // failures pinpoint the exact code path. Documented in
  // playground/e2e/fixtures.spec.ts. Inspect manually via
  // ?id=fixture_point etc.

  fixture_point: {
    name: 'Fixture: point',
    tag: 'fixture',
    description: 'Single SDF point at (0, 0). Used by e2e fixture tests to validate the pointRenderer code path in isolation.',
    source: load('fixture-point.xgis'),
  },
  fixture_line: { name: 'Fixture: line (2pt)', tag: 'fixture', description: '2-vertex line, no join.', source: load('fixture-line.xgis') },
  fixture_line_join: { name: 'Fixture: line join', tag: 'fixture', description: '3-vertex sharp turn — miter join.', source: load('fixture-line-join.xgis') },
  fixture_triangle: { name: 'Fixture: triangle', tag: 'fixture', description: 'Closed 3-vertex polygon.', source: load('fixture-triangle.xgis') },
  fixture_square: { name: 'Fixture: square', tag: 'fixture', description: '4-vertex polygon (2-triangle tessellation).', source: load('fixture-square.xgis') },
  fixture_stroke_fill: { name: 'Fixture: stroke + fill', tag: 'fixture', description: 'Same layer fill + stroke.', source: load('fixture-stroke-fill.xgis') },
  fixture_dashed_line: { name: 'Fixture: dashed line', tag: 'fixture', description: 'Dash shader.', source: load('fixture-dashed-line.xgis') },
  fixture_translucent_stroke: { name: 'Fixture: translucent stroke', tag: 'fixture', description: 'Bucket 2 offscreen path.', source: load('fixture-translucent-stroke.xgis') },
  fixture_multi_layer: { name: 'Fixture: multi-layer', tag: 'fixture', description: 'Two overlapping polygons — draw order.', source: load('fixture-multi-layer.xgis') },
  fixture_anim_opacity: { name: 'Fixture: anim opacity', tag: 'fixture', description: 'Opacity keyframe (Bug 1 isolation).', source: load('fixture-anim-opacity.xgis') },
  fixture_anim_color: { name: 'Fixture: anim color', tag: 'fixture', description: 'Fill keyframe (Bug 1 cross-property).', source: load('fixture-anim-color.xgis') },
  fixture_sdf_point: { name: 'Fixture: SDF pin', tag: 'fixture', description: 'Billboard with anchor-bottom.', source: load('fixture-sdf-point.xgis') },
  fixture_sdf_glow: { name: 'Fixture: SDF glow', tag: 'fixture', description: 'Translucent halo + opaque pin.', source: load('fixture-sdf-glow.xgis') },
  fixture_categorical: { name: 'Fixture: categorical', tag: 'fixture', description: 'match() data-driven fill.', source: load('fixture-categorical.xgis') },
  fixture_picking: {
    name: 'Fixture: picking',
    tag: 'fixture',
    description: 'Three quadrants with distinct IDs — pickAt at known positions returns expected featureId. Picking + overlay enabled for manual inspection.',
    source: load('fixture-picking.xgis'),
    picking: true,
  },
  fixture_mercator_clip: { name: 'Fixture: mercator clip', tag: 'fixture', description: 'Polar polygon — Mercator clipping.', source: load('fixture-mercator-clip.xgis') },
  fixture_antimeridian: { name: 'Fixture: antimeridian', tag: 'fixture', description: 'Polygon crossing 180°.', source: load('fixture-antimeridian.xgis') },
  // Curated interaction fixtures
  fixture_x_translucent_anim: { name: 'Fixture×: translucent + anim', tag: 'fixture', description: 'Bucket 2 + opacity keyframe.', source: load('fixture-x-translucent-anim.xgis') },
  fixture_x_points_translucent: { name: 'Fixture×: points + translucent', tag: 'fixture', description: 'Bug 2 mirror — direct points + bucket 2.', source: load('fixture-x-points-translucent.xgis') },
  fixture_x_zoom_time_opacity: { name: 'Fixture×: zoom × time opacity', tag: 'fixture', description: 'Multiplicative composition.', source: load('fixture-x-zoom-time-opacity.xgis') },
  fixture_x_anim_multi_property: { name: 'Fixture×: anim multi-property', tag: 'fixture', description: 'Bug 1 mirror — opacity+fill+stroke+width keyframes.', source: load('fixture-x-anim-multi-property.xgis') },
  // Reftest pairs (each pair must render identically)
  reftest_triangle_static: { name: 'Reftest A: triangle static', tag: 'fixture', description: 'Triangle via static fill — reference.', source: load('reftest-triangle-static.xgis') },
  reftest_triangle_match: { name: 'Reftest B: triangle match()', tag: 'fixture', description: 'Triangle via match() with single arm — must equal static.', source: load('reftest-triangle-match.xgis') },
  reftest_zoom_static: { name: 'Reftest A: zoom static', tag: 'fixture', description: 'Square with static opacity — reference.', source: load('reftest-zoom-static.xgis') },
  reftest_zoom_degenerate: { name: 'Reftest B: zoom degenerate', tag: 'fixture', description: 'Square with degenerate zoom-opacity stops — must equal static.', source: load('reftest-zoom-degenerate.xgis') },
  reftest_stroke_static: { name: 'Reftest A: stroke static', tag: 'fixture', description: 'Line with static stroke — reference.', source: load('reftest-stroke-static.xgis') },
  reftest_stroke_keyframe_static: { name: 'Reftest B: stroke keyframe static', tag: 'fixture', description: 'Line with degenerate stroke keyframe — must equal static.', source: load('reftest-stroke-keyframe-static.xgis') },
  // Stress fixtures (exercise validation capture)
  fixture_stress_all_renderers: { name: 'Stress: all renderers', tag: 'fixture', description: 'Polygon fill + SDF line + SDF point in one frame.', source: load('fixture-stress-all-renderers.xgis') },
  fixture_stress_many_layers: { name: 'Stress: many layers', tag: 'fixture', description: '8 filtered layers from one source — uniform ring boundary.', source: load('fixture-stress-many-layers.xgis') },
  // Extension: caps/joins/patterns/align/offset/easing/data-driven/shape
  fixture_cap_round:            { name: 'Fixture: cap round',          tag: 'fixture', description: 'stroke-round-cap isolated.',                   source: load('fixture-cap-round.xgis') },
  fixture_cap_square:           { name: 'Fixture: cap square',         tag: 'fixture', description: 'stroke-square-cap isolated.',                  source: load('fixture-cap-square.xgis') },
  fixture_join_round:           { name: 'Fixture: join round',         tag: 'fixture', description: 'stroke-round-join on sharp turn.',             source: load('fixture-join-round.xgis') },
  fixture_join_bevel:           { name: 'Fixture: join bevel',         tag: 'fixture', description: 'stroke-bevel-join on sharp turn.',             source: load('fixture-join-bevel.xgis') },
  fixture_pattern_multi:        { name: 'Fixture: pattern multi-slot', tag: 'fixture', description: '2-slot pattern stack (dot + cross).',          source: load('fixture-pattern-multi.xgis') },
  fixture_stroke_inset:         { name: 'Fixture: stroke inset',       tag: 'fixture', description: 'stroke-inset on polygon boundary.',            source: load('fixture-stroke-inset.xgis') },
  fixture_stroke_offset_right:  { name: 'Fixture: stroke offset right',tag: 'fixture', description: 'Signed stroke-offset-right-8 rail.',           source: load('fixture-stroke-offset-right.xgis') },
  fixture_stroke_offset_right_large: { name: 'Fixture: stroke offset right (large)', tag: 'fixture', description: 'stroke-offset-right-80 — exercises offset-aware tile culling margin.', source: load('fixture-stroke-offset-right-large.xgis') },
  fixture_anim_ease_linear:     { name: 'Fixture: anim ease linear',   tag: 'fixture', description: 'Opacity keyframe with linear easing.',         source: load('fixture-anim-ease-linear.xgis') },
  fixture_dasharray_complex:    { name: 'Fixture: dasharray complex',  tag: 'fixture', description: '4-value composite dash array.',                source: load('fixture-dasharray-complex.xgis') },
  fixture_size_expr:            { name: 'Fixture: size expr',          tag: 'fixture', description: 'Point size-[sqrt(.pop) / 2] expression.',      source: load('fixture-size-expr.xgis') },
  fixture_filter_complex:       { name: 'Fixture: filter complex',     tag: 'fixture', description: 'Filter .kind == "b" — renders only middle.',  source: load('fixture-filter-complex.xgis') },
  fixture_shape_custom_svg:     { name: 'Fixture: custom SVG shape',   tag: 'fixture', description: 'Point with local symbol diamond.',             source: load('fixture-shape-custom-svg.xgis') },
  // Extension 2: projection/anchor/size-zoom/pattern/miterlimit/anim-dashoffset
  fixture_projection_equirectangular: { name: 'Fixture: projection equirect', tag: 'fixture', description: 'Equirectangular projection on a simple polygon.',  source: load('fixture-projection-equirectangular.xgis') },
  fixture_anchor_center:        { name: 'Fixture: anchor center',      tag: 'fixture', description: 'SDF point anchor-center mode.',                source: load('fixture-anchor-center.xgis') },
  fixture_anchor_top:           { name: 'Fixture: anchor top',         tag: 'fixture', description: 'SDF point anchor-top mode.',                   source: load('fixture-anchor-top.xgis') },
  fixture_flat_anchor_bottom:   { name: 'Fixture: flat + anchor bottom', tag: 'fixture', description: 'Flat point anchor-bottom — quad lies on ground, extends north.', source: load('fixture-flat-anchor-bottom.xgis') },
  fixture_size_zoom:            { name: 'Fixture: size zoom stops',    tag: 'fixture', description: 'z0:size-30 z20:size-80 interpolation.',        source: load('fixture-size-zoom.xgis') },
  fixture_stroke_outset:        { name: 'Fixture: stroke outset',      tag: 'fixture', description: 'stroke-outset alignment (mirror of inset).',   source: load('fixture-stroke-outset.xgis') },
  fixture_pattern_anchor_start: { name: 'Fixture: pattern anchor start',tag: 'fixture', description: 'Pattern pinned at line start.',               source: load('fixture-pattern-anchor-start.xgis') },
  fixture_pattern_anchor_end:   { name: 'Fixture: pattern anchor end', tag: 'fixture', description: 'Pattern pinned at line end.',                  source: load('fixture-pattern-anchor-end.xgis') },
  fixture_pattern_units_km:     { name: 'Fixture: pattern units km',   tag: 'fixture', description: 'km-unit spacing/size for stroke pattern.',     source: load('fixture-pattern-units-km.xgis') },
  fixture_anim_dashoffset:      { name: 'Fixture: anim dashoffset',    tag: 'fixture', description: 'Marching-ants animated dashoffset keyframe.',  source: load('fixture-anim-dashoffset.xgis') },
  fixture_miterlimit:           { name: 'Fixture: miterlimit',         tag: 'fixture', description: 'Sharp-angle miter→bevel fallback path.',       source: load('fixture-miterlimit.xgis') },
  // Extension 3: external data injection
  fixture_inline_push:          { name: 'Fixture: inline push',        tag: 'fixture', description: 'Inline source filled via setSourceData().',    source: load('fixture-inline-push.xgis') },
  fixture_typed_array_points:   { name: 'Fixture: typed-array points', tag: 'fixture', description: 'Inline source filled via setSourcePoints().',  source: load('fixture-typed-array-points.xgis') },

  // Extension 4: coverage gaps — cap/anchor/projection/zoom-opacity.
  fixture_cap_arrow:              { name: 'Fixture: cap arrow',            tag: 'fixture', description: 'stroke-arrow-cap directional taper.',                       source: load('fixture-cap-arrow.xgis') },
  fixture_anchor_bottom:          { name: 'Fixture: anchor bottom',        tag: 'fixture', description: 'SDF point anchor-bottom (pin hangs above the anchor).',     source: load('fixture-anchor-bottom.xgis') },
  fixture_projection_orthographic: { name: 'Fixture: projection orthographic', tag: 'fixture', description: 'Orthographic (globe) projection with back-face culling.', source: load('fixture-projection-orthographic.xgis') },
  fixture_projection_natural_earth: { name: 'Fixture: projection natural earth', tag: 'fixture', description: 'Natural Earth pseudocylindrical projection.',          source: load('fixture-projection-natural-earth.xgis') },
  fixture_zoom_opacity:           { name: 'Fixture: zoom opacity stops',   tag: 'fixture', description: 'z0:opacity-10 → z6:opacity-100 fade-in.',                    source: load('fixture-zoom-opacity.xgis') },
}
