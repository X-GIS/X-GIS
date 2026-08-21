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
// #1837 moved the DEFAULT: an inline source with no filter and no geometryExpr
// now takes the virtual route without any opt-in, so the blank this spec used to
// pin on a flag-less boot is gone. The legacy route kept the '' slice-key miss
// behind the explicit Phase-5f opt-OUT (?legacy=1), and this spec pinned that
// blank as contract.
//
// #1940 REMOVED that residual: the legacy route now stores its tiles under the
// same `computeSliceKey(sourceLayer || targetName, filter)` string the VTR looks
// them up under, so the opt-out arm renders. All three arms now assert PIXELS.
//
// Three-way real-GPU probe, same discipline as the issue's repro:
//   default (no flag)  → BOTH hues present (per-feature colour applied) — #1837
//   ?legacy=1          → BOTH hues present (the slice-key agreement) — #1940
//   ?virt_inline=1     → BOTH hues present (the explicit opt-in, unchanged)
//
// KNOWN RESIDUAL, deliberately NOT asserted here (a separate root cause, so
// pinning it would make this spec bless a second defect the way it used to bless
// the blank): on the legacy route the two hues are SWAPPED relative to the
// virtual route — measured default { rose 0.1888, emerald 0.1860 } vs legacy
// { rose 0.1860, emerald 0.1888 }, i.e. the same quad. `buildPropertyTable`
// (compiler/src/tiler/vector-tiler.ts:1550) indexes its `values` rows by feature
// ARRAY INDEX while the tile geometry carries `feature.id`-derived fids
// (`resolveIdResolver`, data/src/workers/geojson-compile-worker.ts:94), so a
// source whose features carry explicit ids reads the wrong row. Invisible until
// now because #821 moved every match() show off this route rather than fixing it.

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
  test('inline match() renders on all three routes — default (#1837), ?legacy=1 (#1940), opt-in', async ({
    page,
  }) => {
    test.setTimeout(180_000)
    await withValidationCapture(page, async () => {
      // DEFAULT boot, no flag. Before #1837 this was the blank this spec pinned as
      // "the residual legacy contract"; the route now defaults to virtual, so the
      // per-feature colour lands with no opt-in at all.
      const dflt = await loadAndPush(page, '')

      console.log('[#821 default]', dflt)
      expect(dflt.rose, 'default boot must render the kind:a quad in rose (#1837)').toBeGreaterThan(
        0.02,
      )
      expect(
        dflt.emerald,
        'default boot must render the kind:b quad in emerald (#1837)',
      ).toBeGreaterThan(0.02)

      // Explicit Phase-5f opt-OUT: still the legacy compile path (no virt attach),
      // and since #1940 its tiles land in the slot the VTR reads. Measured on the
      // fix: { rose: 0.1860, emerald: 0.1888 } — the same two quads the other arms
      // paint, both far above the 0.02 floor (0 / 0 before the fix). See the KNOWN
      // RESIDUAL note in the header for why this arm asserts hue PRESENCE and not
      // the hue↔quad assignment.
      const legacy = await loadAndPush(page, '&legacy=1')

      console.log('[#821 legacy=1]', legacy)
      expect(
        legacy.rose,
        '?legacy=1 must render the rose quad — the legacy route stores under the VTR lookup key (#1940)',
      ).toBeGreaterThan(0.02)
      expect(
        legacy.emerald,
        '?legacy=1 must render the emerald quad — the legacy route stores under the VTR lookup key (#1940)',
      ).toBeGreaterThan(0.02)

      // Explicit opt-in: unchanged by #1837, still renders both hues.
      const virt = await loadAndPush(page, '&virt_inline=1')

      console.log('[#821 virt]', virt)
      expect(virt.rose, 'virt_inline must render the kind:a quad in rose').toBeGreaterThan(0.02)
      expect(virt.emerald, 'virt_inline must render the kind:b quad in emerald').toBeGreaterThan(
        0.02,
      )
    })
  })
})
