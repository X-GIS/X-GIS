// Regression gate for the render-loop interaction-DPR vs MVP-DPR mismatch.
//
// The swapchain must be sized with the
// INTERACTION-aware cap — during a gesture it uses QUALITY.interactionDpr
// (balanced=1.5 / battery=1.0 / ?adaptiveDpr=N) instead of the full
// getMaxDpr() cap. But the render loop's per-frame `dpr` local — threaded
// into camera.getViewForProjection / draws and used to compute the MVP
// altitude (canvasHeight / dpr × metersPerPx) — used to be computed as
//   Math.min(window.devicePixelRatio || 1, getMaxDpr())
// i.e. the FULL maxDpr cap, ignoring the interaction cap. So the dpr the
// camera divides by disagreed with the actual buffer the swapchain was
// sized to → MVP altitude wrong → camera zoom-scale JUMPS on every gesture
// under any preset that sets interactionDpr.
//
// The fix unified both call sites on one helper, `effectiveDpr`; #929 B then
// strengthened it further — the render loop computes `effectiveDpr` ONCE per
// frame and passes the SAME number to resizeCanvas (which no longer reads
// quality itself), so the swapchain size and the camera dpr are one value by
// construction. These tests pin that contract — pure CPU, no GPU.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { canvasEffectiveDpr, effectiveDpr, getMaxDpr } from '@xgis/engine'
import { resizeCanvas, type GPUContext } from '@xgis/rhi-webgpu'
import { QUALITY } from '@xgis/engine'

// jsdom/node leaves window undefined; install a minimal shim carrying only
// devicePixelRatio (gpu.ts reads window.devicePixelRatio; QUALITY caps it).
type WinShim = { devicePixelRatio?: number } | undefined
const g = globalThis as unknown as { window: WinShim }
const HAD_WINDOW = 'window' in globalThis

const CLIENT_W = 800
const CLIENT_H = 600

// Minimal GPUContext for resizeCanvas: it only reads canvas dims + calls
// context.configure when the size changes. device/format are passed through
// to configure unread by the test.
function makeCtx(): GPUContext {
  const canvas = {
    width: 0,
    height: 0,
    clientWidth: CLIENT_W,
    clientHeight: CLIENT_H,
  } as unknown as HTMLCanvasElement
  return {
    canvas,
    device: {} as GPUDevice,
    format: 'bgra8unorm' as GPUTextureFormat,
    context: { configure() {} } as unknown as GPUCanvasContext,
  } as unknown as GPUContext
}

describe('render-loop interaction-DPR matches the swapchain cap (no zoom-scale jump on gesture)', () => {
  let priorMax: number
  let priorInteraction: number | null
  beforeEach(() => {
    priorMax = QUALITY.maxDpr
    priorInteraction = QUALITY.interactionDpr
    // `balanced` preset: full quality at rest (maxDpr=2), reduced during a
    // gesture (interactionDpr=1.5). Device is hi-DPI so neither cap is the
    // raw devicePixelRatio — the cap is the thing under test.
    QUALITY.maxDpr = 2
    QUALITY.interactionDpr = 1.5
    g.window = { devicePixelRatio: 3 }
  })
  afterEach(() => {
    QUALITY.maxDpr = priorMax
    QUALITY.interactionDpr = priorInteraction
    if (HAD_WINDOW) g.window = undefined
    else delete (globalThis as unknown as Record<string, unknown>).window
  })

  it('during a gesture, effectiveDpr uses the interaction cap, NOT the full maxDpr', () => {
    // This is the exact value the render loop now feeds the camera. Before
    // the fix it computed Math.min(dpr, getMaxDpr()) = min(3, 2) = 2, which
    // disagreed with the 1.5 the swapchain was actually sized to.
    expect(effectiveDpr(true)).toBe(1.5)
    expect(effectiveDpr(true)).not.toBe(getMaxDpr()) // 1.5 !== 2 (the old buggy value)
  })

  it('at rest, effectiveDpr uses the full maxDpr cap (unchanged behaviour)', () => {
    expect(effectiveDpr(false)).toBe(2) // min(3, maxDpr=2)
  })

  it('the render-loop dpr exactly reconstructs the swapchain buffer size (the consistency contract)', () => {
    // The render loop derives ONE interaction-aware dpr per frame and feeds
    // the SAME value to resizeCanvas (swapchain) and the camera math, so
    // canvasHeight/dpr (the MVP altitude basis) equals the logical CSS
    // viewport — no jump.
    const ctx = makeCtx()
    const dpr = effectiveDpr(/* interacting */ true)
    resizeCanvas(ctx, dpr)
    expect(ctx.canvas.height).toBe(Math.floor(CLIENT_H * dpr))
    expect(ctx.canvas.width).toBe(Math.floor(CLIENT_W * dpr))
    // MVP altitude basis: device-height / dpr must recover the CSS height.
    // With the OLD dpr (getMaxDpr()=2) this would be 900/2 = 450 ≠ 600.
    expect(ctx.canvas.height / dpr).toBeCloseTo(CLIENT_H, 6)
  })

  it('SSR / no-GPU (no window) → dpr 1', () => {
    delete (globalThis as unknown as Record<string, unknown>).window
    expect(effectiveDpr(true)).toBe(1)
    expect(effectiveDpr(false)).toBe(1)
    g.window = { devicePixelRatio: 3 } // afterEach restores
  })

  it('interactionDpr null (default preset) → gesture keeps the full maxDpr cap', () => {
    QUALITY.interactionDpr = null
    // No reduced gesture cap configured: resizeCanvas and the render loop
    // both stay on maxDpr, so there is nothing to diverge.
    expect(effectiveDpr(true)).toBe(2)
    expect(effectiveDpr(false)).toBe(2)
  })
})

// #1153 M3 — resizeCanvas clamps the device-pixel swapchain to the backend's
// maxTextureDimension2D via a UNIFORM effective-DPR reduction (per-axis clamping
// would distort aspect + break the #929 B single-dpr invariant), and RETURNS the
// dpr that actually sized the buffer so the render loop's frame math can adopt it.
describe('resizeCanvas maxTextureDimension2D clamp (#1153 M3)', () => {
  function makeClampCtx(limit?: number): GPUContext {
    const canvas = {
      width: 0,
      height: 0,
      clientWidth: CLIENT_W, // 800
      clientHeight: CLIENT_H, // 600
    } as unknown as HTMLCanvasElement
    return {
      canvas,
      device: {} as GPUDevice,
      format: 'bgra8unorm' as GPUTextureFormat,
      context: { configure() {} } as unknown as GPUCanvasContext,
      ...(limit !== undefined ? { maxTextureDimension2D: limit } : {}),
    } as unknown as GPUContext
  }

  it('no maxTextureDimension2D field → no clamp, returns the input dpr (minimal-fixture contract)', () => {
    const ctx = makeClampCtx(undefined)
    const ret = resizeCanvas(ctx, 3)
    expect(ret).toBe(3)
    expect(ctx.canvas.width).toBe(Math.floor(CLIENT_W * 3)) // 2400 — byte-identical to pre-M3
    expect(ctx.canvas.height).toBe(Math.floor(CLIENT_H * 3)) // 1800
  })

  it('device-pixel size within the limit → returns the input dpr unchanged', () => {
    const ctx = makeClampCtx(8192)
    const ret = resizeCanvas(ctx, 3) // 2400×1800, both ≤ 8192
    expect(ret).toBe(3)
    expect(ctx.canvas.width).toBe(2400)
    expect(ctx.canvas.height).toBe(1800)
  })

  it('an axis exceeds the limit → uniform dpr reduction, both axes ≤ limit, aspect preserved', () => {
    // dpr 6 → 4800×3600 device px; limit 4096 clamps on width:
    // effDpr = 6 · min(1, 4096/4800, 4096/3600) = 6 · (4096/4800) = 5.12.
    const ctx = makeClampCtx(4096)
    const ret = resizeCanvas(ctx, 6)
    expect(ret).toBeCloseTo(6 * (4096 / 4800), 6)
    expect(ctx.canvas.width).toBeLessThanOrEqual(4096)
    expect(ctx.canvas.height).toBeLessThanOrEqual(4096)
    expect(ctx.canvas.width).toBeGreaterThanOrEqual(4095) // at the ceiling (±1 floor)
    // Aspect preserved (±1 px floor tolerance).
    const aspectIn = CLIENT_W / CLIENT_H
    const aspectOut = ctx.canvas.width / ctx.canvas.height
    expect(Math.abs(aspectOut - aspectIn)).toBeLessThan(0.01)
  })

  it('the render-loop consistency contract survives a clamp: canvas / returned-dpr recovers the CSS viewport', () => {
    // render-loop.ts now adopts the RETURNED dpr for the MVP altitude basis
    // (device-height / dpr). Under a clamp it must still recover the CSS size.
    const ctx = makeClampCtx(4096)
    const dpr = resizeCanvas(ctx, 6)
    expect(ctx.canvas.height / dpr).toBeCloseTo(CLIENT_H, 4)
    expect(ctx.canvas.width / dpr).toBeCloseTo(CLIENT_W, 4)
  })
})

// #1153 M5c review — the ONE dpr authority the OUTSIDE-the-render-loop consumers
// (project/unproject/getBounds/fitBounds/post-compile bounds-fit) read. It derives
// the effDpr the swapchain is ACTUALLY sized at from the canvas itself, so a clamp
// can never split it from a re-derived min(devicePixelRatio, maxDpr) (#929 B).
describe('canvasEffectiveDpr — canvas-derived dpr survives the M3 clamp', () => {
  it('under a clamp, recovers the effDpr the swapchain was sized at (width/clientWidth), NOT the naive cap', () => {
    // A 5000-CSS-px canvas on a DPR-2 display clamps to 8192 device px → effDpr
    // 1.6384; min(devicePixelRatio, maxDpr) would wrongly say 2 and under-report the
    // CSS viewport. The canvas is the authority.
    const canvas = { width: 8192, clientWidth: 5000 } as unknown as HTMLCanvasElement
    expect(canvasEffectiveDpr(canvas)).toBeCloseTo(8192 / 5000, 6)
    // getBounds/fitBounds recover the CSS viewport EXACTLY: width / dpr === clientWidth.
    expect(canvas.width / canvasEffectiveDpr(canvas)).toBeCloseTo(5000, 6)
  })

  it('un-clamped canvas: width === clientWidth·dpr recovers dpr exactly', () => {
    const canvas = { width: 1600, clientWidth: 800 } as unknown as HTMLCanvasElement
    expect(canvasEffectiveDpr(canvas)).toBe(2)
  })

  it('no CSS layout yet (clientWidth 0 / bare mock) → falls back to the quality-policy dpr', () => {
    const canvas = { width: 300, clientWidth: 0 } as unknown as HTMLCanvasElement
    expect(canvasEffectiveDpr(canvas)).toBe(effectiveDpr())
  })
})
