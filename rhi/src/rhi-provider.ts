// ═══ RhiBackendProvider — backend injection contract (#833 M4) ═══
//
// The boot inversion: instead of a backend-resolving function INSIDE the GPU
// layer (the retired `resolveBackend`), the composition root passes an ORDERED
// PROVIDER ARRAY — fallback precedence is data (array order/filtering at the
// call site), not branching. `?forcegl2=1` boots by passing
// `[webGl2BackendProvider]`; the default WebGPU boot passes
// `[webGpuBackendProvider]`.
//
// `TCtx` is the boot context the provider produces. It is generic because the
// transitional context type (GPUContext) still carries WebGPU-typed fields and
// therefore lives in @xgis/rhi-webgpu; when GPUContext neutralizes (#834 M5)
// the concrete type moves here and the parameter can default to it.

export interface RhiBackendProvider<TCtx> {
  /** Stable backend identity — mirrored by `RhiDevice.backend` on the device
   *  the created context carries. */
  readonly id: 'webgpu' | 'webgl2'
  /** Cheap availability check — MUST NOT touch the target canvas (canvas
   *  context types are sticky; probing `getContext` on the real canvas would
   *  poison it for the next provider in the chain). A `false` moves the chain
   *  to the next provider. */
  probe(): Promise<boolean>
  /** Boot the backend on `canvas`. Errors thrown here PROPAGATE — a probe()
   *  that passed means the backend was chosen; a create() failure is a real
   *  boot fault, not a fallback signal. */
  create(canvas: HTMLCanvasElement): Promise<TCtx>
}
