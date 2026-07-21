// #1235 Gap 1 — a LineString pushed via setSourceData into an initially-empty
// geojson source must render. Control scene: the SAME line declared inline at
// compile time renders fine — the gap is specifically line geometry arriving
// through the push path.
//
// STRUCTURAL assertion (the #1235 lesson: a pixel-count gate passes with the
// connector missing): the amber stroke must form a horizontal band — some row
// must carry a contiguous amber run ≥ 200 px, not just scattered pixels.

import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '__1235-push-line__')

const PUSH_SRC = `xgis 1

source measure_path {
  type: geojson
  data: { "type": "FeatureCollection", "features": [] }
}

layer measure_line {
  source: measure_path
  | stroke-amber-400 stroke-6
}
`

const DECLARED_SRC = `xgis 1

source measure_path {
  type: geojson
  data: { "type": "FeatureCollection", "features": [
    { "type": "Feature", "id": 0, "properties": {},
      "geometry": { "type": "LineString", "coordinates": [[-60, 10], [60, 10]] } }
  ] }
}

layer measure_line {
  source: measure_path
  | stroke-amber-400 stroke-6
}
`

type Win = Window & {
  __xgisReady?: boolean
  __xgisMap?: {
    invalidate?: () => void
    setSourceData?: (id: string, fc: unknown) => void
    getTileLoadDiagnostic?: () => Record<string, { catalogLoading: number; uploadQueued: number }>
  }
}

// Pin the camera so BOTH scenes render the identical view — the empty-source
// scene has nothing to auto-fit, and a camera difference must not masquerade
// as the render gap.
async function pinCamera(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const m = (
      window as unknown as {
        __xgisMap: {
          getCamera(): { centerX: number; centerY: number; zoom: number; maxZoom: number }
          markCameraPositioned(): void
          invalidate?: () => void
        }
      }
    ).__xgisMap
    const R = 6378137
    const RAD = Math.PI / 180
    const c = m.getCamera()
    c.zoom = 0.81
    c.centerX = 0
    c.centerY = Math.log(Math.tan(Math.PI / 4 + (10 * RAD) / 2)) * R
    m.markCameraPositioned()
    m.invalidate?.()
  })
}

async function settle(page: import('@playwright/test').Page): Promise<void> {
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
  await page.waitForTimeout(2_000)
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  )
}

async function measureAmberBand(
  page: import('@playwright/test').Page,
  png: Buffer,
): Promise<{ amber: number; maxRowRun: number }> {
  return page.evaluate(
    async ({ b64 }) => {
      const blob = await fetch(`data:image/png;base64,${b64}`).then((r) => r.blob())
      const bmp = await createImageBitmap(blob)
      const c = document.createElement('canvas')
      c.width = bmp.width
      c.height = bmp.height
      const ctx = c.getContext('2d')!
      ctx.drawImage(bmp, 0, 0)
      const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data
      let amber = 0
      let maxRowRun = 0
      for (let y = 0; y < bmp.height; y++) {
        let run = 0
        for (let x = 0; x < bmp.width; x++) {
          const i = (y * bmp.width + x) * 4
          // amber-400 #fbbf24
          const isStroke = d[i] > 200 && d[i + 1] > 130 && d[i + 1] < 220 && d[i + 2] < 110
          if (isStroke) {
            amber++
            run++
            if (run > maxRowRun) maxRowRun = run
          } else run = 0
        }
      }
      return { amber, maxRowRun }
    },
    { b64: png.toString('base64') },
  )
}

async function loadScene(
  page: import('@playwright/test').Page,
  src: string,
  scene: string,
): Promise<void> {
  const b64 = Buffer.from(src, 'utf8').toString('base64')
  await page.goto(`/demo.html?id=__import&e2e=1&scene=${scene}#src=${b64}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(() => (window as unknown as Win).__xgisReady === true, null, {
    timeout: 30_000,
  })
}

test('#1235 gap 1 — pushed LineString renders like a declared one', async ({ page }) => {
  test.setTimeout(240_000)
  mkdirSync(OUT, { recursive: true })
  await page.setViewportSize({ width: 1100, height: 800 })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)))

  // Control: declared-at-compile line renders (calibrates the expected band).
  await loadScene(page, DECLARED_SRC, 'declared')
  await pinCamera(page)
  await settle(page)
  const declaredPng = await page.locator('#map').screenshot()
  writeFileSync(join(OUT, 'declared.png'), declaredPng)
  const declared = await measureAmberBand(page, declaredPng)
  console.log(`DECLARED: amber=${declared.amber}px maxRowRun=${declared.maxRowRun}px`)

  // Witness: identical line pushed into an initially-empty source.
  await loadScene(page, PUSH_SRC, 'pushed')
  await pinCamera(page)
  await settle(page)
  await page.evaluate(() => {
    ;(window as unknown as Win).__xgisMap!.setSourceData!('measure_path', {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 0,
          properties: {},
          geometry: {
            type: 'LineString',
            coordinates: [
              [-60, 10],
              [60, 10],
            ],
          },
        },
      ],
    })
  })
  await settle(page)
  const pushedPng = await page.locator('#map').screenshot()
  writeFileSync(join(OUT, 'pushed.png'), pushedPng)
  const pushed = await measureAmberBand(page, pushedPng)
  console.log(`PUSHED: amber=${pushed.amber}px maxRowRun=${pushed.maxRowRun}px`)

  expect(errors, 'no page errors').toEqual([])
  // The declared arc curves through rows, so contiguous per-row runs top out
  // near ~130 px at this view — 100 px is the calibrated band floor.
  expect(declared.maxRowRun, 'declared line renders a contiguous band').toBeGreaterThan(100)
  // The structural gate: the pushed line must form the same contiguous band,
  // not just scattered pixels, and carry comparable coverage to the control.
  expect(pushed.maxRowRun, 'pushed line renders a contiguous band').toBeGreaterThan(100)
  expect(pushed.amber, 'pushed line coverage comparable to declared').toBeGreaterThan(
    declared.amber * 0.5,
  )
})
