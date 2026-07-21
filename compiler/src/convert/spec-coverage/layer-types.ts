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
    status: 'partial',
    impact: 'medium',
    note: 'Icon-only symbol layers (no text-field) route to the icon stage (#777 I1/I2, PR #965): constant `icon-image` → `label-icon-image-<name>`; data-driven `icon-image: ["match"|"coalesce"|["image", …]]` → per-feature `label-icon-image-[<expr>]` → IconStage.addIcon. Still partial: the icon LAYOUT tail (icon-text-fit / icon-padding / icon-keep-upright / icon-pitch-alignment) and text/icon halo are deferred to the Phase I remainder.',
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
    note: '#777 Phase II — rendered end-to-end on both backends: raster-dem DEM decode → 3×3 Sobel → the full MapLibre v5 method set (standard / basic / combined / igor / multidirectional, up to 4 sources) in HillshadeRenderer/HillshadePass. Residuals: resampling:linear smoothing (its own partial row) and the ≤1-DEM-texel cross-tile edge seam (CLAMP_TO_EDGE; backfill deferred).',
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
