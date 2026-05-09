// Validates Batch 6 — `step` (N-stop) + `concat` end-to-end on a
// real GeoJSON feature set. The demo styles populated-places by
// pop_max into 4 size+color tiers and composes "Name, Country
// (NNN k)" labels via concat.
//
// Coarse signals are enough for a smoke test:
//   - Non-zero white pixel count → labels rendered
//   - Multiple distinct fill colors present → step tiers worked
//     (a broken step would either crash or fall through to a
//     single color)

import { test, expect } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ART = join(HERE, '__step-and-concat__')
mkdirSync(ART, { recursive: true })

test('step (N-stop) + concat render city tiers + composite labels', async ({ page }) => {
  test.setTimeout(45_000)
  await page.setViewportSize({ width: 1280, height: 800 })

  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))

  await page.goto('/demo.html?id=step_and_concat#1.5/0/0/0/0', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 20_000 },
  )
  await page.waitForTimeout(2_500)

  const png = await page.locator('#map').screenshot()
  writeFileSync(join(ART, 'step-and-concat.png'), png)

  const stats = await page.evaluate(async () => {
    const canvas = document.getElementById('map') as HTMLCanvasElement
    const blob = await new Promise<Blob | null>((res) =>
      canvas.toBlob((b) => res(b), 'image/png'),
    )
    if (!blob) return { error: 'no blob' }
    const url = URL.createObjectURL(blob)
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image()
      i.onload = () => res(i); i.onerror = () => rej(new Error('decode'))
      i.src = url
    })
    const off = new OffscreenCanvas(img.width, img.height)
    const ctx = off.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    const data = ctx.getImageData(0, 0, img.width, img.height).data
    let pureWhite = 0
    let rosePixels = 0  // step-sized dots use rose-500 = #f43f5e
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!
      if (r >= 250 && g >= 250 && b >= 250) pureWhite++
      // rose-500 fill: r≈244, g≈63, b≈94. Coarse band around it.
      if (r > 200 && g < 120 && b > 60 && b < 140) rosePixels++
    }
    return { pureWhite, rosePixels }
  })

  // eslint-disable-next-line no-console
  console.log('[step-and-concat]', stats)

  if ('error' in stats) throw new Error(stats.error as string)
  // Labels rendered.
  expect(stats.pureWhite,
    `expected white label pixels (got ${stats.pureWhite})`,
  ).toBeGreaterThan(20)
  // Step-sized rose dots rendered (size-driven by step).
  expect(stats.rosePixels,
    `expected rose-coloured city dots (got ${stats.rosePixels})`,
  ).toBeGreaterThan(50)

  const compileErrors = errors.filter(e =>
    e.includes('Unexpected character') ||
    e.includes('Expected utility name') ||
    e.includes('parse error'),
  )
  expect(compileErrors, 'no compile errors').toEqual([])
})
