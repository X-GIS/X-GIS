// ═══ Backend providers — the boot inversion composition pieces (#833 M4) ═══
//
// Backend precedence is DATA now: an ordered `RhiBackendProvider` array built
// at the composition root, not a resolver function inside the GPU layer. The
// generic walk (`selectBackend`, @xgis/rhi) tries each provider and FALLS BACK
// on a boot failure. `'auto'` chains `[webGpuBackendProvider, webGl2BackendProvider]`
// (WebGPU→WebGL2 fallback); `?forcegl2=1` forces `[webGl2BackendProvider]`; an
// explicit backend pins a single-provider chain (no fallback). The WebGPU
// create() body is the byte-identical pre-inversion initGPU path (createWebGpuContext).
//
// TRANSITIONAL HOME: both providers produce the WebGPU-typed `GPUContext`
// (the webgl2 one via the documented no-op Proxy WebGPU extension), so they
// live here in @xgis/rhi-webgpu until GPUContext neutralizes (#834 M5) —
// then each provider moves to its backend package and `RhiBackendProvider`'s
// TCtx defaults to the neutral context in @xgis/rhi.

import type { RhiBackendProvider } from '@xgis/rhi'
import { selectBackend, BackendUnavailableError } from '@xgis/rhi'
import {
  createWebGpuContext,
  initGPUForcedWebGL2,
  FORCE_GL2,
  WebGPUUnavailableError,
  type BackendChoice,
  type GPUContext,
  type WebGpuBootOptions,
} from './gpu'

/** WebGPU backend provider — a FACTORY (#929 B): the composition root derives
 *  `boot` (sampleCount) from its quality policy and binds it here, so the
 *  adapter never reads engine policy itself. `probe()` is presence-only
 *  (`navigator.gpu`); adapter acquisition stays in `create()` so a probe never
 *  spends an adapter request, and an adapter-null failure surfaces as the same
 *  `WebGPUUnavailableError` the map layer already handles gracefully. */
export function makeWebGpuBackendProvider(boot: WebGpuBootOptions): RhiBackendProvider<GPUContext> {
  return {
    id: 'webgpu',
    probe: async () => typeof navigator !== 'undefined' && !!navigator.gpu,
    create: (canvas) => createWebGpuContext(canvas, boot),
  }
}

/** WebGL2 backend provider. `probe()` uses a SCRATCH canvas — canvas context
 *  types are sticky, so probing the target canvas would poison it for the
 *  next provider. Without a DOM (tests/SSR hand in fake canvases) the scratch
 *  probe is meaningless, so it passes through and `create()` surfaces the
 *  precise failure on the real canvas. `create()` lazy-imports the backend so
 *  only a WebGL2 boot pays for @xgis/rhi-webgl2. */
export const webGl2BackendProvider: RhiBackendProvider<GPUContext> = {
  id: 'webgl2',
  probe: async () =>
    typeof document === 'undefined' || !!document.createElement('canvas').getContext('webgl2'),
  create: async (canvas) => {
    const { WebGl2Device } = await import('@xgis/rhi-webgl2')
    return initGPUForcedWebGL2(canvas, (gl) => new WebGl2Device(gl))
  },
}

/** Boot the first provider in the chain that succeeds, with WebGPU→WebGL2
 *  FALLBACK — the generic walk (probe-skip + create-failure fall-through) is
 *  `selectBackend` in @xgis/rhi, so backend selection is engine-provided, not a
 *  rhi-webgpu private. Thin wrapper: it re-maps the neutral
 *  `BackendUnavailableError` (all providers exhausted) to `WebGPUUnavailableError`
 *  so the map layer's graceful-path check
 *  (`result instanceof WebGPUUnavailableError` → onWebGPUUnavailable) is
 *  unchanged. */
export async function initGPUViaProviders(
  canvas: HTMLCanvasElement,
  providers: readonly RhiBackendProvider<GPUContext>[],
): Promise<GPUContext> {
  try {
    return await selectBackend(canvas, providers)
  } catch (e) {
    if (e instanceof BackendUnavailableError) throw new WebGPUUnavailableError(e.message)
    throw e
  }
}

/** Derive the provider array from a caller's `BackendChoice`, expressed as data:
 *  an explicit `'webgpu'`/`'webgl2'` ALWAYS wins (a host that hard-pins in code
 *  ignores a stray `?forcegl2=1`) and pins a SINGLE-provider chain — no fallback,
 *  a hard pin fails loud. `'auto'` chains `[webgpu, webgl2]` so a
 *  present-but-adapter-null WebGPU FALLS BACK to WebGL2 (via `selectBackend`'s
 *  create-failure fall-through) rather than dead-ending — a degraded WebGL2 frame
 *  beats a blank canvas. `onWebGPUUnavailable()` (the graceful host path) now
 *  fires only when BOTH backends are exhausted. The `?forcegl2=1` dev/bisect
 *  override still forces the WebGL2-only chain for testing. */
export function backendProviderChain(
  choice: BackendChoice,
  boot: WebGpuBootOptions,
): RhiBackendProvider<GPUContext>[] {
  const webgpu = makeWebGpuBackendProvider(boot)
  if (choice === 'webgpu') return [webgpu]
  if (choice === 'webgl2') return [webGl2BackendProvider]
  return FORCE_GL2 ? [webGl2BackendProvider] : [webgpu, webGl2BackendProvider]
}

/** Per-call options for `initGPU`. */
export interface InitGPUOptions {
  backend?: BackendChoice
  /** WebGPU swapchain MSAA sample count. Defaults to 4 — the same value the
   *  engine's default quality preset resolves to — so porcelain boots are
   *  unchanged. Hosts with a live quality policy (map) pass their own value
   *  via `backendProviderChain` instead of relying on this default. */
  sampleCount?: number
}

/** Convenience boot porcelain: derive the provider chain from a
 *  `BackendChoice` and walk it. Equivalent to
 *  `initGPUViaProviders(canvas, backendProviderChain(opts.backend ?? 'auto', …))`
 *  — hosts that want custom precedence pass their own array to
 *  `initGPUViaProviders` directly. */
export async function initGPU(
  canvas: HTMLCanvasElement,
  opts: InitGPUOptions = {},
): Promise<GPUContext> {
  return initGPUViaProviders(
    canvas,
    backendProviderChain(opts.backend ?? 'auto', { sampleCount: opts.sampleCount ?? 4 }),
  )
}
