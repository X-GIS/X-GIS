import type { RuntimeCapability } from './types'

// `circle` layer capability rows (rendered by PointRenderer). Only place a
// circle-axis change touches the capability table.
export const circleCapabilities: readonly RuntimeCapability[] = [
  { property: 'circle-radius',       layerType: 'circle', variant: 'constant',    supported: true },
  { property: 'circle-radius',       layerType: 'circle', variant: 'zoom-interp', supported: true },
  { property: 'circle-radius',       layerType: 'circle', variant: 'data-driven', supported: true },
  { property: 'circle-color',        layerType: 'circle', variant: 'constant',    supported: true },
  { property: 'circle-color',        layerType: 'circle', variant: 'zoom-interp', supported: true },
  { property: 'circle-color',        layerType: 'circle', variant: 'data-driven', supported: true },
  { property: 'circle-opacity',      layerType: 'circle', variant: 'constant',    supported: true },
  { property: 'circle-opacity',      layerType: 'circle', variant: 'zoom-interp', supported: true },
  { property: 'circle-stroke-color', layerType: 'circle', variant: 'constant',    supported: true },
  { property: 'circle-stroke-color', layerType: 'circle', variant: 'zoom-interp', supported: true },
  { property: 'circle-stroke-width', layerType: 'circle', variant: 'constant',    supported: true },
  { property: 'circle-stroke-width', layerType: 'circle', variant: 'zoom-interp', supported: true },
  { property: 'circle-stroke-opacity', layerType: 'circle', variant: 'constant',  supported: true,  note: 'Folds into stroke-color hex alpha at compile time (iter 4)' },
  { property: 'circle-stroke-opacity', layerType: 'circle', variant: 'zoom-interp', supported: true,  note: 'Resolved per frame by PointRenderer.updateDynamicSizes and multiplied into the baked stroke alpha (feat_data slot 8) — WS-1 part 4' },
  { property: 'circle-translate',    layerType: 'circle', variant: 'constant',    supported: true },
  { property: 'circle-translate',    layerType: 'circle', variant: 'zoom-interp', supported: true,  note: 'WS-1 — per-frame via circleTranslate{X,Y}Shape resolved in PointRenderer.updateDynamicSizes into the point frame uniform.' },
]
