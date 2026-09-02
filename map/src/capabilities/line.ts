import type { RuntimeCapability } from './types'

// `line` layer capability rows (paint + layout). Only place a line-axis
// change touches the capability table.
export const lineCapabilities: readonly RuntimeCapability[] = [
  { property: 'line-translate', layerType: 'line', variant: 'constant', supported: true },
  {
    property: 'line-translate',
    layerType: 'line',
    variant: 'zoom-interp',
    supported: true,
    note: 'WS-1 — per-frame via strokeTranslate{X,Y}Shape (mirrors fill-translate, resolved in resolveShow).',
  },
  {
    property: 'line-translate-anchor',
    layerType: 'line',
    variant: 'constant',
    supported: true,
    note: 'map is the spec default (and what an absent anchor means, #2170) = world-space: VTR rotates the [dx,dy] offset by camera.bearing before the px→NDC bake (show.strokeTranslateAnchorMap). An explicit viewport = screen-space, un-flagged. Pitch foreshortening of the offset not reproduced.',
  },
  { property: 'line-color', layerType: 'line', variant: 'constant', supported: true },
  { property: 'line-color', layerType: 'line', variant: 'zoom-interp', supported: true },
  { property: 'line-color', layerType: 'line', variant: 'data-driven', supported: true },
  { property: 'line-width', layerType: 'line', variant: 'constant', supported: true },
  { property: 'line-width', layerType: 'line', variant: 'zoom-interp', supported: true },
  { property: 'line-width', layerType: 'line', variant: 'data-driven', supported: true },
  { property: 'line-opacity', layerType: 'line', variant: 'constant', supported: true },
  { property: 'line-opacity', layerType: 'line', variant: 'zoom-interp', supported: true },
  {
    property: 'line-blur',
    layerType: 'line',
    variant: 'constant',
    supported: true,
    note: 'Strict-zero NOT honoured yet (1.5px soft fade at blur=0)',
  },
  { property: 'line-dasharray', layerType: 'line', variant: 'constant', supported: true },
  {
    property: 'line-dasharray',
    layerType: 'line',
    variant: 'zoom-interp',
    supported: true,
    note: 'WS-1 — PropertyShape<number[]> resolved per frame (resolveArrayShape STEP, Mapbox dash is interpolated:false) in resolveShow → VTR prefers ResolvedShow.dashArray.',
  },
  { property: 'line-gap-width', layerType: 'line', variant: 'constant', supported: true },
  { property: 'line-gap-width', layerType: 'line', variant: 'zoom-interp', supported: true },
  { property: 'line-offset', layerType: 'line', variant: 'constant', supported: true },
  // iter-185 Stage 2 — UV-tiled sprite atlas sampled in fs_line_pattern
  // with world-anchored UV. Stage 2.1 along-line UV pending.
  { property: 'line-pattern', layerType: 'line', variant: 'constant', supported: true },
  {
    property: 'line-pattern',
    layerType: 'line',
    variant: 'data-driven',
    supported: false,
    note: `#2380 — still false, and deliberately: the runtime bakes one pattern per draw. A \`match()\` over sprite names is split into constant-pattern sublayers by the converter (expand-color-match.ts) and never arrives here; the open-ended ["get"] form still does, and is still declined.`,
  },
  // Line layout
  {
    property: 'line-cap',
    layerType: 'line',
    variant: 'constant',
    supported: true,
    note: 'butt / round / square literal only',
  },
  {
    property: 'line-join',
    layerType: 'line',
    variant: 'constant',
    supported: true,
    note: 'miter / round / bevel literal only',
  },
  { property: 'line-miter-limit', layerType: 'line', variant: 'constant', supported: true },
  {
    property: 'line-round-limit',
    layerType: 'line',
    variant: 'constant',
    supported: true,
    note: 'ShowCommand.roundLimit → line uniform round_limit; scales the shader round-join fold threshold. 0/unset = historical fold (default).',
  },
]
