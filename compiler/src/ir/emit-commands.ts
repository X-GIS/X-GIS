// ═══ IR → SceneCommands Bridge ═══
// Converts IR Scene to the existing runtime SceneCommands format.
// This bridge allows the runtime to consume IR without changes.

import type { Scene, RenderNode, ColorValue, TimeStop, Easing, DataExpr } from './render-node'
import { rgbaToHex } from './render-node'
import type { PaintShapes, PropertyShape } from './property-types'
import { hasHillshadePaint, emitHillshadeShapes } from './emit-commands-hillshade'
import { colorValueToShape, sizeValueToShape } from './to-property-shape'
import { generateShaderVariant, type ShaderVariant } from '../codegen/shader-gen'
import { collectPalette, type Palette } from '../codegen/palette'
import { planComputeKernels, type ComputePlanEntry } from '../codegen/compute-plan'
import { buildPerShowMergedVariant } from '../codegen/compute-variant-build'

export type { ShaderVariant } from '../codegen/shader-gen'

export interface LoadCommand {
  name: string
  url: string
  /** Source `type:` from the DSL — `'geojson'` / `'pmtiles'` /
   *  `'tilejson'` / `'raster'` / `'xgvt'`. The runtime dispatches on
   *  this when set; falls back to URL-extension sniffing otherwise.
   *  Without it, a URL like `https://tiles.example.com/planet`
   *  (TileJSON manifest, no extension) gets misrouted as a generic
   *  GeoJSON `fetch().json()` and the engine crashes when it tries
   *  to read `data.features[0]` on the TileJSON document. */
  type?: string
  /** Optional MVT layer subset for PMTiles sources. See the parallel
   *  field on the legacy `interpreter.ts` LoadCommand. */
  layers?: string[]
  /** Optional source-level input CRS (EPSG code, e.g. `"EPSG:5179"`)
   *  threaded from IR `SourceDef.crs`. This is the runtime's carrier
   *  for the URL/command fetch path — the runtime reprojects this
   *  source's GeoJSON from this CRS to WGS84 LL once at registration.
   *  `"EPSG:4326"` (the geojson default) is a no-op. */
  crs?: string
  /** Inline GeoJSON threaded from IR `SourceDef.inlineData` (the
   *  `data: {...}` source-block form). When set, the runtime seeds this
   *  through the geojson ingest path instead of fetching `url`. Mirror
   *  field on the runtime `interpreter.ts` LoadCommand (two-sibling rule). */
  inlineData?: unknown
  /** Non-reserved source-block props for a CUSTOM `type`, threaded from IR
   *  `SourceDef.options`. The runtime hands these to a registered `SourceLoader`'s
   *  `ctx.options`. Undefined for built-in sources (byte-identical). */
  options?: Record<string, string | number | readonly string[]>
  /** `type: raster-dem` DEM elevation-pack encoding threaded from IR
   *  `SourceDef.encoding` — `'mapbox'` (default Terrain-RGB) / `'terrarium'`
   *  / `'custom'`. The (INC-3) hillshade renderer decodes elevation with the
   *  matching pack formula. Undefined for non-DEM sources. */
  encoding?: string
  /** `type: raster-dem` native tile pixel size (256 / 512), threaded from
   *  `SourceDef.tileSize`. Default 512. */
  tileSize?: number
  /** `encoding: custom` elevation unpack factors (threaded from `SourceDef`):
   *  `elevation_m = R*redFactor + G*greenFactor + B*blueFactor - baseShift`. */
  redFactor?: number
  greenFactor?: number
  blueFactor?: number
  baseShift?: number
  /** `type: coverage` colour-ramp LUT name + `[lo, hi]` display window,
   *  threaded from `SourceDef.ramp` / `SourceDef.range` (#1158) so the runtime
   *  arms the coverage renderer with the author's palette. Mirror fields on the
   *  runtime `interpreter.ts` LoadCommand (two-sibling rule). */
  ramp?: string
  range?: readonly [number, number]
}

// ─── Paint sub-bundles (Tier-B B2, rows 3/5) ───────────────────────
//
// The flat scalar PAINT fields were grouped PER CONCERN into the four
// interfaces below; `ShowCommand` then `extends` them. This is a TYPE-
// level grouping only — interface extension is structurally
// transparent, so every wire key (`fillTranslateX`, `strokeBlur`, …)
// stays exactly where it was: the emitted IR object is byte-identical
// and the ~80 runtime readers of `show.fillTranslateX` etc. are
// untouched. The grouping makes a fill-axis edit and a line-axis edit
// land in different interfaces (parallel-safe), and is the type-side
// companion to the composable `emit*Fields` emitters below. The same
// "PURE grouping: same field names" spirit as B1's PaintShapes split.

/** Polygon fill paint axes. */
export interface FillPaint {
  fill: string | null
  /** #732 S5 — optional per-feature FILL colour AST (data-driven point
   *  paint). Emitted when a point layer's `fill` is `data-driven` (a
   *  match/interpolate over a feature property). The GeoJSON point path
   *  (map.ts) evaluates it per feature into the POINT_FEAT fill slots —
   *  the colour-axis mirror of `sizeExpr`. Absent (undefined) for a
   *  constant fill, so the constant path stays byte-identical. */
  fillColorExpr?: DataExpr
  /** iter-177 Mapbox `fill-pattern` (constant string only at this
   *  stage). When set, the runtime resolves the sprite name against
   *  the sprite atlas and uses the sprite's centre pixel as the
   *  fill colour — placeholder for the proper UV-tiling fragment
   *  shader (Stage 2). null = no pattern authored. */
  fillPattern: string | null
  /** Mapbox `paint.fill-translate` (viewport-anchor) — CSS px
   *  offset on fills. Positive x = right, positive y = down. Runtime
   *  reads these into u.fill_translate_x / u.fill_translate_y
   *  (pre-baked as NDC-per-pixel) so the offset stays pixel-constant
   *  across any depth. Default 0/0 / undefined preserves the no-
   *  translate render path. */
  fillTranslateX?: number
  fillTranslateY?: number
  /** WS-1 — per-frame zoom-interp fill translate (per-axis scalar
   *  PropertyShape). Runtime prefers the shape over the constant
   *  fillTranslateX/Y, resolving the offset each frame. */
  fillTranslateXShape?: PropertyShape<number>
  fillTranslateYShape?: PropertyShape<number>
  /** Mapbox `paint.fill-translate-anchor` = "map". Default (undefined /
   *  "viewport") = screen-space offset, byte-identical to today. When
   *  true the runtime rotates the [dx,dy] offset by the map bearing so
   *  it tracks the map world axes (map/world-space anchor). */
  fillTranslateAnchorMap?: boolean
  /** Mapbox `paint.fill-antialias` opt-out. Default (undefined / true)
   *  preserves the current fill render path byte-for-byte; only `false`
   *  is passed through to disable the rim-alpha smoothstep at runtime. */
  fillAntialias?: boolean
}

/** Line / polygon-outline paint axes. */
export interface LinePaint {
  /** iter-178 Mapbox `line-pattern` (constant string only) — stroke-
   *  side mirror of fillPattern. null = no pattern authored. */
  linePattern: string | null
  stroke: string | null
  strokeWidth: number
  /** Optional per-feature stroke-width override AST. Compiler-
   *  synthesized only by the layer-merge pass when grouping
   *  same-source-layer xgis layers whose only stroke difference is
   *  the width (roads_minor / primary / highway pattern). The
   *  runtime worker evaluates this against each feature and writes
   *  the resolved width into the line segment buffer's per-segment
   *  slot; the line shader picks segment.width_px over the layer
   *  uniform when non-zero. */
  strokeWidthExpr?: DataExpr
  /** Optional per-feature stroke colour override AST. Synthesised
   *  by the merge pass when group members differ in stroke colour;
   *  resolved by the worker into a packed RGBA8 u32 baked into the
   *  segment buffer. */
  strokeColorExpr?: DataExpr
  linecap?: 'butt' | 'round' | 'square' | 'arrow'
  linejoin?: 'miter' | 'round' | 'bevel'
  miterlimit?: number
  /** Mapbox `line-round-limit` (default 1.05). Scales the line shader's
   *  round-join fold threshold; unset = no override (today's geometry). */
  roundLimit?: number
  dashArray?: number[]
  /** WS-1 — per-frame zoom-interp dasharray (STEP — Mapbox line-dasharray
   *  is `interpolated: false`). `null` = constant-only; the runtime prefers
   *  this over `dashArray` when present. */
  dashArrayShape: PropertyShape<number[]> | null
  /** Dash offset as a PropertyShape — composed from the static
   *  `stroke.dashOffset` and any `time-interpolated` animation
   *  (`stroke.timeDashOffsetStops`) plus the layer-level lifecycle
   *  metadata (loop / easing / delayMs). `null` means no offset
   *  authored; `kind: 'constant'` carries the static-only case.
   *  dashOffset is a STRUCTURAL stroke attribute (drift of the dash
   *  pattern along the line), not a paint axis — that's why it has
   *  its own field instead of joining the PaintShapes bundle. */
  dashOffsetShape: import('./property-types').PropertyShape<number> | null
  /** Stroke pattern stack — up to 3 repeated symbol slots laid along
   *  the line (Mapbox `line-pattern` superset). Each slot picks a
   *  shape from `ShapeRegistry` and gets its own spacing / anchor /
   *  offset. The line renderer evaluates all active slots per fragment. */
  patterns?: import('./render-node').StrokePattern[]
  /** Lateral parallel offset in pixels (positive = left of travel). */
  strokeOffset?: number
  /** Stroke alignment — 'inset' / 'outset' shift by ±half_width at runtime. */
  strokeAlign?: 'center' | 'inset' | 'outset'
  /** Mapbox `paint.line-blur` edge feathering in CSS px (0 = crisp). */
  strokeBlur?: number
  /** Mapbox `paint.line-gap-width` — px gap between two parallel
   *  strokes composing a road casing. > 0 triggers the line renderer's
   *  double-draw path (two writeLayerSlot + drawSegments per layer
   *  with offsets ±(gap + stroke) / 2). 0 / absent stays on the
   *  single-draw legacy path. */
  strokeGapWidth?: number
  /** Mapbox `paint.line-translate` (viewport-anchor) — CSS px
   *  offset on lines. Mirrors fillTranslateX/Y for the line pipeline.
   *  Runtime bakes CSS px → NDC-per-pixel into u.line_translate_x/y. */
  strokeTranslateX?: number
  strokeTranslateY?: number
  /** WS-1 — per-frame zoom-interp line translate (per-axis scalar
   *  PropertyShape). Runtime prefers the shape over the constant
   *  strokeTranslateX/Y, resolving the offset each frame. */
  strokeTranslateXShape?: PropertyShape<number>
  strokeTranslateYShape?: PropertyShape<number>
  /** Mapbox `paint.line-translate-anchor` = "map". Mirror of
   *  fillTranslateAnchorMap for the line pipeline; default byte-identical. */
  strokeTranslateAnchorMap?: boolean
}

/** Circle / point-marker paint axes. */
export interface CirclePaint {
  /** WS-1 — per-frame zoom-interp circle-stroke-opacity. `null` =
   *  constant-only (folded into the stroke hex alpha at convert time).
   *  When present, PointRenderer.updateDynamicSizes resolves it per frame
   *  and multiplies it into the circle's baked stroke alpha. Only the
   *  circle (point) layer path reads it. */
  circleStrokeOpacityShape: PropertyShape<number> | null
  /** Mapbox `paint.circle-translate` — CSS-px viewport offset for circle
   *  layers. Default 0/0 / undefined = no-op (existing rendering unchanged). */
  circleTranslateX?: number
  circleTranslateY?: number
  /** WS-1 — per-frame zoom-interp circle translate (per-axis scalar
   *  PropertyShape). Runtime prefers the shape over the constant
   *  circleTranslateX/Y, resolving the offset each frame. */
  circleTranslateXShape?: PropertyShape<number>
  circleTranslateYShape?: PropertyShape<number>
  /** Mapbox `paint.circle-blur` — extends the point fragment smoothstep
   *  AA band. Default 0 / undefined = crisp edge (no-op). */
  circleBlur?: number
  /** Mapbox `paint.circle-pitch-scale` = "map". Undefined / false =
   *  "viewport" (spec default — radius constant in screen px; byte-identical).
   *  True = "map" (radius scales with the map perspective). PointRenderer
   *  packs the flag into the point uniform's circle_params.w. */
  circlePitchScaleMap?: boolean
}

/** 3D extrusion paint axes (Mapbox `fill-extrusion-*`). */
export interface ExtrudePaint {
  /** 3D extrusion height. `none` = flat polygon (default). `constant`
   *  = uniform metres for every feature. `feature` = per-feature
   *  property name + fallback metres. The runtime branches the upload
   *  pipeline + binds the extruded vertex layout when set to anything
   *  other than 'none'. */
  extrude: import('./render-node').ExtrudeValue
  /** 3D extrusion BASE — z of the wall bottom (Mapbox
   *  `fill-extrusion-base`). Combined with `extrude` it carves out
   *  the `min_height` podium for buildings. `none` ⇒ z=0 default. */
  extrudeBase: import('./render-node').ExtrudeValue
  /** Mapbox `paint.fill-extrusion-vertical-gradient` opt-out. Default
   *  (undefined / true) preserves the current extrude shading; only
   *  `false` disables the vertical-gradient wall ramp at runtime. */
  fillExtrusionVerticalGradient?: boolean
}

/** Heatmap paint axes (Mapbox `heatmap-*`, Phase R). */
export interface HeatmapPaint {
  /** True when the layer is a Mapbox `heatmap` layer (the `heatmap` marker
   *  utility). Routes the runtime to the HeatmapRenderer. */
  isHeatmap?: boolean
  /** heatmap-radius — Gaussian splat radius in CSS px. Default 30. */
  heatmapRadius?: number
  /** heatmap-weight — per-feature contribution multiplier. Default 1. */
  heatmapWeight?: number
  /** heatmap-intensity — overall density scale. Default 1. */
  heatmapIntensity?: number
  /** heatmap-opacity — layer alpha 0..1. Default 1. */
  heatmapOpacity?: number
  /** heatmap-color ramp stops (offset 0..1 over heatmap-density → RGBA). */
  heatmapColorStops?: { offset: number; rgba: [number, number, number, number] }[]
}

export interface ShowCommand extends FillPaint, LinePaint, CirclePaint, ExtrudePaint, HeatmapPaint {
  /** Position of this show in `Scene.renderNodes` — the key the P4
   *  compute plan uses to route output buffers back to fragment-
   *  shader paint axes. Set at emit time; immutable from there.
   *  Optional for back-compat with hand-built ShowCommands in
   *  tests; the compute path requires it. */
  renderNodeIndex?: number
  targetName: string
  /** DSL layer name from `layer <name> { ... }`. Distinct from
   *  `targetName` (source name) when two layers share a source.
   *  Legacy `show <name> { ... }` syntax mirrors `targetName` here. */
  layerName?: string
  /** Mapbox `layer.minzoom` / `maxzoom` — gate per-frame visibility
   *  on the current camera zoom. See RenderNode for the rationale. */
  minzoom?: number
  maxzoom?: number
  /** Optional MVT layer slice within the source. When set, the
   *  catalog returns only that slice's TileData and the renderer
   *  draws only its geometry. Mapbox-style `source-layer`
   *  semantics (camelCase here for lexer compatibility). */
  sourceLayer?: string
  projection: string
  visible: boolean
  /** CSS-style pointer interactivity. 'none' makes the layer non-pickable
   *  (writeMask:0 on the pick attachment so picks fall through). 'auto'
   *  is the default. */
  pointerEvents: 'auto' | 'none'
  /** Per-frame composed opacity (the resolved-value channel).
   *  Bucket-scheduler writes this in `effectiveShow` after evaluating
   *  paintShapes.opacity; downstream renderers (VTR, line-renderer,
   *  point-renderer, map.ts composite) read it as a plain scalar. */
  opacity: number
  /** Per-frame composed size. Same resolved-value channel pattern as
   *  `opacity`. `null` when the layer doesn't author a size. */
  size: number | null
  shaderVariant: ShaderVariant | null
  filterExpr: DataExpr | null
  geometryExpr: DataExpr | null
  sizeUnit: string | null
  sizeExpr: DataExpr | null
  billboard: boolean
  anchor?: 'center' | 'bottom' | 'top'
  shape: string | null
  /** Optional per-feature text label spec (Batch 1c). When set, the
   *  runtime resolves `label.text` against each feature's properties
   *  via the format pipeline, projects the feature's anchor (point
   *  for points, centroid for polygons) to screen px, and submits
   *  the resulting string to the SDF text stage. Mapbox `symbol`
   *  layers map here via the converter; xgis source uses
   *  `label-["..."]` utility or `label { ... }` sub-block. */
  label?: import('./render-node').LabelDef
  /** Typed `PropertyShape<T>` bundle for every animatable / shape-able
   *  paint axis. The flat `fill` / `stroke` / `opacity` / `strokeWidth`
   *  / `size` fields above are RESOLVED views of the same data:
   *  - `fill` / `stroke` carry the static-hex form used by shader
   *    uniform binding (no per-frame allocation for the common case).
   *  - `opacity` / `size` carry the per-frame resolved scalar that
   *    bucket-scheduler computes from the corresponding shape.
   *  - `paintShapes.*` carry the full evaluation shape (constant /
   *    zoom-interpolated / time-interpolated / zoom-time / data-driven)
   *    for the animation + classifier pipeline.
   *
   *  Different roles, different access patterns — not redundant. Reads
   *  go to whichever view fits the caller's cost model. */
  paintShapes: PaintShapes
}

export interface SceneCommands {
  loads: LoadCommand[]
  shows: ShowCommand[]
  symbols: { name: string; paths: string[] }[]
  /** Resolved canvas background fill `#rrggbb` / `#rrggbbaa`. Set
   *  by `background { fill: <color> }` in the .xgis program; the
   *  runtime applies it as the WebGPU clearValue. Absent → renderer
   *  default (dark navy). */
  background?: string
  /** Scene-wide constant/gradient pool (P3 Step 1, see palette.ts).
   *  Runtime calls `uploadPalette` to create the GPU storage textures
   *  and binds them to every variant whose `paletteColorGradients`
   *  is non-empty. Empty (or absent) when no zoom-interpolated paint
   *  property was eligible for textureSampleLevel routing. */
  palette?: import('../codegen/palette').Palette
  /** P4 plan — one entry per (renderNodeIndex, paintAxis) that
   *  needs a compute kernel evaluation. The runtime consumes this
   *  to build TileComputeResources per visible tile, dispatch
   *  kernels each frame, and merge the compute output buffer
   *  references into the per-show ShaderVariant via
   *  `mergeComputeAddendumIntoVariant`. Absent (or empty) when no
   *  paint axis routes to compute — runtime falls back to the
   *  legacy uniform / inline-fragment path uniformly. */
  computePlan?: ComputePlanEntry[]
}

/**
 * Convert an IR Scene to the legacy SceneCommands format
 * that the existing runtime expects.
 */
/** Compiler emit options. Reserved for opt-in features that need
 *  matching runtime infrastructure before they're safe to enable —
 *  flipping these unconditionally would generate WGSL that fails
 *  pipeline validation against the existing bind-group layouts. */
export interface EmitOptions {
  /** P3 Step 3c gate (COLOR atlas only — scalar atlas is the
   *  separate `enableScalarPaletteSampling` flag below). When true,
   *  zoom-interpolated FILL / STROKE colour values emit
   *  `textureSampleLevel(color_grad_atlas, …)`; when false (default),
   *  they keep the legacy `u.fill_color` / `u.stroke_color` uniform
   *  path. Runtime callers MUST set this to true ONLY after they've
   *  extended the polygon bind-group layout to include @binding(2,4)
   *  texture / sampler entries and bound them via `uploadPalette`. */
  enablePaletteSampling?: boolean
  /** Scalar-axis (opacity / stroke-width) zoom-interpolated palette
   *  routing. Independent of `enablePaletteSampling` because the
   *  runtime side requires an additional `@binding(3)` scalar atlas
   *  texture entry that the legacy bind-group layout lacks. When
   *  false (default) every scalar zoom-interpolated axis keeps the
   *  CPU resolve → uniform path, and the variant shader never
   *  references `scalar_grad_atlas` — so pipelines still validate
   *  against bind-group layouts that don't include binding 3.
   *
   *  Pair with `scalarPaletteMode` (filtering vs manual interp) once
   *  flipping this on; defaults to `'manual'` for universal
   *  WebGPU-adapter compatibility. */
  enableScalarPaletteSampling?: boolean
  /** P4-5 gate. When true, each ShowCommand's shaderVariant is
   *  produced via `buildPerShowMergedVariant` — fill / stroke axes
   *  that routed to compute get their fillExpr / strokeExpr replaced
   *  by `unpack4x8unorm(compute_out_*[input.feat_id])`, the preamble
   *  carries the matching `@group/@binding var<storage,read> ...`
   *  decls, and the variant exposes `computeBindings` so the runtime
   *  can wire the right output buffers per tile. When false (default),
   *  the legacy variant is emitted unchanged. Runtime callers MUST
   *  set this true ONLY after extending the polygon bind-group
   *  layout to include the compute-output bindings and feeding
   *  TileComputeResources.getOutBuffer() into the matching slots
   *  per tile. The compiler picks slot indices via
   *  `computePathBindGroup` / `computePathBaseBinding` below. */
  enableComputePath?: boolean
  /** Bind group index the compute output bindings occupy. Defaults
   *  to 0 (same group as the main uniform); pick whatever your
   *  runtime layout reserves. Ignored when `enableComputePath` is
   *  false. */
  computePathBindGroup?: number
  /** First binding slot to allocate for compute outputs. Each
   *  additional axis takes the next sequential slot. Defaults to
   *  16 — high enough to avoid colliding with the existing uniform
   *  / feature buffer / palette bindings in the polygon layout. */
  computePathBaseBinding?: number
  /** Scalar-gradient sample mode — `'filtering'` when the runtime
   *  has the `float32-filterable` adapter feature (r32float atlas
   *  sampled with HW linear interp via shared filtering sampler),
   *  `'manual'` otherwise (textureLoad ×2 + mix in the shader).
   *  Compiler emits the same call site (`xgis_scalar_sample(...)`)
   *  regardless; only the helper definition's body differs. Default
   *  `'manual'` — universal compatibility, no feature dependency. */
  scalarPaletteMode?: import('../codegen/palette-emit').ScalarPaletteMode
}

export function emitCommands(scene: Scene, opts?: EmitOptions): SceneCommands {
  const loads: LoadCommand[] = scene.sources.map((src) => ({
    name: src.name,
    url: src.url,
    type: src.type,
    layers: src.layers,
    crs: src.crs,
    inlineData: src.inlineData,
    options: src.options,
    encoding: src.encoding,
    tileSize: src.tileSize,
    redFactor: src.redFactor,
    greenFactor: src.greenFactor,
    blueFactor: src.blueFactor,
    baseShift: src.baseShift,
    ramp: src.ramp,
    range: src.range,
  }))

  // Walk the IR once to collect every ZOOM-only paint literal /
  // gradient (P3 Step 1). Always emit the palette into SceneCommands
  // so a runtime that opts INTO `enablePaletteSampling` later in
  // its boot has the data ready. Shader-gen integration is gated
  // separately — without the runtime bind-group extension, an
  // active palette would generate WGSL with @binding(2..4)
  // references that fail pipeline validation against
  // mr-baseBindGroupLayout.
  const palette = collectPalette(scene)
  // Variant-time palette is COLOR-only when only `enablePaletteSampling`
  // is set; scalar gradients are stripped so processOpacity falls back
  // to the legacy `u.opacity` uniform path. Once
  // `enableScalarPaletteSampling` flips on, the full palette flows
  // through and processOpacity routes zoom-interpolated axes to the
  // scalar atlas. Two flags because the runtime needs to extend its
  // bind-group layout BEFORE pipelines that reference
  // `scalar_grad_atlas` are created — flipping per-call lets the
  // runtime side ship in a separate commit without breaking validation.
  let variantPalette: Palette | undefined
  if (opts?.enablePaletteSampling) {
    if (opts.enableScalarPaletteSampling) {
      variantPalette = palette
    } else {
      // Strip scalar gradients (immutable view via a shallow clone).
      // Color path stays identical.
      variantPalette = stripScalarGradients(palette)
    }
  }
  const scalarMode = opts?.scalarPaletteMode ?? 'manual'
  const shows: ShowCommand[] = scene.renderNodes.map((node, i) => {
    const show = emitShow(node, variantPalette, scalarMode)
    show.renderNodeIndex = i
    return show
  })

  // Compute plan is walked unconditionally — the cost is one scene
  // walk per compile, dominated by paint-routing's deps analysis
  // (already linear in the scene's expression count). The runtime
  // ignores `computePlan` when its compute path isn't wired up yet,
  // so emitting it is back-compat by construction.
  const computePlan = planComputeKernels(scene)

  // Compile-side merge gate. When the caller opts in AND the plan
  // has entries, replace each show's variant with the per-show
  // merged version. The runtime sees `shaderVariant.computeBindings`
  // populated and switches to the compute-aware bind-group layout;
  // without `enableComputePath`, variants are byte-identical to the
  // legacy path so existing pipelines validate unchanged.
  if (opts?.enableComputePath && computePlan.length > 0) {
    const bindGroup = opts.computePathBindGroup ?? 0
    const baseBinding = opts.computePathBaseBinding ?? 16
    for (let i = 0; i < shows.length; i++) {
      const show = shows[i]!
      const original = show.shaderVariant
      if (!original) continue
      const merged = buildPerShowMergedVariant(original, computePlan, i, bindGroup, baseBinding)
      // buildPerShowMergedVariant returns by reference when nothing
      // routes to compute for this show — avoid a needless object
      // rebuild in that case.
      if (merged !== original) {
        show.shaderVariant = merged
      }
    }
  }

  return {
    loads,
    shows,
    symbols: scene.symbols,
    palette,
    ...(computePlan.length > 0 ? { computePlan } : {}),
  }
}

/** Return a Palette view with scalarGradients hidden (empty array,
 *  `findScalarGradient` always returns -1). Used to keep the existing
 *  color-only palette wire-up byte-identical when the caller hasn't
 *  opted INTO scalar palette sampling — the runtime side needs its
 *  scalar atlas binding wired first. */
function stripScalarGradients(p: Palette): Palette {
  return {
    colors: p.colors,
    scalars: p.scalars,
    colorGradients: p.colorGradients,
    scalarGradients: [],
    findColor: (r) => p.findColor(r),
    findScalar: (v) => p.findScalar(v),
    findColorGradient: (g) => p.findColorGradient(g),
    findScalarGradient: () => -1,
  }
}

function emitShow(
  node: RenderNode,
  palette?: Palette,
  scalarMode: import('../codegen/palette-emit').ScalarPaletteMode = 'manual',
): ShowCommand {
  // Generate shader variant for this layer. Palette is only forwarded
  // when the caller set `enablePaletteSampling`; otherwise the
  // variant falls back to the legacy `u.fill_color` uniform path
  // (P3 Step 3b's strict back-compat branch).
  const shaderVariant = generateShaderVariant(node, palette, scalarMode)

  const op = node.opacity

  // Lifecycle metadata (loop / easing / delayMs) is shared across every
  // animated property on a layer because a layer hosts one
  // `animation-<name>` reference at a time. lower.ts stamps it onto
  // `node.animationMeta` when ANY property is keyframe-animated;
  // emit-commands just reads it. Falls back to safe defaults when no
  // animation is attached at all.
  const meta = node.animationMeta ?? { loop: false, easing: 'linear' as Easing, delayMs: 0 }

  // dashOffset: compose into a single PropertyShape carrying lifecycle
  // metadata inline. Time-interpolated when keyframes exist, constant
  // otherwise. `null` means no offset authored.
  const dashOffsetTimeStops = node.stroke.timeDashOffsetStops ?? null
  let dashOffsetShape: import('./property-types').PropertyShape<number> | null = null
  if (dashOffsetTimeStops !== null && dashOffsetTimeStops.length > 0) {
    dashOffsetShape = {
      kind: 'time-interpolated',
      stops: dashOffsetTimeStops,
      loop: meta.loop,
      easing: meta.easing,
      delayMs: meta.delayMs,
    }
  } else if (node.stroke.dashOffset !== undefined) {
    dashOffsetShape = { kind: 'constant', value: node.stroke.dashOffset }
  }

  return {
    targetName: node.sourceRef,
    sourceLayer: node.sourceLayer,
    /** DSL layer name (e.g., `layer borders { ... }` → 'borders'). The
     *  data path uses `targetName` (source name) to look up tiles, but
     *  the user-facing `map.getLayer(name)` API matches the DSL layer
     *  name. Two layers can share a source — they get distinct
     *  `layerName`s and distinct entries in the layer registry. */
    layerName: node.name,
    projection: node.projection,
    visible: node.visible,
    pointerEvents: node.pointerEvents,
    opacity: op.kind === 'constant' ? op.value : 1.0,
    size: node.size.kind === 'constant' ? node.size.value : null,
    shaderVariant,
    filterExpr: node.filter,
    geometryExpr: node.geometry,
    minzoom: node.minzoom,
    maxzoom: node.maxzoom,
    sizeUnit:
      node.size.kind === 'constant' || node.size.kind === 'data-driven'
        ? (node.size.unit ?? null)
        : null,
    sizeExpr: node.size.kind === 'data-driven' ? node.size.expr : null,
    billboard: node.billboard,
    anchor: node.anchor,
    shape: node.shape.kind === 'named' ? node.shape.name : null,
    label: node.label,
    // Per-concern paint fields composed via the emit*Fields helpers
    // below — each returns the exact flat keys (its concern interface)
    // it owns, so the spread-merged object is byte-identical to the
    // former monolithic literal. A fill-axis edit now lives in
    // emitFillFields, a line-axis edit in emitLineFields, etc.
    ...emitFillFields(node),
    ...emitLineFields(node, dashOffsetShape),
    ...emitCircleFields(node),
    ...emitExtrudeFields(node),
    ...emitHeatmapFields(node),
    paintShapes: {
      fill: { fill: colorValueToShape(node.fill) },
      line: {
        stroke: colorValueToShape(node.stroke.color),
        // Stroke-width is the only paint property whose spatial
        // dependency (constant / zoom-stops / per-feature) and temporal
        // dependency (timeWidthStops on the parent StrokeValue) live
        // apart. Compose them here so paintShapes.line.strokeWidth is
        // the single authoritative shape — `zoom-time` if both exist,
        // `time-interpolated` if only time, otherwise the bare spatial
        // shape. Composition rule mirrors what bucket-scheduler does
        // today for opacity.
        strokeWidth: composeStrokeWidthShape(node.stroke.width, node.stroke.timeWidthStops, meta),
      },
      circle: { size: sizeValueToShape(node.size) },
      common: { opacity: node.opacity },
      // Raster colour adjustments — each field carries the spec default when
      // the node didn't author it, so resolveNumberShape yields a no-op.
      raster: {
        hueRotate: { kind: 'constant', value: node.rasterHueRotate ?? 0 },
        brightnessMin: { kind: 'constant', value: node.rasterBrightnessMin ?? 0 },
        brightnessMax: { kind: 'constant', value: node.rasterBrightnessMax ?? 1 },
        saturation: { kind: 'constant', value: node.rasterSaturation ?? 0 },
        contrast: { kind: 'constant', value: node.rasterContrast ?? 0 },
        resamplingNearest: node.rasterResamplingNearest ?? false,
      },
      // Hillshade DEM-relief axes — OPTIONAL (only on a hillshade layer's
      // ShowCommand, i.e. the converter authored at least one hillshade
      // axis). Unauthored axes carry the spec default so the (INC-3) renderer
      // resolves a no-op; absent entirely on every other layer type.
      ...(hasHillshadePaint(node) ? { hillshade: emitHillshadeShapes(node) } : {}),
    },
  }
}

// ─── Composable per-concern field emitters (Tier-B B2) ─────────────
//
// Each returns the `Partial<ShowCommand>` slice for one paint concern,
// carrying the exact flat keys (and the same lossy scalar fallbacks)
// the monolithic emitShow literal used to inline. The spread-merge in
// emitShow reassembles them into a byte-identical ShowCommand. The
// SOLE faithfulness requirement is that no fallback ternary is dropped
// or reordered relative to the former literal — verified by a
// byte-identical IR diff over the fixture + synthetic corpus.
//
// The return TYPE is the concrete concern interface (a stricter
// subtype of `Partial<ShowCommand>`) rather than `Partial<ShowCommand>`
// itself, so the spread-merge in emitShow keeps ShowCommand's REQUIRED
// fields (`fill`, `stroke`, `strokeWidth`, `extrude`, …) provably
// present — `Partial` would erase that and force a lossy cast at the
// return site.

/** Polygon fill paint fields. */
function emitFillFields(node: RenderNode): FillPaint {
  return {
    fill: colorToHex(node.fill),
    // #732 S5 — surface the data-driven fill colour AST (mirror of
    // emitLineFields' strokeColorExpr) so the point path can resolve it
    // per feature. `node.fill.expr` is already a DataExpr ({ast}).
    fillColorExpr: node.fill.kind === 'data-driven' ? node.fill.expr : undefined,
    fillPattern: node.fillPattern ?? null,
    fillTranslateX: node.fillTranslateX,
    fillTranslateY: node.fillTranslateY,
    fillTranslateXShape: node.fillTranslateXShape,
    fillTranslateYShape: node.fillTranslateYShape,
    fillTranslateAnchorMap: node.fillTranslateAnchorMap,
    fillAntialias: node.fillAntialias,
  }
}

/** Line / polygon-outline paint fields. */
function emitLineFields(
  node: RenderNode,
  dashOffsetShape: import('./property-types').PropertyShape<number> | null,
): LinePaint {
  return {
    linePattern: node.linePattern ?? null,
    stroke: colorToHex(node.stroke.color),
    // Flatten the discriminated `StrokeWidthValue` into the three
    // back-compat ShowCommand fields the runtime currently consumes.
    // Exhaustive switch — TypeScript fails the build if a new variant
    // is added to StrokeWidthValue and emitting forgets to handle it,
    // which is exactly the safety net WS-4 of the spec-drift plan
    // installs against the PR #95 / #97 / #104 silent-default class.
    strokeWidth: node.stroke.width.kind === 'constant' ? node.stroke.width.value : 1,
    strokeWidthExpr: node.stroke.width.kind === 'data-driven' ? node.stroke.width.expr : undefined,
    strokeColorExpr: node.stroke.colorExpr,
    linecap: node.stroke.linecap,
    linejoin: node.stroke.linejoin,
    miterlimit: node.stroke.miterlimit,
    roundLimit: node.stroke.roundLimit,
    dashArray: node.stroke.dashArray,
    dashArrayShape: node.stroke.dashArrayShape ?? null,
    dashOffsetShape,
    patterns: node.stroke.patterns,
    strokeOffset: node.stroke.offset,
    strokeGapWidth: node.stroke.gapWidth,
    strokeAlign: node.stroke.align,
    strokeBlur: node.stroke.blur,
    strokeTranslateX: node.strokeTranslateX,
    strokeTranslateY: node.strokeTranslateY,
    strokeTranslateXShape: node.strokeTranslateXShape,
    strokeTranslateYShape: node.strokeTranslateYShape,
    strokeTranslateAnchorMap: node.strokeTranslateAnchorMap,
  }
}

/** Circle / point-marker paint fields. */
function emitCircleFields(node: RenderNode): CirclePaint {
  return {
    circleStrokeOpacityShape: node.stroke.strokeOpacityShape ?? null,
    circleTranslateX: node.circleTranslateX,
    circleTranslateY: node.circleTranslateY,
    circleTranslateXShape: node.circleTranslateXShape,
    circleTranslateYShape: node.circleTranslateYShape,
    circleBlur: node.circleBlur,
    circlePitchScaleMap: node.circlePitchScaleMap,
  }
}

/** 3D extrusion paint fields. */
function emitExtrudeFields(node: RenderNode): ExtrudePaint {
  return {
    extrude: node.extrude,
    extrudeBase: node.extrudeBase,
    fillExtrusionVerticalGradient: node.fillExtrusionVerticalGradient,
  }
}

/** Heatmap paint fields (Phase R). */
function emitHeatmapFields(node: RenderNode): HeatmapPaint {
  return {
    isHeatmap: node.isHeatmap,
    heatmapRadius: node.heatmapRadius,
    heatmapWeight: node.heatmapWeight,
    heatmapIntensity: node.heatmapIntensity,
    heatmapOpacity: node.heatmapOpacity,
    heatmapColorStops: node.heatmapColorStops,
  }
}

/** Compose stroke-width's spatial half (StrokeWidthValue) with its
 *  temporal half (node.stroke.timeWidthStops) into a single
 *  PropertyShape. Mirrors emit-commands' existing dual-field output
 *  but produces one typed value instead of two parallel arrays. */
function composeStrokeWidthShape(
  spatial: import('./render-node').StrokeWidthValue,
  timeStops: TimeStop<number>[] | undefined,
  meta: { loop: boolean; easing: Easing; delayMs: number },
): import('./property-types').PropertyShape<number> {
  const sp = spatial
  if (timeStops === undefined || timeStops.length === 0) return sp
  if (sp.kind === 'zoom-interpolated') {
    return {
      kind: 'zoom-time',
      zoomStops: sp.stops,
      ...(sp.base !== undefined && sp.base !== 1 ? { zoomBase: sp.base } : {}),
      timeStops,
      loop: meta.loop,
      easing: meta.easing,
      delayMs: meta.delayMs,
    }
  }
  // Spatial is constant or data-driven — keep time as the dominant
  // axis. data-driven + time is rare (the worker bakes spatial into
  // segment slots; time stays per-frame); we surface it as the spatial
  // shape and let the renderer pick up the time stops separately
  // (matching today's behaviour where data-driven width ignores time).
  if (sp.kind === 'constant') {
    return {
      kind: 'time-interpolated',
      stops: timeStops,
      loop: meta.loop,
      easing: meta.easing,
      delayMs: meta.delayMs,
    }
  }
  return sp
}

function colorToHex(color: ColorValue): string | null {
  if (color.kind === 'none') return null
  if (color.kind === 'constant') return rgbaToHex(color.rgba)
  // For time-interpolated colors, the `base` snapshot is the fallback
  // pre-animation value — emitting it as a hex keeps the existing
  // shader-variant generator and raw pixel readback paths happy.
  if (color.kind === 'time-interpolated') return rgbaToHex(color.base)
  // Zoom-interpolated: pick FIRST stop as the static fallback. Mapbox
  // clamps to first-stop at zoom below the first stop boundary, and
  // first-stop is "the colour at the wider viewing extent" — usually
  // the most opaque / visible. Runtime path also picks up
  // zoomFillStops below and recomputes per frame; this hex is a
  // safety net for downstream consumers that ignore the stops.
  if (color.kind === 'zoom-interpolated' && color.stops.length > 0) {
    return rgbaToHex(color.stops[0]!.value)
  }
  return null
}
