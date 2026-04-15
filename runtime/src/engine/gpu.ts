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
 *  Forces SAMPLE_COUNT=1, clamps DPR, and disables the translucent line
 *  offscreen composite path (the most invasive recent code path). Use this
 *  to bisect: if the demo renders with `?safe=1` but not without, the bug
 *  lives in the new MSAA / offscreen path. */
function readSafeFlag(): boolean {
  if (typeof window === 'undefined') return false
  try { return new URL(window.location.href).searchParams.get('safe') === '1' }
  catch { return false }
}
export const SAFE_MODE: boolean = readSafeFlag()

/** MSAA sample count — 4x on desktop, disabled on mobile / safe mode. */
export const SAMPLE_COUNT: number = (isMobile() || SAFE_MODE) ? 1 : 4

/** Device-pixel-ratio cap. Mobile DPR of 2–3× combined with MSAA quadruples
 *  the fragment budget; clamping to 1.5 is effectively imperceptible while
 *  halving the shaded-pixel count. */
export const MAX_DPR: number = (isMobile() || SAFE_MODE) ? 1.5 : 2

if (typeof window !== 'undefined' && SAFE_MODE) {
  console.warn('[X-GIS] safe mode active (?safe=1) — MSAA disabled, DPR capped, translucent offscreen disabled')
}

export interface GPUContext {
  device: GPUDevice
  context: GPUCanvasContext
  format: GPUTextureFormat
  canvas: HTMLCanvasElement
  sampleCount: number
  /** Validation error queue — the global `uncapturederror` handler
   *  pushes every WebGPU validation error here. Tests poll this
   *  via `getValidationErrors(ctx)` and assert it stays empty;
   *  production code can ignore it (the queue grows unbounded but
   *  errors are also still logged to console for visibility). */
  _validationErrors: { message: string; t: number }[]
}

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

  const device = await adapter.requestDevice()
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
