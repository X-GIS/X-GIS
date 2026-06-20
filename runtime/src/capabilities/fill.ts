import type { RuntimeCapability } from './types'

// `fill` layer capability rows (incl. fill-outline, which lowers to
// stroke- utilities but is a fill-layer paint property). This file is the
// ONLY place a fill-axis change touches the capability table — fill work
// never conflicts with line / circle / background work in the table, so
// independent axes can be implemented in parallel.
export const fillCapabilities: readonly RuntimeCapability[] = [
  { property: 'fill-color',          layerType: 'fill', variant: 'constant',    supported: true },
  { property: 'fill-color',          layerType: 'fill', variant: 'zoom-interp', supported: true },
  { property: 'fill-color',          layerType: 'fill', variant: 'data-driven', supported: true },
  { property: 'fill-opacity',        layerType: 'fill', variant: 'constant',    supported: true },
  { property: 'fill-opacity',        layerType: 'fill', variant: 'zoom-interp', supported: true },
  { property: 'fill-opacity',        layerType: 'fill', variant: 'data-driven', supported: false, note: 'Per-feature opacity not threaded through renderer' },
  { property: 'fill-antialias',      layerType: 'fill', variant: 'constant',    supported: false, note: 'false branch not implemented; pipeline always uses MSAA' },
  { property: 'fill-translate',      layerType: 'fill', variant: 'constant',    supported: true },
  { property: 'fill-translate',      layerType: 'fill', variant: 'zoom-interp', supported: true,  note: 'WS-1 — per-frame: fillTranslate{X,Y}Shape resolved each frame in resolveShow (resolveNumberShape) → VTR NDC bake.' },
  { property: 'fill-translate-anchor', layerType: 'fill', variant: 'constant',  supported: true,  note: 'viewport (default) = screen-space; map = world-space: VTR rotates the [dx,dy] offset by camera.bearing before the px→NDC bake (show.fillTranslateAnchorMap). Pitch foreshortening of the offset not reproduced.' },
  // iter-181/182/183/184 Stage 2 — UV-tiled sprite atlas sampled in
  // fs_fill_pattern with world-anchored UV. Constant string sprite
  // name only; expression form still warns at convert.
  { property: 'fill-pattern',        layerType: 'fill', variant: 'constant',    supported: true },
  { property: 'fill-pattern',        layerType: 'fill', variant: 'data-driven', supported: false, note: 'Expression form of fill-pattern (per-feature sprite name) not threaded through IR' },
  // Fill outline (lowers to stroke- utilities in xgis)
  { property: 'fill-outline-color',  layerType: 'fill', variant: 'constant',    supported: true },
  { property: 'fill-outline-color',  layerType: 'fill', variant: 'zoom-interp', supported: true },
]
