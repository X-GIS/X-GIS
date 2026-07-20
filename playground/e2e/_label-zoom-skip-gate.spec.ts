// ═══ Zoom-tolerant label-prepare skip gate (#1177 Option B) ═══
//
// Continuous wheel-zoom made EVERY frame a label-prepare miss (the exact
// (zoom*100)|0 signature) — the confirmed zoom-jank root cause. With the
// tolerance (|Δzoom| ≤ 0.15, centre ≤ 48 px during an ACTIVE zoom), mid-zoom
// frames replay the prior placement and the moment motion stops one final
// prepare snaps correctness. Two assertions:
//  1. BEHAVIOUR — a 30-step continuous zoom must mostly HIT (pre-fix: every
//     step misses).
//  2. §5 SNAP — after the zoom settles, the frame must equal a FRESH mount at
//     the same camera within the same-code noise band (no stale labels at
//     rest).

import { test, expect, type Page } from '@playwright/test'
import { PNG } from 'pngjs'
import { writeFileSync } from 'node:fs'

async function pump(page: Page, n = 20): Promise<void> {
  for (let i = 0; i < n; i++) {
    await page.evaluate(() =>
      (window as unknown as { __xgisMap?: { invalidate?: () => void } }).__xgisMap?.invalidate?.(),
    )
    await page.waitForTimeout(80)
  }
}

async function boot(page: Page, hash: string): Promise<void> {
  // Default (WebGPU/SwiftShader) backend — NOT forcegl2: the forced-WebGL2
  // slice frame presents only the isolated raster checker + icon batches, so
  // labels never reach the canvas and the §5 snap below would compare two
  // blank frames (caught by image inspection — diff=0 on black≠verified).
  await page.goto(`/demo.html?id=multiline_labels&e2e=1${hash}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 60_000 },
  )
  // `?e2e=1` suppresses the demo-runner's fixture auto-push (tests own the
  // push cadence) — inject the same six-city corpus the manual demo gets, or
  // the label pass measures an EMPTY label set on a blank frame.
  await page.evaluate(() => {
    const w = window as unknown as {
      __xgisMap: { setSourceData: (id: string, d: unknown) => void }
    }
    const city = (lon: number, lat: number, name: string) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: { name },
    })
    w.__xgisMap.setSourceData('cities', {
      type: 'FeatureCollection',
      features: [
        city(-74.006, 40.7128, 'New York City'),
        city(-122.4194, 37.7749, 'San Francisco'),
        city(-118.2437, 34.0522, 'Los Angeles'),
        city(151.2093, -33.8688, 'Sydney Australia'),
        city(-43.1729, -22.9068, 'Rio de Janeiro'),
        city(126.978, 37.5665, 'Seoul'),
      ],
    })
  })
  await pump(page)
}

const shoot = async (page: Page): Promise<PNG> =>
  PNG.sync.read(await page.locator('#xg-canv, canvas').first().screenshot())

test('continuous zoom mostly hits the label-prepare skip; settle snaps exact', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000)
  await boot(page, '#2.0/30/-95')

  const before = await page.evaluate(() =>
    (
      window as unknown as {
        __xgisMap: { getLabelDispatchStats: () => { hits: number; misses: number } }
      }
    ).__xgisMap.getLabelDispatchStats(),
  )

  // 30 × +0.01 zoom steps — a continuous-wheel stand-in. setZoom tags ONLY
  // the CAMERA domain (like the interactive controller); calling invalidate()
  // here would tag LABEL every step and force a miss regardless of the
  // tolerance (measured — that was this gate's own first bug).
  for (let i = 1; i <= 30; i++) {
    await page.evaluate(
      (z) => {
        const w = window as unknown as { __xgisMap: { setZoom: (z: number) => void } }
        w.__xgisMap.setZoom(z)
      },
      2.0 + i * 0.01,
    )
    await page.waitForTimeout(50)
  }
  await page.waitForTimeout(400) // settle WITHOUT invalidate (stats stay pure)

  const after = await page.evaluate(() =>
    (
      window as unknown as {
        __xgisMap: { getLabelDispatchStats: () => { hits: number; misses: number } }
      }
    ).__xgisMap.getLabelDispatchStats(),
  )
  const misses = after.misses - before.misses
  const hits = after.hits - before.hits
  console.log(`[label-zoom-skip] zoom-window hits=${hits} misses=${misses}`)
  // 0.30 zoom span / 0.15 tolerance ≈ 2-3 tolerance-driven prepares + the
  // settle snap + any tile-arrival misses. Pre-fix: ≥ 30 misses (every step).
  expect(misses).toBeLessThan(15)
  expect(hits).toBeGreaterThan(20)

  const settled = await shoot(page)

  // §5 snap gate: a FRESH mount at the settled camera must match.
  await boot(page, '#2.30/30/-95')
  const fresh = await shoot(page)
  let diff = 0
  for (let i = 0; i < settled.data.length; i += 4) {
    if (
      settled.data[i] !== fresh.data[i] ||
      settled.data[i + 1] !== fresh.data[i + 1] ||
      settled.data[i + 2] !== fresh.data[i + 2]
    )
      diff++
  }
  // §5 — persist both frames so the diff verdict can be image-inspected, not
  // trusted as a bare scalar (a diff of 0 between two BLANK frames also
  // passes the number; the saved PNGs prove labels actually rendered).
  writeFileSync(testInfo.outputPath('settled.png'), PNG.sync.write(settled))
  writeFileSync(testInfo.outputPath('fresh.png'), PNG.sync.write(fresh))
  console.log(`[label-zoom-skip] settle-vs-fresh diff=${diff}/${settled.width * settled.height}`)
  // Same calibration family as _scene-builder-twin: same-code page loads
  // differ ~78 px under SwiftShader; stale labels would differ by whole
  // glyph quads (thousands).
  expect(diff).toBeLessThan(settled.width * settled.height * 0.0005)
})
