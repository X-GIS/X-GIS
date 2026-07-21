import type { RuntimeCapability } from './types'

// `heatmap` layer capability rows (Phase R — rendered by HeatmapRenderer's
// 3-pass accum → blur → compose pipeline). GeoJSON-source Point/MultiPoint
// only; tile-sourced heatmaps are a deferred follow-up. Only place a
// heatmap-axis change touches the capability table.
export const heatmapCapabilities: readonly RuntimeCapability[] = [
  { property: 'heatmap-radius', layerType: 'heatmap', variant: 'constant', supported: true },
  {
    property: 'heatmap-radius',
    layerType: 'heatmap',
    variant: 'zoom-interp',
    supported: true,
    note: 'Resolved to the deepest-zoom stop value at compile time; full per-frame zoom-interp deferred.',
  },
  { property: 'heatmap-weight', layerType: 'heatmap', variant: 'constant', supported: true },
  {
    property: 'heatmap-weight',
    layerType: 'heatmap',
    variant: 'data-driven',
    supported: true,
    note: 'Per-feature weight evaluated at layer-build time.',
  },
  { property: 'heatmap-intensity', layerType: 'heatmap', variant: 'constant', supported: true },
  {
    property: 'heatmap-intensity',
    layerType: 'heatmap',
    variant: 'zoom-interp',
    supported: true,
    note: 'Resolved to the deepest-zoom stop value at compile time; full per-frame zoom-interp deferred.',
  },
  {
    property: 'heatmap-color',
    layerType: 'heatmap',
    variant: 'constant',
    supported: true,
    note: 'Custom density→colour ramp baked into the 256×1 LUT (ShowCommand.heatmapColorStops → HeatmapRenderer rampBytes). Exponential / cubic-bezier curves and step ramps densify to linear stops at convert time.',
  },
  { property: 'heatmap-opacity', layerType: 'heatmap', variant: 'constant', supported: true },
  {
    property: 'heatmap-opacity',
    layerType: 'heatmap',
    variant: 'zoom-interp',
    supported: true,
    note: 'Resolved to the deepest-zoom stop value at compile time; full per-frame zoom-interp deferred.',
  },
]
