import type { RuntimeCapability } from './types'

// `fill-extrusion` layer capability rows. Only place a fill-extrusion-axis
// change touches the capability table.
export const fillExtrusionCapabilities: readonly RuntimeCapability[] = [
  { property: 'fill-extrusion-translate', layerType: 'fill-extrusion', variant: 'constant',    supported: true },
  { property: 'fill-extrusion-translate', layerType: 'fill-extrusion', variant: 'zoom-interp', supported: true,  note: 'WS-1 — routes through the fill-translate path; same per-frame resolve, applied in the extrude VS u.fill_translate.' },
  { property: 'fill-extrusion-translate-anchor', layerType: 'fill-extrusion', variant: 'constant', supported: true, note: 'viewport (default) = screen-space; map = world-space: shares fill\'s slot 46/47 uniform, so VTR rotates the [dx,dy] offset by camera.bearing before the px→NDC bake (show.fillTranslateAnchorMap) and the extrude VS inherits it. Pitch foreshortening not reproduced.' },
  { property: 'fill-extrusion-color',  layerType: 'fill-extrusion', variant: 'constant',    supported: true },
  { property: 'fill-extrusion-color',  layerType: 'fill-extrusion', variant: 'zoom-interp', supported: true },
  { property: 'fill-extrusion-height', layerType: 'fill-extrusion', variant: 'constant',    supported: true },
  { property: 'fill-extrusion-height', layerType: 'fill-extrusion', variant: 'zoom-interp', supported: true },
  { property: 'fill-extrusion-height', layerType: 'fill-extrusion', variant: 'data-driven', supported: true },
  { property: 'fill-extrusion-base',   layerType: 'fill-extrusion', variant: 'constant',    supported: true },
  { property: 'fill-extrusion-opacity', layerType: 'fill-extrusion', variant: 'constant',   supported: true },
  { property: 'fill-extrusion-vertical-gradient', layerType: 'fill-extrusion', variant: 'constant', supported: true, note: 'Phase 9 vertical gradient lighting honoured (commit 2026-05-18).' },
  // iter-186 Stage 2 — extruded variant of fillPipelinePattern;
  // fragment shares fs_fill_pattern with the ground path. Walls lose
  // the wall_shade lighting in this Stage 2 cut (Stage 2.1 follow-up).
  { property: 'fill-extrusion-pattern', layerType: 'fill-extrusion', variant: 'constant', supported: true, note: 'Walls + roofs sample atlas via fs_fill_pattern; wall_shade lighting deferred to Stage 2.1' },
  { property: 'fill-extrusion-pattern', layerType: 'fill-extrusion', variant: 'data-driven', supported: false, note: 'Expression form not threaded through IR' },
]
