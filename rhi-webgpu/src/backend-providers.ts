// ═══ Backend providers — the boot inversion composition pieces (#833 M4) ═══
//
// Backend precedence is DATA now: an ordered `RhiBackendProvider` array built
// at the composition root, not a resolver function inside the GPU layer.
// `?forcegl2=1` boots by passing `[webGl2BackendProvider]`; the WebGPU boot
// passes `[webGpuBackendProvider]` and its create() body is the byte-identical
// pre-inversion initGPU WebGPU path (createWebGpuContext).
//
// TRANSITIONAL HOME: both providers produce the WebGPU-typed `GPUContext`
// (the webgl2 one via the documented no-op Proxy WebGPU extension), so they
// live here in @xgis/rhi-webgpu until GPUContext neutralizes (#834 M5) —
// then each provider moves to its backend package and `RhiBackendProvider`'s
// TCtx defaults to the neutral context in @xgis/rhi.

import type { RhiBackendProvider } from '@xgis/rhi'
import {
  createWebGpuContext,
  initGPUForcedWebGL2,
  FORCE_GL2,
  WebGPUUnavailableError,
  type BackendChoice,
  type GPUContext,
} from './gpu'

/** WebGPU backend provider. `probe()` is presence-only (`navigator.gpu`);
 *  adapter acquisition stays in `create()` so a probe never spends an adapter
 *  request, and an adapter-null failure surfaces as the same
 *  `WebGPUUnavailableError` the map layer already handles gracefully. */
export const webGpuBackendProvider: RhiBackendProvider<GPUContext> = {
  id: 'webgpu',
  probe: async () => typeof navigator !== 'undefined' && !!navigator.gpu,
  create: (canvas) => createWebGpuContext(canvas),
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
    typeof document === 'undefined' ||
    !!document.createElement('canvas').getContext('webgl2'),
  create: async (canvas) => {
    const { WebGl2Device } = await import('@xgis/rhi-webgl2')
    return initGPUForcedWebGL2(canvas, (gl) => new WebGl2Device(gl))
  },
}

/** Walk an ordered provider chain: the first provider whose `probe()` passes
 *  boots the canvas. Probe failures fall through; create() errors propagate
 *  (a chosen backend that fails to boot is a fault, not a fallback signal). */
export async function initGPUViaProviders(
  canvas: HTMLCanvasElement,
  providers: readonly RhiBackendProvider<GPUContext>[],
): Promise<GPUContext> {
  for (const p of providers) {
    if (await p.probe()) return p.create(canvas)
  }
  throw new WebGPUUnavailableError(
    `no RHI backend available (probed: ${providers.map((p) => p.id).join(', ') || 'none'})`,
  )
}

/** Derive the provider array from a caller's `BackendChoice` — the old
 *  `resolveBackend` precedence, expressed as data: an explicit
 *  `'webgpu'`/`'webgl2'` ALWAYS wins (a host that hard-pins in code ignores a
 *  stray `?forcegl2=1`); only `'auto'` consults the `?forcegl2=1` dev/bisect
 *  override, then defaults to WebGPU. `'auto'` deliberately does NOT chain
 *  [webgpu, webgl2] — a present-but-adapter-null WebGPU still surfaces
 *  `WebGPUUnavailableError` → `onWebGPUUnavailable()` (the graceful path),
 *  intentional until the WebGL2 backend reaches full render parity (#834 M5);
 *  flipping that policy is then a one-line DATA change here. */
export function backendProviderChain(
  choice: BackendChoice,
): RhiBackendProvider<GPUContext>[] {
  if (choice === 'webgpu') return [webGpuBackendProvider]
  if (choice === 'webgl2') return [webGl2BackendProvider]
  return FORCE_GL2 ? [webGl2BackendProvider] : [webGpuBackendProvider]
}

/** Per-call options for `initGPU`. Backend is the only knob today. */
export interface InitGPUOptions {
  backend?: BackendChoice
}

/** Convenience boot porcelain: derive the provider chain from a
 *  `BackendChoice` and walk it. Equivalent to
 *  `initGPUViaProviders(canvas, backendProviderChain(opts.backend ?? 'auto'))`
 *  — hosts that want custom precedence pass their own array to
 *  `initGPUViaProviders` directly. */
export async function initGPU(
  canvas: HTMLCanvasElement,
  opts: InitGPUOptions = {},
): Promise<GPUContext> {
  return initGPUViaProviders(canvas, backendProviderChain(opts.backend ?? 'auto'))
}
