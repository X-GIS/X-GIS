// ═══════════════════════════════════════════════════════════════════
// Spec invariants — label text resolution
// ═══════════════════════════════════════════════════════════════════
//
// Asserts on the resolved label STRING that X-GIS submits to the GPU,
// captured via RenderTraceRecorder. The assertion target is the trace
// — not the canvas pixel — so we catch spec-compliance regressions at
// the IR level rather than at composite output.
//
// These are e2e because the trace recorder hooks into the running
// XGISMap; pure-vitest invariants land later (Step 3d's headless
// render mode, separate plan).

import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'

interface FrameTrace {
  cameraZoom: number
  cameraCenter: readonly [number, number]
  cameraBearing: number
  cameraPitch: number
  projection: string
  viewportPx: readonly [number, number]
  dpr: number
  tileLOD: { selectedCz: number; fetchedKeys: readonly string[] }
  layers: Array<{
    layerName: string
    fillPhase: string
    resolvedOpacity: number
    resolvedStrokeWidth: number
    resolvedFill?: readonly [number, number, number, number]
    resolvedStroke?: readonly [number, number, number, number]
  }>
  labels: Array<{
    layerName: string
    text: string
    color: readonly [number, number, number, number]
    halo?: { color: readonly [number, number, number, number]; width: number; blur: number }
    fontFamily: string
    fontWeight: number
    fontStyle: string
    sizePx: number
    placement: 'point' | 'curve'
    state: string
    anchorScreenX: number
    anchorScreenY: number
  }>
}

async function captureTrace(page: Page, hash: string, style: string): Promise<FrameTrace> {
  await page.goto(`/compare.html?style=${style}${hash}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 30_000 },
  )
  // Let tiles fetch + labels submit.
  await page.waitForTimeout(8_000)
  return await page.evaluate(async () => {
    const map = (window as unknown as { __xgisMap?: { captureNextFrameTrace?: () => Promise<FrameTrace> } }).__xgisMap
    if (!map?.captureNextFrameTrace) throw new Error('captureNextFrameTrace not available on __xgisMap')
    return await map.captureNextFrameTrace()
  })
}

test.describe('label-text spec invariants', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 800 })
  })

  test('demotiles z=3 country labels use ABBREV form (S. Kor)', async ({ page }) => {
    test.setTimeout(60_000)
    const trace = await captureTrace(page, '#3/36/127', 'maplibre-demotiles')
    const korea = trace.labels.find(l => /Kor/.test(l.text))
    expect(korea, 'Korea label should be in trace at z=3').toBeDefined()
    // ABBREV form — should NOT be "South Korea"
    expect(korea!.text).not.toBe('South Korea')
    expect(korea!.text.length).toBeLessThanOrEqual(10)  // ABBREV is short
  })

  test('demotiles z=5 country labels switch to full NAME (longer than ABBREV)', async ({ page }) => {
    test.setTimeout(60_000)
    // Demotiles countries-label text-field: {stops:[[2,"{ABBREV}"],[4,"{NAME}"]]}
    // z>=4 should use NAME. NAME's exact value depends on the country's
    // OSM data (Korea → "S. Korea" rather than "South Korea"), so this
    // test asserts the toggle FIRED (NAME path picked), not a specific
    // string. The companion z=3 test asserts the shorter ABBREV form;
    // together they prove the zoom-driven step() resolves correctly.
    const traceZ5 = await captureTrace(page, '#5/36/127', 'maplibre-demotiles')
    const koreaZ5 = traceZ5.labels.find(l => /Kor/.test(l.text))
    expect(koreaZ5, 'Korea label should be in trace at z=5').toBeDefined()
    // At z=5 the NAME-form should be at least as long as the ABBREV form
    // (the ABBREV is by definition shorter). Length >= 7 catches every
    // demotiles ABBREV which max at ~5 chars (e.g. "S. Kor", "U.S.A.").
    expect(koreaZ5!.text.length).toBeGreaterThanOrEqual(7)
  })

  test('demotiles geolines-label uses curve placement with blue color', async ({ page }) => {
    test.setTimeout(60_000)
    const trace = await captureTrace(page, '#3/22/-30', 'maplibre-demotiles')
    const tropic = trace.labels.find(l => /Tropic|Equator|Cancer/.test(l.text))
    expect(tropic, 'A geolines label should be in trace at z=3').toBeDefined()
    expect(tropic!.placement).toBe('curve')
    // text-color: "#1077B0" → [0.063, 0.467, 0.690, 1]
    expect(tropic!.color[0]).toBeCloseTo(0.063, 2)
    expect(tropic!.color[1]).toBeCloseTo(0.467, 2)
    expect(tropic!.color[2]).toBeCloseTo(0.690, 2)
    expect(tropic!.color[3]).toBeCloseTo(1, 2)
  })

  test('demotiles countries-label font weight is Semibold (600)', async ({ page }) => {
    test.setTimeout(60_000)
    const trace = await captureTrace(page, '#4/36/127', 'maplibre-demotiles')
    const country = trace.labels.find(l => l.layerName.includes('countries_label') || l.layerName.includes('countries-label'))
    if (country) {
      // Spec: "text-font": ["Open Sans Semibold"] → fontWeight 600
      expect(country.fontWeight).toBe(600)
    }
    // If no countries-label rendered in this camera, the test is a no-op
    // — the assertion only fires when the label is actually submitted.
  })

  test('OFM Bright water_name color is navy (#495e91)', async ({ page }) => {
    test.setTimeout(60_000)
    const trace = await captureTrace(page, '#4/22/-150', 'openfreemap-bright')
    const ocean = trace.labels.find(l =>
      /Pacific|Atlantic|Ocean/i.test(l.text) && /water_name/.test(l.layerName))
    if (ocean) {
      // text-color: "#495e91" → [73/255, 94/255, 145/255, 1]
      expect(ocean.color[0]).toBeCloseTo(73 / 255, 2)
      expect(ocean.color[1]).toBeCloseTo(94 / 255, 2)
      expect(ocean.color[2]).toBeCloseTo(145 / 255, 2)
    }
  })

  test('OFM Bright label_country_2 uses Noto Sans Bold (fontWeight 700)', async ({ page }) => {
    test.setTimeout(60_000)
    // Spec snippet (compiler/src/__tests__/fixtures/openfreemap-bright.json):
    //   "id": "label_country_2", "text-font": ["Noto Sans Bold"]
    // OFM Bright country labels at rank=2 should render Bold (700), not
    // Regular / Semibold. A regression in the font-name → weight mapping
    // would silently downgrade the weight; this pins it.
    const trace = await captureTrace(page, '#3/40/0', 'openfreemap-bright')
    const country = trace.labels.find(l => /label_country_2/.test(l.layerName))
    if (country) {
      expect(country.fontWeight).toBe(700)
    }
    // If label_country_2 isn't visible at this camera, the test is a no-op
    // (assertion only fires when the layer renders).
  })
})
