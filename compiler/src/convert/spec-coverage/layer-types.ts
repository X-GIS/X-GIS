import type { CoverageEntry } from './types'

// ─── 3. Layer types ───────────────────────────────────────────────────
export const LAYER_TYPES: readonly CoverageEntry[] = [
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
