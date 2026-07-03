import type { CoverageEntry } from './types'

export const PAINT_FILL_EXTRUSION: readonly CoverageEntry[] = [
  { name: 'fill-extrusion-color', status: 'supported' },
  { name: 'fill-extrusion-opacity', status: 'supported' },
  {
    name: 'fill-extrusion-height',
    status: 'supported',
    note: 'Constant + interpolate-by-zoom + per-feature expression.',
    source: 'paint.ts:154',
  },
  { name: 'fill-extrusion-base', status: 'supported', source: 'paint.ts:165' },
  {
    name: 'fill-extrusion-translate',
    status: 'supported',
    impact: 'low',
    note: 'WS-1 — routed through addFillTranslate alongside fill-translate, so it inherits the per-frame zoom-interp path (fillTranslate{X,Y}Shape → resolveShow → VTR). The fill-extrusion vertex shaders (vs_main_quantized + vs_main_quantized_extruded) apply u.fill_translate_x/y. Constant vec2 AND per-frame zoom-interp supported. Replaces the old last-stop approximation (iter-180).',
    source: 'paint.ts:addFillTranslate + resolved-show.ts',
  },
  {
    name: 'fill-extrusion-translate-anchor',
    status: 'supported',
    impact: 'low',
    note: 'viewport (default) = screen-space, byte-identical (emits nothing). map = world-space: fill-extrusion-translate rides the SAME fill-translate-{x,y} utilities + slot 46/47 uniform as fill (the extrude vertex shaders apply u.fill_translate_x/y), so the converter emits `fill-translate-anchor-map` (addTranslateAnchor, fill prefix) → RenderNode.fillTranslateAnchorMap → ShowCommand → VTR rotates the [dx,dy] offset by camera.bearing before the px→NDC bake — the extrude path inherits the rotation for free. Pitch foreshortening not reproduced. Depends on fill-extrusion-translate.',
    source: 'paint-fill-extrusion.ts addTranslateAnchor + vector-tile-renderer.ts bearing rotate',
  },
  {
    name: 'fill-extrusion-pattern',
    status: 'supported',
    impact: 'low',
    note: 'Stage 2 landed iter-186 2026-05-20. New `fillPipelinePatternExtruded` + Fallback variants (vs_main_quantized_extruded vertex + extrudedZBufferLayout for per-feature z + fs_fill_pattern fragment). VTR routes extruded pattern shows via setPatternExtrudedPipelines + an extrudedPatternActive gate symmetric with the iter-183 ground path. Same world-anchored UV math as fill-pattern + line-pattern (abs_merc / repeat_m). Documented Stage 2 trade-off: pattern-extrude shows lose the per-fragment wall_shade lighting — sprite colour replaces the shaded fill rgb directly. Stage 2.1 (dedicated fs_fill_pattern_extruded that multiplies the sample by wall_shade) is a follow-up refinement. Constant string form supported end-to-end. iter-165 probe: ZERO uses in OFM bright/liberty target fixtures — Stage 2 is insurance for other styles.',
    source: 'paint.ts:270 iter-179/186',
  },
  {
    name: 'fill-extrusion-vertical-gradient',
    status: 'supported',
    impact: 'low',
    note: "Default `true` is honoured end-to-end — the extrude vertex shader applies the 0.7→1.0 vertical-gradient wall ramp matching MapLibre. The `false` opt-out is now wired: converter emits `fill-extrusion-vertical-gradient-false` (paint.ts) → ShowCommand.fillExtrusionVerticalGradient → the polygon uniform's spare cam_ecef_off_l.w lane → vs_main_ecef_extruded ANDs the flag into the per-wall gradient test so walls shade flat. Default path is byte-identical (flag = 1).",
    source:
      'paint.ts fill-extrusion-vertical-gradient-false / polygon.ts vs_main_ecef_extruded vgrad gate',
  },
  {
    name: 'fill-extrusion-ambient-occlusion-intensity',
    status: 'unsupported',
    impact: 'low',
    note: 'AO would need per-vertex normal + screen-space AO pass. Not in current renderer.',
  },
  {
    name: 'fill-extrusion-ambient-occlusion-radius',
    status: 'unsupported',
    impact: 'low',
    note: 'See fill-extrusion-ambient-occlusion-intensity.',
  },
]
