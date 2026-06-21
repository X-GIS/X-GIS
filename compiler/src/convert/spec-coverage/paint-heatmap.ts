import type { CoverageEntry } from './types'

// Phase R — heatmap render layer landed (3-pass accum → Gaussian blur →
// density→colour compose; HeatmapRenderer + heatmap-pass.ts). The converter
// (layers-heatmap.ts) emits a `heatmap` marker + heatmap-radius/-weight/
// -intensity/-opacity/-color utilities; the runtime routes GeoJSON-source
// Point/MultiPoint heatmap layers to the renderer. Tile-sourced heatmaps are
// a deferred follow-up.
export const PAINT_HEATMAP: readonly CoverageEntry[] = [
  { name: 'heatmap-radius',    status: 'supported', note: 'Per-feature Gaussian splat radius (CSS px). Constant fully; interpolate-by-zoom resolved to the deepest-zoom stop value (full per-frame zoom-interp deferred). GeoJSON-source points.', source: 'layers-heatmap.ts' },
  { name: 'heatmap-weight',    status: 'supported', note: 'Per-feature contribution multiplier (constant + data-driven). Default 1.', source: 'layers-heatmap.ts' },
  { name: 'heatmap-intensity', status: 'supported', note: 'Overall density scale. Constant fully; interpolate-by-zoom resolved to the deepest-zoom stop value.', source: 'layers-heatmap.ts' },
  { name: 'heatmap-color',     status: 'partial', impact: 'medium', note: 'Density → colour ramp. The runtime applies its default Mapbox ramp; a custom `interpolate` over `heatmap-density` is not yet baked into the LUT (converter warns).', source: 'layers-heatmap.ts' },
  { name: 'heatmap-opacity',   status: 'supported', note: 'Layer-level opacity 0..1. Constant fully; interpolate-by-zoom resolved to the deepest-zoom stop value.', source: 'layers-heatmap.ts' },
]
