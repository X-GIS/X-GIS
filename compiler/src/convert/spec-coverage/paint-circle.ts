import type { CoverageEntry } from './types'

export const PAINT_CIRCLE: readonly CoverageEntry[] = [
  {
    name: 'circle-radius',
    status: 'supported',
    note: 'Constant + interpolate-by-zoom + per-feature expression. CSS px (Mapbox radius = xgis size).',
    source: 'layers.ts:537',
  },
  {
    name: 'circle-color',
    status: 'supported',
    note: 'Constant + interpolate-by-zoom + per-feature case/match.',
  },
  {
    name: 'circle-opacity',
    status: 'supported',
    note: 'Mapbox 0..1 → xgis 0..100 scaled. Constant + interpolate-by-zoom.',
  },
  { name: 'circle-stroke-color', status: 'supported' },
  {
    name: 'circle-stroke-width',
    status: 'supported',
    note: 'CSS px; constant + interpolate-by-zoom.',
  },
  {
    name: 'circle-blur',
    status: 'partial',
    impact: 'low',
    note: 'Constant numeric form extends the point fragment smoothstep AA band via circle_params.z in the point uniform (layers-circle.ts). Zoom-interp / data-driven forms warn + drop — need a per-feature feat_data slot for per-feature blur.',
    source: 'layers-circle.ts:circle-blur block',
  },
  {
    name: 'circle-stroke-opacity',
    status: 'supported',
    impact: 'low',
    note: "Constant numeric form folds into stroke-color hex alpha at compile time (iter 4). Zoom-interp form (WS-1, part 4) emits a stroke-opacity-[interpolate(zoom, …)] binding that lower.ts threads to ShowCommand.circleStrokeOpacityShape; PointRenderer.updateDynamicSizes resolves it per frame (resolveNumberShape) and multiplies the alpha into the circle's baked stroke alpha (feat_data slot 8). Non-interpolate data-driven forms still warn + drop.",
    source: 'layers-circle.ts:circle-stroke block',
  },
  {
    name: 'circle-translate',
    status: 'supported',
    impact: 'low',
    note: 'Constant [dx, dy] vec2 AND per-frame zoom-interp now wired end-to-end through the point frame uniform (circle_params.xy — uf 32/33). The constant form emits circle-translate-x-N / circle-translate-y-M; the zoom-interp form splits the vec2 per-axis into circle-translate-{x,y}-[interpolate(zoom, …)] bindings (mirrors addFillTranslate). lower.ts threads both the constant ShowCommand.circleTranslateX/Y and the circleTranslate{X,Y}Shape; PointRenderer.updateDynamicSizes resolves the shapes each frame (resolveNumberShape) into the layer translate the uniform bakes to NDC-per-pixel. This also closed the prior gap where the GeoJSON point addLayer path (map.ts) never threaded circle-translate at all. circle-translate-anchor:map stays deferred (WS-4a).',
    source: 'layers-circle.ts:circle-translate block',
  },
  {
    name: 'circle-translate-anchor',
    status: 'partial',
    impact: 'low',
    note: "viewport (spec default) is the only honoured mode — X-GIS point renderer always applies the translate in viewport/NDC space. 'map'-anchor (world-space shift) is unsupported and warns + drops. The anchor no-op suppression (when circle-translate is absent) mirrors fill-translate-anchor behaviour.",
    source: 'layers-circle.ts:circle-translate-anchor block',
  },
  {
    name: 'circle-pitch-scale',
    status: 'supported',
    impact: 'low',
    note: "viewport (spec default — radius constant in screen px, byte-identical) AND map. The converter emits a circle-pitch-scale-map flag only for 'map'; lower threads it through RenderNode/ShowCommand.circlePitchScaleMap → PointRenderer packs it into the point uniform circle_params.w, and the point VS scales the screen radius by w_ref/clip.w (w_ref = mvp[3][3]) so circles foreshorten with pitch/distance — mirrors MapLibre circle.vertex.glsl's pitch-scale:map for the viewport-aligned path.",
    source: 'layers-circle.ts:circle-pitch-scale block',
  },
  {
    name: 'circle-pitch-alignment',
    status: 'partial',
    impact: 'low',
    note: "viewport (the SPEC DEFAULT here — billboard, byte-identical to today) vs map (the disc lies in the ground plane and foreshortens into an ellipse under pitch). #2118 wired 'map': the converter emits a circle-pitch-alignment-map utility, the IR carries it as ShowCommand.circlePitchAlignmentMap on its OWN field, and PointRenderer raises the point uniform's circle_params.w to mode 2, at which the point VS maps the quad's local axes through the ground basis (the same groundBasisAt/groundPerspectiveScale pair the curved-label path uses — one authority, not a second). NOTE THE ASYMMETRY: this knob's default is 'viewport' while its sibling circle-pitch-scale's is 'map' — they are OPPOSITES, and that is what a re-derivation gets wrong. circle_params.w is an ENUM (0 = viewport/viewport, 1 = viewport align + map scale, 2 = map align), not a bit field, because under alignment:map the ground basis ALREADY carries the distance foreshortening and mode 2 must not also take mode 1's w_ref radius multiplier — a bit field would let both fire and count the perspective twice. An unpitched camera suppresses the whole mode on `pitch` rather than on the computed basis, which is what makes 'an unpitched frame is bit-identical to before #2118' a property of the code instead of a float argument. PARTIAL for one refused pairing: alignment 'map' with an EXPLICIT scale 'viewport' emits nothing and degrades to today, because approximating it would show the author a disc that shrinks with distance when they explicitly asked it not to.",
    source:
      'layers-circle.ts / render/point-renderer.ts writePointFrameUniform / shaders/dsl/point.ts',
  },
]
