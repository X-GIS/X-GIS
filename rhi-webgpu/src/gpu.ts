// ═══ WebGPU Context — 디바이스 초기화 ═══

// Quality policy (MSAA sample count, DPR caps, `?safe=1`) is owned by
// @xgis/engine (engine/src/gpu/quality.ts — the single authority since #832),
// and this boot module no longer reads it (#929 B): the composition root
// derives the values from its quality policy and INJECTS them — `sampleCount`
// through `WebGpuBootOptions`, the resolved `dpr` as a `resizeCanvas` argument.
// The only remaining @xgis/engine imports are the TYPE-level context family
// (`RenderContext` / `BackendChoice`), pinned in the dependency-direction
// ratchet baseline until the #834 M5 context neutralization relocates it.
import type { RhiDevice, RhiTextureFormat } from '@xgis/rhi'
import type { RenderContext } from '@xgis/engine'
// BackendChoice + the neutral render context live in @xgis/engine (#834
// map→engine): they are engine composition concepts (a host canvas + frame
// state), not a render HARDWARE interface, and must not live in a concrete
// backend package either. Re-exported below for existing rhi-webgpu import sites.
export type { BackendChoice } from '@xgis/engine'

/** The WebGPU composition-root handle = the neutral `RenderContext` (#834 —
 *  the surface `@xgis/map` threads) PLUS the two native WebGPU objects the
 *  backend zone owns. Map annotates its device-free consumers as `RenderContext`
 *  from `@xgis/engine`; only the native creation/present code (this package)
 *  names `device`/`context`. Every neutral field (format, rhi, sampleCount,
 *  deviceLost, onDeviceLost with `RhiDeviceLostInfo`, timestamp/float32 flags,
 *  `_validationErrors`) is inherited from `RenderContext` — its docs live there. */
export interface GPUContext extends RenderContext {
  device: GPUDevice
  context: GPUCanvasContext
}

/** `?gpuprof=1` — opt in to timestamp-query GPU profiling. We only
 *  request the feature when this flag is set so the adapter doesn't
 *  reject device creation on hardware/drivers that lack it. */
function readGpuProfFlag(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return new URL(window.location.href).searchParams.get('gpuprof') === '1'
  } catch {
    return false
  }
}
export const GPU_PROF: boolean = readGpuProfFlag()

/** `?forcegl2=1` — boot-time forced-WebGL2 fallback toggle (OFF by default).
 *  Canvas context type is sticky (a canvas that handed out `getContext('webgpu')`
 *  refuses `getContext('webgl2')`), so this MUST be a boot flag + reload, not a
 *  runtime switch — mirroring `?safe=1` (gpu.ts:10) / `?gpuprof=1` precedent. When
 *  set, `initGPU` builds a WebGL2-backed context whose renderers + render loop route
 *  through `host.ctx.rhi` (a `WebGl2Device`) instead of the raw `GPUDevice`. */
function readForceGl2Flag(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return new URL(window.location.href).searchParams.get('forcegl2') === '1'
  } catch {
    return false
  }
}
export const FORCE_GL2: boolean = readForceGl2Flag()

// `BackendChoice` lives in @xgis/engine's render-context family and is
// re-exported at the top of this file — it is map's public
// XGISMapOptions.backend type and must live on the neutral surface, not in a
// concrete backend package.

// Backend PRECEDENCE moved out of this module (#833 M4): the composition root
// expresses it as an ordered RhiBackendProvider array — see
// backend-providers.ts (`backendProviderChain` derives the array from a
// BackendChoice; `initGPUViaProviders` walks it). The old `resolveBackend`
// function authority is retired.

/** Inspect the validation error queue without mutating it. */
export function getValidationErrors(ctx: GPUContext): { message: string; t: number }[] {
  return [...ctx._validationErrors]
}

/** Reset the validation error queue. Tests call this at the start
 *  of each fixture to isolate per-test errors. */
export function clearValidationErrors(ctx: GPUContext): void {
  ctx._validationErrors.length = 0
}

/** Thrown by initGPU when WebGPU cannot be used at all — `navigator.gpu`
 *  is absent (unsupported browser) or no GPU adapter is available. The
 *  map layer catches this specifically to fire `onWebGPUUnavailable()`
 *  and degrade gracefully, distinct from a mid-pipeline GPU fault. */
export class WebGPUUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WebGPUUnavailableError'
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/** Boot-time values the composition root derives from ITS quality policy and
 *  injects (#929 B) — the adapter holds no policy of its own. `sampleCount` is
 *  init-time only (pipelines bake it; a runtime change requires re-boot). */
export interface WebGpuBootOptions {
  sampleCount: number
}

/** Boot the WebGPU backend on `canvas` — the WebGPU provider's `create`
 *  body (#833 M4). This IS the pre-inversion `initGPU` WebGPU path, verbatim:
 *  the provider extraction moved backend SELECTION out (see
 *  backend-providers.ts) and left this boot byte-identical; #929 B then
 *  replaced the engine quality read with the injected `boot.sampleCount`. */
export async function createWebGpuContext(
  canvas: HTMLCanvasElement,
  boot: WebGpuBootOptions,
): Promise<GPUContext> {
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    throw new WebGPUUnavailableError('WebGPU is not supported in this browser')
  }

  // Try high-performance first, fall back to any available adapter
  let adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
  if (!adapter) {
    adapter = await navigator.gpu.requestAdapter()
  }
  if (!adapter) throw new WebGPUUnavailableError('Failed to get GPU adapter')

  // Optional timestamp-query feature — only when ?gpuprof=1 is set AND the
  // adapter advertises support. Falls back to a feature-less device on any
  // mismatch so users without the extension still load the app.
  let timestampQuerySupported = false
  let timestampInsidePassesSupported = false
  const requiredFeatures: GPUFeatureName[] = []
  if (GPU_PROF && adapter.features.has('timestamp-query')) {
    requiredFeatures.push('timestamp-query')
    timestampQuerySupported = true
    // Inside-passes timestamps are a Chromium-experimental superset.
    // Cast through `as` because the standard `GPUFeatureName` type
    // doesn't list the chromium-experimental-* names.
    if (
      adapter.features.has('chromium-experimental-timestamp-query-inside-passes' as GPUFeatureName)
    ) {
      requiredFeatures.push('chromium-experimental-timestamp-query-inside-passes' as GPUFeatureName)
      timestampInsidePassesSupported = true
    }
  } else if (GPU_PROF) {
    console.warn(
      '[X-GIS] ?gpuprof=1 requested but adapter lacks timestamp-query feature — GPU timing disabled',
    )
  }
  // r32float linear filtering. Where present (Chrome 121+ / Safari TP
  // desktop) the scalar gradient atlas samples via textureSampleLevel
  // with the shared filtering sampler. Where missing (notably iPhone
  // Safari / iPhone Chrome as of 2026) the shader emits a textureLoad
  // ×2 + mix manual interp instead — bind-group layout uses
  // `unfilterable-float` sampleType in that case. Both paths produce
  // visually-identical output.
  let float32FilterableSupported = false
  if (adapter.features.has('float32-filterable')) {
    requiredFeatures.push('float32-filterable')
    float32FilterableSupported = true
  }
  const device = await adapter.requestDevice(
    requiredFeatures.length > 0 ? { requiredFeatures } : undefined,
  )

  // #1153 P1 (#5) — the device is minted but unowned until the GPUContext
  // bundle below wraps it. Every failure exit in between (getContext null,
  // context.configure throw, the rhi-webgpu chunk-load reject, the WebGpuDevice
  // ctor) must reclaim it or it leaks for the page lifetime. Destroy then
  // rethrow the ORIGINAL error; the success path is unchanged.
  let ctx: GPUContext
  try {
    const context = canvas.getContext('webgpu')
    if (!context) throw new Error('Failed to get WebGPU context')

    // getPreferredCanvasFormat() is typed GPUTextureFormat but only ever returns
    // 'bgra8unorm' | 'rgba8unorm' — both members of RhiTextureFormat, which is
    // GPUContext.format's type (extends RenderContext). Cast is safe.
    const format = navigator.gpu.getPreferredCanvasFormat() as RhiTextureFormat
    // Colour pipeline (DELIBERATE — verified by the 2026-06 rendering audit, not a
    // gap): the canvas uses the preferred NON-srgb unorm format with NO `-srgb`
    // view. Shaders emit sRGB-encoded colours directly (hexToRgba → 0..1 sRGB, no
    // linearisation), so solid fills display 1:1. The trade-off is that ALPHA
    // BLENDING runs in sRGB (perceptual) space rather than linear — technically
    // "gamma-incorrect" per WebGPU best practice, but it is exactly what MapLibre
    // GL JS and the wider web-map ecosystem do, and X-GIS is pixel-matched against
    // MapLibre. Switching to gamma-correct linear blending (render through an
    // `-srgb` view + linear colours) would DIVERGE from that baseline and require
    // re-tuning every halo/translucency — so it is intentionally NOT done here.
    context.configure({ device, format, alphaMode: 'premultiplied' })

    // The chosen backend's RHI device (this is the WebGPU path → WebGpuDevice over `device`).
    // Lazy-imported like the WebGl2Device factory above so gpu.ts (layer 1) stays off a STATIC
    // upward import edge to the render layer (rhi-webgpu is L3); `initGPU` is async, so the
    // one-time dynamic import is free. This is the SINGLE backend device every renderer routes
    // through (ctx.rhi) — no renderer self-instantiates `new WebGpuDevice`.
    const { WebGpuDevice } = await import('./rhi-webgpu')

    // Build the GPUContext bundle BEFORE wiring the validation
    // handler so the handler can push into the per-context queue
    // (tests read `ctx._validationErrors` to assert no errors fired).
    ctx = {
      device,
      context,
      format,
      canvas,
      sampleCount: boot.sampleCount,
      rhi: new WebGpuDevice(device, context),
      timestampQuerySupported,
      timestampInsidePassesSupported,
      float32FilterableSupported,
      _validationErrors: [],
      deviceLost: false,
    }
  } catch (e) {
    device.destroy()
    throw e
  }

  // Device-loss guard: flip the flag (the render loop reads it and stops
  // issuing work into the dead device) and fire the optional host hook.
  // 'destroyed' is our own device.destroy() teardown — not a fault — so
  // it's logged but not forwarded to onDeviceLost.
  device.lost
    .then((info) => {
      ctx.deviceLost = true
      // 'destroyed' is our own map.destroy()/rhi.destroy() teardown — a normal
      // unmount, not a fault. Stay silent AND skip recovery: an intentional
      // teardown must NOT auto-re-init (that would resurrect a destroyed map).
      if (info.reason !== 'destroyed') {
        console.error('[X-GIS] WebGPU device lost:', info.reason, info.message)
        // Isolate the public host hook: a throwing onDeviceLost must not stop the
        // library's internal recovery from running (#1153 B).
        try {
          ctx.onDeviceLost?.(info)
        } catch (e) {
          console.error('[X-GIS] onDeviceLost hook threw', e)
        }
        // Library-internal bounded auto-recovery (map registers this at run()).
        ctx.onDeviceLostInternal?.(info)
      }
    })
    .catch(() => {
      /* device GC'd before lost resolved — ignore */
    })

  // Surface validation errors via TWO sinks:
  //   (1) console.error for human visibility (existing behavior)
  //   (2) the per-context queue for programmatic test assertions
  //
  // The queue lets `withValidationCapture` in helpers/validation.ts
  // fail a test the moment ANY WebGPU validation error fires —
  // bind group missing, layout mismatch, broken WGSL compile,
  // pipeline state error, etc. — without requiring every resource
  // creation site to be individually wrapped in pushErrorScope.
  device.addEventListener?.('uncapturederror', (e) => {
    const err = e.error
    const msg = err?.message ?? String(e)
    console.error('[WebGPU validation]', msg)
    ctx._validationErrors.push({ message: msg, t: Date.now() })
  })

  return ctx
}

/** Forced-WebGL2 boot (`?forcegl2=1`) — build a WebGL2-backed `GPUContext`.
 *
 *  The canvas yields `getContext('webgl2')` (NO WebGPU context — sticky per Decision
 *  Driver 1) and the renderers/render-loop route through `host.ctx.rhi` (a
 *  `WebGl2Device`). The WebGPU-only fields (`device`/`context`) are STUBBED, not real:
 *  the forced frame never touches them (it flows through the `frameCtx.useRhi` branch),
 *  and the `device.lost` / `context.configure` machinery (gpu.ts ~208/263) is SKIPPED
 *  (there is no WebGPU device to wire). Stubbing rather than widening the field TYPES
 *  honors Principle 3 — `GPUContext.device` stays `GPUDevice` so none of the 1074 raw
 *  `GPU*` read sites recompile. Slice-1 topology is single-sample + isolated (S4): the
 *  shared opaque-pass MSAA path is Story-5 scope, so `sampleCount` is 1 here.
 *  Exported for the unit gate (context-shape + backend-marker ACs); production
 *  reaches it only via `makeWebGl2BackendProvider(...).create` (#833 M4). The RHI
 *  device is INJECTED (`makeRhi`) — the COMPOSITION ROOT supplies the factory
 *  (`@xgis/map` dynamic-imports `WebGl2Device`), so NEITHER this layer-1 module
 *  NOR the provider names `@xgis/rhi-webgl2` (#834 M5; #929 adapter mutual-blindness).
 *  Async so the injected factory may lazy-import the WebGL2 backend chunk. */
export async function initGPUForcedWebGL2(
  canvas: HTMLCanvasElement,
  makeRhi: (gl: WebGL2RenderingContext) => RhiDevice | Promise<RhiDevice>,
): Promise<GPUContext> {
  // preserveDrawingBuffer keeps the rendered frame readable via gl.readPixels after the
  // rAF turn — the US-004 live-render gate reads the checker pixels back. (This slice is a
  // dev/test path; the minor compositor cost is acceptable.)
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    premultipliedAlpha: true,
    preserveDrawingBuffer: true,
    stencil: true,
  })
  if (!gl)
    throw new WebGPUUnavailableError(
      '?forcegl2=1 set but canvas.getContext("webgl2") returned null',
    )
  const rhi = await makeRhi(gl)

  if (typeof window !== 'undefined') {
    // Page-readable backend marker for the e2e gate (mirrors the interface-member
    // truth `host.ctx.rhi.backend`; the gate reads this from the page).
    ;(window as unknown as { __xgisActiveBackend?: string }).__xgisActiveBackend = 'webgl2'
    console.warn(
      '[X-GIS] forced WebGL2 backend active (?forcegl2=1) — single-sample isolated raster slice',
    )
  }

  // FAIL-LOUD stub for the WebGPU device/context (#834 device retirement S6 —
  // replaces the recursive no-op Proxy). Every map-init / scene-compile /
  // frame path that used to touch ctx.device on this backend is now fenced
  // (PipelineFactory build + variant builders, palette upload, addLayer
  // uploads, renderer bind-group rebuilds, heatmap/line ctor natives) —
  // constructors may still STORE the reference, but any property ACCESS is a
  // bug and throws with an actionable message instead of silently producing
  // dummy objects that masked missing fences for months. `then` stays
  // undefined (benign thenable probe on await); symbol keys return undefined
  // so console/inspect diagnostics can print the ctx without detonating.
  const unavailable = (what: string): unknown =>
    new Proxy(Object.create(null), {
      get: (_t, p) => {
        if (typeof p === 'symbol' || p === 'then') return undefined
        throw new Error(
          `[X-GIS] ctx.${what}.${String(p)} accessed on the webgl2 backend — ` +
            `native WebGPU objects do not exist under ?forcegl2 (#834); route through ctx.rhi ` +
            `or fence the caller behind backend === 'webgpu'.`,
        )
      },
    })
  return {
    device: unavailable('device') as GPUDevice,
    context: unavailable('context') as GPUCanvasContext,
    format: 'rgba8unorm',
    canvas,
    sampleCount: 1,
    rhi,
    timestampQuerySupported: false,
    timestampInsidePassesSupported: false,
    float32FilterableSupported: false,
    _validationErrors: [],
    deviceLost: false,
  }
}

/** (Re)size the swapchain to `clientSize × dpr`. The caller derives `dpr`
 *  from ITS quality policy (map: `effectiveDpr(interacting)` in @xgis/engine)
 *  and MUST feed the SAME value into its per-frame math (MVP altitude /
 *  camera zoom-scale) — computing it once and passing it here makes a
 *  divergent cap structurally impossible (#929 B; previously this function
 *  read `effectiveDpr` itself and the render loop re-derived it). */
export function resizeCanvas(ctx: GPUContext, dpr: number): void {
  const w = Math.floor(ctx.canvas.clientWidth * dpr)
  const h = Math.floor(ctx.canvas.clientHeight * dpr)
  if (ctx.canvas.width !== w || ctx.canvas.height !== h) {
    ctx.canvas.width = w
    ctx.canvas.height = h
    // Forced-WebGL2 path has no GPUCanvasContext to reconfigure — the gl viewport is
    // set per-frame in the RHI screen pass. Resize the backing buffer, skip configure.
    if (ctx.rhi?.backend === 'webgl2') return
    ctx.context.configure({ device: ctx.device, format: ctx.format, alphaMode: 'premultiplied' })
  }
}
