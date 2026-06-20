import type { CoverageEntry } from './types'

export const PAINT_HEATMAP: readonly CoverageEntry[] = [
  { name: 'heatmap-radius',    status: 'unsupported', impact: 'medium', note: 'Heatmap layer renderer not implemented — radius (px) defines per-feature Gaussian footprint.' },
  { name: 'heatmap-weight',    status: 'unsupported', impact: 'medium', note: 'Per-feature contribution multiplier; no renderer.' },
  { name: 'heatmap-intensity', status: 'unsupported', impact: 'medium', note: 'Overall density scale (per-zoom interpolated); no renderer.' },
  { name: 'heatmap-color',     status: 'unsupported', impact: 'medium', note: 'Density → colour ramp (interpolate over `heatmap-density`); no renderer.' },
  { name: 'heatmap-opacity',   status: 'unsupported', impact: 'medium', note: 'Layer-level opacity; no renderer.' },
]
