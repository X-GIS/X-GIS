// DPR unit-correctness for the public camera/viewport API (panBy /
// fitBounds / getBounds). The render path (view-matrix.ts buildRTCMatrix)
// is metres-per-CSS-pixel and Camera.pan is DPR-invariant (the `× dpr`
// factor was deliberately removed, commit ee1f394). But canvas.width is
// DEVICE pixels = clientWidth*dpr (gpu.ts resizeCanvas:
//   const dpr = Math.min(window.devicePixelRatio || 1, getMaxDpr())
//   const w   = Math.floor(ctx.canvas.clientWidth * dpr)
// ). Three controller methods used to consume the device-pixel width (or
// multiply CSS-px input by dpr), so at DPR=2 they were off by a factor of
// 2 (panBy moved 2× farther, getBounds was 2× too wide, fitBounds zoomed
// one full level too high). These tests pin DPR-INVARIANCE: identical CSS
// viewport ⇒ identical result regardless of window.devicePixelRatio.
//
// jsdom leaves window.devicePixelRatio undefined (→ 1); we set it
// explicitly and build the mock canvas so canvas.width === cssWidth*dpr,
// mirroring gpu.ts. getMaxDpr() defaults to 2 (QUALITY_PRESETS.default),
// so DPR=2 is NOT clamped down — the bug is fully exercised.

import { describe, expect, it, afterEach } from 'vitest'
import { XGISMap } from '@xgis/map'

// The vitest env is `node` (vitest.config.ts sets no `environment`), so
// `window` is undefined by default — which is exactly why the existing
// map-camera-api panBy test runs "at DPR=1" (the controller's
// `typeof window !== 'undefined'` guard falls through to dpr=1). To
// exercise the DPR=2 path we install a minimal `window` carrying only
// `devicePixelRatio`; gpu.ts's getMaxDpr() reads QUALITY (default 2), and
// the controller reads `window.devicePixelRatio`. afterEach removes it.
type WinShim = { devicePixelRatio?: number } | undefined
const g = globalThis as unknown as { window: WinShim }
const HAD_WINDOW = 'window' in globalThis

// CSS viewport held constant across the DPR=1 / DPR=2 runs so the ONLY
// difference is devicePixelRatio. canvas.width/height = CSS * dpr (device
// px) exactly as gpu.ts resizeCanvas computes them.
const CSS_W = 600
const CSS_H = 400

function mockCanvas(dpr: number): HTMLCanvasElement {
  return { width: CSS_W * dpr, height: CSS_H * dpr } as unknown as HTMLCanvasElement
}

interface Internals {
  // `getCtxCanvas()` returns `this.ctx?.canvas`; fitBounds reads it. Inject
  // a fake ctx so fitBounds sees the device-px mock canvas (otherwise it
  // falls back to the CSS-notional 800 default and never exercises dpr).
  ctx: { canvas: HTMLCanvasElement }
  camera: { centerX: number; centerY: number; zoom: number; bearing: number; pitch: number }
  setCenter(lon: number, lat: number): void
  setZoom(zoom: number): void
  panBy(offset: [number, number]): void
  fitBounds(bounds: [[number, number], [number, number]], opts?: { padding?: number }): void
  getBounds(): [[number, number], [number, number]]
  getCameraState(): { center: [number, number]; zoom: number; bearing: number; pitch: number }
}

function makeMap(dpr: number): Internals {
  g.window = { devicePixelRatio: dpr }
  const canvas = mockCanvas(dpr)
  const m = new XGISMap(canvas) as unknown as Internals
  // getCanvas() returns the ctor canvas already; wire ctx.canvas so the
  // ctx-only accessor fitBounds uses also resolves to the device-px mock.
  m.ctx = { canvas }
  return m
}

describe('camera API DPR unit-correctness (panBy / fitBounds / getBounds)', () => {
  afterEach(() => {
    // Remove the shim so other suites that rely on `window` being absent
    // (→ controller dpr=1) are unaffected.
    if (HAD_WINDOW) g.window = undefined
    else delete (globalThis as unknown as Record<string, unknown>).window
  })

  describe('panBy is DPR-invariant', () => {
    it('panBy([N,0]) moves the camera center the SAME world distance at DPR=2 as at DPR=1', () => {
      const N = 100

      const m1 = makeMap(1)
      m1.setCenter(0, 0)
      m1.setZoom(4)
      const start1 = m1.camera.centerX
      m1.panBy([N, 0])
      const delta1 = m1.camera.centerX - start1

      const m2 = makeMap(2)
      m2.setCenter(0, 0)
      m2.setZoom(4)
      const start2 = m2.camera.centerX
      m2.panBy([N, 0])
      const delta2 = m2.camera.centerX - start2

      // DPR-invariant: same CSS-px drag ⇒ same world delta.
      // (Before the fix: delta2 === 2 * delta1.)
      expect(delta2).toBeCloseTo(delta1, 6)
      expect(delta1).toBeGreaterThan(0) // sanity: it actually moved
    })
  })

  describe('fitBounds is DPR-invariant', () => {
    it('the resulting zoom at DPR=2 equals the DPR=1 zoom (not one level higher)', () => {
      const bounds: [[number, number], [number, number]] = [[120, 30], [130, 40]]

      const m1 = makeMap(1)
      m1.fitBounds(bounds)
      const zoom1 = m1.camera.zoom

      const m2 = makeMap(2)
      m2.fitBounds(bounds)
      const zoom2 = m2.camera.zoom

      // DPR-invariant fit. (Before the fix: zoom2 === zoom1 + log2(2) = +1.)
      expect(zoom2).toBeCloseTo(zoom1, 6)
    })

    it('the requested bbox fits within the viewport after fitBounds (DPR=2)', () => {
      const bounds: [[number, number], [number, number]] = [[120, 30], [130, 40]]
      const requestedLonSpan = 130 - 120

      const m2 = makeMap(2)
      m2.fitBounds(bounds)
      // After the fit, getBounds recovers the viewport extent. The viewport
      // lon span must be AT LEAST the requested lon span (the bbox fits inside,
      // not cropped). It may be wider when the lat axis is the tighter
      // constraint (fitBounds now picks min(lonFitZoom, latFitZoom)), but
      // it must NOT be narrower (bbox cropped). Before the DPR fix the
      // over-high zoom made the visible span ~half the request → cropped.
      const [[w], [e]] = m2.getBounds()
      expect(e - w).toBeGreaterThanOrEqual(requestedLonSpan * 0.999)
    })
  })

  describe('getBounds is DPR-invariant', () => {
    it('the returned lon span at DPR=2 equals the DPR=1 span (not 2× wider)', () => {
      const m1 = makeMap(1)
      m1.setCenter(0, 0)
      m1.setZoom(4)
      const b1 = m1.getBounds()
      const lonSpan1 = b1[1][0] - b1[0][0]

      const m2 = makeMap(2)
      m2.setCenter(0, 0)
      m2.setZoom(4)
      const b2 = m2.getBounds()
      const lonSpan2 = b2[1][0] - b2[0][0]

      // DPR-invariant. (Before the fix: lonSpan2 === 2 * lonSpan1.)
      expect(lonSpan2).toBeCloseTo(lonSpan1, 6)
      expect(lonSpan1).toBeGreaterThan(0)
    })

    it('the returned lat span at DPR=2 equals the DPR=1 span (not 2× taller)', () => {
      const m1 = makeMap(1)
      m1.setCenter(0, 0)
      m1.setZoom(4)
      const b1 = m1.getBounds()
      const latSpan1 = b1[1][1] - b1[0][1]

      const m2 = makeMap(2)
      m2.setCenter(0, 0)
      m2.setZoom(4)
      const b2 = m2.getBounds()
      const latSpan2 = b2[1][1] - b2[0][1]

      expect(latSpan2).toBeCloseTo(latSpan1, 6)
      expect(latSpan1).toBeGreaterThan(0)
    })
  })
})
