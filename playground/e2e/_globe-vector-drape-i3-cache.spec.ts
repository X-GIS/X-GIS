/// <reference types="@webgpu/types" />
import { test, expect } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// #599 I3 — globe vector-drape baked-fill cache LIFECYCLE proof. I2 drapes each
// visible tile's baked fill onto the sphere; I3 bounds that baked-texture cache
// (LRU cap, evicted at the frame boundary) + frees it on destroy. This proves on
// the REAL GPU that, as the user pans/zooms across many tiles, the baked cache
// stays BOUNDED (never grows past MAX_CACHED_BAKES) and does NOT leak on a static
// hold (0 growth across repeated settles — the I2 zero-rebake property observed
// as size stability), while the globe still renders (no page errors, frame moves).
// Headed WebGPU only (the bake is WebGPU-only). `minimal` = local ne_110m country
// fills (constant `fill-stone-200`), no network.

// Mirror of MAX_CACHED_BAKES in map/src/render/vector-drape-renderer.ts — the LRU
// cap the resident baked-fill textures must never exceed.
const MAX_CACHED_BAKES = 256

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__globe-vector-drape-i3-cache__')

type Win = Window & {
  __xgisReady?: boolean
  __xgisActiveBackend?: string
  __XGIS_DISABLE_VECTOR_DRAPE?: boolean
  __xgisMap?: {
    invalidate?: () => void
    getCamera?: () => { projType?: number; globeMode?: boolean; zoom?: number }
    ctx?: { rhi?: { backend?: string } }
    vtSources?: Map<
      string,
      {
        renderer?: {
          getDrawStats?: () => { tilesVisible?: number }
          _drape?: { baked?: { size?: number } } | null
        }
      }
    >
  }
}

const tilesVisible = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const m = (window as unknown as Win).__xgisMap
    let t = 0
    for (const s of m?.vtSources?.values() ?? [])
      t += s.renderer?.getDrawStats?.().tilesVisible ?? 0
    return t
  })

// Sum of resident baked-fill textures across every vector source's drape. -1 when
// no drape is engaged (so the test can skip rather than assert a phantom bound).
const bakedSize = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const m = (window as unknown as Win).__xgisMap
    let n = -1
    for (const s of m?.vtSources?.values() ?? []) {
      const sz = s.renderer?._drape?.baked?.size
      if (typeof sz === 'number') n = (n < 0 ? 0 : n) + sz
    }
    return n
  })

async function settle(page: import('@playwright/test').Page, ms: number): Promise<void> {
  await page.evaluate(() => (window as unknown as Win).__xgisMap?.invalidate?.())
  await page.waitForTimeout(ms)
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  )
}

test('#599 I3 — globe drape baked-fill cache stays bounded + leak-free across pan/zoom', async ({
  page,
}) => {
  test.setTimeout(180_000)
  mkdirSync(OUT, { recursive: true })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
  await page.setViewportSize({ width: 900, height: 900 })

  await page.goto('/demo.html?id=minimal&proj=globe#2/10/0', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window as unknown as Win).__xgisReady === true, {
    timeout: 30_000,
  })
  // Drape defaults ON; be explicit so a stray global from a prior nav can't disable it.
  await page.evaluate(() => {
    ;(window as unknown as Win).__XGIS_DISABLE_VECTOR_DRAPE = false
  })

  const cam = await page.evaluate(() => {
    const w = window as unknown as Win
    return {
      backend: w.__xgisMap?.ctx?.rhi?.backend ?? w.__xgisActiveBackend ?? 'unknown',
      globeMode: w.__xgisMap?.getCamera?.().globeMode ?? false,
    }
  })
  test.skip(
    cam.backend !== 'webgpu',
    `#599 I3 drape needs a headed WebGPU adapter (got ${cam.backend})`,
  )

  // Warm the tile set until it stops growing, then confirm the drape is engaged.
  let prev = -1
  for (let i = 0; i < 20; i++) {
    await settle(page, 1000)
    const t = await tilesVisible(page)
    if (t > 0 && t === prev) break
    prev = t
  }
  const startBaked = await bakedSize(page)
  test.skip(startBaked < 1, `#599 I3 needs the vector drape engaged (bakedSize=${startBaked})`)

  const startShot = await page.locator('#map').screenshot()
  writeFileSync(join(OUT, 'start.png'), startShot)

  // Pan (drag) + zoom (wheel) across many distinct tiles so the cache is exercised
  // well beyond a single static view. Sample the baked size after each move; it
  // must never exceed the LRU cap.
  const box = (await page.locator('#map').boundingBox())!
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  const samples: number[] = [startBaked]

  // Zoom in a couple levels first (more tiles per view = a real cache workout).
  for (let z = 0; z < 2; z++) {
    await page.mouse.move(cx, cy)
    await page.mouse.wheel(0, -420)
    await settle(page, 700)
    samples.push(await bakedSize(page))
  }

  // Rotate the globe through 8 drags (N/E/S/W and back) to reveal fresh tiles.
  const drags: Array<[number, number]> = [
    [-320, 0],
    [-320, 0],
    [0, -260],
    [320, 0],
    [320, 0],
    [0, 260],
    [-260, -200],
    [260, 200],
  ]
  for (const [dx, dy] of drags) {
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + dx, cy + dy, { steps: 12 })
    await page.mouse.up()
    await settle(page, 650)
    samples.push(await bakedSize(page))
  }

  const movedShot = await page.locator('#map').screenshot()
  writeFileSync(join(OUT, 'after-pan-zoom.png'), movedShot)

  // Static hold: with the view frozen, a leak would show as the baked size
  // creeping up frame-over-frame. Sample 3 consecutive settles — must be flat.
  const hold: number[] = []
  for (let i = 0; i < 3; i++) {
    await settle(page, 700)
    hold.push(await bakedSize(page))
  }
  const holdShot = await page.locator('#map').screenshot()
  writeFileSync(join(OUT, 'static-hold.png'), holdShot)

  const maxBaked = Math.max(...samples, ...hold)
  console.log(
    'DRAPE_I3',
    JSON.stringify({
      ...cam,
      tilesVisible: prev,
      startBaked,
      samples,
      hold,
      maxBaked,
      cap: MAX_CACHED_BAKES,
      startBytes: startShot.length,
      movedBytes: movedShot.length,
    }),
  )
  console.log('DRAPE_I3 pageerrors', errors.length, errors.slice(0, 3))

  // (1) No crashes while panning/zooming with the drape live.
  expect(errors, 'no page/console errors during pan/zoom + static hold').toEqual([])
  // (2) The globe is still on the sphere route (drape path stayed active).
  expect(cam.globeMode, 'globe projection active').toBe(true)
  // (3) BOUNDED: the baked-fill cache never exceeds its LRU cap (no unbounded
  //     growth as the user pans across tiles — the I3 fix).
  expect(
    maxBaked,
    `baked cache must stay within the LRU cap (max=${maxBaked})`,
  ).toBeLessThanOrEqual(MAX_CACHED_BAKES)
  // (4) LEAK-FREE on a static hold: a frozen view re-drapes the SAME cached tiles,
  //     so the resident count must not creep up across repeated frames.
  expect(hold[hold.length - 1]!, 'baked size must not grow on a static hold').toBeLessThanOrEqual(
    hold[0]!,
  )
  // (5) The move actually rendered a different frame (globe still draws after moving).
  expect(Buffer.compare(movedShot, startShot), 'pan/zoom must change the frame').not.toBe(0)
})
