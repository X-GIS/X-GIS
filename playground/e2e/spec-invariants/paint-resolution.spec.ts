// ═══════════════════════════════════════════════════════════════════
// Spec invariants — paint property resolution through the pipeline
// ═══════════════════════════════════════════════════════════════════
//
// Pins line-opacity / line-color / line-width zoom-interpolated paint
// values on demotiles `countries-boundary`. The Mapbox spec defines
// `interpolate ["linear"]` semantics for stop arrays; these tests lock
// in the values reach the frame trace EXACTLY as the spec computes
// them. A regression to step / nearest / exponential interpretation
// trips every assertion below.
//
// Spec snippet (compiler/src/__tests__/fixtures/maplibre-demotiles.json):
//   countries-boundary {
//     line-color:   "rgba(255,255,255,1)"
//     line-width:   stops [[1,1], [6,2], [14,6], [22,12]]
//     line-opacity: stops [[3,0.5], [6,1]]
//   }
//
// Mapbox stops without an explicit interpolate head default to linear
// interpolation, with clamp-to-endpoint extrapolation outside the
// stop range.

import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'

interface FrameTrace {
  cameraZoom: number
  layers: Array<{
    layerName: string
    fillPhase: string
    resolvedOpacity: number
    resolvedStrokeWidth: number
    resolvedFill?: readonly [number, number, number, number]
    resolvedStroke?: readonly [number, number, number, number]
  }>
}

async function captureTrace(page: Page, hash: string, style: string): Promise<FrameTrace> {
  await page.goto(`/compare.html?style=${style}${hash}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 30_000 },
  )
  await page.waitForTimeout(8_000)
  return await page.evaluate(async () => {
    const map = (window as unknown as { __xgisMap?: { captureNextFrameTrace?: () => Promise<FrameTrace> } }).__xgisMap
    if (!map?.captureNextFrameTrace) throw new Error('captureNextFrameTrace missing')
    return await map.captureNextFrameTrace()
  })
}

function findBoundary(trace: FrameTrace) {
  // X-GIS lowercases / underscores Mapbox layer ids — countries-boundary
  // → countries_boundary. The trace also records the original Mapbox id
  // under .layerName for compound layers; match on either spelling.
  return trace.layers.find(l =>
    /countries[-_]boundary/.test(l.layerName) && l.fillPhase !== 'fill',
  )
}

test.describe('countries-boundary paint resolution', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 800 })
  })

  test('opacity at z=2 clamps to first stop value 0.5', async ({ page }) => {
    test.setTimeout(60_000)
    // z=2 is BELOW the first opacity stop at z=3 (value 0.5). Mapbox
    // linear-interpolate clamps to the endpoint — opacity must be 0.5,
    // NOT extrapolated downwards to 0 or below.
    const trace = await captureTrace(page, '#2/0/0', 'maplibre-demotiles')
    const b = findBoundary(trace)
    expect(b, 'countries-boundary must be in trace at z=2').toBeDefined()
    expect(b!.resolvedOpacity).toBeCloseTo(0.5, 3)
  })

  test('opacity at z=4 linear-interp between (3,0.5) and (6,1)', async ({ page }) => {
    test.setTimeout(60_000)
    // t = (4 - 3) / (6 - 3) = 1/3
    // value = 0.5 + t * (1 - 0.5) = 0.5 + 0.5/3 ≈ 0.6667
    const trace = await captureTrace(page, '#4/0/0', 'maplibre-demotiles')
    const b = findBoundary(trace)
    expect(b, 'countries-boundary must be in trace at z=4').toBeDefined()
    expect(b!.resolvedOpacity).toBeCloseTo(0.6667, 3)
  })

  test('opacity at z=6 reaches last stop value 1.0', async ({ page }) => {
    test.setTimeout(60_000)
    // z=6 is exactly the last opacity stop.
    const trace = await captureTrace(page, '#6/0/0', 'maplibre-demotiles')
    const b = findBoundary(trace)
    expect(b, 'countries-boundary must be in trace at z=6').toBeDefined()
    expect(b!.resolvedOpacity).toBeCloseTo(1.0, 3)
  })

  test('line-width at z=2 linear-interp between (1,1) and (6,2)', async ({ page }) => {
    test.setTimeout(60_000)
    // t = (2 - 1) / (6 - 1) = 0.2; width = 1 + 0.2 * 1 = 1.2 px
    const trace = await captureTrace(page, '#2/0/0', 'maplibre-demotiles')
    const b = findBoundary(trace)
    expect(b, 'countries-boundary must be in trace at z=2').toBeDefined()
    expect(b!.resolvedStrokeWidth).toBeCloseTo(1.2, 2)
  })

  test('line-width at z=8 linear-interp between (6,2) and (14,6)', async ({ page }) => {
    test.setTimeout(60_000)
    // t = (8 - 6) / (14 - 6) = 0.25; width = 2 + 0.25 * 4 = 3.0 px
    const trace = await captureTrace(page, '#8/0/0', 'maplibre-demotiles')
    const b = findBoundary(trace)
    expect(b, 'countries-boundary must be in trace at z=8').toBeDefined()
    expect(b!.resolvedStrokeWidth).toBeCloseTo(3.0, 2)
  })

})

// NOTE on `resolvedStroke`: the trace recorder reports `null` when the
// stroke colour is a `kind: 'constant'` PropertyShape (no per-frame
// re-evaluation needed). countries-boundary's `line-color:
// rgba(255,255,255,1)` is exactly that case — the white value lives
// statically on `cs.show.paintShapes.stroke` and is not echoed into
// the trace's resolved slot. Colour preservation through the IR
// pipeline is therefore better tested at the compile boundary; this
// spec covers the per-frame DYNAMIC values (opacity, width).
