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
  { name: 'sprite',   status: 'supported', note: 'Importer extracts the URL from raw JSON and forwards to XGISMap.setSpriteUrl(). Runtime IconStage fetches the JSON + PNG and renders bitmap icons; SDF icons + icon-text-fit are Phase 2.' },
  { name: 'glyphs',   status: 'supported', note: 'Importer extracts the URL from raw JSON and forwards to XGISMap.setGlyphsUrl(). Runtime TextStage fetches MapLibre SDF PBFs and upgrades visually when available; Canvas2D fallback stays on for offline / missing-glyph cases. Not encoded in xgis source.' },
  { name: 'transition', status: 'unsupported', impact: 'low', note: 'Per-property fade-in dropped.' },
  { name: 'light',    status: 'unsupported', impact: 'low', note: 'No fill-extrusion ambient lighting model.' },
  { name: 'fog',      status: 'unsupported', impact: 'low' },
  { name: 'terrain',  status: 'unsupported', impact: 'medium', note: 'Roadmap Batch 4 (raster-dem + hillshade).' },
  { name: 'projection', status: 'partial', impact: 'low', note: 'mercator only; URL `?proj=` provides limited overrides at runtime.' },
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
  { name: 'image',              status: 'unsupported', impact: 'low' },
  { name: 'video',              status: 'unsupported', impact: 'low' },
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
  { name: 'sky',                status: 'unsupported', impact: 'low' },
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
  { name: 'line-round-limit', status: 'unsupported', impact: 'low' },
  { name: 'fill-sort-key',    status: 'unsupported', impact: 'low' },
  { name: 'line-sort-key',    status: 'unsupported', impact: 'low' },
  { name: 'circle-sort-key',  status: 'unsupported', impact: 'low', note: 'Per-feature draw-order key for circle layers; current renderer ignores it.' },
]

const LAYOUT_SYMBOL: readonly CoverageEntry[] = [
  { name: 'symbol-placement',     status: 'supported', note: 'point / line / line-center literals; `["step", ["zoom"], …]` form expands to multiple layers with intersected minzoom/maxzoom + segment-resolved placement (OFM Bright highway-shield-* coverage). Non-zoom step inputs fall back to default placement.', source: 'layers.ts:447' },
  { name: 'symbol-spacing',       status: 'supported', note: 'Defaults to 250 px when missing on line placement.', source: 'layers.ts:471' },
  { name: 'symbol-avoid-edges',   status: 'unsupported', impact: 'low' },
  { name: 'symbol-sort-key',      status: 'unsupported', impact: 'medium', note: 'Layer draw order is style order; per-feature override not honoured.' },
  { name: 'symbol-z-order',       status: 'unsupported', impact: 'low' },
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
  { name: 'text-pitch-alignment', status: 'partial', impact: 'medium', note: 'Converter emits, runtime ignores — labels never project onto ground plane.', source: 'map.ts:2461' },
  { name: 'text-keep-upright',    status: 'supported', note: 'Per-glyph flip for line labels.', source: 'text-stage.ts:509' },
  { name: 'text-writing-mode',    status: 'unsupported', impact: 'medium', note: 'CJK vertical text would need a per-glyph rotation pipeline.' },
  { name: 'text-max-angle',       status: 'unsupported', impact: 'low' },
  { name: 'icon-image',           status: 'partial', impact: 'high', note: 'Constant string only. Data-driven / expression form not yet supported (warns + drops). Phase B shipped in 8a85df0 / d97fac0.', source: 'layers.ts:614' },
  { name: 'icon-size',            status: 'supported', note: 'Constant only.', source: 'layers.ts:623' },
  { name: 'icon-rotate',          status: 'supported', note: 'Constant degrees.', source: 'layers.ts:641' },
  { name: 'icon-anchor',          status: 'supported', note: 'Literal 9-way enum.', source: 'layers.ts:627' },
  { name: 'icon-offset',          status: 'supported', note: '[x, y] in CSS px; split into label-icon-offset-x / -y utilities.', source: 'layers.ts:631' },
  { name: 'icon-allow-overlap',   status: 'unsupported', impact: 'medium', note: 'Icon collision queue not implemented — text and icon collisions are independent in spec but our greedy bbox pass only sees labels.' },
  { name: 'icon-overlap',         status: 'unsupported', impact: 'medium', note: 'MapLibre overlap-policy enum (never/always/cooperative); supersedes icon-allow-overlap. Same icon-collision gap.' },
  { name: 'icon-ignore-placement',status: 'unsupported', impact: 'medium', note: 'Same icon-collision gap as icon-allow-overlap.' },
  { name: 'icon-optional',        status: 'unsupported', impact: 'low' },
  { name: 'icon-rotation-alignment', status: 'unsupported', impact: 'medium' },
  { name: 'icon-padding',         status: 'unsupported', impact: 'low' },
  { name: 'icon-text-fit',        status: 'unsupported', impact: 'medium', note: 'Shield/badge backgrounds depend on this.' },
  { name: 'icon-text-fit-padding',status: 'unsupported', impact: 'low', note: 'Padding when icon-text-fit fits glyph bbox; dependent on icon-text-fit.' },
  { name: 'icon-keep-upright',    status: 'unsupported', impact: 'low' },
  { name: 'icon-pitch-alignment', status: 'unsupported', impact: 'low' },
]

// ─── 5. Paint properties ──────────────────────────────────────────────
const PAINT_BACKGROUND: readonly CoverageEntry[] = [
  { name: 'background-color',   status: 'partial', impact: 'low', note: 'Constant + CSS form only — interpolate-by-zoom of background falls through (rare).' },
  { name: 'background-opacity', status: 'unsupported', impact: 'low' },
  { name: 'background-pattern', status: 'unsupported', impact: 'low' },
]

const PAINT_FILL: readonly CoverageEntry[] = [
  { name: 'fill-color',         status: 'supported', note: 'Constant + interpolate-by-zoom + per-feature case/match expressions.', source: 'paint.ts:91' },
  { name: 'fill-opacity',       status: 'supported', source: 'paint.ts:133' },
  { name: 'fill-antialias',     status: 'unsupported', impact: 'low', note: 'Always anti-aliased; opt-out for pixel-art look not implemented.' },
  { name: 'fill-outline-color', status: 'supported', note: 'Lowers to `stroke-<color> stroke-1` on the same fill layer — the xgis polygon renderer paints fill + outline in the same pass. Constant + interpolate-by-zoom.', source: 'paint.ts:153' },
  { name: 'fill-pattern',       status: 'unsupported', impact: 'high', note: 'Batch 2 (bitmap atlas).' },
  { name: 'fill-translate',     status: 'unsupported', impact: 'low', note: 'OFM building-top pseudo-3D roof offset dropped.' },
  { name: 'fill-translate-anchor', status: 'unsupported', impact: 'low' },
]

const PAINT_LINE: readonly CoverageEntry[] = [
  { name: 'line-color',     status: 'supported', source: 'paint.ts:102' },
  { name: 'line-width',     status: 'supported', note: 'Constant + interpolate-by-zoom (linear AND exponential base) + per-feature width. PR #104 added per-frame zoom-stops; PR #108 conformance test pins differential parity with MapLibre createExpression() at z=4..20 (incl. fractional zooms).', source: 'paint.ts:113' },
  { name: 'line-opacity',   status: 'supported', source: 'paint.ts:133' },
  { name: 'line-dasharray', status: 'partial', impact: 'medium', note: 'Constant numeric array only — interpolate-by-zoom dasharray not lowered.', source: 'paint.ts:126' },
  { name: 'line-blur',      status: 'supported', note: 'Edge feathering in CSS px. The line shader uses `aa_width_px` to widen both the geometry quad and the smoothstep range so the edge soft-fades over `1.5 + blur` px each side. Constant only — interpolate-by-zoom warns and drops.', source: 'paint.ts:190' },
  { name: 'line-gap-width', status: 'unsupported', impact: 'medium', note: 'Used for road casings.' },
  { name: 'line-offset',    status: 'supported', note: 'Positive Mapbox values (right of travel) → `stroke-offset-right-N`; negative → `stroke-offset-left-N`. The xgis line renderer threads `strokeOffset` through to the vertex shader including offset-aware miter / join geometry. Constant only — interpolate-by-zoom warns and drops.', source: 'paint.ts:175' },
  { name: 'line-translate', status: 'unsupported', impact: 'low' },
  { name: 'line-translate-anchor', status: 'unsupported', impact: 'low', note: 'viewport / map coordinate space for line-translate; dependent on line-translate.' },
  { name: 'line-pattern',   status: 'unsupported', impact: 'medium' },
  { name: 'line-gradient',  status: 'unsupported', impact: 'low' },
]

const PAINT_SYMBOL: readonly CoverageEntry[] = [
  { name: 'text-color',       status: 'supported', note: 'Constant + interpolate-by-zoom + per-feature colorExpr.', source: 'layers.ts:199' },
  { name: 'text-opacity',     status: 'unsupported', impact: 'low' },
  { name: 'text-halo-color',  status: 'supported', note: 'Constant + interpolate-by-zoom.', source: 'layers.ts:269' },
  { name: 'text-halo-width',  status: 'supported', note: 'Constant + interpolate-by-zoom; PR #76 fixed scaling into SDF units.', source: 'layers.ts:259' },
  { name: 'text-halo-blur',   status: 'supported', note: 'Constant only at conversion; IR exposes a PropertyShape so future zoom-interp / data-driven emit lands without IR changes.', source: 'layers.ts:283' },
  { name: 'text-translate',   status: 'supported', note: 'Pixel-space offset added on top of em-unit text-offset.', source: 'layers.ts:340' },
  { name: 'text-translate-anchor', status: 'unsupported', impact: 'low' },
  { name: 'icon-color',       status: 'unsupported', impact: 'high' },
  { name: 'icon-opacity',     status: 'unsupported', impact: 'high' },
  { name: 'icon-halo-color',  status: 'unsupported', impact: 'medium' },
  { name: 'icon-halo-width',  status: 'unsupported', impact: 'medium' },
  { name: 'icon-halo-blur',   status: 'unsupported', impact: 'low' },
  { name: 'icon-translate',   status: 'unsupported', impact: 'low' },
  { name: 'icon-translate-anchor', status: 'unsupported', impact: 'low', note: 'viewport / map coordinate space for icon-translate; dependent on icon pipeline (Batch 2).' },
]

const PAINT_CIRCLE: readonly CoverageEntry[] = [
  { name: 'circle-radius',       status: 'supported', note: 'Constant + interpolate-by-zoom + per-feature expression. CSS px (Mapbox radius = xgis size).', source: 'layers.ts:537' },
  { name: 'circle-color',        status: 'supported', note: 'Constant + interpolate-by-zoom + per-feature case/match.' },
  { name: 'circle-opacity',      status: 'supported', note: 'Mapbox 0..1 → xgis 0..100 scaled. Constant + interpolate-by-zoom.' },
  { name: 'circle-stroke-color', status: 'supported' },
  { name: 'circle-stroke-width', status: 'supported', note: 'CSS px; constant + interpolate-by-zoom.' },
  { name: 'circle-blur',         status: 'unsupported', impact: 'low' },
  { name: 'circle-stroke-opacity', status: 'unsupported', impact: 'low', note: 'Would need to fold into stroke-colour alpha.' },
  { name: 'circle-translate',    status: 'unsupported', impact: 'low' },
  { name: 'circle-translate-anchor', status: 'unsupported', impact: 'low' },
  { name: 'circle-pitch-scale',  status: 'unsupported', impact: 'low' },
  { name: 'circle-pitch-alignment', status: 'unsupported', impact: 'low' },
]

const PAINT_FILL_EXTRUSION: readonly CoverageEntry[] = [
  { name: 'fill-extrusion-color',   status: 'supported' },
  { name: 'fill-extrusion-opacity', status: 'supported' },
  { name: 'fill-extrusion-height',  status: 'supported', note: 'Constant + interpolate-by-zoom + per-feature expression.', source: 'paint.ts:154' },
  { name: 'fill-extrusion-base',    status: 'supported', source: 'paint.ts:165' },
  { name: 'fill-extrusion-translate', status: 'unsupported', impact: 'low' },
  { name: 'fill-extrusion-translate-anchor', status: 'unsupported', impact: 'low', note: 'viewport / map space for fill-extrusion-translate; dependent on translate.' },
  { name: 'fill-extrusion-pattern',   status: 'unsupported', impact: 'medium' },
  { name: 'fill-extrusion-vertical-gradient', status: 'unsupported', impact: 'low' },
  { name: 'fill-extrusion-ambient-occlusion-intensity', status: 'unsupported', impact: 'low' },
  { name: 'fill-extrusion-ambient-occlusion-radius',    status: 'unsupported', impact: 'low' },
]

const PAINT_RASTER: readonly CoverageEntry[] = [
  { name: 'raster-opacity',         status: 'supported', note: 'Constant + interpolate-by-zoom + data-driven (all PropertyShape kinds) routed through the global RasterRenderer opacity uniform. Single raster show per scene is supported; multi-raster styles fall back to the first declared show.', source: 'paint.ts:38' },
  { name: 'raster-hue-rotate',      status: 'unsupported', impact: 'low' },
  { name: 'raster-brightness-min',  status: 'unsupported', impact: 'low' },
  { name: 'raster-brightness-max',  status: 'unsupported', impact: 'low' },
  { name: 'raster-saturation',      status: 'unsupported', impact: 'low' },
  { name: 'raster-contrast',        status: 'unsupported', impact: 'low' },
  { name: 'raster-fade-duration',   status: 'unsupported', impact: 'low' },
  { name: 'raster-resampling',      status: 'unsupported', impact: 'low' },
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
  { name: 'hillshade-shadow-color',           status: 'unsupported', impact: 'medium' },
  { name: 'hillshade-highlight-color',        status: 'unsupported', impact: 'medium' },
  { name: 'hillshade-accent-color',           status: 'unsupported', impact: 'low' },
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
  { name: 'to-number / number',  status: 'supported', note: 'Passthrough — xgis coerces in arithmetic context.' },
  { name: 'to-string / to-boolean / to-color', status: 'supported', note: 'Passthrough.' },
  // Colour
  { name: 'rgb / rgba',      status: 'partial', impact: 'low', note: 'Constant channels only — hex-encoded at convert time. Per-channel v8 literal-wrap (`[\"literal\", N]`) accepted.', source: 'expressions.ts:507' },
  { name: 'hsl / hsla',      status: 'partial', impact: 'low', note: 'Constant channels only — converted via CSS hsl()/hsla() and re-hexed at convert time. Per-channel v8 literal-wrap accepted.', source: 'colors.ts:69' },
  { name: 'interpolate (linear)',      status: 'supported' },
  { name: 'interpolate (exponential)', status: 'supported', note: 'Mapbox `["exponential", N]` lowers to `interpolate_exp(zoom, N, …)`; runtime applies the Mapbox curve formula. base=1 collapses to the linear fast path.', source: 'paint.ts:46' },
  { name: 'interpolate (cubic-bezier)',status: 'partial', impact: 'low', note: 'Folded to linear with a warning — no per-stop bezier evaluator yet.' },
  { name: 'interpolate-hcl',           status: 'partial', impact: 'low', note: 'Approximated as linear-RGB with a warning — no LAB/HCL per-stop evaluator yet.', source: 'expressions.ts:220' },
  { name: 'interpolate-lab',           status: 'partial', impact: 'low', note: 'Approximated as linear-RGB with a warning — no LAB/HCL per-stop evaluator yet.', source: 'expressions.ts:220' },
  // Feature meta
  { name: 'geometry-type',   status: 'supported', note: 'Routes via synthetic `$geometryType` prop injected at filter-eval time.', source: 'expressions.ts:263' },
  { name: 'id',              status: 'supported', note: 'Routes via synthetic `$featureId` prop injected from `feature.id` (GeoJSON RFC 7946 §3.2; MVT feature.id) at every filter-eval site. Same pattern as `geometry-type`.', source: 'expressions.ts:278' },
  { name: 'properties',      status: 'unsupported', impact: 'low' },
  { name: 'feature-state',   status: 'na', note: 'Mapbox v8 dynamic property setter — no xgis equivalent.' },
  // Formatting / advanced
  { name: 'typeof',          status: 'supported', note: 'Returns Mapbox-shaped strings ("string" / "number" / "boolean" / "object" / "null").', source: 'expressions.ts:237' },
  { name: 'format',          status: 'partial', impact: 'low', note: 'Span texts concatenated via xgis concat(); per-span opts (font-scale / text-color / text-font / vertical-align) dropped — X-GIS labels render with one style per layer.', source: 'expressions.ts:208' },
  { name: 'image',           status: 'unsupported', impact: 'high', note: 'Sprite atlas (Batch 2).' },
  { name: 'number-format',   status: 'supported', note: 'Lowers to positional `number_format(input, minFrac, maxFrac, locale, currency)` (xgis has no object-literal syntax). Routes through Intl.NumberFormat at runtime; null slots use spec defaults.', source: 'expressions.ts:275' },
  { name: 'collator',        status: 'unsupported', impact: 'low' },
  { name: 'resolved-locale', status: 'unsupported', impact: 'low' },
  { name: 'is-supported-script', status: 'unsupported', impact: 'low' },
  { name: 'array',           status: 'partial', impact: 'low', note: 'Type-assertion drops to value pass-through (X-GIS arrays carry no per-element type tag, so the spec\'s "abort if not array" semantic is lost; in paint/filter use a non-array would null-cascade anyway).', source: 'expressions.ts:163' },
  { name: 'slice',           status: 'supported', note: 'String or array; Mapbox `["slice", input, start[, end]]`. Routes to JS String/Array `.slice` semantics.', source: 'expressions.ts:248' },
  { name: 'index-of',        status: 'supported', note: 'Lowers to xgis `index_of(needle, haystack[, from])`. Returns -1 when not found.', source: 'expressions.ts:257' },
  // Camera / spatial
  { name: 'zoom',            status: 'supported', note: 'Lowers to bare `zoom` identifier. Works in `interpolate(zoom, …)` / `step(zoom, …)` AND anywhere else (filter compare, case condition, arithmetic).', source: 'expressions.ts:471' },
  { name: 'pitch',           status: 'unsupported', impact: 'low' },
  { name: 'distance-from-center', status: 'unsupported', impact: 'low' },
  { name: 'distance',        status: 'unsupported', impact: 'low' },
  { name: 'within',          status: 'unsupported', impact: 'low' },
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
  { name: '$type',                                   status: 'unsupported', impact: 'low', note: 'Legacy filter — use the new `["geometry-type"]` accessor instead.', source: 'expressions.ts:414' },
  { name: '$id',                                     status: 'unsupported', impact: 'low' },
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
