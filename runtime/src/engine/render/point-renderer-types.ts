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
  // Expanded buffers for 3× world copies (created on first render)
  _expandedVertBuf?: GPUBuffer
  _expandedIdxBuf?: GPUBuffer
  _expandedFeatBuf?: GPUBuffer
  _expandedBindGroup?: GPUBindGroup
  _expandedSize?: number
}
