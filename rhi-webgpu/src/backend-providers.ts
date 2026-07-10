// ═══ Backend providers — the boot inversion composition pieces (#833 M4) ═══
//
// Backend precedence is DATA now: an ordered `RhiBackendProvider` array built
// at the composition root, not a resolver function inside the GPU layer. The
// generic walk (`selectBackend`, @xgis/rhi) tries each provider and FALLS BACK
// on a boot failure. `'auto'` chains `[webgpu, webgl2]` (WebGPU→WebGL2 fallback);
// `?forcegl2=1` forces `[webgl2]`; an explicit backend pins a single-provider
// chain (no fallback). The WebGPU create() body is the byte-identical
// pre-inversion initGPU path (createWebGpuContext).
//
// Both providers produce the WebGPU-typed `GPUContext` (the webgl2 one via the
// documented FAIL-LOUD device stub), so both boot bodies live here in
// @xgis/rhi-webgpu. The concrete `WebGl2Device`, however, is NOT constructed
// here: it is INJECTED as a `WebGl2DeviceFactory` by the composition root
// (#834 M5) so @xgis/rhi-webgpu names @xgis/rhi-webgl2 NOWHERE — the two adapter
// packages stay mutually blind (#929). When `GPUContext` fully neutralizes each
// provider can move to its own backend package; the injection seam already
// severs the adapter→adapter dependency today.

import type { RhiBackendProvider, RhiDevice } from '@xgis/rhi'
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

/** A composition-root-injected WebGL2 device factory. Threading the concrete
 *  `WebGl2Device` construction through a parameter is what lets @xgis/rhi-webgpu
 *  name @xgis/rhi-webgl2 NOWHERE — the composition root (which legitimately
 *  depends on both backends) owns the cross-backend wiring, so the two adapter
 *  packages stay mutually blind (#929; #834 M5). May be async so the caller can
 *  code-split the WebGL2 backend chunk (loaded only when WebGL2 actually boots). */
export type WebGl2DeviceFactory = (gl: WebGL2RenderingContext) => RhiDevice | Promise<RhiDevice>

/** Placeholder factory for a WebGL2-reachable chain built WITHOUT an injected
 *  device factory (e.g. the `initGPU` porcelain called with no `makeWebGl2Device`).
 *  The provider still exists so chain composition + precedence are unchanged, but
 *  ACTUALLY booting WebGL2 without a factory is a composition-root wiring bug —
 *  fail loud with an actionable message rather than a mystery null. */
const requireInjectedWebGl2Device: WebGl2DeviceFactory = () => {
  throw new Error(
    '[X-GIS] WebGL2 backend selected but no makeWebGl2Device factory was injected — ' +
      'pass one to backendProviderChain()/initGPU() at the composition root (#834 M5).',
  )
}

/** WebGL2 backend provider FACTORY. `probe()` uses a SCRATCH canvas — canvas
 *  context types are sticky, so probing the target canvas would poison it for
 *  the next provider. Without a DOM (tests/SSR hand in fake canvases) the scratch
 *  probe is meaningless, so it passes through and `create()` surfaces the precise
 *  failure on the real canvas. The concrete `WebGl2Device` is supplied by
 *  `makeDevice` (injected at the composition root), so this module never imports
 *  @xgis/rhi-webgl2; a lazy `makeDevice` keeps the WebGL2 chunk load-on-demand. */
export function makeWebGl2BackendProvider(
  makeDevice: WebGl2DeviceFactory,
): RhiBackendProvider<GPUContext> {
  return {
    id: 'webgl2',
    probe: async () =>
      typeof document === 'undefined' || !!document.createElement('canvas').getContext('webgl2'),
    create: (canvas) => initGPUForcedWebGL2(canvas, makeDevice),
  }
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
 *  override still forces the WebGL2-only chain for testing.
 *
 *  `makeWebGl2Device` is the composition root's WebGL2 device factory (#834 M5):
 *  supply it for any chain that can reach WebGL2 (`'webgl2'` / `'auto'` /
 *  `?forcegl2=1`). Omitting it keeps the chain SHAPE identical (so a WebGPU boot
 *  is unaffected) but a WebGL2 create() then fails loud — see
 *  {@link requireInjectedWebGl2Device}. */
export function backendProviderChain(
  choice: BackendChoice,
  boot: WebGpuBootOptions,
  makeWebGl2Device?: WebGl2DeviceFactory,
): RhiBackendProvider<GPUContext>[] {
  const webgpu = makeWebGpuBackendProvider(boot)
  if (choice === 'webgpu') return [webgpu]
  const webgl2 = makeWebGl2BackendProvider(makeWebGl2Device ?? requireInjectedWebGl2Device)
  if (choice === 'webgl2') return [webgl2]
  return FORCE_GL2 ? [webgl2] : [webgpu, webgl2]
}

/** Per-call options for `initGPU`. */
export interface InitGPUOptions {
  backend?: BackendChoice
  /** WebGPU swapchain MSAA sample count. Defaults to 4 — the same value the
   *  engine's default quality preset resolves to — so porcelain boots are
   *  unchanged. Hosts with a live quality policy (map) pass their own value
   *  via `backendProviderChain` instead of relying on this default. */
  sampleCount?: number
  /** WebGL2 device factory injected by the composition root (#834 M5). Required
   *  to actually boot the WebGL2 backend (the `'webgl2'` / `'auto'`-fallback /
   *  `?forcegl2=1` paths); omit it only when a WebGPU boot is guaranteed (a
   *  WebGL2 selection without it fails loud). Keeps @xgis/rhi-webgpu free of any
   *  @xgis/rhi-webgl2 import (#929). */
  makeWebGl2Device?: WebGl2DeviceFactory
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
    backendProviderChain(
      opts.backend ?? 'auto',
      { sampleCount: opts.sampleCount ?? 4 },
      opts.makeWebGl2Device,
    ),
  )
}
