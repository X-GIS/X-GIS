// Near-first occlusion gate for the site-demo report: at
// #2.90/42.29894/119.09100/30.0/81.4 on layer_below_labels, Shanghai sits
// NEARER the camera (lower on screen, pitch 81.4°) than Seoul and their
// boxes overlap. The collision pass used to drop Shanghai and keep Seoul
// (the depth-blind lexicographic #728 tieBreak); with CollisionItem.nearY
// the FRONT label must win and the one behind is occluded — the Mapbox/
// MapLibre near-first placement direction.
//
// Reads the post-collision draw list via setLabelDumpFilter('') +
// getDumpedLabels (CPU-side placement decision — SwiftShader-safe) and the
// pre-collision submissions via getDispatchedLabelTexts. Headless
// SwiftShader (HEADED=0 XGIS_SOFTWARE_GPU=1) + ?forcegl2=1, same as
// _labels-gl2-gate.spec.ts.

import { test, expect } from '@playwright/test'
import fs from 'node:fs'

const OUT = 'e2e/__label-occlusion__'
const HASH = '#2.90/42.29894/119.09100/30.0/81.4'

interface DumpLabel {
  text: string
  anchorX: number
  anchorY: number
  curved: boolean
}

test('dump placed labels at the reported pitched camera', async ({ page }) => {
  test.setTimeout(120_000)
  fs.mkdirSync(OUT, { recursive: true })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push(m.text().slice(0, 300))
  })

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/demo.html?id=layer_below_labels&forcegl2=1&e2e=1${HASH}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 60_000 },
  )
  // Wait until labels actually dispatch + place (geojson fetch → shaping).
  await page
    .waitForFunction(
      () => {
        const m = (
          window as unknown as {
            __xgisMap?: { getLastLabelCounts?: () => { drawn: number } | null }
          }
        ).__xgisMap
        const c = m?.getLastLabelCounts?.()
        return !!c && c.drawn > 0
      },
      null,
      { timeout: 40_000 },
    )
    .catch(() => {})
  // Filter '' matches every drawn label (includes('') === true).
  await page.evaluate(() => {
    const m = (
      window as unknown as {
        __xgisMap?: { setLabelDumpFilter?: (s: string) => void; invalidate?: () => void }
      }
    ).__xgisMap
    m?.setLabelDumpFilter?.('')
    m?.invalidate?.()
  })
  await page.waitForTimeout(1_500)

  const result = await page.evaluate(() => {
    const m = (
      window as unknown as {
        __xgisMap?: {
          getDumpedLabels?: () => DumpLabel[] | null
          getDispatchedLabelTexts?: () => string[] | null
          getLastLabelCounts?: () => { submitted: number; drawn: number } | null
        }
      }
    ).__xgisMap
    interface DumpLabel {
      text: string
      anchorX: number
      anchorY: number
      curved: boolean
    }
    return {
      drawn: (m?.getDumpedLabels?.() ?? []).map((l) => ({
        text: l.text,
        x: Math.round(l.anchorX),
        y: Math.round(l.anchorY),
      })),
      dispatched: m?.getDispatchedLabelTexts?.() ?? [],
      counts: m?.getLastLabelCounts?.() ?? null,
    }
  })

  console.log('label counts:', JSON.stringify(result.counts))
  console.log('dispatched (pre-collision):', JSON.stringify(result.dispatched))
  console.log('drawn (post-collision), by anchorY:')
  for (const l of [...result.drawn].sort((a, b) => a.y - b.y)) {
    console.log(`  y=${String(l.y).padStart(4)} x=${String(l.x).padStart(4)}  ${l.text}`)
  }
  console.log('page errors:', JSON.stringify(errors))

  await page.screenshot({ path: `${OUT}/reported-camera.png` })
  fs.writeFileSync(`${OUT}/reported-camera.json`, JSON.stringify(result, null, 2))

  // Both cities were submitted (the bug is in collision, not dispatch)…
  expect(result.dispatched).toContain('Seoul')
  expect(result.dispatched).toContain('Shanghai')
  // …their boxes overlap at this camera, so exactly one survives — and it
  // must be the NEAR one. Before the nearY fix this pair resolved the
  // other way (Seoul drawn, Shanghai dropped).
  const drawnTexts = result.drawn.map((l) => l.text)
  expect(drawnTexts).toContain('Shanghai')
  expect(drawnTexts).not.toContain('Seoul')
})
