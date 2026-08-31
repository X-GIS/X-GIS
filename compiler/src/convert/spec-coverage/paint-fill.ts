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
    note: '#2166 CORRECTS THIS ROW\'S PREMISE. `fill-antialias` has never meant "an MSAA setting": MapLibre creates its context with `antialias: false` (map.ts:457) and has no MSAA at all, so its ONLY fill-edge AA is the 1 px feathered fill-OUTLINE pass, which draw_fill.ts:44 draws exclusively when the property is true. The spec encodes exactly that — fill-outline-color carries `requires: [{"!":"fill-pattern"},{"fill-antialias":true}]` — and the earlier note here audited X-GIS\'s own frame-global MSAA (quality.ts) instead of the property, concluding "not per-layer disable-able". What the property actually gates IS per-layer, and is now wired: emitFillPaint reads fill-antialias BEFORE calling addFillOutline and skips the `stroke-<color> stroke-1` emit when the value is the constant `false` (paint-fill.ts). OFM Bright `highway-area` (antialias:false + outline #cfcdca) stops painting a 1 px grey border MapLibre never paints. The pre-existing rim-alpha chain is unchanged and additive: the `fill-antialias-false` flag → ShowCommand.fillAntialias → ResolvedShow.fillAntialias → the polygon uniform\'s spare cam_ecef_off_h.w lane → the fs_fill fragment gates its sphere-rim hemisphere fade (polygon_rim_alpha), which is 1.0 on flat-Mercator and bites on the curved-globe/azimuthal rim. #1995\'s ZOOM form rides that SAME lane: boolZoomStepCall (bool-zoom-step.ts) lifts `["step", ["zoom"], …]` to a 0/1 `fill-antialias-[step(zoom, …)]` binding, extractStepZoomStops lowers it to a zoom-stepped PropertyShape<number> on the same ShowCommand.fillAntialias field, and resolveShow STEPs it per frame (resolveSteppedShape). STILL `partial`, for two REMAINING reasons, neither of them MSAA: (1) the zoom-step form emits an UNGATED stroke — a zoom-gated outline draw is not a convert-time decision (OFM Bright `landcover-wood` is the witness, and its outline is alpha 0.03); (2) the reverse half is unbuilt — when fill-antialias is true and fill-outline-color is UNSET, MapLibre still draws the outline in the fill colour, which X-GIS does not (41 of 47 corpus fill layers; adding it is a per-layer extra draw that must be pixel-judged). Data-driven (per-feature) fill-antialias warns and drops, and that is CORRECT, not a gap: the spec types the property `parameters: ["zoom"]` / data-constant, so the per-feature form is out of spec.',
    source:
      'paint-fill.ts (outline gate + flag) + bool-zoom-step.ts / resolved-show.ts / polygon.ts buildFsFill rim gate',
  },
  {
    name: 'fill-outline-color',
    status: 'supported',
    note: 'Lowers to `stroke-<color> stroke-1` on the same fill layer — the xgis polygon renderer paints fill + outline in the same pass. Constant + interpolate-by-zoom. #2166: honours the spec `requires: [{"!":"fill-pattern"},{"fill-antialias":true}]` for the fill-antialias half — a constant `fill-antialias: false` suppresses the stroke emit entirely (see the fill-antialias row).',
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
    note: 'WS-1 — constant vec2 AND per-frame zoom-interp, now in both the modern `["interpolate", …]` expression and the legacy `{"stops": [[zoom, [dx, dy]], …]}` object (#1976): the shared isZoomInterpCandidate pre-gate (paint-helpers.ts) admits both shapes into vec2AxisZoomInterp. A single-stop legacy function folds to the constant vec2 it denotes (foldSingleStopZoomFunction, applied once at the paintToUtilities props-bag boundary — range-typed only: categorical/unknown `type` keeps its drop path) instead of dropping. The converter splits the Mapbox vec2 interpolate into scalar x/y bracket bindings (fill-translate-x-[interpolate(zoom,…)]); lower builds fillTranslate{X,Y}Shape; resolveShow resolves each frame (resolveNumberShape) into ResolvedShow.fillTranslateX/Y; VTR bakes CSS-px → NDC (`clip.xy += u.fill_translate * clip.w` in vs_main). Replaces the old last-stop approximation (iter 508). OFM building-top pseudo-3D roof offset honoured. Data-driven (per-feature) form still drops with a warning. fill-extrusion-translate rides this same addFillTranslate emitter (paint-helpers.ts) and its drop warning now names its own property (paint.fill-extrusion-translate: …) instead of misattributing to fill-translate.',
    source: 'paint.ts:addFillTranslate + resolved-show.ts + vector-tile-renderer.ts',
  },
  {
    name: 'fill-translate-anchor',
    status: 'supported',
    impact: 'low',
    note: 'The spec default is `map`, but X-GIS resolves an ABSENT anchor as viewport — that inversion is #2170, not a documented choice. viewport = screen-space offset, byte-identical to the historical path (emits nothing). map = world-space: the converter emits `fill-translate-anchor-map` (addTranslateAnchor) → lower sets RenderNode.fillTranslateAnchorMap → ShowCommand → VTR rotates the [dx,dy] offset by camera.bearing before the CSS-px → NDC bake, so the offset tracks the map world axes. Pitch foreshortening of a map-anchored offset is not reproduced by the clip-space bake (bearing rotation is the dominant/flat behaviour). Depends on fill-translate.',
    source: 'paint-fill.ts addTranslateAnchor + vector-tile-renderer.ts bearing rotate',
  },
]
