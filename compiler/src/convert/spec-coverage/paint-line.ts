import type { CoverageEntry } from './types'

export const PAINT_LINE: readonly CoverageEntry[] = [
  { name: 'line-color', status: 'supported', source: 'paint.ts:102' },
  {
    name: 'line-width',
    status: 'supported',
    note: 'Constant + interpolate-by-zoom (linear AND exponential base) + per-feature width. PR #104 added per-frame zoom-stops; PR #108 conformance test pins differential parity with MapLibre createExpression() at z=4..20 (incl. fractional zooms).',
    source: 'paint.ts:113',
  },
  { name: 'line-opacity', status: 'supported', source: 'paint.ts:133' },
  {
    name: 'line-dasharray',
    status: 'supported',
    impact: 'medium',
    note: 'WS-1 — constant numeric array AND per-frame zoom-interp, now in both the modern `["interpolate", …]` expression and the legacy `{"stops": [[zoom, value], …]}` object (#1976): a shared isZoomInterpCandidate pre-gate (paint-helpers.ts) admits both shapes, and interpolateZoomStops already lifted the legacy form into the same InterpolateZoomShape the modern path produces. A single-stop legacy function folds to the constant array it denotes (foldSingleStopZoomFunction, applied once at the paintToUtilities props-bag boundary — range-typed only: categorical/unknown `type` keeps its drop path) instead of dropping. A 1-element dash array [a] — constant or interp stop value — normalizes to [a, a] per the SVG/MapLibre odd-length dash repeat rule (Carto Dark Matter boundary_county); longer odd lengths stay as authored. The converter emits a bracket binding (stroke-dasharray-[interpolate(zoom, z, [a,b], …)]); extractInterpolateZoomArrayStops lowers the array-valued stops to StrokeValue.dashArrayShape (PropertyShape<number[]>); resolveShow STEPs to the nearest zoom stop (resolveArrayShape — Mapbox line-dasharray is interpolated:false) into ResolvedShow.dashArray; VTR prefers it over the static array, scaling by mpp. `["step", ["zoom"], base, z1, v1, …]` (#1994) now lifts too — resolveArrayShape already STEPs to the last stop whose zoom <= cameraZoom regardless of which Mapbox expression authored the binding (dasharray is interpolated:false either way), so step\'s own breakpoints map directly onto the SAME interpolate(zoom, …) binding (base at a sentinel zoom of 0, camera zoom never being negative) — an EXACT translation, not an approximation. Data-driven (per-feature, e.g. `["step", ["get", …], …]`) dash still drops with a warning.',
    source:
      'paint.ts:addStrokeDash + lower-helpers.ts:extractInterpolateZoomArrayStops + paint-shape-resolve.ts:resolveArrayShape',
  },
  {
    name: 'line-blur',
    status: 'supported',
    note: 'Edge feathering in CSS px. The line shader uses `aa_width_px` to widen both the geometry quad and the smoothstep range so the edge soft-fades over `1.5 + blur` px each side. Constant only — interpolate-by-zoom warns and drops.',
    source: 'paint.ts:190',
  },
  {
    name: 'line-gap-width',
    status: 'supported',
    impact: 'medium',
    note: 'Constant + zoom-interp last-stop approx end-to-end via stroke-gap-N utility. Runtime double-draws each line at ±(gap+stroke)/2 via writeLayerSlot (iter 499). OFM road-casing layers honoured. Iter 498 + 499 + 513 shipped 2026-05-18.',
    source: 'paint.ts:addLineGapWidth',
  },
  {
    name: 'line-offset',
    status: 'supported',
    note: 'Positive Mapbox values (right of travel) → `stroke-offset-right-N`; negative → `stroke-offset-left-N`. The xgis line renderer threads `strokeOffset` through to the vertex shader including offset-aware miter / join geometry. Constant only — interpolate-by-zoom warns and drops.',
    source: 'paint.ts:175',
  },
  {
    name: 'line-translate',
    status: 'supported',
    impact: 'low',
    note: 'WS-1 — constant vec2 AND per-frame zoom-interp (mirrors fill-translate), now in both the modern `["interpolate", …]` expression and the legacy `{"stops": [[zoom, [dx, dy]], …]}` object (#1976): the shared isZoomInterpCandidate pre-gate (paint-helpers.ts) admits both shapes into vec2AxisZoomInterp. A single-stop legacy function folds to the constant vec2 it denotes (foldSingleStopZoomFunction, applied once at the paintToUtilities props-bag boundary — range-typed only: categorical/unknown `type` keeps its drop path) instead of dropping. Converter emits scalar stroke-translate-{x,y} bracket bindings for the zoom-interp form; lower builds strokeTranslate{X,Y}Shape; resolveShow resolves each frame into ResolvedShow.strokeTranslateX/Y; VTR bakes CSS px → NDC into LineLayer uniform slots 48/49 (u.line_translate_x/y), applied in vs_line post-MVP. Anchor (viewport / map) handled by line-translate-anchor. Data-driven (per-feature) form still drops with a warning.',
    source: 'paint.ts:addLineTranslate + resolved-show.ts',
  },
  {
    name: 'line-translate-anchor',
    status: 'supported',
    impact: 'low',
    note: 'viewport (default) = screen-space offset, byte-identical to the historical path (emits nothing). map = world-space: the converter emits `stroke-translate-anchor-map` (addTranslateAnchor; the line translate rides the stroke-translate namespace) → lower sets RenderNode.strokeTranslateAnchorMap → ShowCommand → VTR rotates the [dx,dy] offset by camera.bearing before the CSS-px → NDC bake. Pitch foreshortening of a map-anchored offset is not reproduced by the clip-space bake (bearing rotation is the dominant/flat behaviour). Depends on line-translate.',
    source: 'paint-line.ts addTranslateAnchor + vector-tile-renderer.ts bearing rotate',
  },
  {
    name: 'line-pattern',
    status: 'supported',
    impact: 'low',
    note: 'Stage 2 landed iter-185 2026-05-20. line-renderer declares sprite_atlas at binding 5 + sprite_samp at binding 6 (shared TileBindGroupLayout with VTR so iter-181/182 atlas binding is already attached). New `fs_line_pattern` fragment + `pipelinePattern` alpha-blend pipeline. Pattern shows route via getDrawPipeline(translucent, patternActive=true). World-anchored UV (abs_merc / repeat_m) — Stage 2.1 along-line UV (arc length + transverse v) is a follow-up refinement. UV bbox packed into stroke_color uniform slot (20-23); repeat metres packed into layer.color.r / .a via writeLayerSlot override. Constant string form supported end-to-end. iter-165 probe: ZERO line-pattern uses in OFM bright/liberty target fixtures, so visual A/B unavailable against current set — Stage 2 is insurance for other styles (USA OSM / custom sprites).',
    source: 'line-renderer.ts iter-178/185',
  },
  {
    name: 'line-gradient',
    status: 'partial',
    impact: 'low',
    note: 'Colour ramp along the line, sampled at ["line-progress"]. #2117 lowered the supported form end to end: ["interpolate", ["linear"], ["line-progress"], p0, c0, …] becomes the `stroke-gradient-[…]` binding, rides the LineLayer uniform\'s 8-stop ramp lane (the dash_array lane\'s shape — the line pipeline has no per-LAYER texture slot to hang a 256-texel LUT on, since group(1) is built once per tile SEGMENT BUFFER while the style rides a dynamic offset), and fs_line evaluates the authored stops analytically. NO new arc-length authority was introduced: progress is arc_pos / line_length, both already stamped for the DASH phase (vector-tiler augmentChainWithArc -> vertex[5]; line-segment-build arcTotal -> LineSegment.line_length), so Mapbox\'s `lineMetrics: true` opt-in has no counterpart to honour. PARTIAL for two reasons, both warned or fixture-pinned rather than silent: (1) progress is normalised over the arc of the TILE-CLIPPED chain, so a GeoJSON feature the tiler splits renders one 0->1 ramp PER TILE — closing that needs the geojson-vt clip stage to carry each clipped segment\'s [progressStart, progressEnd] fraction of the original arc, which is the bulk of the work and not in this increment; (2) vector-tile sources are REFUSED with a precise warning (the layer\'s `source-layer` is the layer-local witness of the source kind), matching Mapbox/MapLibre\'s own GeoJSON-only restriction and for the same reason. Every other form — a non-expression value, a non-interpolate root, a non-linear curve, an input other than ["line-progress"], or a ramp past the 8-stop budget — warns with property + reason + alternative instead of dropping.',
    source: 'paint-line.ts addLineGradient / shaders/dsl/line-gradient.ts',
  },
]
