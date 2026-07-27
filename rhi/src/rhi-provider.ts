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

/** Page-global record of which backend has CLAIMED a canvas element.
 *
 *  A canvas's context type is STICKY and IRREVERSIBLE: once `getContext('webgpu')`
 *  hands out a context, `getContext('webgl2')` on that same element returns null
 *  forever (verified in Chromium). The chain therefore CANNOT walk from one
 *  backend to another on a single canvas — the fallback provider's create() dies
 *  on a null context and the map never boots. Two production paths reach that
 *  state: a WebGPU create() that fails AFTER claiming the canvas, and a re-boot
 *  (device-lost recovery / host remount) on a canvas a previous SUCCESSFUL WebGPU
 *  boot already claimed, once WebGPU has become unavailable.
 *
 *  A WeakMap keyed on the element is the right authority: it is page-global (so it
 *  survives across boots — providers are re-created per boot) and it never keeps a
 *  detached canvas alive. Backends record their claim; {@link selectBackend} reads
 *  it and asks the composition root for a fresh surface before booting a DIFFERENT
 *  backend on a claimed element. */
const CLAIMED_SURFACES = new WeakMap<HTMLCanvasElement, 'webgpu' | 'webgl2'>()

/** Record that `backend` has taken this canvas's (irreversible) context type.
 *  Backends call this the moment `getContext` succeeds. */
export function markSurfaceClaimed(canvas: HTMLCanvasElement, backend: 'webgpu' | 'webgl2'): void {
  CLAIMED_SURFACES.set(canvas, backend)
}

/** The backend that owns this canvas's context type, or undefined when the
 *  element is still virgin (any backend may boot on it). */
export function surfaceClaimedBy(canvas: HTMLCanvasElement): 'webgpu' | 'webgl2' | undefined {
  return CLAIMED_SURFACES.get(canvas)
}

/** Test seam — forget a canvas's claim so a fixture can re-use one element. */
export function _resetSurfaceClaimForTests(canvas: HTMLCanvasElement): void {
  CLAIMED_SURFACES.delete(canvas)
}

/** A backend's `create()` could not get its context type out of the ELEMENT it was
 *  handed — `getContext(...)` returned null. Distinct from every other boot fault
 *  because retrying on the SAME element is provably futile (the type is sticky)
 *  while retrying on a fresh one usually works, so {@link selectBackend} answers it
 *  with a renewed surface instead of falling straight through.
 *
 *  This is the signal {@link surfaceClaimedBy} cannot give: the claim registry only
 *  knows about claims OUR backends made, and a host may hand us a canvas it already
 *  took a context on. Backend-neutral, so any backend can raise it. */
export class SurfaceUnusableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SurfaceUnusableError'
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/** Composition-root collaborators for {@link selectBackend}. */
export interface SelectBackendOptions {
  /** Mint a REPLACEMENT drawing surface when the chain must boot `backend` on a
   *  canvas another backend has already claimed. The composition root owns this
   *  because it owns the canvas's place in the DOM and every listener bound to it.
   *  Return null (or omit the option entirely) to decline — the chain then records
   *  a precise cause and moves on, so declining is exactly the pre-renewal
   *  behaviour. Only ever called on a path that would otherwise fail. */
  renewSurface?: (
    claimed: HTMLCanvasElement,
    backend: 'webgpu' | 'webgl2',
  ) => HTMLCanvasElement | null
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
  opts: SelectBackendOptions = {},
): Promise<TCtx> {
  const causes: unknown[] = []
  // The surface the chain boots on. It only ever changes when a provider needs a
  // canvas that another backend has irreversibly claimed (see CLAIMED_SURFACES) —
  // on every path that works today this stays the caller's canvas, untouched.
  let surface = canvas
  /** Ask the composition root for a virgin element. Records why when it declines
   *  (or cannot), so the exhaustion message names the CLAIM — the old text blamed
   *  `?forcegl2=1` for a null webgl2 context and sent every reader down the wrong
   *  path. Renewal is one-way: `surface` becomes the element every later provider
   *  boots on, so a chain renews at most once per attempt that needs it. */
  const renew = (id: 'webgpu' | 'webgl2', why: string): boolean => {
    const fresh = opts.renewSurface?.(surface, id) ?? null
    if (!fresh) {
      causes.push(
        new Error(
          `backend "${id}" cannot boot on this canvas (${why}) and no replacement was ` +
            `available — a canvas's context type is sticky and irreversible, so the ` +
            `composition root must supply selectBackend's renewSurface()`,
        ),
      )
      return false
    }
    surface = fresh
    return true
  }
  for (const p of providers) {
    let probed = false
    try {
      probed = await p.probe()
    } catch (e) {
      causes.push(e)
      continue
    }
    if (!probed) continue
    // Known-claimed: booting this provider here is IMPOSSIBLE, not merely likely to
    // fail, so renew BEFORE spending a create() on it.
    const claimed = surfaceClaimedBy(surface)
    if (
      claimed !== undefined &&
      claimed !== p.id &&
      !renew(p.id, `already claimed by "${claimed}"`)
    )
      continue
    try {
      return await p.create(surface)
    } catch (e) {
      causes.push(e)
      // A null getContext means the ELEMENT is unusable for this backend — the
      // registry misses this when the claim was made outside our backends (a host
      // that took a context on the canvas before handing it over). Retry this
      // provider ONCE on a fresh element; any other fault falls through as before.
      if (e instanceof SurfaceUnusableError && renew(p.id, 'its getContext returned null')) {
        try {
          return await p.create(surface)
        } catch (e2) {
          causes.push(e2)
        }
      }
    }
  }
  throw new BackendUnavailableError(
    `no RHI backend could boot (tried: ${providers.map((p) => p.id).join(', ') || 'none'})`,
    causes,
  )
}
