// ═══ forcegl2 live-swap re-boot gate (#1196) ═══
//
// A second `map.run()` on a live forced-WebGL2 map re-boots the device on the
// SAME canvas-sticky GL context: the entry teardown loses the context, and the
// remount must restore it (rhi gl2-restore-token + the macrotask restore in
// gpu.ts ensureWebGl2ContextRestored). Pre-fix this either dropped a tile
// ("vertex compile failed", ~7 000 px) or failed the whole boot into the
// WebGPU-unavailable UX. The gate asserts the re-run frame equals the first
// mount within the same-code noise band, and that no real errors surface.

import { test, expect, type Page } from '@playwright/test'
import { PNG } from 'pngjs'

async function pump(page: Page): Promise<void> {
  for (let i = 0; i < 25; i++) {
    await page.evaluate(() =>
      (window as unknown as { __xgisMap?: { invalidate?: () => void } }).__xgisMap?.invalidate?.(),
    )
    await page.waitForTimeout(80)
  }
}

const shoot = async (page: Page): Promise<PNG> =>
  PNG.sync.read(await page.locator('#xg-canv, canvas').first().screenshot())

test('re-run() on a live forcegl2 map re-boots and renders the same frame', async ({ page }) => {
  test.setTimeout(240_000)
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('Failed to load resource')) errors.push(m.text())
  })

  await page.goto('/demo.html?id=minimal&e2e=1&forcegl2=1', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 60_000 },
  )
  // The demo page's warning overlay would repaint over the canvas region on
  // the re-boot (the forced-webgl2 banner warn) — keep the shots map-only.
  await page.addStyleTag({ content: '#log-overlay { display: none !important; }' })
  // Pin the camera: run() re-fits bounds, and its fit differs from the demo
  // mount's — the gate compares RENDERING, not camera policy.
  await page.evaluate(() => {
    const m = (
      window as unknown as {
        __xgisMap?: { setZoom: (z: number) => void; setCenter: (lon: number, lat: number) => void }
      }
    ).__xgisMap!
    m.setZoom(0.5)
    m.setCenter(0, 0)
  })
  await pump(page)
  const a = await shoot(page)

  // Live swap: identical source through the public run() — the re-boot path.
  await page.evaluate(async () => {
    const w = window as unknown as { __xgisMap?: { run: (t: string, b: string) => Promise<void> } }
    await w.__xgisMap!.run(
      `xgis 1
source world { type: geojson, url: "ne_110m_countries.geojson" }
layer countries { source: world
  | fill-stone-200 stroke-stone-400 stroke-1
}`,
      '/data/',
    )
  })
  await page.evaluate(() => {
    const m = (
      window as unknown as {
        __xgisMap?: { setZoom: (z: number) => void; setCenter: (lon: number, lat: number) => void }
      }
    ).__xgisMap!
    m.setZoom(0.5)
    m.setCenter(0, 0)
  })
  await pump(page)
  const b = await shoot(page)

  let diff = 0
  for (let i = 0; i < a.data.length; i += 4) {
    if (
      a.data[i] !== b.data[i] ||
      a.data[i + 1] !== b.data[i + 1] ||
      a.data[i + 2] !== b.data[i + 2]
    )
      diff++
  }
  console.log(`[gl2-live-swap] diffPixels=${diff}/${a.width * a.height}`)
  // Same calibration family as _scene-builder-twin.spec.ts: same-code page
  // loads differ by ~78 px under SwiftShader; the pre-fix tile drop was
  // ≈ 7 000 px and the pre-fix boot failure a blank frame (hundreds of
  // thousands). 0.05% (310 px) splits noise from both failure modes.
  expect(diff).toBeLessThan(a.width * a.height * 0.0005)
  expect(errors).toEqual([])
})
