// Multi-line label WRAP gate (#2455). The multiline_labels demo labels cities
// with names longer than `label-max-width-7`, so a label wraps to 2–3 lines
// centred on one anchor. This spec asserts the WRAP itself — a label's ink
// forms vertically adjacent, co-centred bands — not merely that ink exists.
//
// History (#2455): the previous spec used a raw `#map` screenshot + a
// `waitForTimeout` settle (both forbidden by CLAUDE.md §5), asked for pixels
// `>= 250` on every channel — a shade 15 px SDF glyphs never reach on
// SwiftShader (measured 0, against 123 at the `> 230` its sibling gate uses)
// — and sat at a camera where no label wrapped at all. It was also never
// registered in CI. The data push, camera and readback below are the ones
// `_labels-gl2-gate` validated on this same demo.
//
// Headless SwiftShader (HEADED=0 XGIS_SOFTWARE_GPU=1) — GPU-less.

import { test, expect } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { awaitMapIdle, captureMapFrame } from './helpers/visual'

const HERE = dirname(fileURLToPath(import.meta.url))
const ART = join(HERE, '__multiline-labels__')
mkdirSync(ART, { recursive: true })

interface Band {
  y0: number
  y1: number
  x0: number
  x1: number
}

test('multiline labels wrap at max-width — a label is two vertically adjacent, co-centred ink bands', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1280, height: 800 })

  // ?e2e=1 opts out of the demo-runner's auto data push (the test controls
  // the cadence) — push the same long-named cities `_labels-gl2-gate` pushes.
  await page.goto('/demo.html?id=multiline_labels&forcegl2=1&e2e=1', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 30_000 },
  )
  await page.evaluate(() => {
    ;(
      window as unknown as {
        __xgisMap?: { setSourceData?: (id: string, fc: unknown) => void }
      }
    ).__xgisMap?.setSourceData?.('cities', {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [-74, 40.7] },
          properties: { name: 'New York City' },
        },
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [2.35, 48.85] },
          properties: { name: 'Paris Metropolitan Area' },
        },
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [139.69, 35.68] },
          properties: { name: 'Tokyo Special Wards' },
        },
      ],
    })
  })
  const idle = await awaitMapIdle(page, 60_000)
  expect(idle, 'the scene converges (awaitMapIdle)').toBe('idle')

  const png = await captureMapFrame(page)
  writeFileSync(join(ART, 'multiline.png'), png)

  // Decode the chrome-free frame in the page and measure ink bands: rows with
  // near-white pixels (> 230 on every channel — the threshold the sibling gate
  // measured against real SDF glyph cores) grouped into runs, each run's
  // horizontal extent from its own ink.
  const bands = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const blob = new Blob([bytes], { type: 'image/png' })
    const bmp = await createImageBitmap(blob)
    const off = new OffscreenCanvas(bmp.width, bmp.height)
    const ctx = off.getContext('2d')!
    ctx.drawImage(bmp, 0, 0)
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data
    const W = bmp.width
    const rows: { y: number; x0: number; x1: number; n: number }[] = []
    for (let y = 0; y < bmp.height; y++) {
      let x0 = -1
      let x1 = -1
      let n = 0
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4
        if (d[i]! > 230 && d[i + 1]! > 230 && d[i + 2]! > 230) {
          if (x0 < 0) x0 = x
          x1 = x
          n++
        }
      }
      if (n > 0) rows.push({ y, x0, x1, n })
    }
    // Rows ≤ 2 apart are ONE glyph line: a thin horizontal stroke (the bar of
    // an "e", the crossbar of a "t") can leave a row with no near-white pixel
    // inside a line, and splitting there would turn one line into two
    // "adjacent" bands — measured: a single clipped 10-row line read as three
    // fragments at y252-253 / 255-258 / 260-261 and passed the wrap test.
    const out: { y0: number; y1: number; x0: number; x1: number }[] = []
    for (const r of rows) {
      const last = out[out.length - 1]
      if (last && r.y - last.y1 <= 3) {
        last.y1 = r.y
        last.x0 = Math.min(last.x0, r.x0)
        last.x1 = Math.max(last.x1, r.x1)
      } else out.push({ y0: r.y, y1: r.y, x0: r.x0, x1: r.x1 })
    }
    // A glyph line is several rows tall; drop sub-5-row slivers (an isolated
    // stroke fragment) so they cannot pair with anything.
    return out.filter((b) => b.y1 - b.y0 + 1 >= 5)
  }, png.toString('base64'))

  console.log('[multiline-labels] ink bands', JSON.stringify(bands))
  expect(bands.length, 'some label ink rendered').toBeGreaterThan(1)

  // A WRAPPED label: two consecutive glyph lines one line pitch apart —
  // 15 px × 1.1 line-height ≈ 17 px baseline pitch with ~10-row glyph bands
  // leaves a 4..8 px gap (measured 7) — whose horizontal centres agree
  // (label-justify-center) within a few px. Two unrelated labels one line
  // each sit hundreds of px apart or are not co-centred; rows of ONE line
  // never sit 4+ px apart (they were merged above).
  const wrapped = bands.filter((b: Band, i: number) => {
    const n = bands[i + 1] as Band | undefined
    if (!n) return false
    const gap = n.y0 - b.y1
    const cb = (b.x0 + b.x1) / 2
    const cn = (n.x0 + n.x1) / 2
    return gap >= 4 && gap <= 8 && Math.abs(cb - cn) <= 4
  })
  expect(
    wrapped.length,
    `at least one label wraps into co-centred adjacent lines; bands=${JSON.stringify(bands)}`,
  ).toBeGreaterThan(0)
})
