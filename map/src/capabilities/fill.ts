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
    // Was "false branch not implemented", then "the missing piece is GEOMETRIC
    // edge AA (frame-global MSAA)". Both wrong about what the property IS:
    // #2166 established that fill-antialias gates the fill-OUTLINE draw
    // (MapLibre runs with `antialias: false` and has no MSAA to disable), and
    // that half is now honoured at convert time.
    note: 'false suppresses the fill-outline draw (#2166 — the converter skips `stroke-<color> stroke-1`, matching draw_fill.ts:44) AND gates the sphere-rim alpha fade (cam_ecef_off_h.w → fs_fill polygon_rim_alpha, 1.0 on flat-Mercator). Still a gap only for the TRUE direction: MapLibre outlines an antialiased fill in the fill colour when fill-outline-color is unset, which X-GIS does not synthesise',
  },
  {
    property: 'fill-antialias',
    layerType: 'fill',
    variant: 'zoom-interp',
    supported: false,
    note: '#1995 — the boolean `["step", ["zoom"], …]` form is no longer dropped: it lowers to a 0/1 PropertyShape resolved per frame (resolveSteppedShape) into the same rim-alpha lane, flipping at the authored zoom. Still a gap because the OUTLINE half stays ungated for this variant: #2166 gates the stroke emit on the CONSTANT `false` only, and a zoom-gated outline draw is not a convert-time decision (OFM Bright `landcover-wood`)',
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
    note: 'map is the spec default (and what an absent anchor means, #2170) = world-space: VTR rotates the [dx,dy] offset by camera.bearing before the px→NDC bake (show.fillTranslateAnchorMap). An explicit viewport = screen-space, un-flagged. Pitch foreshortening of the offset not reproduced.',
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
    note: `#2380 — still false, and deliberately: this row describes what the RUNTIME honours, and the runtime still bakes ONE pattern per draw (\`show.fillPattern\` is a single string resolved to one UV bbox at render-loop.ts:881). What changed is upstream — the converter splits a \`match()\` over sprite names into one sublayer per unique sprite (expand-color-match.ts), so the runtime never receives a data-driven pattern in the first place. Do NOT flip this to true on the strength of a match() style now rendering: the open-ended ["get"] form still reaches here and is still declined.`,
  },
  // Fill outline (lowers to stroke- utilities in xgis)
  { property: 'fill-outline-color', layerType: 'fill', variant: 'constant', supported: true },
  { property: 'fill-outline-color', layerType: 'fill', variant: 'zoom-interp', supported: true },
]
