// §5 render proof for the allow-overlap DRAW-order near-first change: two
// overlapping same-layer allow-overlap labels in distinct colours, dispatched
// near-first (so SOURCE order would paint the FAR one on top), must render with
// the NEAR (larger screen-Y) label ON TOP. Reads the real-pipeline draw order
// via getDumpedLabels (authoritative for a painter-order change) and saves a
// screenshot. Headless SwiftShader + ?forcegl2=1 (same harness as
// _labels-gl2-gate); injects a custom source via window.__xgisRunSource so no
// permanent demo is added.

import { test, expect } from '@playwright/test'
import fs from 'node:fs'

const OUT = 'e2e/__label-draw-order__'

const SRC = `xgis 1
source pts { type: geojson }
layer lbl {
  source: pts
  | label-[.name] label-color-[.color] label-size-40
    label-halo-2 label-halo-color-#000 label-allow-overlap
}`

// NEAR (lower on screen, larger Y) dispatched FIRST → source order would draw it
// UNDER the far one. Two points a small latitude apart at the same lon so their
// size-40 labels overlap vertically; distinct colours so the top one is legible.
const DATA = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { name: 'NEAR', color: '#00b0ff' }, // blue, southern (lower on screen)
      geometry: { type: 'Point', coordinates: [0, 0.0] },
    },
    {
      type: 'Feature',
      properties: { name: 'FAR', color: '#ff4040' }, // red, northern; ~12px above → labels overlap
      geometry: { type: 'Point', coordinates: [0, 0.55] },
    },
  ],
}

interface DumpLabel {
  text: string
  anchorX: number
  anchorY: number
}

test('near (larger-Y) allow-overlap label paints on top of the far one', async ({ page }) => {
  test.setTimeout(120_000)
  fs.mkdirSync(OUT, { recursive: true })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push(m.text().slice(0, 300))
  })

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto('/demo.html?id=multiline_labels&forcegl2=1&e2e=1#4/0.8/0', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 60_000 },
  )
  // Inject the allow-overlap style, then push the two overlapping points.
  await page.evaluate(async (src) => {
    await (
      window as unknown as { __xgisRunSource?: (s: string) => Promise<unknown> }
    ).__xgisRunSource?.(src)
  }, SRC)
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 30_000 },
  )
  await page.evaluate((fc) => {
    ;(
      window as unknown as { __xgisMap?: { setSourceData?: (id: string, fc: unknown) => void } }
    ).__xgisMap?.setSourceData?.('pts', fc)
  }, DATA)
  await page
    .waitForFunction(
      () => {
        const m = (
          window as unknown as {
            __xgisMap?: { getLastLabelCounts?: () => { drawn: number } | null }
          }
        ).__xgisMap
        const c = m?.getLastLabelCounts?.()
        return !!c && c.drawn >= 2
      },
      null,
      { timeout: 30_000 },
    )
    .catch(() => {})
  await page.evaluate(() => {
    const m = (
      window as unknown as {
        __xgisMap?: { setLabelDumpFilter?: (s: string) => void; invalidate?: () => void }
      }
    ).__xgisMap
    m?.setLabelDumpFilter?.('')
    m?.invalidate?.()
  })
  await page.waitForTimeout(1_200)

  const dump = (await page.evaluate(() => {
    const m = (window as unknown as { __xgisMap?: { getDumpedLabels?: () => DumpLabel[] | null } })
      .__xgisMap
    return (m?.getDumpedLabels?.() ?? []).map((l) => ({
      text: l.text,
      x: Math.round(l.anchorX),
      y: Math.round(l.anchorY),
    }))
  })) as { text: string; x: number; y: number }[]

  console.log('draw order (emission order):', JSON.stringify(dump))
  console.log('errors:', JSON.stringify(errors))
  await page.screenshot({ path: `${OUT}/near-on-top.png` })
  fs.writeFileSync(`${OUT}/dump.json`, JSON.stringify(dump, null, 2))

  const near = dump.find((d) => d.text === 'NEAR')
  const far = dump.find((d) => d.text === 'FAR')
  expect(near, 'NEAR drawn').toBeTruthy()
  expect(far, 'FAR drawn').toBeTruthy()
  // NEAR sits lower on screen (larger anchorY) than FAR — the scene precondition.
  expect(near!.y).toBeGreaterThan(far!.y)
  // Painter order: NEAR must be emitted AFTER FAR (drawn last = on top), even
  // though it was dispatched first. Before the within-layer Y-sort this was
  // reversed (source order → FAR last).
  const nearIdx = dump.findIndex((d) => d.text === 'NEAR')
  const farIdx = dump.findIndex((d) => d.text === 'FAR')
  expect(nearIdx).toBeGreaterThan(farIdx)
})
