import type { CoverageEntry } from './types'

// ─── 3. Layer types ───────────────────────────────────────────────────
export const LAYER_TYPES: readonly CoverageEntry[] = [
  {
    name: 'background',
    status: 'supported',
    note: 'Lifts to top-level `background { fill: # }` directive.',
    source: 'mapbox-to-xgis.ts:82',
  },
  { name: 'fill', status: 'supported' },
  { name: 'line', status: 'supported' },
  {
    name: 'symbol (text)',
    status: 'supported',
    note: 'TextStage renders SDF glyphs from Canvas2D fonts.',
    source: 'layers.ts:154',
  },
  {
    name: 'symbol (icon-only)',
    status: 'supported',
    impact: 'medium',
    note: 'Icon-only symbol layers (no text-field) route to the icon stage (#777 I1/I2, PR #965). Verified across every icon-image form: a constant sprite name, `match`, `coalesce`, `step` by zoom, and the `["image", \u2026]` wrapper all convert with zero warnings and reach `label-icon-image-<name>` / per-feature `label-icon-image-[<expr>]` -> IconStage.addIcon, as do the same layers carrying icon-size / -rotate / -anchor / -offset / -allow-overlap, and an explicitly EMPTY text-field. #2489 flipped this from `partial`: like every other row in this file it describes ROUTING, and the property-level gaps it used to enumerate belong to their own rows (`icon-pitch-alignment` is still `unsupported` there, and holding this row at partial for it counted the same gap twice). Four of the five reasons it gave had shipped, and the halo claim was wrong in both directions at once - text halo is supported, icon halo is `na`. An icon-only layer emits `label-[""]` plus default label tokens; that empty label is inert BY CONSTRUCTION, not by luck - addLabel early-returns on empty resolved text, and #609\'s obstacle path depends on exactly that (text-stage.ts: an empty-text paired symbol is absent from getActiveTextPairKeys and keeps seeding its obstacle).',
    source: 'layers-symbol.ts:252',
  },
  { name: 'fill-extrusion', status: 'supported', note: 'Extruded polygon with per-vertex z.' },
  { name: 'raster', status: 'supported' },
  {
    name: 'circle',
    status: 'supported',
    note: 'Routes to the runtime PointRenderer (SDF disks). circle-radius/-color/-stroke-color/-stroke-width/-opacity all map onto the existing point utility surface, including interpolate-by-zoom + data-driven forms.',
    source: 'layers.ts:514',
  },
  {
    name: 'heatmap',
    status: 'supported',
    note: 'Phase R — 3-pass GPU pipeline (accum → Gaussian blur → density→colour compose) in HeatmapRenderer. Routes GeoJSON-source Point/MultiPoint heatmap layers to the renderer; heatmap-radius/-weight/-intensity/-color/-opacity supported. Tile-sourced heatmaps deferred.',
    source: 'layers-heatmap.ts',
  },
  {
    name: 'hillshade',
    status: 'supported',
    note: '#777 Phase II — rendered end-to-end on both backends: raster-dem DEM decode → 3×3 Sobel → the full MapLibre v5 method set (standard / basic / combined / igor / multidirectional, up to 4 sources) in HillshadeRenderer/HillshadePass. Residuals: the spec-default `resampling: linear` is not rendered — X-GIS shades per fragment from a nearest-sampled DEM, so the relief is flat across each DEM texel, the MapLibre `nearest` look (`resampling` selects the relief filter, not the DEM sampler, which the packed decode pins to nearest in both engines; its own partial row, and an explicitly authored linear warns) — and the ≤1-DEM-texel cross-tile edge seam (CLAMP_TO_EDGE; backfill deferred).',
    source: 'layer-converters/generic.ts',
  },
  {
    name: 'sky',
    status: 'unsupported',
    impact: 'low',
    note: 'Atmospheric sky dome (sky-color / sky-atmosphere-* / sky-type). Layer-level skip added to SKIP_REASONS so the converter emits an explicit // SKIPPED comment with diagnostic note rather than falling through to the generic handler.',
    source: 'layers.ts:SKIP_REASONS',
  },
]
