// Validates Batch 1d: `symbol-placement: line` (xgis utility
// `label-along-path`) walks lineVertices, places one label per
// feature at the first segment's midpoint, rotated to the local
// tangent.
//
// We can't easily probe rotation per-glyph, but two coarser
// signals are enough for a smoke test:
//   1. Non-zero white pixel count = labels rendered (cf.
//      _pmtiles-labels.spec which uses the same threshold).
//   2. forEachLineLabelFeature must be called — surface that as
//      no compile errors AND non-zero label count via the canvas.

import { test, expect } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ART = join(HERE, '__along-path-roads__')
mkdirSync(ART, { recursive: true })

test('label-along-path renders road names from VT linestrings', async ({ page }) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1280, height: 800 })

  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))

  // Florence Duomo at z=15 — `roads` source-layer is dense here.
  await page.goto('/demo.html?id=along_path_roads#15/43.7733/11.2558/0/0', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 30_000 },
  )
  await page.waitForTimeout(4_000)

  const png = await page.locator('#map').screenshot()
  writeFileSync(join(ART, 'along-path-roads.png'), png)

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
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] >= 250 && data[i + 1] >= 250 && data[i + 2] >= 250) pureWhite++
    }
    return { pureWhite }
  })

  // eslint-disable-next-line no-console
  console.log('[along-path-roads]', stats)

  if ('error' in stats) throw new Error(stats.error as string)
  // Stone-300 roads (RGB ~214) never reach >=250 — only white
  // label fills do. Florence at z=15 has dozens of named roads,
  // so we expect significant white pixel coverage.
  expect(stats.pureWhite,
    `expected white text pixels (got ${stats.pureWhite})`,
  ).toBeGreaterThan(50)

  const compileErrors = errors.filter(e =>
    e.includes('Unexpected character') ||
    e.includes('Expected utility name') ||
    e.includes('parse error'),
  )
  expect(compileErrors, 'no compile errors').toEqual([])
})
