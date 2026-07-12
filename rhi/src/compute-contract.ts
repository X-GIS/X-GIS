// ═══ Neutral GPU compute contracts (#929 B3) ═══
//
// The backend-facing surface of a compiler-produced compute kernel, and the
// compute-output binding slots a shader variant carries. Lives in @xgis/rhi —
// the []-root of the dependency graph — so a WebGPU / WebGL2 backend adapter can
// type its dispatcher against these WITHOUT importing @xgis/compiler (which would
// invert the dependency direction). The compiler's richer types (`ComputeKernel`,
// `ShaderVariant`) extend / satisfy these structurally; the backend never sees
// the compiler-only fields (`module`, `categoryOrder`, `paintAxis`, …).

/** The backend-NEUTRAL surface of a compute kernel — everything a dispatcher
 *  needs that carries no shader-dsl / compiler-internal type. The compiler's
 *  `ComputeKernel` extends this and adds the shader-dsl `module` IR (which the
 *  live backend lowers to WGSL / GLSL) plus the string-category map. */
export interface ComputeKernelContract {
  /** WGSL/GLSL function name to use as the pipeline entry point. Each
   *  emitter picks a distinct name (`eval_match`, `eval_case`,
   *  `eval_interpolate`) so the runtime can build separate
   *  ComputePipeline objects without name collision when multiple
   *  kernels share a pipeline-cache key family. */
  entryPoint: string
  /** Number of f32 slots per feature in the feat_data buffer the
   *  runtime must populate. The emitter packs one slot per field
   *  referenced (typed-array stride). */
  featureStrideF32: number
  /** Ordered field names the runtime must lay out in feat_data —
   *  matches the offsets the kernel reads. `fieldOffsets[i]` = i. */
  fieldOrder: string[]
  /** Convenience: dispatch X count for a given total feature count. */
  dispatchSize(featureCount: number): number
}

/** One compute-output storage binding the backend must wire into the per-tile
 *  bind group: an opaque binding slot index. Content-blind — the backend binds
 *  "slot N" and never learns which paint axis (fill / stroke) it feeds. The
 *  compiler's `ComputeOutputBindingSpec` structurally satisfies this and carries
 *  the extra style-side fields (`paintAxis`, `bindGroup`). */
export interface ComputeBinding {
  readonly binding: number
}

/** The ordered compute-output bindings a shader variant carries, as the backend
 *  reads them (length + per-slot `binding`). */
export type ComputeBindings = readonly ComputeBinding[]
