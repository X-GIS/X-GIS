import type { RuntimeCapability } from './types'

// `line` layer capability rows (paint + layout). Only place a line-axis
// change touches the capability table.
export const lineCapabilities: readonly RuntimeCapability[] = [
  { property: 'line-translate',      layerType: 'line', variant: 'constant',    supported: true },
  { property: 'line-translate',      layerType: 'line', variant: 'zoom-interp', supported: true,  note: 'WS-1 — per-frame via strokeTranslate{X,Y}Shape (mirrors fill-translate, resolved in resolveShow).' },
  { property: 'line-color',          layerType: 'line', variant: 'constant',    supported: true },
  { property: 'line-color',          layerType: 'line', variant: 'zoom-interp', supported: true },
  { property: 'line-color',          layerType: 'line', variant: 'data-driven', supported: true },
  { property: 'line-width',          layerType: 'line', variant: 'constant',    supported: true },
  { property: 'line-width',          layerType: 'line', variant: 'zoom-interp', supported: true },
  { property: 'line-width',          layerType: 'line', variant: 'data-driven', supported: true },
  { property: 'line-opacity',        layerType: 'line', variant: 'constant',    supported: true },
  { property: 'line-opacity',        layerType: 'line', variant: 'zoom-interp', supported: true },
  { property: 'line-blur',           layerType: 'line', variant: 'constant',    supported: true,  note: 'Strict-zero NOT honoured yet (1.5px soft fade at blur=0)' },
  { property: 'line-dasharray',      layerType: 'line', variant: 'constant',    supported: true },
  { property: 'line-dasharray',      layerType: 'line', variant: 'zoom-interp', supported: true,  note: 'WS-1 — PropertyShape<number[]> resolved per frame (resolveArrayShape STEP, Mapbox dash is interpolated:false) in resolveShow → VTR prefers ResolvedShow.dashArray.' },
  { property: 'line-gap-width',      layerType: 'line', variant: 'constant',    supported: true },
  { property: 'line-gap-width',      layerType: 'line', variant: 'zoom-interp', supported: true },
  { property: 'line-offset',         layerType: 'line', variant: 'constant',    supported: true },
  // iter-185 Stage 2 — UV-tiled sprite atlas sampled in fs_line_pattern
  // with world-anchored UV. Stage 2.1 along-line UV pending.
  { property: 'line-pattern',        layerType: 'line', variant: 'constant',    supported: true },
  { property: 'line-pattern',        layerType: 'line', variant: 'data-driven', supported: false, note: 'Expression form not threaded through IR' },
  // Line layout
  { property: 'line-cap',            layerType: 'line', variant: 'constant',    supported: true,  note: 'butt / round / square literal only' },
  { property: 'line-join',           layerType: 'line', variant: 'constant',    supported: true,  note: 'miter / round / bevel literal only' },
  { property: 'line-miter-limit',    layerType: 'line', variant: 'constant',    supported: true },
]
