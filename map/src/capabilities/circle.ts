import type { RuntimeCapability } from './types'

// `circle` layer capability rows (rendered by PointRenderer). Only place a
// circle-axis change touches the capability table.
export const circleCapabilities: readonly RuntimeCapability[] = [
  { property: 'circle-radius', layerType: 'circle', variant: 'constant', supported: true },
  { property: 'circle-radius', layerType: 'circle', variant: 'zoom-interp', supported: true },
  { property: 'circle-radius', layerType: 'circle', variant: 'data-driven', supported: true },
  { property: 'circle-color', layerType: 'circle', variant: 'constant', supported: true },
  { property: 'circle-color', layerType: 'circle', variant: 'zoom-interp', supported: true },
  { property: 'circle-color', layerType: 'circle', variant: 'data-driven', supported: true },
  { property: 'circle-opacity', layerType: 'circle', variant: 'constant', supported: true },
  { property: 'circle-opacity', layerType: 'circle', variant: 'zoom-interp', supported: true },
  { property: 'circle-stroke-color', layerType: 'circle', variant: 'constant', supported: true },
  { property: 'circle-stroke-color', layerType: 'circle', variant: 'zoom-interp', supported: true },
  { property: 'circle-stroke-width', layerType: 'circle', variant: 'constant', supported: true },
  { property: 'circle-stroke-width', layerType: 'circle', variant: 'zoom-interp', supported: true },
  {
    property: 'circle-stroke-opacity',
    layerType: 'circle',
    variant: 'constant',
    supported: true,
    note: 'Folds into stroke-color hex alpha at compile time (iter 4)',
  },
  {
    property: 'circle-stroke-opacity',
    layerType: 'circle',
    variant: 'zoom-interp',
    supported: true,
    note: 'Resolved per frame by PointRenderer.updateDynamicSizes and multiplied into the baked stroke alpha (feat_data slot 8) — WS-1 part 4',
  },
  { property: 'circle-translate', layerType: 'circle', variant: 'constant', supported: true },
  {
    property: 'circle-translate',
    layerType: 'circle',
    variant: 'zoom-interp',
    supported: true,
    note: 'WS-1 — per-frame via circleTranslate{X,Y}Shape resolved in PointRenderer.updateDynamicSizes into the point frame uniform.',
  },
  {
    property: 'circle-pitch-scale',
    layerType: 'circle',
    variant: 'constant',
    supported: true,
    note: 'viewport + map. circlePitchScaleMap → the point uniform circle_params.w mode code (1); the VS scales the screen radius by w_ref/clip.w (Phase S Batch 3). NOTE (#2118 audit): "map" is this property\'s SPEC default, not "viewport" — the converter resolves an absent value to viewport, so an unauthored circle does not shrink with distance the way MapLibre\'s does. Recorded at convert/layers-circle.ts, deliberately not changed here.',
  },
  // circle-pitch-alignment is IMPLEMENTED (#2118 — the point VS lays the disc in
  // the ground plane through the ground basis) but deliberately has NO ROW HERE.
  // Adding one with `supported: true` would fail spec-coverage-runtime-drift's
  // first assertion, because the matching spec-coverage row still reads
  // `status: 'unsupported'` and compiler/src/convert/spec-coverage/ is FROZEN
  // behind PR #1993. The three-way sync (spec-coverage row + gap-matrix + this
  // table) is the follow-up that unfreezing owns; a row added here alone would
  // turn a documentation gap into a red gate.
]
