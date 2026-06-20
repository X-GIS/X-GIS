// ═══ Mapbox Style Spec coverage table ═══
//
// Single source of truth for "what does the converter handle?". The
// site's /docs/mapbox-spec page renders this; the
// spec-coverage-drift.test.ts validates that every property the
// converter source actually references appears here (catches stale
// table after converter changes) and that every property declared
// here is actually referenced (catches dead table entries).
//
// Status values:
//   - 'supported'    — converter emits an xgis form AND runtime honours it
//   - 'partial'      — converter emits SOMETHING but loses information
//                      (e.g. exponential interpolate folded to linear),
//                      OR runtime gap behind the converter
//   - 'unsupported'  — converter drops with a warning OR silently
//   - 'na'           — Mapbox-specific concept with no xgis equivalent
//                      and no plan to add (e.g. `ref`, deprecated keys)
//
// Impact tier captures user-visible severity, NOT effort to fix:
//   - 'high'   — visible mismatch in common basemap styles (OFM Bright,
//                MapLibre demo) — colour / line width / labels
//   - 'medium' — visible in some styles or specific zoom ranges
//   - 'low'    — rarely-used; visual difference minor or invisible

export type CoverageStatus = 'supported' | 'partial' | 'unsupported' | 'na'
export type CoverageImpact = 'high' | 'medium' | 'low'

export interface CoverageEntry {
  /** Mapbox Style Spec property name (or expression op). */
  readonly name: string
  readonly status: CoverageStatus
  readonly impact?: CoverageImpact
  /** Short note shown next to the table row. */
  readonly note?: string
  /** Source file:line where the converter (or its absence) lives. */
  readonly source?: string
}

export interface CoverageSection {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly entries: readonly CoverageEntry[]
}

// ─── 1. Top-level style spec ──────────────────────────────────────────
const TOP_LEVEL: readonly CoverageEntry[] = [
  { name: 'version',  status: 'na',          note: 'Spec versioning; ignored.' },
  { name: 'name',     status: 'supported',   note: 'Emitted as a leading /* comment */ in the converted xgis.', source: 'mapbox-to-xgis.ts' },
  { name: 'metadata', status: 'unsupported', impact: 'low', note: 'Silent drop — informational only in Mapbox.' },
  { name: 'center',   status: 'supported', note: 'Applied by the demo-runner Mapbox importer after `runSource()` via `Camera.centerX/Y` + `markCameraPositioned()`. URL-hash camera still wins (hash parsing runs first). Compiler does NOT encode camera state into xgis source — top-level camera lives in the runtime, not the DSL.' },
  { name: 'zoom',     status: 'supported', note: 'Same path as `center` — runtime-side via demo-runner.' },
  { name: 'bearing',  status: 'supported', note: 'Same path as `center` — runtime-side via demo-runner.' },
  { name: 'pitch',    status: 'supported', note: 'Same path as `center` — runtime-side via demo-runner.' },
  { name: 'sources',  status: 'supported', source: 'sources.ts' },
  { name: 'layers',   status: 'supported', source: 'layers.ts' },
  { name: 'sprite',   status: 'supported', note: 'Importer extracts the URL from raw JSON and forwards to XGISMap.setSpriteUrl(). Runtime IconStage fetches `${url}.json` + `${url}.png` (DPR>=1.5 tries `@2x` first) and renders bitmap icons; SDF icons + icon-text-fit are Phase 2. Unknown icon names dropped silently at prepare-time; iter 526 added IconStage.getMissingIconNames() diagnostic for post-load misses.' },
  { name: 'glyphs',   status: 'supported', note: 'Importer extracts the URL from raw JSON and forwards to XGISMap.setGlyphsUrl(). Runtime TextStage fetches MapLibre SDF PBFs and upgrades visually when available; Canvas2D fallback stays on for offline / missing-glyph cases. Not encoded in xgis source.' },
  { name: 'transition', status: 'unsupported', impact: 'low', note: 'Per-property fade-in dropped.' },
  { name: 'light',    status: 'supported', impact: 'low', note: 'WS-9 — custom `light` (position / intensity / color) is now honoured. The extrude shader (vs_main_ecef_extruded) reads intensity from light_dir_ecef.w and colour from light_color_packed (RGBA8) instead of the old baked WGSL consts; the CPU packs the MapLibre default (position [1.15,210°,30°] → (0.288,-0.498,0.996), intensity 0.5, white) when no light is authored, so the default render is byte-identical. Host-applied like projection/camera: the demo-runner + compare-runner parse the top-level `light` block and call XGISMap.setLight(), which the render loop pushes into every VTR each frame. `anchor` is accepted but the directional frame stays the #420 camera-anchor ENU basis (the map/viewport bearing distinction is not yet modelled — invisible on the target corpus, which uses the default anchor). Light affects fill-extrusion only.' },
  { name: 'fog',      status: 'unsupported', impact: 'low', note: 'Mapbox v3 distance-fog gradient. Would need a post-process pass with depth-based mixing.' },
  { name: 'terrain',  status: 'unsupported', impact: 'medium', note: 'Roadmap Batch 4 (raster-dem + hillshade).' },
  { name: 'projection', status: 'supported', impact: 'low', note: 'WS-8 — all 8 X-GIS projections (mercator / equirectangular / natural_earth / orthographic / azimuthal_equidistant / stereographic / oblique_mercator / globe) render and the top-level style-spec `projection` field is now honoured. Same host-integration path as center/zoom: the playground demo-runner + compare-runner read the raw style JSON, map the Mapbox type name (e.g. globe → globe, naturalEarth → natural_earth via setProjection ALIASES) and call XGISMap.setProjection() after runSource(). URL `?proj=` still overrides. Mapbox-only types with no X-GIS equivalent (albers / equalEarth / lambertConformalConic / winkelTripel) warn at setProjection and keep the current projection. Not encoded in the xgis DSL (runtime-only, by design).' },
  { name: 'imports',  status: 'unsupported', note: 'Mapbox v3 style-import not parsed.' },
]

// ─── 2. Source types ──────────────────────────────────────────────────
const SOURCE_TYPES: readonly CoverageEntry[] = [
  { name: 'vector (.pmtiles)',  status: 'supported', note: 'Routed to PMTilesBackend.', source: 'sources.ts:38' },
  { name: 'vector (TileJSON)',  status: 'supported', note: 'Runtime fetches manifest then attaches PMTiles backend.', source: 'sources.ts:41' },
  { name: 'pmtiles',            status: 'supported', note: 'Community-extension type ("type":"pmtiles") accepted as a sibling of the .pmtiles-URL detection path.', source: 'sources.ts:94' },
  { name: 'tilejson (explicit)',status: 'supported', note: 'Third-party convention: `"type":"tilejson"` directly. Routed alongside the `vector` + URL-sniffing path.', source: 'sources.ts:105' },
  { name: 'raster',             status: 'supported', source: 'sources.ts:48' },
  { name: 'geojson (URL)',      status: 'supported', source: 'sources.ts:73' },
  { name: 'geojson (inline)',   status: 'supported', note: 'Captured via inlineGeoJSON collector → auto-pushed after run().', source: 'sources.ts:77' },
  { name: 'raster-dem',         status: 'partial',     impact: 'medium', note: 'Source registered, no hillshade renderer yet (Batch 4).', source: 'sources.ts:57' },
  { name: 'image',              status: 'unsupported', impact: 'low', note: 'Single-image source (e.g. user-supplied PNG draped onto a quad). Not in current loader; raster is the closest substitute.' },
  { name: 'video',              status: 'unsupported', impact: 'low', note: 'Streaming video source. Not in current loader.' },
]

// ─── 3. Layer types ───────────────────────────────────────────────────
const LAYER_TYPES: readonly CoverageEntry[] = [
  { name: 'background',         status: 'supported', note: 'Lifts to top-level `background { fill: # }` directive.', source: 'mapbox-to-xgis.ts:82' },
  { name: 'fill',               status: 'supported' },
  { name: 'line',               status: 'supported' },
  { name: 'symbol (text)',      status: 'supported', note: 'TextStage renders SDF glyphs from Canvas2D fonts.', source: 'layers.ts:154' },
  { name: 'symbol (icon-only)', status: 'unsupported', impact: 'high', note: 'No text-field → skipped. Awaits Batch 2 (sprite atlas).', source: 'layers.ts:159' },
  { name: 'fill-extrusion',     status: 'supported', note: 'Extruded polygon with per-vertex z.' },
  { name: 'raster',             status: 'supported' },
  { name: 'circle',             status: 'supported', note: 'Routes to the runtime PointRenderer (SDF disks). circle-radius/-color/-stroke-color/-stroke-width/-opacity all map onto the existing point utility surface, including interpolate-by-zoom + data-driven forms.', source: 'layers.ts:514' },
  { name: 'heatmap',            status: 'unsupported', impact: 'medium', note: 'Batch 3 (accumulation MRT + Gaussian blur).', source: 'layers.ts:18' },
  { name: 'hillshade',          status: 'unsupported', impact: 'medium', note: 'Batch 4 (raster-dem + lighting shader).', source: 'layers.ts:19' },
  { name: 'sky',                status: 'unsupported', impact: 'low', note: 'Atmospheric sky dome (sky-color / sky-atmosphere-* / sky-type). Layer-level skip added to SKIP_REASONS so the converter emits an explicit // SKIPPED comment with diagnostic note rather than falling through to the generic handler.', source: 'layers.ts:SKIP_REASONS' },
]

// ─── 3b. Layer common fields ──────────────────────────────────────────
const LAYER_COMMON: readonly CoverageEntry[] = [
  { name: 'id',           status: 'supported', note: 'Sanitised into a valid xgis identifier.', source: 'layers.ts:520' },
  { name: 'type',          status: 'supported', note: 'Discriminator — see Layer types table above.' },
  { name: 'source',        status: 'supported', source: 'layers.ts:521' },
  { name: 'source-layer',  status: 'supported', note: 'Lowered to `sourceLayer: "..."` block prop.', source: 'layers.ts:522' },
  { name: 'minzoom',       status: 'supported', note: 'PR #81: enforced at every label submission via `inZoomRange`.', source: 'layers.ts:523' },
  { name: 'maxzoom',       status: 'supported', source: 'layers.ts:524' },
  { name: 'filter',        status: 'supported', note: 'Legacy + expression form; routes through filter-eval.', source: 'layers.ts:525' },
  { name: 'metadata',      status: 'unsupported', impact: 'low', note: 'Informational — silently dropped.' },
  { name: 'ref',           status: 'na', note: 'Deprecated layer-ref shorthand (Mapbox style spec v7).' },
]

// ─── 4. Layout properties (per layer type) ───────────────────────────
const LAYOUT_FILL_LINE: readonly CoverageEntry[] = [
  { name: 'visibility',       status: 'supported', note: '`none` → `visible: false`.', source: 'layers.ts:538' },
  { name: 'line-cap',         status: 'supported', note: 'butt / round / square literals only.', source: 'layers.ts:548' },
  { name: 'line-join',        status: 'supported', note: 'miter / round / bevel literals only.', source: 'layers.ts:552' },
  { name: 'line-miter-limit', status: 'supported', note: 'Constant only.', source: 'layers.ts:556' },
  { name: 'line-round-limit', status: 'unsupported', impact: 'low', note: 'Limit beyond which round joins switch to bevel. X-GIS line-join logic uses a fixed threshold; per-layer override not threaded.' },
  { name: 'fill-sort-key',    status: 'unsupported', impact: 'low', note: 'Per-feature fill draw-order. X-GIS uses layer-order; per-feature would need an additional sort pass.' },
  { name: 'line-sort-key',    status: 'unsupported', impact: 'low', note: 'Per-feature line draw-order. Same gap as fill-sort-key.' },
  { name: 'circle-sort-key',  status: 'unsupported', impact: 'low', note: 'Per-feature draw-order key for circle layers; current renderer ignores it.' },
]

const LAYOUT_SYMBOL: readonly CoverageEntry[] = [
  { name: 'symbol-placement',     status: 'supported', note: 'point / line / line-center literals; `["step", ["zoom"], …]` form expands to multiple layers with intersected minzoom/maxzoom + segment-resolved placement (OFM Bright highway-shield-* coverage). Non-zoom step inputs fall back to default placement.', source: 'layers.ts:447' },
  { name: 'symbol-spacing',       status: 'supported', note: 'Defaults to 250 px when missing on line placement.', source: 'layers.ts:471' },
  { name: 'symbol-avoid-edges',   status: 'unsupported', impact: 'low', note: 'Skip labels whose bbox crosses tile boundaries. Useful for de-duping labels at tile seams; X-GIS today uses cross-tile collision instead.' },
  { name: 'symbol-sort-key',      status: 'partial', impact: 'medium', note: 'Constant numeric value plumbed end-to-end (iter 399-405). Runtime collision pass sorts CollisionItems by sortKey ascending — lower wins. Expression form (`["get", "rank"]`) flattens to 0 with a warning.', source: 'layers.ts:702' },
  { name: 'symbol-z-order',       status: 'unsupported', impact: 'low', note: 'Per-feature draw-order override. X-GIS uses symbol-sort-key for ordering today; symbol-z-order would need a separate sort pass after collision.' },
  { name: 'text-field',           status: 'supported', note: 'String / {token} / expression / number / boolean / null. Colon-bearing locale keys route via `get("name:xx")`.', source: 'layers.ts:164' },
  { name: 'text-font',            status: 'supported', note: 'Family extracted, weight + italic stripped into `label-font-weight-N` / `label-italic`.', source: 'layers.ts:417' },
  { name: 'text-size',            status: 'supported', note: 'Constant + interpolate-by-zoom + per-feature expression (sizeExpr).', source: 'layers.ts:231' },
  { name: 'text-max-width',       status: 'supported', note: 'Default 10 ems for non-line placement (Mapbox parity).', source: 'layers.ts:385' },
  { name: 'text-line-height',     status: 'supported' },
  { name: 'text-letter-spacing',  status: 'supported', note: 'Constant + interpolate-by-zoom.' },
  { name: 'text-justify',         status: 'supported', note: 'auto / left / center / right literals.' },
  { name: 'text-anchor',          status: 'supported', note: 'Full 9-way (center / top / bottom / left / right + 4 diagonals).', source: 'layers.ts:295' },
  { name: 'text-variable-anchor', status: 'supported', note: 'Real layout property (and legacy array-in-text-anchor) lower to anchorCandidates; runtime collision picks first non-overlapping.', source: 'layers.ts:370' },
  { name: 'text-variable-anchor-offset', status: 'supported', note: 'Per-anchor em offsets; runtime applies MapLibre baseline shift.', source: 'layers.ts:435' },
  { name: 'text-radial-offset',   status: 'supported', note: 'Constant em; runtime fromRadialOffset per candidate anchor (MapLibre-parity).', source: 'layers.ts:435' },
  { name: 'text-offset',          status: 'supported', note: 'Constant 2-tuple only.', source: 'layers.ts:329' },
  { name: 'text-rotate',          status: 'supported', note: 'Constant only.' },
  { name: 'text-padding',         status: 'supported', note: 'Constant + interpolate-by-zoom.', source: 'layers.ts:351' },
  { name: 'text-transform',       status: 'supported', note: 'uppercase / lowercase / none literals.' },
  { name: 'text-allow-overlap',   status: 'supported' },
  { name: 'text-ignore-placement',status: 'supported' },
  { name: 'text-overlap',         status: 'partial', impact: 'low', note: 'MapLibre overlap-policy enum (never / always / cooperative). always → label-allow-overlap; never → default; cooperative approximated as always (priority-aware collision pending) + warning. Wins over legacy text-allow-overlap when both declared.', source: 'layers.ts:418' },
  { name: 'text-optional',        status: 'unsupported', impact: 'low', note: 'Icons not implemented — moot.' },
  { name: 'text-rotation-alignment', status: 'supported', note: 'Literal map / viewport / auto. Honoured at runtime.', source: 'map.ts:2369' },
  { name: 'text-pitch-alignment', status: 'partial', impact: 'medium', note: 'Converter emits, runtime ignores — labels never project onto ground plane. Iter 10 surfaced an explicit warning when `map` is authored (the gap-revealing case) so authors of pitched-view styles see the diagnostic. `viewport` and `auto` match X-GIS\' billboard-rendering default and stay silent.', source: 'map.ts:2461' },
  { name: 'text-keep-upright',    status: 'supported', note: 'Per-glyph flip for line labels.', source: 'text-stage.ts:509' },
  { name: 'text-writing-mode',    status: 'unsupported', impact: 'medium', note: 'CJK vertical text would need a per-glyph rotation pipeline.' },
  { name: 'text-max-angle',       status: 'unsupported', impact: 'low', note: 'Maximum angle between consecutive glyphs on a line-placed label. X-GIS uses a fixed threshold; per-layer override would thread through label-placement.' },
  { name: 'icon-image',           status: 'supported', impact: 'high', note: 'Constant + data-driven match/case via label-icon-image-[<expr>] bracket binding. Per-feature evaluation in TextStage.applyFeatureExprs dispatches IconStage.addIcon. Iter 490 + 491 shipped 2026-05-18. Iter 535 verified end-to-end across the OFM Bright highway-shield path (road_N / us-interstate_N / us-state_N): the iter 531 null-comparison fix unblocks the shield-layer filter, the diagnostic quartet (iter 526/532/533/534) confirmed dispatch → vertex buffer → GPU draw all complete. The atlas ships shields as WHITE-on-transparent backgrounds (zero SDF sprites) so colored shield appearance comes from the text-field number overlay — not sprite tinting.', source: 'layers.ts:1007 + map.ts:applyFeatureExprs' },
  { name: 'icon-size',            status: 'supported', note: 'Constant + zoom-interp (iter 523). Bracket-binding `label-icon-size-[interpolate(zoom, …)]` lowers to LabelShapes.iconSize PropertyShape; runtime resolveNumberShape at dispatchIcon time. Data-driven (case/match/get) still drops with a warning — no per-feature path. OFM bright road_oneway / road_oneway_opposite (15→0.5, 19→1) honoured.', source: 'layers.ts:1075' },
  { name: 'icon-rotate',          status: 'supported', note: 'Constant degrees.', source: 'layers.ts:641' },
  { name: 'icon-anchor',          status: 'supported', note: 'Literal 9-way enum.', source: 'layers.ts:627' },
  { name: 'icon-offset',          status: 'supported', note: '[x, y] in CSS px; split into label-icon-offset-x / -y utilities.', source: 'layers.ts:631' },
  { name: 'icon-allow-overlap',   status: 'partial', impact: 'medium', note: 'No icon collision queue yet — every icon places (matches `true` semantics). OFM label_city/town/village/city_capital authoring `true` (4 layers per fixture) renders correctly. `false` would suppress overlapping icons; not implemented (would need icon-side collision bboxes). Iter 495 status review.' },
  { name: 'icon-overlap',         status: 'partial', impact: 'medium', note: 'MapLibre overlap-policy enum. `always` matches X-GIS default (every icon places). `never`/`cooperative` need icon collision bboxes (deferred). Iter 495 status review.' },
  { name: 'icon-ignore-placement',status: 'unsupported', impact: 'medium', note: 'Same icon-collision gap as icon-allow-overlap. "true" would let other labels overlap this icon\'s footprint.' },
  { name: 'icon-optional',        status: 'partial', impact: 'low', note: 'Default `false` (icon required for label placement) is X-GIS\' current contract — labels with iconImage place when both fit. OFM label_city/town/etc. all author the default. `true` (label may place icon-less) needs icon-side collision arbitration; not implemented.' },
  { name: 'icon-rotation-alignment', status: 'supported', impact: 'medium', note: 'All three values (map / viewport / auto) honored. "viewport"/"auto" map to X-GIS axis-aligned icons; "map" adds the per-segment tangent to icon-rotate at dispatch time under symbol-placement=line (OFM road_oneway one-way arrows). Compiler iter 506 emits label-icon-rotation-alignment-map; runtime adds tangent in dispatchIcon.', source: 'layers.ts:1056 + map.ts:dispatchIcon' },
  { name: 'icon-padding',         status: 'unsupported', impact: 'low', note: 'Per-icon collision-bbox padding. X-GIS uses a fixed 2px default per spec; per-layer override needs to thread through label-collision.' },
  { name: 'icon-text-fit',        status: 'unsupported', impact: 'medium', note: 'Shield/badge backgrounds depend on this.' },
  { name: 'icon-text-fit-padding',status: 'unsupported', impact: 'low', note: 'Padding when icon-text-fit fits glyph bbox; dependent on icon-text-fit.' },
  { name: 'icon-keep-upright',    status: 'unsupported', impact: 'low', note: 'Flip line-placed icons so they always face up. Currently icons follow the symbol-placement=line tangent without flipping.' },
  { name: 'icon-pitch-alignment', status: 'unsupported', impact: 'low', note: 'viewport (default) / map / auto. X-GIS uses viewport-aligned icons unconditionally; map mode would project the icon quad onto the ground plane.' },
]

// ─── 5. Paint properties ──────────────────────────────────────────────
const PAINT_BACKGROUND: readonly CoverageEntry[] = [
  { name: 'background-color',   status: 'supported', impact: 'low', note: 'Constant + CSS form fold to a hex; interpolate-by-zoom resolves per frame (WS-1) — flat via the background-pass clear, sphere via the synthetic earth-surface show paintShapes.fill.' },
  { name: 'background-opacity', status: 'supported', impact: 'low', note: 'Constant numeric form folds into background-color hex alpha (iter 47, mirror of circle-stroke-opacity iter 4). Interpolate-by-zoom emits an opacity: style property that resolves per frame (WS-1) and multiplies into the background clear alpha on the FLAT path. On sphere/globe the synthetic earth-surface show carries the colour shape but the separate per-zoom opacity is not applied there (the earth surface is opaque; sphere bg-opacity semantics are a documented follow-up).' },
  { name: 'background-pattern', status: 'unsupported', impact: 'low', note: 'Needs sprite atlas + tiled fragment. Batch 2 dependency.' },
]

const PAINT_FILL: readonly CoverageEntry[] = [
  { name: 'fill-color',         status: 'supported', note: 'Constant + interpolate-by-zoom + per-feature case/match expressions.', source: 'paint.ts:91' },
  { name: 'fill-opacity',       status: 'supported', source: 'paint.ts:133' },
  { name: 'fill-antialias',     status: 'partial', impact: 'low', note: 'Default `true` byte-identical (current render path). Geometric fill-edge AA in X-GIS comes from pipeline MSAA, not a per-fragment coverage smoothstep, so it is not per-layer disable-able. The `false` opt-out IS now wired: the converter emits a `fill-antialias-false` flag (paint.ts) → ShowCommand.fillAntialias → the polygon uniform\'s spare cam_ecef_off_h.w lane → the fs_fill fragment gates the only fill-alpha smoothstep it has (the sphere-rim hemisphere fade, polygon_rim_alpha) on the flag, giving a hard rim edge. On flat-Mercator the rim factor is already 1.0 so `false` is visually inert there; it bites on the curved-globe/azimuthal rim. OFM liberty `landcover_wood`/`grass`/`ice` set `false`.', source: 'paint.ts fill-antialias-false / polygon.ts buildFsFill rim gate' },
  { name: 'fill-outline-color', status: 'supported', note: 'Lowers to `stroke-<color> stroke-1` on the same fill layer — the xgis polygon renderer paints fill + outline in the same pass. Constant + interpolate-by-zoom.', source: 'paint.ts:153' },
  { name: 'fill-pattern',       status: 'supported', impact: 'high', note: 'Stage 2 (true UV-tiled bitmap) landed iter-181/182/183 2026-05-20. Sprite atlas bound at @group(0) @binding(5) on every polygon pipeline + dedicated `sprite_samp` at binding(6). `fs_fill_pattern` fragment shader samples the atlas at world-anchored UV computed from `abs_merc / pattern_repeat_m`; pattern repeat in Mercator metres derived per-frame from sprite design CSS-px width × WORLD_MERC / (256 * 2^cameraZoom) so the bitmap stays anchored to the ground. Pattern parameters pack into reused uniform slots (fill_color = UV bbox, fill_translate = repeat metres) so the 192-byte Uniforms struct is unchanged. VTR routes fillPattern shows to `fillPipelinePatternGround` (+ Fallback) variant; ground polygons on the baseBindGroupLayout path only — variant + featureBindGroupLayout pattern shows fall through to the Stage 1 sprite-centre-pixel colour. Constant string form supported end-to-end. Documented trade-offs: pattern shows cannot also use solid fill-color or fill-translate; extrude-pattern walls still flat (Stage 2 ground-only).', source: 'paint.ts iter-177/181/182/183' },
  { name: 'fill-translate',     status: 'supported', impact: 'low', note: 'WS-1 — constant vec2 AND per-frame zoom-interp. The converter splits the Mapbox vec2 interpolate into scalar x/y bracket bindings (fill-translate-x-[interpolate(zoom,…)]); lower builds fillTranslate{X,Y}Shape; resolveShow resolves each frame (resolveNumberShape) into ResolvedShow.fillTranslateX/Y; VTR bakes CSS-px → NDC (`clip.xy += u.fill_translate * clip.w` in vs_main). Replaces the old last-stop approximation (iter 508). OFM building-top pseudo-3D roof offset honoured.', source: 'paint.ts:addFillTranslate + resolved-show.ts + vector-tile-renderer.ts' },
  { name: 'fill-translate-anchor', status: 'unsupported', impact: 'low', note: 'viewport / map coordinate space for fill-translate; depends on fill-translate path.' },
]

const PAINT_LINE: readonly CoverageEntry[] = [
  { name: 'line-color',     status: 'supported', source: 'paint.ts:102' },
  { name: 'line-width',     status: 'supported', note: 'Constant + interpolate-by-zoom (linear AND exponential base) + per-feature width. PR #104 added per-frame zoom-stops; PR #108 conformance test pins differential parity with MapLibre createExpression() at z=4..20 (incl. fractional zooms).', source: 'paint.ts:113' },
  { name: 'line-opacity',   status: 'supported', source: 'paint.ts:133' },
  { name: 'line-dasharray', status: 'supported', impact: 'medium', note: 'WS-1 — constant numeric array AND per-frame zoom-interp. The converter emits a bracket binding (stroke-dasharray-[interpolate(zoom, z, [a,b], …)]); extractInterpolateZoomArrayStops lowers the array-valued stops to StrokeValue.dashArrayShape (PropertyShape<number[]>); resolveShow STEPs to the nearest zoom stop (resolveArrayShape — Mapbox line-dasharray is interpolated:false) into ResolvedShow.dashArray; VTR prefers it over the static array, scaling by mpp. data-driven (per-feature) dash still drops with a warning.', source: 'paint.ts:addStrokeDash + lower-helpers.ts:extractInterpolateZoomArrayStops + paint-shape-resolve.ts:resolveArrayShape' },
  { name: 'line-blur',      status: 'supported', note: 'Edge feathering in CSS px. The line shader uses `aa_width_px` to widen both the geometry quad and the smoothstep range so the edge soft-fades over `1.5 + blur` px each side. Constant only — interpolate-by-zoom warns and drops.', source: 'paint.ts:190' },
  { name: 'line-gap-width', status: 'supported', impact: 'medium', note: 'Constant + zoom-interp last-stop approx end-to-end via stroke-gap-N utility. Runtime double-draws each line at ±(gap+stroke)/2 via writeLayerSlot (iter 499). OFM road-casing layers honoured. Iter 498 + 499 + 513 shipped 2026-05-18.', source: 'paint.ts:addLineGapWidth' },
  { name: 'line-offset',    status: 'supported', note: 'Positive Mapbox values (right of travel) → `stroke-offset-right-N`; negative → `stroke-offset-left-N`. The xgis line renderer threads `strokeOffset` through to the vertex shader including offset-aware miter / join geometry. Constant only — interpolate-by-zoom warns and drops.', source: 'paint.ts:175' },
  { name: 'line-translate', status: 'supported', impact: 'low', note: 'WS-1 — constant vec2 AND per-frame zoom-interp (mirrors fill-translate). Converter emits scalar stroke-translate-{x,y} bracket bindings for the zoom-interp form; lower builds strokeTranslate{X,Y}Shape; resolveShow resolves each frame into ResolvedShow.strokeTranslateX/Y; VTR bakes CSS px → NDC into LineLayer uniform slots 48/49 (u.line_translate_x/y), applied in vs_line post-MVP. viewport anchor only — map-space translate (line-translate-anchor:map) deferred (WS-4a).', source: 'paint.ts:addLineTranslate + resolved-show.ts' },
  { name: 'line-translate-anchor', status: 'partial', impact: 'low', note: 'viewport (default) is honoured (matches X-GIS behaviour). map coordinate space for line-translate deferred (no OFM uses).' },
  { name: 'line-pattern',   status: 'supported', impact: 'low', note: 'Stage 2 landed iter-185 2026-05-20. line-renderer declares sprite_atlas at binding 5 + sprite_samp at binding 6 (shared TileBindGroupLayout with VTR so iter-181/182 atlas binding is already attached). New `fs_line_pattern` fragment + `pipelinePattern` alpha-blend pipeline. Pattern shows route via getDrawPipeline(translucent, patternActive=true). World-anchored UV (abs_merc / repeat_m) — Stage 2.1 along-line UV (arc length + transverse v) is a follow-up refinement. UV bbox packed into stroke_color uniform slot (20-23); repeat metres packed into layer.color.r / .a via writeLayerSlot override. Constant string form supported end-to-end. iter-165 probe: ZERO line-pattern uses in OFM bright/liberty target fixtures, so visual A/B unavailable against current set — Stage 2 is insurance for other styles (USA OSM / custom sprites).', source: 'line-renderer.ts iter-178/185' },
  { name: 'line-gradient',  status: 'unsupported', impact: 'low', note: 'Gradient along the line via ["line-progress"]. iter-166 probe: ZERO uses in OFM bright/liberty (also 0 lineMetrics declarations) — empirically confirms the low impact rating. Implementation cost (iter-158 scoping, the renderer change is NOT the hard part): (1) PREREQUISITE — geojson-vt currently IGNORES source.lineMetrics (geojsonvt/index.ts:14, sources.ts:406). line-progress is normalised over the ORIGINAL feature but geojson-vt clips lines per tile, so the clip stage must track each clipped segment\'s [progressStart,progressEnd] fraction of the original arc-length. This compiler-tiler change is the bulk of the work. (2) line-segment-build.ts interpolates per-vertex progress 0..1. (3) new per-vertex progress attribute + WGSL line fragment samples a gradient LUT the converter emits from the line-gradient interpolate stops. ~5 files; multi-day; not a surgical fix. PMTiles vector sources can\'t support it anyway (don\'t preserve original-line arc-length across tile boundaries) — feature is GeoJSON-source-with-lineMetrics-true only, niche.', source: 'paint.ts:218 specific warning' },
]

const PAINT_SYMBOL: readonly CoverageEntry[] = [
  { name: 'text-color',       status: 'supported', note: 'Constant + interpolate-by-zoom + per-feature colorExpr.', source: 'layers.ts:199' },
  { name: 'text-opacity',     status: 'supported', note: 'Constant folded into label-color alpha (applyAlphaMultiplier). Zoom-interp + data-driven emit `label-opacity-[…]` → LabelShapes.opacity PropertyShape; runtime resolveNumberShape multiplies into resolvedColor.a + resolvedHalo.color.a per frame. Iter 113.', source: 'layers.ts:480' },
  { name: 'text-halo-color',  status: 'supported', note: 'Constant + interpolate-by-zoom.', source: 'layers.ts:269' },
  { name: 'text-halo-width',  status: 'supported', note: 'Constant + interpolate-by-zoom; PR #76 fixed scaling into SDF units.', source: 'layers.ts:259' },
  { name: 'text-halo-blur',   status: 'supported', note: 'Constant only at conversion; IR exposes a PropertyShape so future zoom-interp / data-driven emit lands without IR changes.', source: 'layers.ts:283' },
  { name: 'text-translate',   status: 'supported', note: 'Pixel-space offset added on top of em-unit text-offset.', source: 'layers.ts:340' },
  { name: 'text-translate-anchor', status: 'unsupported', impact: 'low', note: 'viewport (default) vs map coordinate space for text-translate. X-GIS applies text-translate in viewport space only; the `map` mode would need MVP-aware offset.' },
  { name: 'icon-color',       status: 'supported', note: 'SDF sprite tint. iter 138 (Plan §4): IconRenderer carries a per-vertex tint + fwidth SDF fragment path; one batch mixes raster + SDF quads (per-vertex sdf flag, no pipeline split). Constant + zoom-interp + data-driven all route through LabelShapes.iconColor PropertyShape<RGBA> (same contract as text-color); runtime resolveColorShape at dispatchIcon → IconStage tint. Raster sprites ignore the tint per Mapbox spec.', source: 'layers.ts icon-color emit / icon-renderer.ts fs sdf branch' },
  { name: 'icon-opacity',     status: 'supported', note: 'Constant + zoom-interp + data-driven all route through LabelShapes.iconOpacity PropertyShape. Runtime resolveNumberShape at dispatchIcon → IconStage.addIcon per-vertex alpha. Iter 113.', source: 'layers.ts:1260' },
  { name: 'icon-halo-color',  status: 'unsupported', impact: 'low', note: 'SDF icon halo colour. iter-162 probe (playground/scripts/sprite-sdf-buffer-probe.ts) fetched the live OFM bright sprite: 264 entries, ZERO SDF. icon-halo applies ONLY to SDF sprites (Mapbox spec), so for the dominant OFM target styles this property is a NO-OP — implementing the composite produces zero visual change there. impact reclassified medium → low. iter-138 SDF icon foundation (fragment branch + per-vertex tint) STAYS and correctly serves any future style with SDF icons (USA OSM highway-shield-heavy styles, custom sprites). Composite shader work (second smoothstep at edge-haloWidth, mirror fs_text) is straightforward; the spritezero buffer constant remains UNRESOLVED (pin via the probe when a style with SDF icons becomes the target).' },
  { name: 'icon-halo-width',  status: 'unsupported', impact: 'low', note: 'SDF icon halo width. Same iter-162 disposition as icon-halo-color: OFM bright has 0 SDF icons → no-op on the target style. impact reclassified medium → low.' },
  { name: 'icon-halo-blur',   status: 'unsupported', impact: 'low', note: 'SDF icon halo feather. Same iter-162 disposition: OFM bright has 0 SDF icons → no-op on the target style.' },
  { name: 'icon-translate',   status: 'partial', impact: 'low', note: 'CSS-px viewport offset for icons (independent of text-translate). Constant [dx, dy] form wired end-to-end: converter emits `label-icon-translate-{x,y}-N` (layers-symbol.ts) → LabelDef.iconTranslateX/Y → dispatchIcon adds it (× dpr) to the icon anchor before IconStage.addIcon (label-pass.ts), alongside icon-offset. Default [0,0] = no-op. Non-constant (expression / interpolate) form still warns + drops.', source: 'layers-symbol.ts icon-translate emit / label-pass.ts dispatchIcon' },
  { name: 'icon-translate-anchor', status: 'partial', impact: 'low', note: 'Only `viewport` (the value matching X-GIS\' screen-space icon-translate) is honoured. `map` (world-space offset on bearing) warns + is not implemented.', source: 'layers-symbol.ts icon-translate-anchor' },
]

const PAINT_CIRCLE: readonly CoverageEntry[] = [
  { name: 'circle-radius',       status: 'supported', note: 'Constant + interpolate-by-zoom + per-feature expression. CSS px (Mapbox radius = xgis size).', source: 'layers.ts:537' },
  { name: 'circle-color',        status: 'supported', note: 'Constant + interpolate-by-zoom + per-feature case/match.' },
  { name: 'circle-opacity',      status: 'supported', note: 'Mapbox 0..1 → xgis 0..100 scaled. Constant + interpolate-by-zoom.' },
  { name: 'circle-stroke-color', status: 'supported' },
  { name: 'circle-stroke-width', status: 'supported', note: 'CSS px; constant + interpolate-by-zoom.' },
  { name: 'circle-blur',         status: 'partial', impact: 'low', note: 'Constant numeric form extends the point fragment smoothstep AA band via circle_params.z in the point uniform (layers-circle.ts). Zoom-interp / data-driven forms warn + drop — need a per-feature feat_data slot for per-feature blur.', source: 'layers-circle.ts:circle-blur block' },
  { name: 'circle-stroke-opacity', status: 'supported', impact: 'low', note: 'Constant numeric form folds into stroke-color hex alpha at compile time (iter 4). Zoom-interp form (WS-1, part 4) emits a stroke-opacity-[interpolate(zoom, …)] binding that lower.ts threads to ShowCommand.circleStrokeOpacityShape; PointRenderer.updateDynamicSizes resolves it per frame (resolveNumberShape) and multiplies the alpha into the circle\'s baked stroke alpha (feat_data slot 8). Non-interpolate data-driven forms still warn + drop.', source: 'layers-circle.ts:circle-stroke block' },
  { name: 'circle-translate',    status: 'supported', impact: 'low', note: 'Constant [dx, dy] vec2 AND per-frame zoom-interp now wired end-to-end through the point frame uniform (circle_params.xy — uf 32/33). The constant form emits circle-translate-x-N / circle-translate-y-M; the zoom-interp form splits the vec2 per-axis into circle-translate-{x,y}-[interpolate(zoom, …)] bindings (mirrors addFillTranslate). lower.ts threads both the constant ShowCommand.circleTranslateX/Y and the circleTranslate{X,Y}Shape; PointRenderer.updateDynamicSizes resolves the shapes each frame (resolveNumberShape) into the layer translate the uniform bakes to NDC-per-pixel. This also closed the prior gap where the GeoJSON point addLayer path (map.ts) never threaded circle-translate at all. circle-translate-anchor:map stays deferred (WS-4a).', source: 'layers-circle.ts:circle-translate block' },
  { name: 'circle-translate-anchor', status: 'partial', impact: 'low', note: "viewport (spec default) is the only honoured mode — X-GIS point renderer always applies the translate in viewport/NDC space. 'map'-anchor (world-space shift) is unsupported and warns + drops. The anchor no-op suppression (when circle-translate is absent) mirrors fill-translate-anchor behaviour.", source: 'layers-circle.ts:circle-translate-anchor block' },
  { name: 'circle-pitch-scale',  status: 'unsupported', impact: 'low', note: 'viewport (default — radius constant on screen) vs map (radius scales with zoom). X-GIS uses viewport-scale unconditionally.' },
  { name: 'circle-pitch-alignment', status: 'unsupported', impact: 'low', note: 'viewport (default) vs map. X-GIS uses viewport-aligned circles; map mode would project the disc onto the ground plane.' },
]

const PAINT_FILL_EXTRUSION: readonly CoverageEntry[] = [
  { name: 'fill-extrusion-color',   status: 'supported' },
  { name: 'fill-extrusion-opacity', status: 'supported' },
  { name: 'fill-extrusion-height',  status: 'supported', note: 'Constant + interpolate-by-zoom + per-feature expression.', source: 'paint.ts:154' },
  { name: 'fill-extrusion-base',    status: 'supported', source: 'paint.ts:165' },
  { name: 'fill-extrusion-translate', status: 'supported', impact: 'low', note: 'WS-1 — routed through addFillTranslate alongside fill-translate, so it inherits the per-frame zoom-interp path (fillTranslate{X,Y}Shape → resolveShow → VTR). The fill-extrusion vertex shaders (vs_main_quantized + vs_main_quantized_extruded) apply u.fill_translate_x/y. Constant vec2 AND per-frame zoom-interp supported. Replaces the old last-stop approximation (iter-180).', source: 'paint.ts:addFillTranslate + resolved-show.ts' },
  { name: 'fill-extrusion-translate-anchor', status: 'unsupported', impact: 'low', note: 'viewport / map space for fill-extrusion-translate; dependent on translate.' },
  { name: 'fill-extrusion-pattern',   status: 'supported', impact: 'low', note: 'Stage 2 landed iter-186 2026-05-20. New `fillPipelinePatternExtruded` + Fallback variants (vs_main_quantized_extruded vertex + extrudedZBufferLayout for per-feature z + fs_fill_pattern fragment). VTR routes extruded pattern shows via setPatternExtrudedPipelines + an extrudedPatternActive gate symmetric with the iter-183 ground path. Same world-anchored UV math as fill-pattern + line-pattern (abs_merc / repeat_m). Documented Stage 2 trade-off: pattern-extrude shows lose the per-fragment wall_shade lighting — sprite colour replaces the shaded fill rgb directly. Stage 2.1 (dedicated fs_fill_pattern_extruded that multiplies the sample by wall_shade) is a follow-up refinement. Constant string form supported end-to-end. iter-165 probe: ZERO uses in OFM bright/liberty target fixtures — Stage 2 is insurance for other styles.', source: 'paint.ts:270 iter-179/186' },
  { name: 'fill-extrusion-vertical-gradient', status: 'supported', impact: 'low', note: 'Default `true` is honoured end-to-end — the extrude vertex shader applies the 0.7→1.0 vertical-gradient wall ramp matching MapLibre. The `false` opt-out is now wired: converter emits `fill-extrusion-vertical-gradient-false` (paint.ts) → ShowCommand.fillExtrusionVerticalGradient → the polygon uniform\'s spare cam_ecef_off_l.w lane → vs_main_ecef_extruded ANDs the flag into the per-wall gradient test so walls shade flat. Default path is byte-identical (flag = 1).', source: 'paint.ts fill-extrusion-vertical-gradient-false / polygon.ts vs_main_ecef_extruded vgrad gate' },
  { name: 'fill-extrusion-ambient-occlusion-intensity', status: 'unsupported', impact: 'low', note: 'AO would need per-vertex normal + screen-space AO pass. Not in current renderer.' },
  { name: 'fill-extrusion-ambient-occlusion-radius',    status: 'unsupported', impact: 'low', note: 'See fill-extrusion-ambient-occlusion-intensity.' },
]

const PAINT_RASTER: readonly CoverageEntry[] = [
  { name: 'raster-opacity',         status: 'supported', note: 'Constant + interpolate-by-zoom + data-driven (all PropertyShape kinds) routed through the global RasterRenderer opacity uniform. Single raster show per scene is supported; multi-raster styles fall back to the first declared show.', source: 'paint.ts:38' },
  { name: 'raster-hue-rotate',      status: 'unsupported', impact: 'low', note: 'Rotate raster hue in HSL. Would need a fragment HSL-rotate pass.' },
  { name: 'raster-brightness-min',  status: 'unsupported', impact: 'low', note: 'Lower bound of raster brightness remap. Fragment-shader linear contrast adjust.' },
  { name: 'raster-brightness-max',  status: 'unsupported', impact: 'low', note: 'Upper bound of raster brightness remap.' },
  { name: 'raster-saturation',      status: 'unsupported', impact: 'low', note: 'HSL saturation multiplier on raster sample.' },
  { name: 'raster-contrast',        status: 'unsupported', impact: 'low', note: 'Fragment-shader contrast scale.' },
  { name: 'raster-fade-duration',   status: 'unsupported', impact: 'low', note: 'Crossfade between zoom levels. X-GIS swaps tiles atomically; no fade.' },
  { name: 'raster-resampling',      status: 'unsupported', impact: 'low', note: 'linear (default) vs nearest. Sampler is fixed to linear; per-show override would need a separate sampler binding. Iter 17 added spec-default suppression + iter 18 generic SPEC_DEFAULT_NO_WARN helper so authoring `linear` (matches X-GIS) is silent; `nearest` warns explicitly.' },
  { name: 'resampling',             status: 'unsupported', impact: 'low', note: 'MapLibre v3 alias for raster-resampling — same semantic.' },
]

const PAINT_HEATMAP: readonly CoverageEntry[] = [
  { name: 'heatmap-radius',    status: 'unsupported', impact: 'medium', note: 'Heatmap layer renderer not implemented — radius (px) defines per-feature Gaussian footprint.' },
  { name: 'heatmap-weight',    status: 'unsupported', impact: 'medium', note: 'Per-feature contribution multiplier; no renderer.' },
  { name: 'heatmap-intensity', status: 'unsupported', impact: 'medium', note: 'Overall density scale (per-zoom interpolated); no renderer.' },
  { name: 'heatmap-color',     status: 'unsupported', impact: 'medium', note: 'Density → colour ramp (interpolate over `heatmap-density`); no renderer.' },
  { name: 'heatmap-opacity',   status: 'unsupported', impact: 'medium', note: 'Layer-level opacity; no renderer.' },
]

const PAINT_HILLSHADE: readonly CoverageEntry[] = [
  { name: 'hillshade-illumination-direction', status: 'unsupported', impact: 'medium', note: 'Hillshade renderer not implemented (raster-dem source registered but unused). Direction in degrees from N clockwise.' },
  { name: 'hillshade-illumination-altitude',  status: 'unsupported', impact: 'medium', note: 'Light elevation angle (0–90°); no renderer.' },
  { name: 'hillshade-illumination-anchor',    status: 'unsupported', impact: 'low', note: 'map / viewport — whether the sun follows bearing; no renderer.' },
  { name: 'hillshade-exaggeration',           status: 'unsupported', impact: 'medium', note: 'Vertical-relief multiplier; no renderer.' },
  { name: 'hillshade-shadow-color',           status: 'unsupported', impact: 'medium', note: 'Shadow side colour; no hillshade renderer.' },
  { name: 'hillshade-highlight-color',        status: 'unsupported', impact: 'medium', note: 'Lit side colour; no hillshade renderer.' },
  { name: 'hillshade-accent-color',           status: 'unsupported', impact: 'low', note: 'Per-feature accent tint; no hillshade renderer.' },
  { name: 'hillshade-method',                 status: 'unsupported', impact: 'low', note: 'basic / combined / igor / multidirectional — different DEM gradient algorithms.' },
  { name: 'resampling',                       status: 'unsupported', impact: 'low', note: 'bilinear / nearest sampling of the DEM raster; depends on hillshade renderer.' },
]

// ─── 6. Expression operators ──────────────────────────────────────────
const EXPRESSIONS: readonly CoverageEntry[] = [
  // Lookups + control flow
  { name: 'literal',         status: 'supported', note: 'Scalar + array forms. Null-valued wrappers (`[\"literal\", null]`) treated as "property omitted" by the paint-helper gate (isOmitted in paint.ts).', source: 'expressions.ts:33' },
  { name: 'get',             status: 'supported', note: 'Bare field for identifier-safe names; `get("name:xx")` for colon-bearing locale keys.', source: 'expressions.ts:25' },
  { name: 'has',             status: 'supported', source: 'expressions.ts:43' },
  { name: '!has',            status: 'supported', source: 'expressions.ts:52' },
  { name: 'coalesce',        status: 'supported', note: 'Lowers to xgis `??` chain.', source: 'expressions.ts:59' },
  { name: 'case',            status: 'supported', source: 'expressions.ts:65' },
  { name: 'match',           status: 'supported', note: 'Routes through `match() { … }` when input is FieldAccess; ternary fallback otherwise.', source: 'expressions.ts:83' },
  { name: 'step',            status: 'supported', source: 'expressions.ts:185' },
  { name: 'let / var',       status: 'supported', note: 'Pure substitution at convert time.', source: 'expressions.ts:199' },
  // Logic + comparison
  { name: 'all',             status: 'supported' },
  { name: 'any',             status: 'supported' },
  { name: '!',               status: 'supported' },
  { name: '== / != / < / <= / > / >=', status: 'supported' },
  { name: 'in',              status: 'supported', note: 'Both expression form and legacy form. Empty value list lowers to constant `false` per spec.', source: 'expressions.ts:560' },
  { name: '!in',             status: 'supported' },
  // Arithmetic + math
  { name: '+ / - / * / / / %', status: 'supported' },
  { name: 'min / max',       status: 'supported' },
  { name: '^ / abs / ceil / floor / round / sqrt', status: 'supported' },
  { name: 'sin / cos / tan / asin / acos / atan',  status: 'supported' },
  { name: 'ln / log10 / log2', status: 'supported' },
  { name: 'pi / e / ln2',    status: 'supported', note: 'Zero-arg constants.' },
  // String + array
  { name: 'concat',          status: 'supported' },
  { name: 'length',          status: 'supported' },
  { name: 'upcase / downcase', status: 'supported' },
  { name: 'at',              status: 'supported', note: 'Array indexing.' },
  // Coercions
  { name: 'to-number / number',  status: 'supported', note: 'Converter passes through to a coalesce chain; xgis evaluator coerces in arithmetic context. Iter 539 added spec-compliant `to_number(v, fallback…)` builtin in the evaluator for hand-authored xgis source / tooling chains that bypass the converter.', source: 'evaluator.ts:to_number' },
  { name: 'to-string / to-boolean / to-color', status: 'supported', note: 'Converter passes through to coalesce chains; iter 539 added spec-compliant `to_string` / `to_boolean` builtins in the evaluator (null → "", number → str, etc.); iter 541 added `to_color` (hex regex validation, X-GIS hex-only — converter pre-resolves CSS names like "red" via tokens/colors.ts:resolveColor).', source: 'evaluator.ts:to_string + to_boolean + to_color' },
  // Colour
  { name: 'rgb / rgba',      status: 'partial', impact: 'low', note: 'Constant channels only — hex-encoded at convert time. Per-channel v8 literal-wrap (`[\"literal\", N]`) accepted.', source: 'expressions.ts:507' },
  { name: 'hsl / hsla',      status: 'partial', impact: 'low', note: 'Constant channels only — converted via CSS hsl()/hsla() and re-hexed at convert time. Per-channel v8 literal-wrap accepted.', source: 'colors.ts:69' },
  { name: 'interpolate (linear)',      status: 'supported' },
  { name: 'interpolate (exponential)', status: 'supported', note: 'Mapbox `["exponential", N]` lowers to `interpolate_exp(zoom, N, …)`; runtime applies the Mapbox curve formula. base=1 collapses to the linear fast path.', source: 'paint.ts:46' },
  { name: 'interpolate (cubic-bezier)',status: 'partial', impact: 'low', note: 'Numeric-valued zoom AND data-driven interpolates densify at compile time into a piecewise-linear approximation (6 samples per segment, CSS bezier-eased via Newton-Raphson). Runtime sees a longer linear stop list and visually approximates the bezier curve. Non-numeric values (colour stops) still warn and fold to pure linear. Iter 60-62 landings.', source: 'paint.ts:cssBezierEase + expressions.ts:interpolate handler' },
  { name: 'interpolate-hcl',           status: 'supported', note: 'LCh (polar Lab, hue shortest-path) colour interpolation: hex stops densify at compile time (iter 61-62 linear, iter 137 exponential — 6 samples / segment); non-hex (data-driven) stops now route to the runtime evaluator case interpolate_hcl (iter 164) which parses each stop\'s y at eval time, interpolates in LCh, and returns a hex. Full coverage modulo exponential×non-hex (rare combination — still warns and downgrades).', source: 'paint.ts + expressions.ts + eval/evaluator.ts interpolate_hcl' },
  { name: 'interpolate-lab',           status: 'supported', note: 'Lab (D50) colour interpolation: hex stops densify at compile time (iter 61-62 linear, iter 137 exponential — 6 samples / segment); non-hex (data-driven) stops now route to the runtime evaluator case interpolate_lab (iter 164) which parses each stop\'s y at eval time, interpolates in Lab, and returns a hex. Full coverage modulo exponential×non-hex (rare combination — still warns and downgrades).', source: 'paint.ts + expressions.ts + eval/evaluator.ts interpolate_lab' },
  // Feature meta
  { name: 'geometry-type',   status: 'supported', note: 'Routes via synthetic `$geometryType` prop injected at filter-eval time.', source: 'expressions.ts:263' },
  { name: 'id',              status: 'supported', note: 'Routes via synthetic `$featureId` prop injected from `feature.id` (GeoJSON RFC 7946 §3.2; MVT feature.id) at every filter-eval site. Same pattern as `geometry-type`.', source: 'expressions.ts:278' },
  { name: 'properties',      status: 'unsupported', impact: 'low', note: 'Returns whole feature properties object — X-GIS expressions access by field name (`.field` / `["get","field"]`); no object literal accessor.' },
  { name: 'feature-state',   status: 'na', note: 'Mapbox v8 dynamic property setter — no xgis equivalent.' },
  // Formatting / advanced
  { name: 'typeof',          status: 'supported', note: 'Returns Mapbox-shaped strings ("string" / "number" / "boolean" / "object" / "null").', source: 'expressions.ts:237' },
  { name: 'format',          status: 'partial', impact: 'low', note: 'Span texts concatenated via xgis concat(); per-span opts (font-scale / text-color / text-font / vertical-align) dropped — X-GIS labels render with one style per layer. Iter 25 added per-section partial-drop semantics: when one section fails to convert (e.g. uses an unsupported accessor), surviving sections still concat — only ALL-sections-fail returns null. Pre-fix any single failure bailed the whole format expression and dropped the label silently.', source: 'expressions.ts:208' },
  { name: 'image',           status: 'unsupported', impact: 'high', note: 'Sprite atlas (Batch 2).' },
  { name: 'number-format',   status: 'supported', note: 'Lowers to positional `number_format(input, minFrac, maxFrac, locale, currency)` (xgis has no object-literal syntax). Routes through Intl.NumberFormat at runtime; null slots use spec defaults.', source: 'expressions.ts:275' },
  { name: 'collator',        status: 'unsupported', impact: 'low', note: 'Locale-aware comparator for ==/!=/in. X-GIS uses byte-exact string compare. Surface as warning when authored.' },
  { name: 'resolved-locale', status: 'unsupported', impact: 'low', note: 'Returns locale string from a collator. Depends on collator support.' },
  { name: 'is-supported-script', status: 'unsupported', impact: 'low', note: 'Returns true if all chars in a string are renderable. X-GIS assumes Unicode-renderable. No-op gate.' },
  { name: 'array',           status: 'partial', impact: 'low', note: 'Type-assertion drops to value pass-through (X-GIS arrays carry no per-element type tag, so the spec\'s "abort if not array" semantic is lost; in paint/filter use a non-array would null-cascade anyway).', source: 'expressions.ts:163' },
  { name: 'slice',           status: 'supported', note: 'String or array; Mapbox `["slice", input, start[, end]]`. Routes to JS String/Array `.slice` semantics.', source: 'expressions.ts:248' },
  { name: 'index-of',        status: 'supported', note: 'Lowers to xgis `index_of(needle, haystack[, from])`. Returns -1 when not found.', source: 'expressions.ts:257' },
  // Camera / spatial
  { name: 'zoom',            status: 'supported', note: 'Lowers to bare `zoom` identifier. Works in `interpolate(zoom, …)` / `step(zoom, …)` AND anywhere else (filter compare, case condition, arithmetic).', source: 'expressions.ts:471' },
  { name: 'pitch',           status: 'supported', impact: 'low', note: 'Mapbox `["pitch"]` lowers to a bare `pitch` identifier (mirror of the `zoom` path). The evaluator resolves it via the reserved `$pitch` key (CAMERA_PITCH_KEY), injected by the render-path eval sites (map.ts applyFilter + per-feature paint/size eval, feature-helpers applyFilter/applyGeometry) from `camera.pitch` (degrees). Decode-time/worker sites have no camera so `["pitch"]` resolves to null there — same proxy contract `["zoom"]` has with tileZoom.', source: 'expressions.ts case pitch / eval/evaluator.ts + reserved-keys.ts' },
  { name: 'distance-from-center', status: 'unsupported', impact: 'low', note: 'Returns screen-space distance from viewport centre for the current feature. Would need per-feature distance evaluation in worker.' },
  { name: 'distance',        status: 'unsupported', impact: 'low', note: 'Geometry-to-geometry geodesic distance. Surface as warning when authored; would need spatial index for performance.' },
  { name: 'within',          status: 'unsupported', impact: 'low', note: 'Point-in-polygon test for filter context. Surface as warning when authored.' },
  { name: 'accumulated',     status: 'na', note: 'Heatmap-only.' },
  { name: 'heatmap-density', status: 'na', note: 'Heatmap-only.' },
  { name: 'line-progress',   status: 'na', note: 'line-gradient only.' },
  { name: 'sky-radial-progress', status: 'na' },
]

// ─── 7. Filter operators (legacy + expression form) ──────────────────
const FILTERS: readonly CoverageEntry[] = [
  { name: '== / != / < / <= / > / >= (legacy form)', status: 'supported', note: 'Field-as-second-arg shape recognised.', source: 'expressions.ts:420' },
  { name: 'in / !in (legacy + expression form)',     status: 'supported' },
  { name: 'has / !has',                              status: 'supported' },
  { name: 'all / any / !',                           status: 'supported' },
  { name: 'match (boolean form)',                    status: 'supported', note: 'Lowers to OR/AND chain when all values are boolean literals.', source: 'expressions.ts:335' },
  { name: '$type',                                   status: 'supported', note: 'Legacy filter — routes to geometry-type accessor (get("$geometryType")).', source: 'expressions.ts' },
  { name: '$id',                                     status: 'supported', note: 'Legacy filter — routes to id accessor (get("$featureId")).', source: 'expressions.ts' },
]

// ─── Assembled tree ───────────────────────────────────────────────────
export const MAPBOX_COVERAGE: readonly CoverageSection[] = [
  {
    id: 'top-level',
    title: 'Top-level style properties',
    description: 'Fields on the root Mapbox style object.',
    entries: TOP_LEVEL,
  },
  {
    id: 'sources',
    title: 'Source types',
    description: '`sources[id].type` values.',
    entries: SOURCE_TYPES,
  },
  {
    id: 'layers',
    title: 'Layer types',
    description: '`layer.type` values.',
    entries: LAYER_TYPES,
  },
  {
    id: 'layer-common',
    title: 'Layer common fields',
    description: 'Shared across all `layer` shapes regardless of type.',
    entries: LAYER_COMMON,
  },
  {
    id: 'layout-fill-line',
    title: 'Layout — fill / line',
    entries: LAYOUT_FILL_LINE,
  },
  {
    id: 'layout-symbol',
    title: 'Layout — symbol',
    entries: LAYOUT_SYMBOL,
  },
  {
    id: 'paint-background',
    title: 'Paint — background',
    entries: PAINT_BACKGROUND,
  },
  {
    id: 'paint-fill',
    title: 'Paint — fill',
    entries: PAINT_FILL,
  },
  {
    id: 'paint-line',
    title: 'Paint — line',
    entries: PAINT_LINE,
  },
  {
    id: 'paint-symbol',
    title: 'Paint — symbol',
    entries: PAINT_SYMBOL,
  },
  {
    id: 'paint-circle',
    title: 'Paint — circle',
    entries: PAINT_CIRCLE,
  },
  {
    id: 'paint-fill-extrusion',
    title: 'Paint — fill-extrusion',
    entries: PAINT_FILL_EXTRUSION,
  },
  {
    id: 'paint-raster',
    title: 'Paint — raster',
    entries: PAINT_RASTER,
  },
  {
    id: 'paint-heatmap',
    title: 'Paint — heatmap',
    description: 'Heatmap layer renderer is not implemented; every property here is unsupported pending a roadmap entry.',
    entries: PAINT_HEATMAP,
  },
  {
    id: 'paint-hillshade',
    title: 'Paint — hillshade',
    description: 'Hillshade layer renderer is not implemented; raster-dem source is recognised but produces no output.',
    entries: PAINT_HILLSHADE,
  },
  {
    id: 'expressions',
    title: 'Expression operators',
    description: 'Mapbox Style Spec v1 expression form (the bracketed `["op", …]` syntax).',
    entries: EXPRESSIONS,
  },
  {
    id: 'filters',
    title: 'Filters',
    description: 'Legacy + expression form. Most filter operators reuse the expression infrastructure.',
    entries: FILTERS,
  },
]

/** Flat enumeration of every entry across sections, for tooling / tests. */
export function flattenCoverage(): readonly CoverageEntry[] {
  return MAPBOX_COVERAGE.flatMap(s => s.entries)
}
