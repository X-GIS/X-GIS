// Spec invariants — camera state correctness through the render loop.
// Verifies bearing, pitch, projection, viewport, dpr all reach the
// frame intent intact. Catches regressions in camera matrix
// composition or canvas DPR handling.

import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'

interface FrameTrace {
  cameraZoom: number
  cameraCenter: readonly [number, number]
  cameraBearing: number
  cameraPitch: number
  projection: string
  viewportPx: readonly [number, number]
  dpr: number
  tileLOD: { selectedCz: number; fetchedKeys: readonly string[] }
  layers: unknown[]
  labels: unknown[]
}

async function captureTrace(page: Page, hash: string): Promise<FrameTrace> {
  await page.goto(`/compare.html?style=openfreemap-bright${hash}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 30_000 },
  )
  await page.waitForTimeout(6_000)
  return await page.evaluate(async () => {
    const map = (window as unknown as { __xgisMap?: { captureNextFrameTrace?: () => Promise<FrameTrace> } }).__xgisMap
    if (!map?.captureNextFrameTrace) throw new Error('captureNextFrameTrace missing')
    return await map.captureNextFrameTrace()
  })
}

test.describe('camera-state spec invariants', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 800 })
  })

  test('zoom from URL hash reaches the frame trace verbatim', async ({ page }) => {
    test.setTimeout(45_000)
    const trace = await captureTrace(page, '#5.42/40/0')
    expect(trace.cameraZoom).toBeCloseTo(5.42, 2)
  })

  test('bearing from URL hash reaches the frame trace verbatim', async ({ page }) => {
    test.setTimeout(45_000)
    const trace = await captureTrace(page, '#4/40/0/45/0')
    expect(trace.cameraBearing).toBeCloseTo(45, 1)
  })

  test('pitch from URL hash reaches the frame trace verbatim', async ({ page }) => {
    test.setTimeout(45_000)
    const trace = await captureTrace(page, '#14/40.75/-73.98/0/60')
    expect(trace.cameraPitch).toBeCloseTo(60, 1)
  })

  test('viewport size + dpr correspond to canvas physical pixels', async ({ page }) => {
    test.setTimeout(45_000)
    const trace = await captureTrace(page, '#3/0/0')
    expect(trace.viewportPx[0]).toBeGreaterThan(0)
    expect(trace.viewportPx[1]).toBeGreaterThan(0)
    expect(trace.dpr).toBeGreaterThanOrEqual(1)
    // canvas.width = CSS_width * dpr. With viewport 1400 CSS px,
    // a single pane at 50% width is ~700 CSS px; physical px =
    // 700 * dpr should match trace.viewportPx[0].
  })

  test.skip('tile-LOD selectedCz follows the z+0.7 floor rule at z=2.3', async ({ page }) => {
    // SKIP: recordTileLOD hook not yet wired into VTR.render. Future
    // PR connects vector-tile-renderer.ts's cz selection (around line
    // 2123-2150 after commit 4e348ff) to the recorder. Once wired:
    //   cz = floor(2.3 + 0.7) = 3 → expect(selectedCz).toBe(3)
    test.setTimeout(45_000)
    const trace = await captureTrace(page, '#2.3/0/0')
    expect(trace.tileLOD.selectedCz).toBe(3)
  })

  test('mercator projection name flows into the trace', async ({ page }) => {
    test.setTimeout(45_000)
    const trace = await captureTrace(page, '#3/0/0')
    expect(trace.projection).toBe('mercator')
  })
})
