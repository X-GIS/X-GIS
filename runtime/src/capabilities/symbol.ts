import type { RuntimeCapability } from './types'

// `symbol` layer capability rows — text + icon paint/layout (rendered by
// the TextStage / IconStage / label pipeline). Only place a symbol-axis
// change touches the capability table.
export const symbolCapabilities: readonly RuntimeCapability[] = [
  // Text paint
  { property: 'text-color',          layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'text-color',          layerType: 'symbol', variant: 'zoom-interp', supported: true },
  { property: 'text-color',          layerType: 'symbol', variant: 'data-driven', supported: true },
  { property: 'text-opacity',        layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'text-opacity',        layerType: 'symbol', variant: 'zoom-interp', supported: true,  note: 'WS-1 — LabelShapes.opacity PropertyShape resolved per frame in render-loop-helpers (resolveNumberShape into resolvedColor.a + halo.a). Iter 113.' },
  { property: 'text-opacity',        layerType: 'symbol', variant: 'data-driven', supported: false, note: 'Per-feature alpha path deferred' },
  { property: 'text-halo-color',     layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'text-halo-color',     layerType: 'symbol', variant: 'zoom-interp', supported: true },
  { property: 'text-halo-width',     layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'text-halo-width',     layerType: 'symbol', variant: 'zoom-interp', supported: true },
  { property: 'text-pitch-alignment', layerType: 'symbol', variant: 'constant',   supported: false, note: 'Runtime never projects labels onto ground plane' },

  // Icon paint
  { property: 'icon-opacity',        layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'icon-opacity',        layerType: 'symbol', variant: 'zoom-interp', supported: false, note: 'Per-feature alpha attr path deferred' },
  { property: 'icon-opacity',        layerType: 'symbol', variant: 'data-driven', supported: false, note: 'Per-feature alpha path deferred' },
  { property: 'icon-size',           layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'icon-size',           layerType: 'symbol', variant: 'zoom-interp', supported: true },
  { property: 'icon-size',           layerType: 'symbol', variant: 'data-driven', supported: false, note: 'Worker per-feature evaluator pending' },
  { property: 'symbol-sort-key',     layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'symbol-sort-key',     layerType: 'symbol', variant: 'data-driven', supported: false, note: 'Expression flattens to 0; per-feature key plumbing pending' },

  // Symbol layout — common
  { property: 'symbol-placement',    layerType: 'symbol', variant: 'constant',  supported: true,  note: 'point / line / line-center literal' },
  { property: 'symbol-spacing',      layerType: 'symbol', variant: 'constant',  supported: true },

  // Symbol text layout
  { property: 'text-field',          layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'text-field',          layerType: 'symbol', variant: 'data-driven', supported: true },
  { property: 'text-font',           layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'text-size',           layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'text-size',           layerType: 'symbol', variant: 'zoom-interp', supported: true },
  { property: 'text-size',           layerType: 'symbol', variant: 'data-driven', supported: true,  note: 'sizeExpr per-feature evaluation' },
  { property: 'text-max-width',      layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'text-line-height',    layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'text-letter-spacing', layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'text-letter-spacing', layerType: 'symbol', variant: 'zoom-interp', supported: true },
  { property: 'text-justify',        layerType: 'symbol', variant: 'constant',    supported: true,  note: 'auto / left / center / right literal' },
  { property: 'text-anchor',         layerType: 'symbol', variant: 'constant',    supported: true,  note: '9-way enum literal' },
  { property: 'text-variable-anchor', layerType: 'symbol', variant: 'constant',   supported: true },
  { property: 'text-variable-anchor-offset', layerType: 'symbol', variant: 'constant', supported: true },
  { property: 'text-radial-offset',  layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'text-offset',         layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'text-rotate',         layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'text-padding',        layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'text-padding',        layerType: 'symbol', variant: 'zoom-interp', supported: true },
  { property: 'text-transform',      layerType: 'symbol', variant: 'constant',    supported: true,  note: 'uppercase / lowercase / none literal' },
  { property: 'text-allow-overlap',  layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'text-ignore-placement', layerType: 'symbol', variant: 'constant',  supported: true },
  { property: 'text-rotation-alignment', layerType: 'symbol', variant: 'constant', supported: true, note: 'map / viewport / auto literal' },
  { property: 'text-keep-upright',   layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'text-max-angle',      layerType: 'symbol', variant: 'constant',    supported: true,  note: 'LabelDef.maxAngle drives the TextStage curved-label angular gate; unset = no clamp (historical behaviour)' },
  { property: 'text-translate',      layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'text-translate-anchor', layerType: 'symbol', variant: 'constant',  supported: true,  note: 'viewport (default) = screen-space (byte-identical); map = world-space: TextStage.prepare rotates the [dx,dy] text-translate by camera.bearing (rotateLabelTranslate, mirror of the fill/line clip-space bake) and re-keys the layout cache. Pitch foreshortening not reproduced.' },
  { property: 'text-halo-blur',      layerType: 'symbol', variant: 'constant',    supported: true,  note: 'IR exposes PropertyShape; non-constant emits warn until shape-resolve lands' },

  // Symbol icon layout
  { property: 'icon-image',          layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'icon-image',          layerType: 'symbol', variant: 'data-driven', supported: true,  note: 'match/case via label-icon-image-[<expr>] (iter 490)' },
  { property: 'icon-rotate',         layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'icon-anchor',         layerType: 'symbol', variant: 'constant',    supported: true,  note: '9-way enum literal' },
  { property: 'icon-offset',         layerType: 'symbol', variant: 'constant',    supported: true },
  { property: 'icon-rotation-alignment', layerType: 'symbol', variant: 'constant', supported: true, note: 'map / viewport / auto literal (iter 506)' },
  { property: 'icon-translate-anchor', layerType: 'symbol', variant: 'constant',  supported: true,  note: 'viewport (default) = screen-space (byte-identical); map = world-space: dispatchIcon rotates ONLY the icon-translate portion of the icon anchor offset by camera.bearing (icon-offset stays screen-space). Pitch foreshortening not reproduced.' },
]
