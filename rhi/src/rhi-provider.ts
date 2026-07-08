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
  /** Boot the backend on `canvas`. A rejection is a boot FAULT for this
   *  provider; {@link selectBackend} treats it as a fallback signal and moves
   *  to the next provider in the chain (a single-provider chain therefore fails
   *  loud — its rejection is the exhaustion cause). */
  create(canvas: HTMLCanvasElement): Promise<TCtx>
}

/** Thrown by {@link selectBackend} when no provider in the chain could boot —
 *  every probe returned false / threw, or every passing probe's create()
 *  rejected. `causes` carries the collected probe/create errors (the WebGPU
 *  adapter-null rejection, the WebGL2 context-null rejection, …) for
 *  diagnostics. Backend-neutral: lives in @xgis/rhi so any composition root can
 *  catch it without naming a concrete backend. */
export class BackendUnavailableError extends Error {
  readonly causes: readonly unknown[]
  constructor(message: string, causes: readonly unknown[] = []) {
    super(message)
    this.name = 'BackendUnavailableError'
    this.causes = causes
  }
}

/** Walk an ordered provider chain with FALLBACK and boot the first one that
 *  succeeds. For each provider: a `probe()` that returns false (or throws) skips
 *  it; a passing probe's `create()` is awaited — on success its context is
 *  returned, on rejection the chain FALLS THROUGH to the next provider. This is
 *  the WebGPU→WebGL2 story: `[webgpu, webgl2]` tries WebGPU (presence + adapter),
 *  and an adapter-null / boot failure falls back to WebGL2 rather than dead-ending.
 *  An explicit single-provider chain (`[webgpu]` / `[webgl2]`) has nothing to fall
 *  back to, so its create() rejection surfaces as the exhaustion cause — a hard
 *  pin fails loud. Throws {@link BackendUnavailableError} only once every provider
 *  is exhausted. Generic over the boot context so it names no backend type. */
export async function selectBackend<TCtx>(
  canvas: HTMLCanvasElement,
  providers: readonly RhiBackendProvider<TCtx>[],
): Promise<TCtx> {
  const causes: unknown[] = []
  for (const p of providers) {
    let probed = false
    try {
      probed = await p.probe()
    } catch (e) {
      causes.push(e)
      continue
    }
    if (!probed) continue
    try {
      return await p.create(canvas)
    } catch (e) {
      causes.push(e)
      // create() failed — fall through to the next provider in the chain.
    }
  }
  throw new BackendUnavailableError(
    `no RHI backend could boot (tried: ${providers.map((p) => p.id).join(', ') || 'none'})`,
    causes,
  )
}
