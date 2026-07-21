// #1235 — the un-parked "Measure distances" demo gate. Two synthetic clicks
// must produce the amber CONNECTOR between them, asserted STRUCTURALLY (a
// contiguous amber run on the midline band between the click columns) — the
// #1235 lesson: a pixel-count gate passes with the connector missing, which is
// exactly how the gap-1 bug originally slipped through. Also asserts the
// haversine badge and click-to-remove.

import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '__1235-measure-gate__')

type Win = Window & {
  __xgisReady?: boolean
  __xgisMap?: {
    invalidate?: () => void
    getTileLoadDiagnostic?: () => Record<string, { catalogLoading: number; uploadQueued: number }>
  }
}

async function settle(page: import('@playwright/test').Page, ms = 2000): Promise<void> {
  await page
    .waitForFunction(
      () => {
        const m = (window as unknown as Win).__xgisMap
        if (!m?.getTileLoadDiagnostic) return true
        m.invalidate?.()
        const d = m.getTileLoadDiagnostic()
        let n = 0
        for (const k in d) n += d[k]!.catalogLoading + d[k]!.uploadQueued
        return n === 0
      },
      null,
      { timeout: 30_000 },
    )
    .catch(() => {})
  await page.waitForTimeout(ms)
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  )
}

test('#1235 measure demo — clicks build the amber connector + haversine badge', async ({
  page,
}) => {
  test.setTimeout(240_000)
  mkdirSync(OUT, { recursive: true })
  await page.setViewportSize({ width: 1100, height: 800 })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)))

  await page.goto('/demo.html?id=measure_distances&e2e=1', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window as unknown as Win).__xgisReady === true, null, {
    timeout: 30_000,
  })
  await settle(page, 2500)

  const box = (await page.locator('#map').boundingBox())!
  const y = Math.round(box.height * 0.5)
  const x1 = Math.round(box.width * 0.3)
  const x2 = Math.round(box.width * 0.7)
  await page.mouse.click(box.x + x1, box.y + y)
  await page.waitForTimeout(400)
  await page.mouse.click(box.x + x2, box.y + y)
  await settle(page, 2000)

  const png = await page.locator('#map').screenshot()
  writeFileSync(join(OUT, 'two-clicks.png'), png)

  const badge = await page.locator('#measure-badge').textContent()
  console.log(`BADGE: ${badge}`)

  // Structural connector assertion: within the midline band (clicks were at
  // the same screen y = height/2, so the connector stays near it — the ratio
  // survives the CSS-px → device-px screenshot scale), some row must carry a
  // contiguous amber run covering most of the click span.
  const m2 = await page.evaluate(
    async ({ b64, yRatio }) => {
      const blob = await fetch(`data:image/png;base64,${b64}`).then((r) => r.blob())
      const bmp = await createImageBitmap(blob)
      const c = document.createElement('canvas')
      c.width = bmp.width
      c.height = bmp.height
      const ctx = c.getContext('2d')!
      ctx.drawImage(bmp, 0, 0)
      const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data
      const yMid = Math.round(bmp.height * yRatio)
      const band = Math.round(bmp.height * 0.06)
      let maxRun = 0
      for (let y = Math.max(0, yMid - band); y < Math.min(bmp.height, yMid + band); y++) {
        let run = 0
        for (let x = 0; x < bmp.width; x++) {
          const i = (y * bmp.width + x) * 4
          const isStroke = d[i] > 200 && d[i + 1] > 130 && d[i + 1] < 220 && d[i + 2] < 110
          if (isStroke) {
            run++
            if (run > maxRun) maxRun = run
          } else run = 0
        }
      }
      return { maxRun, w: bmp.width }
    },
    { b64: png.toString('base64'), yRatio: 0.5 },
  )
  console.log(`CONNECTOR: maxRun=${m2.maxRun}px of width=${m2.w}px`)

  expect(errors, 'no page errors').toEqual([])
  expect(badge ?? '', 'badge shows a haversine total').toMatch(/Total distance: \d+(\.\d+)? km/)
  // The click span is 40% of the canvas width; the connector must cover most
  // of it in one contiguous run (tile-seam AA may split it once).
  expect(m2.maxRun, 'amber connector spans the click gap').toBeGreaterThan(m2.w * 0.25)

  // Click-to-remove: clicking the second point again removes it → 1 point,
  // no connector, badge resets to the 1-point state.
  await page.mouse.click(box.x + x2, box.y + y)
  await page.waitForTimeout(800)
  const badge2 = await page.locator('#measure-badge').textContent()
  console.log(`BADGE2: ${badge2}`)
  expect(badge2 ?? '', 'removing a point updates the badge').toMatch(/1 point\b/)
})
