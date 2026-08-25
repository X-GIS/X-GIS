import type { RuntimeCapability } from './types'

// `fill` layer capability rows (incl. fill-outline, which lowers to
// stroke- utilities but is a fill-layer paint property). This file is the
// ONLY place a fill-axis change touches the capability table — fill work
// never conflicts with line / circle / background work in the table, so
// independent axes can be implemented in parallel.
export const fillCapabilities: readonly RuntimeCapability[] = [
  { property: 'fill-color', layerType: 'fill', variant: 'constant', supported: true },
  { property: 'fill-color', layerType: 'fill', variant: 'zoom-interp', supported: true },
  { property: 'fill-color', layerType: 'fill', variant: 'data-driven', supported: true },
  { property: 'fill-opacity', layerType: 'fill', variant: 'constant', supported: true },
  { property: 'fill-opacity', layerType: 'fill', variant: 'zoom-interp', supported: true },
  {
    property: 'fill-opacity',
    layerType: 'fill',
    variant: 'data-driven',
    supported: false,
    note: 'Per-feature opacity not threaded through renderer',
  },
  {
    property: 'fill-antialias',
    layerType: 'fill',
    variant: 'constant',
    supported: false,
    // Was "false branch not implemented" — stale since the opt-out was wired,
    // and #1995 (which cites this same lane for the zoom form) makes it
    // actively misleading. What is actually missing is GEOMETRIC edge AA.
    note: 'false gates only the sphere-rim alpha fade (cam_ecef_off_h.w → fs_fill polygon_rim_alpha), which is 1.0 on flat-Mercator; the pipeline MSAA that does the geometric edge AA is not per-layer disable-able',
  },
  {
    property: 'fill-antialias',
    layerType: 'fill',
    variant: 'zoom-interp',
    supported: false,
    note: '#1995 — the boolean `["step", ["zoom"], …]` form is no longer dropped: it lowers to a 0/1 PropertyShape resolved per frame (resolveSteppedShape) into the same rim-alpha lane, flipping at the authored zoom. Still listed as a gap for the SAME reason as the constant variant — the geometric MSAA edge AA is untouched',
  },
  { property: 'fill-translate', layerType: 'fill', variant: 'constant', supported: true },
  {
    property: 'fill-translate',
    layerType: 'fill',
    variant: 'zoom-interp',
    supported: true,
    note: 'WS-1 — per-frame: fillTranslate{X,Y}Shape resolved each frame in resolveShow (resolveNumberShape) → VTR NDC bake.',
  },
  {
    property: 'fill-translate-anchor',
    layerType: 'fill',
    variant: 'constant',
    supported: true,
    note: 'viewport (default) = screen-space; map = world-space: VTR rotates the [dx,dy] offset by camera.bearing before the px→NDC bake (show.fillTranslateAnchorMap). Pitch foreshortening of the offset not reproduced.',
  },
  // iter-181/182/183/184 Stage 2 — UV-tiled sprite atlas sampled in
  // fs_fill_pattern with world-anchored UV. Constant string sprite
  // name only; expression form still warns at convert.
  { property: 'fill-pattern', layerType: 'fill', variant: 'constant', supported: true },
  {
    property: 'fill-pattern',
    layerType: 'fill',
    variant: 'data-driven',
    supported: false,
    note: 'Expression form of fill-pattern (per-feature sprite name) not threaded through IR',
  },
  // Fill outline (lowers to stroke- utilities in xgis)
  { property: 'fill-outline-color', layerType: 'fill', variant: 'constant', supported: true },
  { property: 'fill-outline-color', layerType: 'fill', variant: 'zoom-interp', supported: true },
]
