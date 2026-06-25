// ═══ WebGPU Context — 디바이스 초기화 ═══

/** `?safe=1` URL flag — user-facing fallback for debugging.
 *  Disables the translucent line offscreen composite path (the most
 *  invasive recent code path). MSAA / DPR clamps moved into the quality
 *  module; `?safe=1` also routes the quality preset to `battery` (see
 *  `quality.ts` resolveQuality()). Use this to bisect: if the demo
 *  renders with `?safe=1` but not without, the bug lives in the new
 *  MSAA / offscreen path. */
function readSafeFlag(): boolean {
  if (typeof window === 'undefined') return false
  try { return new URL(window.location.href).searchParams.get('safe') === '1' }
  catch { return false }
}
export const SAFE_MODE: boolean = readSafeFlag()

// QUALITY drives SAMPLE_COUNT (MSAA), MAX_DPR, and PICK. Defaults are
// preserved (msaa=4, dpr=2 on desktop) — change only when ?msaa=N,
// ?dpr=N, ?quality=preset, ?picking=1, or ?safe=1 is explicitly passed.
// At runtime `map.setQuality(patch)` mutates QUALITY in place and
// dispatches rebuilds; these exports stay as thin getters so every read
// site sees the current value (no stale snapshots).
import { QUALITY } from './quality'
import type { RhiDevice } from '../render/rhi/rhi'
import { WebGl2Device } from '../render/rhi/rhi-webgl2'

// Function-accessor form for values that change at runtime. A plain
// `export const X = QUALITY.msaa` would snapshot at module load and
// stay stale after runtime updates.
export const getSampleCount = (): number => QUALITY.msaa
export const getMaxDpr = (): number => QUALITY.maxDpr
export const isPickEnabled = (): boolean => QUALITY.picking

/** @deprecated Use `getSampleCount()` — this binding reflects the
 *  module-load value only and does NOT follow runtime quality updates. */
export const SAMPLE_COUNT: number = QUALITY.msaa
/** @deprecated Use `getMaxDpr()` — module-load snapshot only. */
export const MAX_DPR: number = QUALITY.maxDpr
/** @deprecated Use `isPickEnabled()` — module-load snapshot only. */
export const PICK: boolean = QUALITY.picking

if (typeof window !== 'undefined' && SAFE_MODE) {
  console.warn('[X-GIS] safe mode active (?safe=1) — translucent offscreen disabled (quality preset = battery)')
}

export interface GPUContext {
  device: GPUDevice
  context: GPUCanvasContext
  format: GPUTextureFormat
  canvas: HTMLCanvasElement
  sampleCount: number
  /** Forced-WebGL2 fallback (the `?forcegl2=1` toggle): the RHI device the renderers +
   *  render loop route through INSTEAD of the raw GPUDevice. Present ONLY under the toggle;
   *  undefined on the normal WebGPU path (then the engine uses `device` directly, unchanged).
   *  A WebGl2Device here (backend==='webgl2') is how a real layer renders on WebGL2. */
  rhi?: RhiDevice
  /** True when the device was created with the `timestamp-query`
   *  feature enabled. Gated by `?gpuprof=1` so production users don't
   *  pay the always-on adapter feature requirement. Consumers (`GPUTimer`)
   *  no-op when this is false. */
  timestampQuerySupported: boolean
  /** True when the device additionally has Chromium's
   *  `chromium-experimental-timestamp-query-inside-passes` — lets us
   *  call `pass.writeTimestamp(querySet, idx)` mid-pass to break a
   *  pass's GPU time into per-pipeline buckets (raster vs polygon
   *  fill vs line vs extruded). Strictly a superset of
   *  `timestamp-query`. */
  timestampInsidePassesSupported: boolean
  /** True when the device was created with `float32-filterable`. Used
   *  by palette-emit's scalar-gradient sample emission to pick between
   *  HW linear filtering (`textureSampleLevel`) and a `textureLoad`
   *  ×2 + `mix` manual interpolation. iPhone Safari + iPhone Chrome
   *  do NOT advertise the feature (2026 status), so the manual path
   *  is the universal fallback — chosen at shader emit time via a
   *  build-time string substitution rather than a runtime branch. */
  float32FilterableSupported: boolean
  /** Validation error queue — the global `uncapturederror` handler
   *  pushes every WebGPU validation error here. Tests poll this
   *  via `getValidationErrors(ctx)` and assert it stays empty;
   *  production code can ignore it (the queue grows unbounded but
   *  errors are also still logged to console for visibility). */
  _validationErrors: { message: string; t: number }[]
  /** Set true once `device.lost` resolves. The render loop checks this
   *  and stops issuing GPU work into the dead device — without the guard
   *  a lost device (driver reset, tab backgrounding, OOM) turns every
   *  subsequent frame into a cascade of "device is lost" errors. */
  deviceLost: boolean
  /** Optional host hook fired once when the device is lost (after
   *  `deviceLost` is set). Lets the embedding app surface a "GPU lost —
   *  reload" affordance or trigger its own re-init. Wired via
   *  XGISMap.onDeviceLost(). 'destroyed' reason (explicit device.destroy())
   *  is NOT forwarded — that is an intentional teardown, not a fault. */
  onDeviceLost?: (info: GPUDeviceLostInfo) => void
}

/** `?gpuprof=1` — opt in to timestamp-query GPU profiling. We only
 *  request the feature when this flag is set so the adapter doesn't
 *  reject device creation on hardware/drivers that lack it. */
function readGpuProfFlag(): boolean {
  if (typeof window === 'undefined') return false
  try { return new URL(window.location.href).searchParams.get('gpuprof') === '1' }
  catch { return false }
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
  try { return new URL(window.location.href).searchParams.get('forcegl2') === '1' }
  catch { return false }
}
export const FORCE_GL2: boolean = readForceGl2Flag()

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

export async function initGPU(canvas: HTMLCanvasElement): Promise<GPUContext> {
  // Forced-WebGL2 boot path (`?forcegl2=1`). Additive EARLY RETURN — the WebGPU
  // body below stays byte-identical (Principle 1 / S2: the sacred path is untouched
  // when the flag is off). Bypasses the WebGPU adapter entirely so the produced frame
  // provably originates on `WebGl2Device` (the gate asserts `host.ctx.rhi.backend`).
  if (FORCE_GL2) return initGPUForcedWebGL2(canvas)

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
    if (adapter.features.has('chromium-experimental-timestamp-query-inside-passes' as GPUFeatureName)) {
      requiredFeatures.push('chromium-experimental-timestamp-query-inside-passes' as GPUFeatureName)
      timestampInsidePassesSupported = true
    }
  } else if (GPU_PROF) {
    console.warn('[X-GIS] ?gpuprof=1 requested but adapter lacks timestamp-query feature — GPU timing disabled')
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

  const context = canvas.getContext('webgpu')
  if (!context) throw new Error('Failed to get WebGPU context')

  const format = navigator.gpu.getPreferredCanvasFormat()
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

  // Build the GPUContext bundle BEFORE wiring the validation
  // handler so the handler can push into the per-context queue
  // (tests read `ctx._validationErrors` to assert no errors fired).
  const ctx: GPUContext = {
    device, context, format, canvas,
    sampleCount: SAMPLE_COUNT,
    timestampQuerySupported,
    timestampInsidePassesSupported,
    float32FilterableSupported,
    _validationErrors: [],
    deviceLost: false,
  }

  // Device-loss guard: flip the flag (the render loop reads it and stops
  // issuing work into the dead device) and fire the optional host hook.
  // 'destroyed' is our own device.destroy() teardown — not a fault — so
  // it's logged but not forwarded to onDeviceLost.
  device.lost.then((info) => {
    ctx.deviceLost = true
    // 'destroyed' is our own map.destroy()/device.destroy() teardown — a
    // normal unmount, not a fault. Stay silent so every SPA unmount doesn't
    // print a red console.error that looks like a GPU crash.
    if (info.reason !== 'destroyed') {
      console.error('[X-GIS] WebGPU device lost:', info.reason, info.message)
      ctx.onDeviceLost?.(info)
    }
  }).catch(() => { /* device GC'd before lost resolved — ignore */ })

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
    const err = (e as unknown as { error: { message: string } }).error
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
 *  reaches it only via `initGPU`'s `FORCE_GL2` early return. */
export function initGPUForcedWebGL2(canvas: HTMLCanvasElement): GPUContext {
  // preserveDrawingBuffer keeps the rendered frame readable via gl.readPixels after the
  // rAF turn — the US-004 live-render gate reads the checker pixels back. (This slice is a
  // dev/test path; the minor compositor cost is acceptable.)
  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true })
  if (!gl) throw new WebGPUUnavailableError('?forcegl2=1 set but canvas.getContext("webgl2") returned null')
  const rhi = new WebGl2Device(gl)

  if (typeof window !== 'undefined') {
    // Page-readable backend marker for the e2e gate (mirrors the interface-member
    // truth `host.ctx.rhi.backend`; the gate reads this from the page).
    ;(window as unknown as { __xgisActiveBackend?: string }).__xgisActiveBackend = 'webgl2'
    console.warn('[X-GIS] forced WebGL2 backend active (?forcegl2=1) — single-sample isolated raster slice')
  }

  // Recursive no-op stub for the WebGPU device/context. The renderer CONSTRUCTORS build
  // pipelines/buffers/layouts from `ctx.device` (createShaderModule / createBindGroupLayout
  // / createBuffer …) at map-init time, BEFORE any frame — so an `undefined` device crashes
  // the boot. This proxy makes every property access AND call return itself, so the
  // constructors get harmless dummies they store but never use: the forced-WebGL2 frame
  // renders through `rhi` via the render loop's early return, and the WebGPU multi-pass that
  // would consume these never runs. (Principle 3: the field types stay GPUDevice/GPUCanvasContext.)
  // `then` MUST return undefined: otherwise the proxy looks like a thenable (its `.then`
  // is a function) and `await device.createRenderPipelineAsync(…)` hangs forever (the fake
  // `.then` never calls resolve). Returning undefined for `then` makes the proxy a plain
  // value, so `await noop` resolves to it immediately.
  const noop = new Proxy(function () { /* no-op */ }, {
    get: (_t, p) => (p === 'then' ? undefined : noop), apply: () => noop,
  }) as unknown
  return {
    device: noop as GPUDevice,
    context: noop as GPUCanvasContext,
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

/** The devicePixelRatio the swapchain is (re)sized to. During an
 *  interaction `resizeCanvas` drops to `QUALITY.interactionDpr` (when set),
 *  otherwise it uses the full `getMaxDpr()` cap. The render loop MUST derive
 *  its per-frame `dpr` (which feeds the MVP altitude / camera zoom-scale)
 *  from the SAME value — a divergent cap makes `canvasHeight/dpr` disagree
 *  with the actual buffer size and the zoom-scale jumps on every gesture
 *  under presets that set `interactionDpr` (balanced/battery/?adaptiveDpr).
 *  Single source of truth so the two can never drift. SSR/no-GPU → 1. */
export function effectiveDpr(interacting = false): number {
  // Use the LIVE getter so runtime `map.setQuality({ maxDpr })` propagates
  // on the very next resize without touching anything else.
  const cap = interacting && QUALITY.interactionDpr !== null
    ? QUALITY.interactionDpr
    : getMaxDpr()
  if (typeof window === 'undefined') return 1
  return Math.min(window.devicePixelRatio || 1, cap)
}

export function resizeCanvas(ctx: GPUContext, interacting = false): void {
  const dpr = effectiveDpr(interacting)
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
