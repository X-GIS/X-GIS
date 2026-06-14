// Regression gate for the render-loop interaction-DPR vs MVP-DPR mismatch.
//
// resizeCanvas(ctx, _interacting) sizes the swapchain with the
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
// The fix unifies both call sites on one helper, gpu.ts `effectiveDpr`, so
// resizeCanvas (the swapchain size) and the render loop (the camera dpr)
// can never diverge. These tests pin that contract — pure CPU, no GPU.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { effectiveDpr, resizeCanvas, getMaxDpr, type GPUContext } from './gpu/gpu'
import { QUALITY } from './gpu/quality'

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
    // resizeCanvas sizes the swapchain with the interaction-aware cap during
    // a gesture. The render loop must derive the SAME dpr so canvasHeight/dpr
    // (the MVP altitude basis) equals the logical CSS viewport — no jump.
    const ctx = makeCtx()
    resizeCanvas(ctx, /* interacting */ true)

    const dpr = effectiveDpr(true)
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
