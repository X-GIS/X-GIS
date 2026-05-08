// Diagnostic for the "buildings behind appear in front" bug.
// User reports the bug persists across previous fixes (23453f3 +
// 0a59bbc per-feature depth jitter, b4fb2f9 two-phase opaque, dec154f
// OIT routing). Need a concrete repro scenario before more code work.
//
// Captures screenshots at (a) the URL where prior coplanar z-fight
// fixes were verified (Tokyo z=16.33 pitch=63.5°), (b) a high-pitch
// view showing many adjacent buildings, (c) a low-pitch view from
// the side (where height ordering is most visually obvious).

import { test, expect } from '@playwright/test'

const SCENARIOS: Array<{ slug: string; url: string; viewport?: { width: number; height: number } }> = [
  // High-pitch reference URL from commit 23453f3.
  { slug: 'tokyo-pitch63', url: '/demo.html?id=osm_style#16.33/35.6585/139.7454/0/63.5' },
  // Lower pitch — height ordering most visible from the side.
  { slug: 'tokyo-pitch45', url: '/demo.html?id=osm_style#16/35.6585/139.7454/0/45' },
  // Manhattan — taller buildings, larger height variance.
  { slug: 'manhattan-pitch60', url: '/demo.html?id=osm_style#15.5/40.7508/-73.9851/0/60' },
]

test.describe('3D building depth-sort diag', () => {
  for (const scn of SCENARIOS) {
    test(`screenshot ${scn.slug}`, async ({ page }) => {
      test.setTimeout(60_000)
      await page.setViewportSize(scn.viewport ?? { width: 1280, height: 720 })
      await page.goto(scn.url, { waitUntil: 'domcontentloaded' })
      await page.waitForFunction(
        () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
        null, { timeout: 30_000 },
      )
      // Settle: tiles + layer compile + extrude data → GPU upload.
      // The async upload path needs a few frames to drain through the
      // priority queue.
      await page.waitForTimeout(5_000)

      // Inspect what's on screen for diagnostic logging.
      const stats = await page.evaluate(() => {
        const map = (window as unknown as {
          __xgisMap?: {
            camera: { lon: number; lat: number; zoom: number; bearing: number; pitch: number }
            vtSources?: Map<string, {
              renderer?: {
                _frameTileCache?: { tiles?: Array<{ z: number; x: number; y: number }> }
                _gpuCacheCount?: number
              }
            }>
          }
        }).__xgisMap
        if (!map) return { error: 'no map' }
        const out: Record<string, unknown> = { camera: map.camera }
        if (map.vtSources) {
          for (const [name, src] of map.vtSources) {
            const r = src.renderer
            out[name] = {
              tiles: r?._frameTileCache?.tiles?.length ?? 0,
              gpuCache: r?._gpuCacheCount ?? 0,
            }
          }
        }
        return out
      })
      // eslint-disable-next-line no-console
      console.log(`[building-diag ${scn.slug}]`, JSON.stringify(stats, null, 2))

      // Save screenshot for visual inspection.
      await page.locator('#map').screenshot({ path: `test-results/building-diag-${scn.slug}.png` })

      // No assertion — this is purely a capture run. The output
      // screenshots in test-results/ tell us whether buildings behind
      // visually appear in front.
      expect(stats).toBeTruthy()
    })
  }
})
