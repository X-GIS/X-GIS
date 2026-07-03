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
    note: 'WS-1 — constant numeric array AND per-frame zoom-interp. The converter emits a bracket binding (stroke-dasharray-[interpolate(zoom, z, [a,b], …)]); extractInterpolateZoomArrayStops lowers the array-valued stops to StrokeValue.dashArrayShape (PropertyShape<number[]>); resolveShow STEPs to the nearest zoom stop (resolveArrayShape — Mapbox line-dasharray is interpolated:false) into ResolvedShow.dashArray; VTR prefers it over the static array, scaling by mpp. data-driven (per-feature) dash still drops with a warning.',
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
    note: 'WS-1 — constant vec2 AND per-frame zoom-interp (mirrors fill-translate). Converter emits scalar stroke-translate-{x,y} bracket bindings for the zoom-interp form; lower builds strokeTranslate{X,Y}Shape; resolveShow resolves each frame into ResolvedShow.strokeTranslateX/Y; VTR bakes CSS px → NDC into LineLayer uniform slots 48/49 (u.line_translate_x/y), applied in vs_line post-MVP. Anchor (viewport / map) handled by line-translate-anchor.',
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
    status: 'unsupported',
    impact: 'low',
    note: "Gradient along the line via [\"line-progress\"]. iter-166 probe: ZERO uses in OFM bright/liberty (also 0 lineMetrics declarations) — empirically confirms the low impact rating. Implementation cost (iter-158 scoping, the renderer change is NOT the hard part): (1) PREREQUISITE — geojson-vt currently IGNORES source.lineMetrics (geojsonvt/index.ts:14, sources.ts:406). line-progress is normalised over the ORIGINAL feature but geojson-vt clips lines per tile, so the clip stage must track each clipped segment's [progressStart,progressEnd] fraction of the original arc-length. This compiler-tiler change is the bulk of the work. (2) line-segment-build.ts interpolates per-vertex progress 0..1. (3) new per-vertex progress attribute + WGSL line fragment samples a gradient LUT the converter emits from the line-gradient interpolate stops. ~5 files; multi-day; not a surgical fix. PMTiles vector sources can't support it anyway (don't preserve original-line arc-length across tile boundaries) — feature is GeoJSON-source-with-lineMetrics-true only, niche.",
    source: 'paint.ts:218 specific warning',
  },
]
