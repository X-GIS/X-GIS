// ═══ WebGPU Context — 디바이스 초기화 ═══

/** Crude mobile / low-power detection.
 *  Coarse pointer + narrow viewport is the strongest signal for a phone or
 *  tablet. On mobile we drop MSAA and clamp DPR to keep fragment-shader load
 *  within a sane envelope — otherwise the line SDF shader (pattern loops,
 *  SDF math, dash phase) at DPR 3 × 4 samples saturates mobile tile units. */
export function isMobile(): boolean {
  if (typeof window === 'undefined') return false
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false
  const narrow = (window.innerWidth || 0) <= 900
  return coarse && narrow
}

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

// QUALITY drives both SAMPLE_COUNT (MSAA) and MAX_DPR. Defaults are
// preserved (msaa=4, dpr=2 on desktop) — change only when ?msaa=N,
// ?dpr=N, ?quality=preset, or ?safe=1 is explicitly passed.
import { QUALITY } from './quality'

/** MSAA sample count. Source of truth for every pipeline that sets
 *  `multisample.count` — keep in sync via this import. */
export const SAMPLE_COUNT: number = QUALITY.msaa

/** Device-pixel-ratio cap. */
export const MAX_DPR: number = QUALITY.maxDpr

/** GPU picking enabled (via `?picking=1`). When true every main-pass
 *  pipeline adds an RG32Uint fragment target and `map.pickAt()` returns
 *  feature/instance IDs under the pointer. Implies `SAMPLE_COUNT === 1`. */
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
  /** True when the device was created with the `timestamp-query`
   *  feature enabled. Gated by `?gpuprof=1` so production users don't
   *  pay the always-on adapter feature requirement. Consumers (`GPUTimer`)
   *  no-op when this is false. */
  timestampQuerySupported: boolean
  /** Validation error queue — the global `uncapturederror` handler
   *  pushes every WebGPU validation error here. Tests poll this
   *  via `getValidationErrors(ctx)` and assert it stays empty;
   *  production code can ignore it (the queue grows unbounded but
   *  errors are also still logged to console for visibility). */
  _validationErrors: { message: string; t: number }[]
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

/** Inspect the validation error queue without mutating it. */
export function getValidationErrors(ctx: GPUContext): { message: string; t: number }[] {
  return [...ctx._validationErrors]
}

/** Reset the validation error queue. Tests call this at the start
 *  of each fixture to isolate per-test errors. */
export function clearValidationErrors(ctx: GPUContext): void {
  ctx._validationErrors.length = 0
}

export async function initGPU(canvas: HTMLCanvasElement): Promise<GPUContext> {
  if (!navigator.gpu) {
    throw new Error('WebGPU is not supported in this browser')
  }

  // Try high-performance first, fall back to any available adapter
  let adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
  if (!adapter) {
    adapter = await navigator.gpu.requestAdapter()
  }
  if (!adapter) throw new Error('Failed to get GPU adapter')

  // Optional timestamp-query feature — only when ?gpuprof=1 is set AND the
  // adapter advertises support. Falls back to a feature-less device on any
  // mismatch so users without the extension still load the app.
  let timestampQuerySupported = false
  const requiredFeatures: GPUFeatureName[] = []
  if (GPU_PROF && adapter.features.has('timestamp-query')) {
    requiredFeatures.push('timestamp-query')
    timestampQuerySupported = true
  } else if (GPU_PROF) {
    console.warn('[X-GIS] ?gpuprof=1 requested but adapter lacks timestamp-query feature — GPU timing disabled')
  }
  const device = await adapter.requestDevice(
    requiredFeatures.length > 0 ? { requiredFeatures } : undefined,
  )
  device.lost.then((info) => console.error('WebGPU device lost:', info.message))

  const context = canvas.getContext('webgpu')
  if (!context) throw new Error('Failed to get WebGPU context')

  const format = navigator.gpu.getPreferredCanvasFormat()
  context.configure({ device, format, alphaMode: 'premultiplied' })

  // Build the GPUContext bundle BEFORE wiring the validation
  // handler so the handler can push into the per-context queue
  // (tests read `ctx._validationErrors` to assert no errors fired).
  const ctx: GPUContext = {
    device, context, format, canvas,
    sampleCount: SAMPLE_COUNT,
    timestampQuerySupported,
    _validationErrors: [],
  }

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

export function resizeCanvas(ctx: GPUContext): void {
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
  const w = Math.floor(ctx.canvas.clientWidth * dpr)
  const h = Math.floor(ctx.canvas.clientHeight * dpr)
  if (ctx.canvas.width !== w || ctx.canvas.height !== h) {
    ctx.canvas.width = w
    ctx.canvas.height = h
    ctx.context.configure({ device: ctx.device, format: ctx.format, alphaMode: 'premultiplied' })
  }
}
