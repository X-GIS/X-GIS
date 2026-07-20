// ═══ SceneBuilder runScene ↔ run() twin-render gate (#1194 A1b) ═══
//
// The A1a parity gate proves builder AST ≡ parsed AST byte-for-byte at the
// compiler level; this gate proves the RUNTIME half: a page mounted via
// `map.runScene(twin)` (`?runscene=1`, compiler twin-corpus) renders
// PIXEL-IDENTICAL to the same demo mounted via `map.run(xgisText)`. Two CLEAN
// first-mount page loads — deliberately NOT a live swap: run()→run() itself
// is not pixel-stable across swaps under forcegl2 (a pre-existing VTR
// re-upload "vertex compile failed" drop on the first swap — tracked
// separately; a control probe pinned it with zero runScene involvement).
// Offline geojson (minimal) so SwiftShader rasters deterministically; with
// identical camera + data + code, the ONLY variable is the entry path.

import { test, expect, type Page } from '@playwright/test'
import { PNG } from 'pngjs'

async function loadAndShoot(page: Page, extra: string): Promise<PNG> {
  await page.goto(`/demo.html?id=minimal&e2e=1&forcegl2=1${extra}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 30_000 },
  )
  for (let i = 0; i < 25; i++) {
    await page.evaluate(() =>
      (window as unknown as { __xgisMap?: { invalidate?: () => void } }).__xgisMap?.invalidate?.(),
    )
    await page.waitForTimeout(80)
  }
  return PNG.sync.read(await page.locator('#xg-canv, canvas').first().screenshot())
}

test('runScene first-mount renders pixel-identical to its run() twin', async ({ page }) => {
  test.setTimeout(150_000)
  const a = await loadAndShoot(page, '') // DSL path: demo-runner → map.run(text)
  const b = await loadAndShoot(page, '&runscene=1') // builder path: → map.runScene(twin)

  expect(b.width).toBe(a.width)
  expect(b.height).toBe(a.height)
  let diff = 0
  for (let i = 0; i < a.data.length; i += 4) {
    if (
      a.data[i] !== b.data[i] ||
      a.data[i + 1] !== b.data[i + 1] ||
      a.data[i + 2] !== b.data[i + 2]
    )
      diff++
  }
  console.log(`[scene-builder-twin] diffPixels=${diff}/${a.width * a.height}`)
  // Threshold calibrated per §12 (measure the same-code noise floor first):
  // two clean loads of the SAME run() path differ by ~78 px (0.013%) under
  // SwiftShader (page-load-timed label/AA settle); the run↔runScene pair
  // measured 115 px — indistinguishable from that floor. 0.05% sits >2× above
  // the floor and >20× below the smallest real defect (one dropped tile
  // ≈ 7 000 px, a colour change ≈ 100 000 px), so it separates noise from
  // seam bugs decisively. Hash equality (§12 rung 3) needs a deterministic
  // harness (fixed timestamps) — not this gate's scope.
  expect(diff).toBeLessThan(a.width * a.height * 0.0005)
})
