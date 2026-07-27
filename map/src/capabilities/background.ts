import type { RuntimeCapability } from './types'

// `background` top-level directive capability rows. Only place a
// background-axis change touches the capability table.
export const backgroundCapabilities: readonly RuntimeCapability[] = [
  { property: 'background-color', layerType: 'background', variant: 'constant', supported: true },
  {
    property: 'background-color',
    layerType: 'background',
    variant: 'zoom-interp',
    supported: true,
    note: 'WS-1 — interpolate(zoom, …) fill resolves per frame: flat via the background-pass clear, sphere via the synthetic earth-surface show paintShapes.fill',
  },
  {
    property: 'background-opacity',
    layerType: 'background',
    variant: 'constant',
    supported: true,
    note: 'Folds into background-color hex alpha (iter 47)',
  },
  {
    property: 'background-opacity',
    layerType: 'background',
    variant: 'zoom-interp',
    supported: true,
    note: 'WS-1 — opacity: interpolate(zoom, …) resolves per frame and multiplies into the background clear alpha',
  },
  {
    property: 'background-pattern',
    layerType: 'background',
    variant: 'constant',
    supported: true,
    note: '#777 I-E — constant sprite name tiled over the coverage clear by the background pass (fullscreen quad, wrapped UV into the sprite atlas; dual-source DSL pipeline). The zoom-crossfade form warns once at convert time.',
  },
]
