// ═══ SDF Point Renderer — Types ═══
// Top-level type/interface declarations extracted verbatim from
// point-renderer.ts. Behaviour-preserving structural split only; no logic
// or symbol renames. `PointLayer` is an internal (non-exported) type, so it
// is imported by point-renderer.ts and not re-exported from the public
// surface.

export interface PointLayer {
  vertexBuffer: GPUBuffer
  indexBuffer: GPUBuffer
  featureBuffer: GPUBuffer
  featData: Float32Array
  lons: Float64Array
  lats: Float64Array
  indexCount: number
  pointCount: number
  bindGroup: GPUBindGroup
  /** Flat layers lie on the ground plane and draw without depth write so
   *  overlapping circles blend cleanly without z-fighting from coplanar
   *  fragments. Billboards keep depth write so near markers occlude far. */
  isFlat: boolean
  /** Translucent billboards skip depth write so they don't occlude opaque
   *  geometry drawn behind them in later layers (classic transparency +
   *  depth ordering). A layer is translucent when opacity, fill.a, or
   *  stroke.a (all multiplied together) drops below 1. */
  isTranslucent: boolean
  /** Typed point-size PropertyShape (Plan Step 1d). When the layer
   *  doesn't author a size (`paintShapes.size === null`) the field is
   *  also null and the live-resize loop in `updateDynamicSizes` skips
   *  the layer entirely. Otherwise the loop dispatches through the
   *  five PropertyShape variants — `constant` and `data-driven` are
   *  no-ops at the layer level (size is baked into featData at addLayer
   *  time, or per-feature evaluated by the worker); the three
   *  animated kinds resolve per-frame. */
  sizeShape: import('@xgis/compiler').PropertyShape<number> | null
  /** Last zoom value the dynamic size was uploaded for, used to skip
   *  redundant queue.writeBuffer calls when the camera is idle. Only
   *  meaningful for zoom-only shapes — time-animated layers always
   *  update because elapsedMs always advances. */
  lastDynZoom: number
  /** circle-translate x in CSS px (+right). Baked to NDC in the uniform. */
  circleTranslateX: number
  /** circle-translate y in CSS px (+down). Baked to NDC in the uniform. */
  circleTranslateY: number
  /** circle-blur in CSS px (0 = crisp edge / no-op). */
  circleBlur: number
  /** WS-1 — per-frame zoom-interp circle-stroke-opacity. When a zoom /
   *  time / zoom-time shape, `updateDynamicSizes` resolves it each frame
   *  and writes `baseStrokeAlphaSlot8 × resolved` into feat_data slot 8.
   *  `null` / `constant` / `data-driven` are no-ops at the layer level
   *  (the constant alpha is already folded into the stroke colour). */
  strokeOpacityShape: import('@xgis/compiler').PropertyShape<number> | null
  /** The stroke alpha baked into feat_data slot 8 at addLayer time
   *  (stroke[3] × layer opacity). The per-frame resolved stroke-opacity
   *  multiplies this base — kept separate so re-resolution never compounds. */
  baseStrokeAlphaSlot8: number
  /** Last zoom the dynamic stroke-opacity was uploaded for — skips
   *  redundant featData patches when the camera is idle (mirror of
   *  `lastDynZoom`). */
  lastDynStrokeOpacityZoom: number
  /** WS-1 — per-frame zoom-interp circle-translate x / y. When a zoom /
   *  time / zoom-time shape, `updateDynamicSizes` resolves it each frame
   *  and writes the result into `circleTranslateX` / `circleTranslateY`
   *  (the fields `writePointFrameUniform` bakes into the point frame
   *  uniform's circle_params.xy — uf[32]/[33] — next frame). `null` /
   *  `constant` / `data-driven` are no-ops (the constant fallback below
   *  is already stored in `circleTranslateX` / `circleTranslateY`). */
  circleTranslateXShape: import('@xgis/compiler').PropertyShape<number> | null
  circleTranslateYShape: import('@xgis/compiler').PropertyShape<number> | null
  /** Constant circle-translate fallback (CSS px). Kept separate so a
   *  per-frame resolved shape never compounds on prior frames. */
  baseCircleTranslateX: number
  baseCircleTranslateY: number
  /** Last zoom the dynamic circle-translate was resolved for — skips
   *  redundant work when the camera is idle (mirror of `lastDynZoom`). */
  lastDynTranslateZoom: number
  /** Mapbox `paint.circle-pitch-scale` = "map". false = viewport (spec
   *  default — radius constant in screen px, byte-identical). true = map:
   *  `writePointFrameUniform` sets circle_params.w=1 and the point VS scales
   *  the quad expansion by w_ref/clip.w so circles foreshorten with pitch. */
  circlePitchScaleMap: boolean
  // Expanded buffers for 3× world copies (created on first render)
  _expandedVertBuf?: GPUBuffer
  _expandedIdxBuf?: GPUBuffer
  _expandedFeatBuf?: GPUBuffer
  _expandedBindGroup?: GPUBindGroup
  _expandedSize?: number
}
