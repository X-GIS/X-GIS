// ═══ Demo Definitions — Minimum-data e2e fixtures — each isolates a single feature/code path. ═══
// Faithful per-category fragment of the single DEMOS record (assembled in
// ../demos.ts, which preserves the original insertion order). Demo .xgis
// sources load via the shared loader; ids are unchanged (URL nav depends on
// them). Append-only: a new demo in this category is added HERE.

import { load, type Demo } from './loader'

export const DEMOS_FIXTURES: Record<string, Demo> = {
  // Minimum-data e2e fixtures. Each isolates a single feature so
  // failures pinpoint the exact code path. Documented in
  // playground/e2e/fixtures.spec.ts. Inspect manually via
  // ?id=fixture_point etc.

  fixture_point: {
    name: 'Fixture: point',
    tag: 'fixture',
    description:
      'Single SDF point at (0, 0). Used by e2e fixture tests to validate the pointRenderer code path in isolation.',
    source: load('fixture-point.xgis'),
  },
  fixture_symbol_icon: {
    name: 'Fixture: symbol icon (host image)',
    tag: 'fixture',
    description:
      'Label + host-image icon (label-icon-image-*) over the spriteUrl-less host-atlas path — push data + addImage from the host.',
    source: load('fixture-symbol-icon.xgis'),
  },
  fixture_symbol_icon_textfit: {
    name: 'Fixture: symbol icon-text-fit (local sprite)',
    tag: 'fixture',
    description:
      'Shield sprite stretched to its PAIRED text bbox via icon-text-fit: both (#777 I-A). Two symbol layers — a 2-digit ("12") narrow shield and a 5-digit ("12345") wide one — over the local sprite atlas. Load with &sprite=/fixture-sprite. §5 probe: A/B vs MapLibre, DC>0 confined to the shield quads.',
    source: load('fixture-symbol-icon-textfit.xgis'),
  },
  fixture_format_image: {
    name: 'Fixture: inline image in label text (local sprite)',
    tag: 'fixture',
    description:
      'Inline sprite inside a formatted label (#777 I-G): text-field concat("A ", image("pat"), " B") renders the "pat" sprite (16x16) INLINE on the text baseline, advancing the post-image text by the image width. Over the local sprite atlas — load with &sprite=/fixture-sprite. §5 probe: /demo.html?id=fixture_format_image&sprite=/fixture-sprite ; A/B vs MapLibre, DC>0 confined to the image quad + shifted post-image glyphs.',
    source: load('fixture-format-image.xgis'),
  },
  fixture_raster_local: {
    name: 'Fixture: raster (local checker)',
    tag: 'fixture',
    description:
      'Deterministic offline raster tile (no {z}/{x}/{y}) for the P1.4 RHI-flip DC=0 gate.',
    source: load('fixture-raster-local.xgis'),
  },
  fixture_hillshade_local: {
    name: 'Fixture: hillshade (local DEM)',
    tag: 'fixture',
    description:
      'Deterministic offline raster-dem DEM tile (Terrain-RGB radial hill, no {z}/{x}/{y}) drawn as shaded relief (#777 Phase II). The raster-dem source routes to the HillshadeRenderer. Opens at z11 (a whole-world DEM is physically near-flat at low zoom). §5 probe: /demo.html?id=fixture_hillshade_local — real-GPU A/B vs a MapLibre hillshade on the same DEM (INC-6).',
    source: load('fixture-hillshade-local.xgis'),
    zoom: 11,
  },
  fixture_hillshade_basic: {
    name: 'Fixture: hillshade method=basic',
    tag: 'fixture',
    description:
      'hillshade-method matrix over the local DEM: `basic` (GDAL Lambert). Paired with fixture_hillshade_local (standard) by _hillshade-methods-gl2-gate — each method must render relief AND differ from standard.',
    source: load('fixture-hillshade-basic.xgis'),
    zoom: 11,
  },
  fixture_hillshade_combined: {
    name: 'Fixture: hillshade method=combined',
    tag: 'fixture',
    description:
      'hillshade-method matrix over the local DEM: `combined` (slope-weighted Lambert angle).',
    source: load('fixture-hillshade-combined.xgis'),
    zoom: 11,
  },
  fixture_hillshade_igor: {
    name: 'Fixture: hillshade method=igor',
    tag: 'fixture',
    description:
      'hillshade-method matrix over the local DEM: `igor` (aspect-weighted slope strength).',
    source: load('fixture-hillshade-igor.xgis'),
    zoom: 11,
  },
  fixture_hillshade_multidir: {
    name: 'Fixture: hillshade method=multidirectional',
    tag: 'fixture',
    description:
      'hillshade-method matrix over the local DEM: `multidirectional` with three tinted light sources — exercises the numbered source-2..4 utilities → hs_light2..4 uniform lanes → unrolled 4-source shader loop end-to-end.',
    source: load('fixture-hillshade-multidir.xgis'),
    zoom: 11,
  },
  fixture_line: {
    name: 'Fixture: line (2pt)',
    tag: 'fixture',
    description: '2-vertex line, no join.',
    source: load('fixture-line.xgis'),
  },
  fixture_line_join: {
    name: 'Fixture: line join',
    tag: 'fixture',
    description: '3-vertex sharp turn — miter join.',
    source: load('fixture-line-join.xgis'),
  },
  fixture_triangle: {
    name: 'Fixture: triangle',
    tag: 'fixture',
    description: 'Closed 3-vertex polygon.',
    source: load('fixture-triangle.xgis'),
  },
  fixture_square: {
    name: 'Fixture: square',
    tag: 'fixture',
    description: '4-vertex polygon (2-triangle tessellation).',
    source: load('fixture-square.xgis'),
  },
  fixture_stroke_fill: {
    name: 'Fixture: stroke + fill',
    tag: 'fixture',
    description: 'Same layer fill + stroke.',
    source: load('fixture-stroke-fill.xgis'),
  },
  fixture_dashed_line: {
    name: 'Fixture: dashed line',
    tag: 'fixture',
    description: 'Dash shader.',
    source: load('fixture-dashed-line.xgis'),
  },
  fixture_translucent_stroke: {
    name: 'Fixture: translucent stroke',
    tag: 'fixture',
    description: 'Bucket 2 offscreen path.',
    source: load('fixture-translucent-stroke.xgis'),
  },
  fixture_multi_layer: {
    name: 'Fixture: multi-layer',
    tag: 'fixture',
    description: 'Two overlapping polygons — draw order.',
    source: load('fixture-multi-layer.xgis'),
  },
  fixture_anim_opacity: {
    name: 'Fixture: anim opacity',
    tag: 'fixture',
    description: 'Opacity keyframe (Bug 1 isolation).',
    source: load('fixture-anim-opacity.xgis'),
  },
  fixture_anim_color: {
    name: 'Fixture: anim color',
    tag: 'fixture',
    description: 'Fill keyframe (Bug 1 cross-property).',
    source: load('fixture-anim-color.xgis'),
  },
  fixture_sdf_point: {
    name: 'Fixture: SDF pin',
    tag: 'fixture',
    description: 'Billboard with anchor-bottom.',
    source: load('fixture-sdf-point.xgis'),
  },
  fixture_sdf_glow: {
    name: 'Fixture: SDF glow',
    tag: 'fixture',
    description: 'Translucent halo + opaque pin.',
    source: load('fixture-sdf-glow.xgis'),
  },
  fixture_categorical: {
    name: 'Fixture: categorical',
    tag: 'fixture',
    description: 'match() data-driven fill.',
    source: load('fixture-categorical.xgis'),
  },
  fixture_picking: {
    name: 'Fixture: picking',
    tag: 'fixture',
    description:
      'Three quadrants with distinct IDs — pickAt at known positions returns expected featureId. Picking + overlay enabled for manual inspection.',
    source: load('fixture-picking.xgis'),
    picking: true,
  },
  fixture_mercator_clip: {
    name: 'Fixture: mercator clip',
    tag: 'fixture',
    description: 'Polar polygon — Mercator clipping.',
    source: load('fixture-mercator-clip.xgis'),
  },
  fixture_antimeridian: {
    name: 'Fixture: antimeridian',
    tag: 'fixture',
    description: 'Polygon crossing 180°.',
    source: load('fixture-antimeridian.xgis'),
  },
  // Curated interaction fixtures
  fixture_x_translucent_anim: {
    name: 'Fixture×: translucent + anim',
    tag: 'fixture',
    description: 'Bucket 2 + opacity keyframe.',
    source: load('fixture-x-translucent-anim.xgis'),
  },
  fixture_x_points_translucent: {
    name: 'Fixture×: points + translucent',
    tag: 'fixture',
    description: 'Bug 2 mirror — direct points + bucket 2.',
    source: load('fixture-x-points-translucent.xgis'),
  },
  fixture_x_zoom_time_opacity: {
    name: 'Fixture×: zoom × time opacity',
    tag: 'fixture',
    description: 'Multiplicative composition.',
    source: load('fixture-x-zoom-time-opacity.xgis'),
  },
  fixture_x_anim_multi_property: {
    name: 'Fixture×: anim multi-property',
    tag: 'fixture',
    description: 'Bug 1 mirror — opacity+fill+stroke+width keyframes.',
    source: load('fixture-x-anim-multi-property.xgis'),
  },
  // Reftest pairs (each pair must render identically)
  reftest_triangle_static: {
    name: 'Reftest A: triangle static',
    tag: 'fixture',
    description: 'Triangle via static fill — reference.',
    source: load('reftest-triangle-static.xgis'),
  },
  reftest_triangle_match: {
    name: 'Reftest B: triangle match()',
    tag: 'fixture',
    description: 'Triangle via match() with single arm — must equal static.',
    source: load('reftest-triangle-match.xgis'),
  },
  reftest_zoom_static: {
    name: 'Reftest A: zoom static',
    tag: 'fixture',
    description: 'Square with static opacity — reference.',
    source: load('reftest-zoom-static.xgis'),
  },
  reftest_zoom_degenerate: {
    name: 'Reftest B: zoom degenerate',
    tag: 'fixture',
    description: 'Square with degenerate zoom-opacity stops — must equal static.',
    source: load('reftest-zoom-degenerate.xgis'),
  },
  reftest_stroke_static: {
    name: 'Reftest A: stroke static',
    tag: 'fixture',
    description: 'Line with static stroke — reference.',
    source: load('reftest-stroke-static.xgis'),
  },
  reftest_stroke_keyframe_static: {
    name: 'Reftest B: stroke keyframe static',
    tag: 'fixture',
    description: 'Line with degenerate stroke keyframe — must equal static.',
    source: load('reftest-stroke-keyframe-static.xgis'),
  },
  // Stress fixtures (exercise validation capture)
  fixture_stress_all_renderers: {
    name: 'Stress: all renderers',
    tag: 'fixture',
    description: 'Polygon fill + SDF line + SDF point in one frame.',
    source: load('fixture-stress-all-renderers.xgis'),
  },
  fixture_extrude_local: {
    name: 'Fixture: extrude (local)',
    tag: 'fixture',
    description: 'Constant-height 3D-extruded polygon through the VTR (P1.6 extrude verify).',
    source: load('fixture-extrude-local.xgis'),
  },
  fixture_flat_local: {
    name: 'Fixture: flat (local)',
    tag: 'fixture',
    description: 'Flat polygon through the VTR, fill only (P1.6 no-pick flat verify).',
    source: load('fixture-flat-local.xgis'),
  },
  fixture_fill_pattern: {
    name: 'Fixture: fill pattern (local sprite)',
    tag: 'fixture',
    description:
      'Polygon filled via fill-pattern (fs_fill_pattern) sampling a local sprite atlas — selects fillPipelinePatternGround for the §4 RHI Material twin DC=0 gate. Load with &sprite=/fixture-sprite.',
    source: load('fixture-fill-pattern.xgis'),
  },
  fixture_bg_pattern: {
    name: 'Fixture: background pattern (local sprite)',
    tag: 'fixture',
    description:
      'Background whose only paint is a sprite pattern (background { pattern: pat }) tiled over the coverage clear by the background pass first draw (#777 I-E, fs_pattern, wrapped UV). Load with &sprite=/fixture-sprite.',
    source: load('fixture-bg-pattern.xgis'),
  },
  fixture_stress_many_layers: {
    name: 'Stress: many layers',
    tag: 'fixture',
    description: '8 filtered layers from one source — uniform ring boundary.',
    source: load('fixture-stress-many-layers.xgis'),
  },
  // Extension: caps/joins/patterns/align/offset/easing/data-driven/shape
  fixture_cap_round: {
    name: 'Fixture: cap round',
    tag: 'fixture',
    description: 'stroke-round-cap isolated.',
    source: load('fixture-cap-round.xgis'),
  },
  fixture_cap_square: {
    name: 'Fixture: cap square',
    tag: 'fixture',
    description: 'stroke-square-cap isolated.',
    source: load('fixture-cap-square.xgis'),
  },
  fixture_join_round: {
    name: 'Fixture: join round',
    tag: 'fixture',
    description: 'stroke-round-join on sharp turn.',
    source: load('fixture-join-round.xgis'),
  },
  fixture_join_bevel: {
    name: 'Fixture: join bevel',
    tag: 'fixture',
    description: 'stroke-bevel-join on sharp turn.',
    source: load('fixture-join-bevel.xgis'),
  },
  fixture_pattern_multi: {
    name: 'Fixture: pattern multi-slot',
    tag: 'fixture',
    description: '2-slot pattern stack (dot + cross).',
    source: load('fixture-pattern-multi.xgis'),
  },
  ofm_bright_local: {
    name: 'OFM Bright (offline mirror, Tokyo z14)',
    tag: 'fixture',
    description:
      'OpenFreeMap Bright from the local /ofm-mirror snapshot — the #834 M5 forcegl2 final-gate fixture. Only valid at #14/35.68/139.76.',
    source: load('ofm-bright-local.xgis'),
  },
  fixture_translucent_outline: {
    name: 'Fixture: translucent outline (MAX+composite)',
    tag: 'fixture',
    description:
      'Polygon with fill + inset stroke at opacity-60 — the stroke half routes through the translucent offscreen MAX-blend + composite bucket.',
    source: load('fixture-translucent-outline.xgis'),
  },
  fixture_line_image_pattern: {
    name: 'Fixture: line image pattern (local sprite)',
    tag: 'fixture',
    description:
      'Line stroked via Mapbox line-pattern (stroke-image-, fs_line_pattern) sampling a local sprite atlas. Load with &sprite=/fixture-sprite.',
    source: load('fixture-line-image-pattern.xgis'),
  },
  fixture_stroke_inset: {
    name: 'Fixture: stroke inset',
    tag: 'fixture',
    description: 'stroke-inset on polygon boundary.',
    source: load('fixture-stroke-inset.xgis'),
  },
  fixture_stroke_offset_right: {
    name: 'Fixture: stroke offset right',
    tag: 'fixture',
    description: 'Signed stroke-offset-right-8 rail.',
    source: load('fixture-stroke-offset-right.xgis'),
  },
  fixture_stroke_offset_right_large: {
    name: 'Fixture: stroke offset right (large)',
    tag: 'fixture',
    description: 'stroke-offset-right-80 — exercises offset-aware tile culling margin.',
    source: load('fixture-stroke-offset-right-large.xgis'),
  },
  fixture_anim_ease_linear: {
    name: 'Fixture: anim ease linear',
    tag: 'fixture',
    description: 'Opacity keyframe with linear easing.',
    source: load('fixture-anim-ease-linear.xgis'),
  },
  fixture_dasharray_complex: {
    name: 'Fixture: dasharray complex',
    tag: 'fixture',
    description: '4-value composite dash array.',
    source: load('fixture-dasharray-complex.xgis'),
  },
  fixture_size_expr: {
    name: 'Fixture: size expr',
    tag: 'fixture',
    description: 'Point size-[sqrt(.pop) / 2] expression.',
    source: load('fixture-size-expr.xgis'),
  },
  fixture_filter_complex: {
    name: 'Fixture: filter complex',
    tag: 'fixture',
    description: 'Filter .kind == "b" — renders only middle.',
    source: load('fixture-filter-complex.xgis'),
  },
  fixture_shape_custom_svg: {
    name: 'Fixture: custom SVG shape',
    tag: 'fixture',
    description: 'Point with local symbol diamond.',
    source: load('fixture-shape-custom-svg.xgis'),
  },
  // Extension 2: projection/anchor/size-zoom/pattern/miterlimit/anim-dashoffset
  fixture_projection_equirectangular: {
    name: 'Fixture: projection equirect',
    tag: 'fixture',
    description: 'Equirectangular projection on a simple polygon.',
    source: load('fixture-projection-equirectangular.xgis'),
  },
  fixture_anchor_center: {
    name: 'Fixture: anchor center',
    tag: 'fixture',
    description: 'SDF point anchor-center mode.',
    source: load('fixture-anchor-center.xgis'),
  },
  fixture_anchor_top: {
    name: 'Fixture: anchor top',
    tag: 'fixture',
    description: 'SDF point anchor-top mode.',
    source: load('fixture-anchor-top.xgis'),
  },
  fixture_flat_anchor_bottom: {
    name: 'Fixture: flat + anchor bottom',
    tag: 'fixture',
    description: 'Flat point anchor-bottom — quad lies on ground, extends north.',
    source: load('fixture-flat-anchor-bottom.xgis'),
  },
  fixture_size_zoom: {
    name: 'Fixture: size zoom stops',
    tag: 'fixture',
    description: 'z0:size-30 z20:size-80 interpolation.',
    source: load('fixture-size-zoom.xgis'),
  },
  fixture_stroke_outset: {
    name: 'Fixture: stroke outset',
    tag: 'fixture',
    description: 'stroke-outset alignment (mirror of inset).',
    source: load('fixture-stroke-outset.xgis'),
  },
  fixture_pattern_anchor_start: {
    name: 'Fixture: pattern anchor start',
    tag: 'fixture',
    description: 'Pattern pinned at line start.',
    source: load('fixture-pattern-anchor-start.xgis'),
  },
  fixture_pattern_anchor_end: {
    name: 'Fixture: pattern anchor end',
    tag: 'fixture',
    description: 'Pattern pinned at line end.',
    source: load('fixture-pattern-anchor-end.xgis'),
  },
  fixture_pattern_units_km: {
    name: 'Fixture: pattern units km',
    tag: 'fixture',
    description: 'km-unit spacing/size for stroke pattern.',
    source: load('fixture-pattern-units-km.xgis'),
  },
  fixture_anim_dashoffset: {
    name: 'Fixture: anim dashoffset',
    tag: 'fixture',
    description: 'Marching-ants animated dashoffset keyframe.',
    source: load('fixture-anim-dashoffset.xgis'),
  },
  fixture_miterlimit: {
    name: 'Fixture: miterlimit',
    tag: 'fixture',
    description: 'Sharp-angle miter→bevel fallback path.',
    source: load('fixture-miterlimit.xgis'),
  },
  // Extension 3: external data injection
  fixture_inline_push: {
    name: 'Fixture: inline push',
    tag: 'fixture',
    description: 'Inline source filled via setSourceData().',
    source: load('fixture-inline-push.xgis'),
  },
  fixture_inline_match: {
    name: 'Fixture: inline match()',
    tag: 'fixture',
    description: 'Inline source + per-feature match() colour via setSourceData() (#821).',
    source: load('fixture-inline-match.xgis'),
  },
  fixture_render_verify: {
    name: 'Fixture: render verify',
    tag: 'fixture',
    description:
      'Render-verification harness (Oracle-B): 4 inline sources (graticule/polys/lines/points) pushed via setSourceData; diffed vs a d3-geo Canvas reference.',
    source: load('fixture-render-verify.xgis'),
  },
  fixture_typed_array_points: {
    name: 'Fixture: typed-array points',
    tag: 'fixture',
    description: 'Inline source filled via setSourcePoints().',
    source: load('fixture-typed-array-points.xgis'),
  },

  // Extension 4: coverage gaps — cap/anchor/projection/zoom-opacity.
  fixture_cap_arrow: {
    name: 'Fixture: cap arrow',
    tag: 'fixture',
    description: 'stroke-arrow-cap directional taper.',
    source: load('fixture-cap-arrow.xgis'),
  },
  fixture_anchor_bottom: {
    name: 'Fixture: anchor bottom',
    tag: 'fixture',
    description: 'SDF point anchor-bottom (pin hangs above the anchor).',
    source: load('fixture-anchor-bottom.xgis'),
  },
  fixture_projection_orthographic: {
    name: 'Fixture: projection orthographic',
    tag: 'fixture',
    description: 'Orthographic (globe) projection with back-face culling.',
    source: load('fixture-projection-orthographic.xgis'),
  },
  fixture_projection_natural_earth: {
    name: 'Fixture: projection natural earth',
    tag: 'fixture',
    description: 'Natural Earth pseudocylindrical projection.',
    source: load('fixture-projection-natural-earth.xgis'),
  },
  fixture_zoom_opacity: {
    name: 'Fixture: zoom opacity stops',
    tag: 'fixture',
    description: 'z0:opacity-10 → z6:opacity-100 fade-in.',
    source: load('fixture-zoom-opacity.xgis'),
  },
  fixture_synth_bg_only: {
    name: 'Fixture: synth bg only',
    tag: 'fixture',
    description:
      'Synthetic earth-surface background fill only — AC2c.3.2 mesh density verification.',
    source: load('fixture-synth-bg-only.xgis'),
  },
}
