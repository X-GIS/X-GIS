// iter-342 — render-path truth probe for the azimuthal pitch-0
// discontinuity gate E (_camera-tilt-continuity) flagged (NDC 1864× at
// pitch 0→ε). That gate reads getCameraDebugSnapshot.matrix, which for
// ortho/stereo/azimuthal is the underlying FLAT camera — the projection
// runs in the shader (project_geom), so a jump in that matrix may NOT be
// what is actually drawn. This probe measures the RENDER PATH: capture
// real canvas pixels at pitch {0, 0.5, 30, 30.5} and compare the
// per-degree pixel change at the 0→ε boundary vs the mid-range 30→ε
// boundary. If 0→0.5 change ≫ 30→30.5 change, the discontinuity is REAL
// and visible (a fixable bug). If comparable, gate E's finding is a
// snapshot-matrix artifact (the shader re-projects smoothly). Diagnostic
// only — logs the verdict, asserts nothing host-specific.

import { test, expect } from '@playwright/test'
import { captureCanvas, pixelDiffRatio } from './helpers/visual'

const SPHERE_PROJS = ['orthographic', 'azimuthal_equidistant', 'stereographic']

async function setProjPitchSettle(
  page: import('@playwright/test').Page,
  proj: string,
  pitch: number,
): Promise<void> {
  await page.evaluate(
    ({ proj, pitch }) => {
      const m = (
        window as unknown as {
          __xgisMap: {
            setProjection(n: string): void
            getCamera(): {
              centerX: number
              centerY: number
              zoom: number
              bearing: number
              pitch: number
              maxZoom: number
            }
            markCameraPositioned(): void
            invalidate?(): void
          }
        }
      ).__xgisMap
      m.setProjection(proj)
      const R = 6378137,
        RAD = Math.PI / 180
      const c = m.getCamera()
      c.zoom = 2
      c.centerX = 127 * RAD * R
      c.centerY = Math.log(Math.tan(Math.PI / 4 + (30 * RAD) / 2)) * R
      c.bearing = 0
      c.pitch = pitch
      m.markCameraPositioned()
      m.invalidate?.()
    },
    { proj, pitch },
  )
  await page
    .waitForFunction(
      () => {
        const m = (
          window as unknown as {
            __xgisMap?: {
              getTileLoadDiagnostic(): Record<
                string,
                { catalogLoading: number; uploadQueued: number }
              >
              invalidate?(): void
            }
          }
        ).__xgisMap
        if (!m) return false
        m.invalidate?.()
        const d = m.getTileLoadDiagnostic()
        let n = 0
        for (const k in d) n += d[k]!.catalogLoading + d[k]!.uploadQueued
        return n === 0
      },
      null,
      { timeout: 25_000 },
    )
    .catch(() => {})
  await page.waitForTimeout(700)
}

test('azimuthal-family pitch-0 render-path continuity (real vs snapshot artifact)', async ({
  page,
}) => {
  test.setTimeout(220_000)
  const errs: string[] = []
  page.on('pageerror', (e) => errs.push(String(e)))
  await page.setViewportSize({ width: 800, height: 800 })
  await page.goto('/debug-labels.html?style=openfreemap-bright#2/30/127', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => !!(window as unknown as { __xgisMap?: unknown }).__xgisMap,
    null,
    { timeout: 30_000 },
  )
  await page.waitForTimeout(7_000)

  const verdicts: string[] = []
  for (const proj of SPHERE_PROJS) {
    await setProjPitchSettle(page, proj, 0)
    const p0 = await captureCanvas(page)
    await setProjPitchSettle(page, proj, 0.5)
    const p05 = await captureCanvas(page)
    await setProjPitchSettle(page, proj, 30)
    const p30 = await captureCanvas(page)
    await setProjPitchSettle(page, proj, 30.5)
    const p305 = await captureCanvas(page)

    const dBoundary = await pixelDiffRatio(page, p0, p05, 24) // 0 → 0.5°
    const dMid = await pixelDiffRatio(page, p30, p305, 24) // 30 → 30.5°
    // per-degree change ratio. >5× the mid-range slope = visible jump.
    const ratio = dMid > 1e-5 ? dBoundary / dMid : dBoundary > 0.05 ? 999 : 1
    const verdict = ratio > 5 ? 'REAL-JUMP' : 'smooth(artifact)'
    console.log(
      `[${proj}] 0→0.5°=${(dBoundary * 100).toFixed(2)}% 30→30.5°=${(dMid * 100).toFixed(2)}% slope-ratio=${ratio.toFixed(1)}× ⇒ ${verdict}`,
    )
    if (ratio > 5)
      verdicts.push(
        `${proj}: ${ratio.toFixed(1)}× (${(dBoundary * 100).toFixed(1)}% vs ${(dMid * 100).toFixed(1)}%)`,
      )
  }
  console.log(
    `REAL render-path pitch-0 jumps: ${verdicts.length ? verdicts.join(' | ') : 'NONE — gate E finding is a snapshot-matrix artifact'}; pageErrors: ${errs.length}`,
  )
  expect(errs, errs.slice(0, 3).join(' | ')).toHaveLength(0)
})
