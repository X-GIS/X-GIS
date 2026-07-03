import type { CoverageEntry } from './types'

export const PAINT_FILL: readonly CoverageEntry[] = [
  {
    name: 'fill-color',
    status: 'supported',
    note: 'Constant + interpolate-by-zoom + per-feature case/match expressions.',
    source: 'paint.ts:91',
  },
  { name: 'fill-opacity', status: 'supported', source: 'paint.ts:133' },
  {
    name: 'fill-antialias',
    status: 'partial',
    impact: 'low',
    note: "Default `true` byte-identical (current render path). Geometric fill-edge AA in X-GIS comes from pipeline MSAA, not a per-fragment coverage smoothstep, so it is not per-layer disable-able. The `false` opt-out IS now wired: the converter emits a `fill-antialias-false` flag (paint.ts) → ShowCommand.fillAntialias → the polygon uniform's spare cam_ecef_off_h.w lane → the fs_fill fragment gates the only fill-alpha smoothstep it has (the sphere-rim hemisphere fade, polygon_rim_alpha) on the flag, giving a hard rim edge. On flat-Mercator the rim factor is already 1.0 so `false` is visually inert there; it bites on the curved-globe/azimuthal rim. OFM liberty `landcover_wood`/`grass`/`ice` set `false`.",
    source: 'paint.ts fill-antialias-false / polygon.ts buildFsFill rim gate',
  },
  {
    name: 'fill-outline-color',
    status: 'supported',
    note: 'Lowers to `stroke-<color> stroke-1` on the same fill layer — the xgis polygon renderer paints fill + outline in the same pass. Constant + interpolate-by-zoom.',
    source: 'paint.ts:153',
  },
  {
    name: 'fill-pattern',
    status: 'supported',
    impact: 'high',
    note: 'Stage 2 (true UV-tiled bitmap) landed iter-181/182/183 2026-05-20. Sprite atlas bound at @group(0) @binding(5) on every polygon pipeline + dedicated `sprite_samp` at binding(6). `fs_fill_pattern` fragment shader samples the atlas at world-anchored UV computed from `abs_merc / pattern_repeat_m`; pattern repeat in Mercator metres derived per-frame from sprite design CSS-px width × WORLD_MERC / (256 * 2^cameraZoom) so the bitmap stays anchored to the ground. Pattern parameters pack into reused uniform slots (fill_color = UV bbox, fill_translate = repeat metres) so the 192-byte Uniforms struct is unchanged. VTR routes fillPattern shows to `fillPipelinePatternGround` (+ Fallback) variant; ground polygons on the baseBindGroupLayout path only — variant + featureBindGroupLayout pattern shows fall through to the Stage 1 sprite-centre-pixel colour. Constant string form supported end-to-end. Documented trade-offs: pattern shows cannot also use solid fill-color or fill-translate; extrude-pattern walls still flat (Stage 2 ground-only).',
    source: 'paint.ts iter-177/181/182/183',
  },
  {
    name: 'fill-translate',
    status: 'supported',
    impact: 'low',
    note: 'WS-1 — constant vec2 AND per-frame zoom-interp. The converter splits the Mapbox vec2 interpolate into scalar x/y bracket bindings (fill-translate-x-[interpolate(zoom,…)]); lower builds fillTranslate{X,Y}Shape; resolveShow resolves each frame (resolveNumberShape) into ResolvedShow.fillTranslateX/Y; VTR bakes CSS-px → NDC (`clip.xy += u.fill_translate * clip.w` in vs_main). Replaces the old last-stop approximation (iter 508). OFM building-top pseudo-3D roof offset honoured.',
    source: 'paint.ts:addFillTranslate + resolved-show.ts + vector-tile-renderer.ts',
  },
  {
    name: 'fill-translate-anchor',
    status: 'supported',
    impact: 'low',
    note: 'viewport (default) = screen-space offset, byte-identical to the historical path (emits nothing). map = world-space: the converter emits `fill-translate-anchor-map` (addTranslateAnchor) → lower sets RenderNode.fillTranslateAnchorMap → ShowCommand → VTR rotates the [dx,dy] offset by camera.bearing before the CSS-px → NDC bake, so the offset tracks the map world axes. Pitch foreshortening of a map-anchored offset is not reproduced by the clip-space bake (bearing rotation is the dominant/flat behaviour). Depends on fill-translate.',
    source: 'paint-fill.ts addTranslateAnchor + vector-tile-renderer.ts bearing rotate',
  },
]
