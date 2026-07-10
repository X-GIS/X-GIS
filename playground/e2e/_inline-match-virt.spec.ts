// #821 — inline setSourceData + per-feature match() colour.
//
// The legacy inline path (pool.compile → GeoJSONRuntimeBackend) stores tiles
// under the default '' slice while the VTR looks them up under
// computeSliceKey(sourceName, …) — a permanent cache miss, so a match()
// (needsFeatureBuffer) style on an inline source rendered a BLANK frame. The
// fix routes those variants through VirtualPMTilesBackend (?virt_inline=1)
// with buildShowSourceMaps' showSlices, so the MVT worker emits per-tile
// featureProps under the slice keys the VTR actually reads.
//
// Three-way real-GPU probe, same discipline as the issue's repro:
//   legacy + match()  → blank (documents the residual legacy contract)
//   virt   + match()  → BOTH hues present (per-feature colour applied)

import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { captureCanvas, colorHistogram, type ColorBucket } from './helpers/visual'
import { withValidationCapture, clearValidationErrors } from './helpers/validation'

const ROSE_500: [number, number, number] = [244, 63, 94]
const EMERALD_500: [number, number, number] = [16, 185, 129]
const BUCKETS: ColorBucket[] = [
  { name: 'rose', rgb: ROSE_500, tolerance: 80 },
  { name: 'emerald', rgb: EMERALD_500, tolerance: 80 },
]

// Two large adjacent quads sharing one source; kind decides the hue.
const FC = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 1,
      properties: { kind: 'a' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-24, -14],
            [-1, -14],
            [-1, 14],
            [-24, 14],
            [-24, -14],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      id: 2,
      properties: { kind: 'b' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [1, -14],
            [24, -14],
            [24, 14],
            [1, 14],
            [1, -14],
          ],
        ],
      },
    },
  ],
}

async function loadAndPush(
  page: Page,
  extraQuery: string,
): Promise<{ rose: number; emerald: number }> {
  await page.setViewportSize({ width: 800, height: 600 })
  await page.goto(`/demo.html?id=fixture_inline_match&e2e=1${extraQuery}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 30_000 },
  )
  await clearValidationErrors(page)
  await page.evaluate((fc) => {
    const map = (
      window as unknown as { __xgisMap: { setSourceData: (id: string, fc: unknown) => void } }
    ).__xgisMap
    map.setSourceData('shapes', fc)
  }, FC)
  // Worker tiling + upload settle (the virtual path is async end-to-end).
  await page.waitForTimeout(3_500)
  const png = await captureCanvas(page)
  return (await colorHistogram(page, png, BUCKETS)) as { rose: number; emerald: number }
}

test.describe('#821 inline match() colour', () => {
  test('virt_inline renders BOTH per-feature hues; legacy stays blank', async ({ page }) => {
    test.setTimeout(120_000)
    await withValidationCapture(page, async () => {
      // Legacy path (no flag): the '' slice-key mismatch → nothing drawn.
      const legacy = await loadAndPush(page, '')

      console.log('[#821 legacy]', legacy)
      expect(legacy.rose, 'legacy inline match() is a known blank (issue #821)').toBeLessThan(0.001)
      expect(legacy.emerald, 'legacy inline match() is a known blank (issue #821)').toBeLessThan(
        0.001,
      )

      // Virtual path: per-feature match() colour must land — both hues,
      // each covering a substantial share of the frame (two big quads).
      const virt = await loadAndPush(page, '&virt_inline=1')

      console.log('[#821 virt]', virt)
      expect(virt.rose, 'virt_inline must render the kind:a quad in rose').toBeGreaterThan(0.02)
      expect(virt.emerald, 'virt_inline must render the kind:b quad in emerald').toBeGreaterThan(
        0.02,
      )
    })
  })
})
