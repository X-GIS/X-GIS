// ═══════════════════════════════════════════════════════════════════
// OFM Bright school fill (data-driven landuse `class` match)
// ═══════════════════════════════════════════════════════════════════
//
// User-reported 2026-05-12: at #17.85/37.12665/126.92430 schools /
// hospitals must render with the OFM Bright landuse-fill `match(.class)`
// lavender / beige, but X-GIS dropped them entirely.
//
// Root cause turned out to be a chain of five issues, fixed together
// 2026-05-14:
//   1. `show-source-maps.ts:124` needsFeatureProps gated on label
//      presence only — worker skipped featureProps emission for
//      data-driven-fill-only slices.
//   2. `vector-tile-renderer.ts` had no per-tile featureDataBuffer
//      path. PMTiles backend leaves source-level PropertyTable empty
//      by design, so the renderer's source-scoped featureDataBuffer
//      never got built.
//   3. `sub-tile-generator.ts:279` didn't forward parent's
//      featureProps/heights/bases, so over-zoom (z > maxLevel=14)
//      tiles dropped per-feature data.
//   4. `vector-tile-renderer.ts:2336` early-return guarded on the
//      source-level `tileBgFeature` being null — exited before
//      reaching the per-tile bind group resolution.
//   5. `renderer.ts:469` FILL_RETURN_MARKER string did NOT match
//      `fs_fill`'s actual `out.color = ...` line (which carries the
//      wall_shade multiplier). `String.replace` silently no-ops on
//      miss, so every variant pipeline emitted the zero-uniform
//      `u.fill_color` instead of the match() chain — alpha=0, the
//      polygons painted invisibly.
//
// Spec runs the user-reported camera, captures the side-by-side
// ML / XG screenshot. Visual diff is the contract — the school
// polygons must appear in both panes.

import { test } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__ofm-school-fill__')
mkdirSync(OUT, { recursive: true })

test('ofm-bright school fill — #17.85/37.12665/126.92430', async ({ page }) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1800, height: 900 })
  await page.goto(
    `/compare.html?style=openfreemap-bright#17.85/37.12665/126.92430`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(
    () => {
      const w = window as unknown as { __xgisReady?: boolean; __mlReady?: boolean }
      return w.__xgisReady === true && w.__mlReady === true
    },
    null, { timeout: 30_000 },
  )
  // PMTiles z=17 first-fetch on cold start typically resolves in
  // 2-4s, plus SDF label / icon stages. 10s covers headroom.
  await page.waitForTimeout(10_000)

  const panes = page.locator('#panes .pane')
  const ml = await panes.nth(0).screenshot()
  const xg = await panes.nth(1).screenshot()
  writeFileSync(join(OUT, 'ml.png'), ml)
  writeFileSync(join(OUT, 'xg.png'), xg)
})
