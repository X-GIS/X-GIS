// iter-341 — per-projection label on-screen gate (recommendation D). A
// drawn label's anchor IS project(featureGeo) by construction, so the
// azimuthal-mispositioning class (memory project_azimuthal_label_position
// iter-157: projType 3/4/5 fell to the Mercator-frustum tile selector →
// labels dispatched from the WRONG tiles → glyphs land far from where
// the feature actually projects) shows up as label ANCHORS far OFF the
// viewport. Invariant: every drawn (placed) label anchor sits within the
// viewport + a generous margin, across ALL 8 projections at a city zoom
// (+ pitch). Reuses getDumpedLabels (anchorX/anchorY) — no new accessor.
// Real chromium WebGPU.

import { test, expect } from '@playwright/test'

const W = 800,
  H = 800
const MARGIN = 400 // labels just off-edge are legit; >0.5 viewport out = wrong dispatch

const _PROJECTIONS = [
  'mercator',
  'globe',
  'orthographic',
  'azimuthal_equidistant',
  'stereographic',
  'equirectangular',
  'natural_earth',
  'oblique_mercator',
]

test('per-projection labels stay on-screen (no wrong-tile mispositioning)', async ({ page }) => {
  test.setTimeout(200_000)
  const errs: string[] = []
  page.on('pageerror', (e) => errs.push(String(e)))
  await page.setViewportSize({ width: W, height: H })
  await page.goto('/debug-labels.html?style=openfreemap-bright#14/37.566/126.978', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => !!(window as unknown as { __xgisMap?: unknown }).__xgisMap,
    null,
    { timeout: 30_000 },
  )
  await page.waitForTimeout(8_000)

  const reports = await page.evaluate(
    async ({ W, H, MARGIN }) => {
      interface DL {
        anchorX: number
        anchorY: number
        curved: boolean
        text: string
      }
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
            setLabelDumpFilter(s: string): void
            getDumpedLabels(): DL[] | null
            getTileLoadDiagnostic(): Record<
              string,
              { catalogLoading: number; uploadQueued: number }
            >
          }
        }
      ).__xgisMap
      const R = 6378137,
        RAD = Math.PI / 180
      const setCam = (zoom: number, pitch: number) => {
        const c = m.getCamera()
        c.zoom = zoom
        c.centerX = 126.978 * RAD * R
        c.centerY = Math.log(Math.tan(Math.PI / 4 + (37.566 * RAD) / 2)) * R
        c.bearing = 0
        c.pitch = pitch
        m.markCameraPositioned()
        m.invalidate?.()
      }
      const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
      const settle = async () => {
        let st = 0
        for (let i = 0; i < 40; i++) {
          await sleep(400)
          m.invalidate?.()
          const d = m.getTileLoadDiagnostic()
          let n = 0
          for (const k in d) n += d[k]!.catalogLoading + d[k]!.uploadQueued
          if (n === 0) {
            if (++st >= 2) return
          } else st = 0
        }
      }
      const out: { proj: string; total: number; offscreen: number; worst: string }[] = []
      for (const proj of [
        'mercator',
        'globe',
        'orthographic',
        'azimuthal_equidistant',
        'stereographic',
        'equirectangular',
        'natural_earth',
        'oblique_mercator',
      ]) {
        m.setProjection(proj)
        setCam(14, 0)
        await settle()
        m.setLabelDumpFilter('')
        m.invalidate?.()
        await sleep(450)
        const labels = m.getDumpedLabels() ?? []
        let off = 0,
          worst = ''
        let worstD = 0
        for (const l of labels) {
          const ax = l.anchorX,
            ay = l.anchorY
          const outX = ax < -MARGIN || ax > W + MARGIN
          const outY = ay < -MARGIN || ay > H + MARGIN
          if (outX || outY) {
            off++
            const d = Math.max(ax < 0 ? -ax : ax - W, ay < 0 ? -ay : ay - H)
            if (d > worstD) {
              worstD = d
              worst = `"${l.text.replace(/\n/g, '\\n')}"@(${ax.toFixed(0)},${ay.toFixed(0)})`
            }
          }
        }
        out.push({ proj, total: labels.length, offscreen: off, worst })
      }
      return out
    },
    { W, H, MARGIN },
  )

  const offenders: string[] = []
  for (const r of reports) {
    console.log(
      `[${r.proj}] ${r.total} labels, ${r.offscreen} off-screen${r.worst ? ' worst ' + r.worst : ''}`,
    )
    // A couple just past the margin is fine; many = wrong-tile dispatch.
    if (r.offscreen > 3) offenders.push(`${r.proj}: ${r.offscreen} off-screen (${r.worst})`)
  }
  console.log(
    `offenders: ${offenders.length ? offenders.join(' | ') : 'none'}; pageErrors: ${errs.length}`,
  )
  expect(errs, errs.slice(0, 3).join(' | ')).toHaveLength(0)
  expect(
    offenders,
    'projections with many off-screen label anchors (wrong-tile mispositioning)',
  ).toEqual([])
})
