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
//   all three          → the SAME quad wears the same hue — #1947
//
// #1947 CLOSED the last residual, and this spec now PINS it. The legacy route
// used to paint the two quads with each other's colour — default
// { rose 0.1888, emerald 0.1860 } vs legacy { rose 0.1860, emerald 0.1888 },
// the same two quads swapped — because `buildPropertyTable`
// (compiler/src/tiler/vector-tiler.ts) parked its `values` rows at each
// feature's ARRAY INDEX while the tile geometry carries the `feature.id`-derived
// fid every consumer looks a row up by (`resolveIdResolver`,
// data/src/workers/geojson-compile-worker.ts:94). The table is fid-addressed
// now, so the per-arm histograms agree to ~4e-6 — two orders below the 2.8e-3
// gap between the hues, which is what the cross-arm assertions below gate on.
// The FC deliberately carries explicit ids 1 and 2 (≠ positions 0 and 1): that
// is the input shape that made the two indexings disagree.

import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { captureCanvas, colorHistogram, type ColorBucket } from './helpers/visual'
import {
  withValidationCapture,
  clearValidationErrors,
  type ValidationCheckpoint,
} from './helpers/validation'

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
  checkpoint: ValidationCheckpoint,
): Promise<{ rose: number; emerald: number }> {
  // Drain the queue of the realm this navigation replaces (#2352). Without it
  // only the LAST of the three routes below was ever validated — the default
  // and ?legacy=1 arms fired their errors into realms that died unread.
  await checkpoint()
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
    await withValidationCapture(page, async (checkpoint) => {
      // DEFAULT boot, no flag. Before #1837 this was the blank this spec pinned as
      // "the residual legacy contract"; the route now defaults to virtual, so the
      // per-feature colour lands with no opt-in at all.
      const dflt = await loadAndPush(page, '', checkpoint)

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
      // #1947 fix: { rose: 0.18880, emerald: 0.18599 } — the same two quads the
      // other arms paint, wearing the same hues (it read { rose: 0.1860,
      // emerald: 0.1888 } while the property table was array-indexed, and 0 / 0
      // before #1940).
      const legacy = await loadAndPush(page, '&legacy=1', checkpoint)

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
      const virt = await loadAndPush(page, '&virt_inline=1', checkpoint)

      console.log('[#821 virt]', virt)
      expect(virt.rose, 'virt_inline must render the kind:a quad in rose').toBeGreaterThan(0.02)
      expect(virt.emerald, 'virt_inline must render the kind:b quad in emerald').toBeGreaterThan(
        0.02,
      )

      // #1947 — the hue↔quad ASSIGNMENT, not just hue presence. The two quads
      // are near-mirror images, so each hue's coverage identifies WHICH quad
      // wears it: swapping them moves each share by ~2.8e-3, while the routes'
      // rasterisation differences move it by ~4e-6. `toBeCloseTo(_, 3)` admits
      // <5e-4 — 120× the cross-route noise, 5.6× under the swap signal — so a
      // property table that stops following the geometry's fid turns this red
      // and names the arm that drifted.
      for (const [name, arm] of [
        ['?legacy=1', legacy],
        ['?virt_inline=1', virt],
      ] as const) {
        expect(
          arm.rose,
          `${name} must paint the SAME quad rose as the default arm (#1947)`,
        ).toBeCloseTo(dflt.rose, 3)
        expect(
          arm.emerald,
          `${name} must paint the SAME quad emerald as the default arm (#1947)`,
        ).toBeCloseTo(dflt.emerald, 3)
      }
    })
  })
})
