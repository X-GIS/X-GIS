// E2E verification that the PMTiles + MVT input pipeline renders.
//
// Loads the pmtiles_source demo (Firenze sample, ~5km × 5km area at
// z=0..15) at z=13 over Florence center. After __xgisReady + a short
// settle, asserts:
//
//   1. The PMTiles header was successfully fetched (console log).
//   2. The fill (stone-200, ~rgb(231,229,228)) is visible in non-
//      trivial pixel count — proves the full pipeline (PMTilesBackend
//      → fetcher → decode MVT → compileSingleTile → cacheTileData →
//      VTR upload → render) is intact.
//
// At z<10 viewing this archive's bounds, the data area is sub-pixel
// and the screen is correctly blank — see pmtiles-source.xgis comment
// for the geometry rationale.

import { test, expect, type Page } from '@playwright/test'

async function waitForXgisReady(page: Page) {
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 15_000 },
  )
}

/** Count pixels that are NOT near-black (background). The
 *  pmtiles_source demo paints stone-200 fills + stone-500 strokes
 *  on a dark background, so any non-trivial light-pixel count
 *  proves the catalog/backend/render path delivered geometry. */
async function countLitPixels(page: Page) {
  // Screenshot the map canvas only — the playground has an editor pane
  // on the right with lots of syntax-highlighted text (false positives).
  const canvas = page.locator('canvas#map')
  const sShot = await canvas.screenshot({ type: 'png' })
  return await page.evaluate(async ({ pngBytes }) => {
    const blob = new Blob([new Uint8Array(pngBytes)], { type: 'image/png' })
    const url = URL.createObjectURL(blob)
    const img = new Image()
    await new Promise<void>((res, rej) => {
      img.onload = () => res(); img.onerror = () => rej(new Error('img'))
      img.src = url
    })
    const off = new OffscreenCanvas(img.width, img.height)
    const ctx = off.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    const data = ctx.getImageData(0, 0, img.width, img.height).data
    let lit = 0
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2]
      // "Lit" = sum of channels above a reasonable background floor.
      // stone-200 is ~rgb(231,229,228); stone-500 stroke ~rgb(120,113,108).
      // Both clear r+g+b > 300 easily; dark background sits well below.
      if (r + g + b > 300) lit++
    }
    URL.revokeObjectURL(url)
    return lit
  }, { pngBytes: Array.from(sShot) })
}

test('PMTiles: archive header attaches + fetches log', async ({ page }) => {
  test.setTimeout(45_000)
  await page.setViewportSize({ width: 1280, height: 720 })
  const logs: string[] = []
  page.on('console', msg => { logs.push(msg.text()) })

  await page.goto(
    '/demo.html?id=pmtiles_source#13/43.77/11.25',
    { waitUntil: 'domcontentloaded' },
  )
  await waitForXgisReady(page)
  await page.waitForTimeout(3500) // give PMTiles header + tiles time to land

  const attachLog = logs.find(l => l.includes('[X-GIS] PMTiles attached'))
  console.log('attach log:', attachLog ?? '(not found)')
  expect(attachLog, 'PMTiles header should attach').toBeTruthy()
  expect(attachLog!).toContain('z=0..15')
  expect(attachLog!).toContain('92 tile entries')
})

test('PMTiles: Florence at z=13 renders non-empty fill + strokes', async ({ page }) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1280, height: 720 })
  const logs: string[] = []
  page.on('console', msg => { logs.push(msg.text()) })

  await page.goto(
    '/demo.html?id=pmtiles_source#13/43.77/11.25',
    { waitUntil: 'domcontentloaded' },
  )
  await waitForXgisReady(page)
  await page.waitForTimeout(6000) // generous wait for HTTP roundtrips + GPU upload

  // Diagnostic: save the canvas to disk + dump ALL console logs.
  const canvas = page.locator('canvas#map')
  await canvas.screenshot({ path: 'test-results/pmtiles-florence-z13.png' })
  console.log('=== All page logs ===')
  for (const l of logs) console.log('  >', l)
  console.log('=== Catalog state ===')
  const catState = await page.evaluate(() => {
    type Catalog = {
      maxLevel: number
      getBounds(): unknown
      getCacheSize(): number
      getPendingLoadCount(): number
      hasData(): boolean
      hasEntryInIndex(key: number): boolean
    }
    const m = (window as unknown as { __xgisMap?: { vtSources?: Map<string, { source: Catalog; renderer: unknown }> } }).__xgisMap
    const entry = m?.vtSources?.get('pm')
    if (!entry) return { error: 'no pm source' }
    const s = entry.source

    // Pack a tileKey the same way @xgis/compiler tileKey does:
    //   morton-style: ((z & 31) << 25) | ... but we don't have it here.
    // Use the runtime export through the catalog's bounds calc:
    //   Just probe the Florence center at a few z levels via the
    //   public hasEntryInIndex.
    // Format for tileKey is opaque; instead expose a probe via
    // indirect calls using catalog's internal mechanics.
    // For diagnosis, just report state — actual hasEntryInIndex
    // probing requires importing tileKey which we can't easily
    // do in page.evaluate.

    return {
      maxLevel: s.maxLevel,
      bounds: s.getBounds(),
      cacheSize: s.getCacheSize(),
      pendingLoads: s.getPendingLoadCount(),
      hasData: s.hasData(),
    }
  })
  console.log('  ', JSON.stringify(catState, null, 2))

  const lit = await countLitPixels(page)
  console.log(`[z=13 Florence] lit pixels: ${lit}`)
  // Florence at z=13 should fill a meaningful screen area — even at
  // 5km × 5km bounds, that's ~200×200 px = 40k pixels minimum.
  expect(lit, 'Florence area should render visible features').toBeGreaterThan(2000)
})

// Note on off-bounds testing: the PMTiles header's bounds field is a
// hint, not a strict crop — the protomaps Firenze archive happens to
// contain low-z world-basemap polygons that render via ancestor
// fallback even when the camera sits over the Atlantic. So a "does
// nothing render outside bounds" e2e oracle is unreliable against a
// real third-party archive. Backend.has() bounds-filtering is unit-
// tested in isolation against a mock fetcher in pmtiles-backend.test.ts
// — that's the right altitude for that property.
