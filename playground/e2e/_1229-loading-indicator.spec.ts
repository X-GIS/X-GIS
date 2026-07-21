// #1229 item 1 — tile-loading indicator gate. Drives the `raster` demo (an
// OpenStreetMap {z}/{x}/{y} URL source) with its tile fetches THROTTLED via
// page.route, so the engine's per-frame in-flight tile count
// (XGISMap.getMissingTileCount()) stays > 0 for an observable window — the exact
// "slow / network source sits partially blank" scenario item 1 targets. Asserts
// the #status loading affordance APPEARS while tiles stream and CLEARS on settle.
//
// Fail-before: without the getMissingTileCount() accessor + the #status-loading
// wiring the suffix never appears, so the APPEARS assertion is red.
//
// Extends the toolbar-net class (_snapshot-button / _mobile-monaco-collapse),
// NOT smoke (a hardware-GPU render-baseline spec).

import { test, expect } from '@playwright/test'
import zlib from 'node:zlib'

// A real, decodable 256×256 solid PNG for the throttled route to fulfil raster
// tiles with (the renderer runs createImageBitmap + reads its size — no fake
// bytes). Built here so the spec stays self-contained.
function solidPng(): Buffer {
  const W = 256
  const H = 256
  const crc32 = (buf: Buffer): number => {
    let c = ~0
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i]!
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
    }
    return ~c >>> 0
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const t = Buffer.from(type, 'ascii')
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
    return Buffer.concat([len, t, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0)
  ihdr.writeUInt32BE(H, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type RGB
  const raw = Buffer.alloc(H * (1 + W * 3))
  for (let y = 0; y < H; y++) {
    const off = y * (1 + W * 3)
    for (let x = 0; x < W; x++) {
      const p = off + 1 + x * 3
      raw[p] = 90
      raw[p + 1] = 120
      raw[p + 2] = 170
    }
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
const TILE_PNG = solidPng()

test('#1229 item 1 — loading indicator appears while a URL source loads, clears on settle', async ({
  page,
}) => {
  test.setTimeout(120_000)

  // Latch the FIRST appearance of the loading affordance from before any page
  // script runs. The suffix is transient (it clears when tiles settle), so a
  // discrete poll can miss it; a MutationObserver on #status cannot.
  await page.addInitScript(() => {
    const w = window as unknown as { __loadingSeen?: boolean }
    w.__loadingSeen = false
    const check = (): void => {
      const s = document.getElementById('status')
      const el = document.getElementById('status-loading') as HTMLElement | null
      if ((s && s.hasAttribute('data-loading')) || (el && !el.hidden)) w.__loadingSeen = true
    }
    const obs = new MutationObserver(check)
    const start = (): void =>
      obs.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['data-loading', 'hidden'],
      })
    if (document.documentElement) start()
    else document.addEventListener('DOMContentLoaded', start)
  })

  // Throttle the OSM raster tiles — each fulfils after a delay, so the in-flight
  // count is observably > 0 (a slow network source). Offline + deterministic:
  // never touches the real OSM servers.
  await page.route('**/tile.openstreetmap.org/**', async (route) => {
    await new Promise((r) => setTimeout(r, 700))
    await route.fulfill({ status: 200, contentType: 'image/png', body: TILE_PNG })
  })

  // A modest zoom so several tiles are requested (robust window), applied after
  // run() by the demo-runner's hash → camera sync.
  await page.goto('/demo.html?id=raster&e2e=1#3/20/0', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 60_000 },
  )

  // APPEARS — the affordance showed at least once while tiles were in flight,
  // which only happens when getMissingTileCount() reported > 0.
  await expect
    .poll(
      () => page.evaluate(() => (window as unknown as { __loadingSeen?: boolean }).__loadingSeen),
      { timeout: 30_000 },
    )
    .toBe(true)

  // CLEARS — once the throttled tiles all land, the count settles to 0 and the
  // suffix hides + the #status[data-loading] hook is removed. Never stuck on.
  await expect(page.locator('#status-loading')).toBeHidden({ timeout: 30_000 })
  await expect
    .poll(
      () => page.evaluate(() => document.getElementById('status')!.hasAttribute('data-loading')),
      {
        timeout: 30_000,
      },
    )
    .toBe(false)

  // And the public accessor reads 0 at rest (the engine-side settle signal).
  const settled = await page.evaluate(() =>
    (
      window as unknown as { __xgisMap?: { getMissingTileCount(): number } }
    ).__xgisMap!.getMissingTileCount(),
  )
  expect(settled).toBe(0)
})
