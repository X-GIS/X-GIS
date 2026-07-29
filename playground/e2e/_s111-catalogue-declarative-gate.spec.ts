// ═══ The live demo's residency is DECLARATIVE — engine-resolved from the viewport (#1453) ═══
//
// `s111_live` used to install `installS111Mosaic`: 860 lines of app code doing bbox overlap,
// relevance ordering, a byte budget, an LRU and a concurrency cap on every move-end. Its
// source now declares `url: "/opendata/s111.stac.json"` and the ENGINE does that job — the same
// deal `type: raster` has always offered.
//
// A unit test cannot close this. The claim is that a REAL demo, over the REAL proxy, streaming
// REAL NOAA cells, draws through the catalogue path — and the app-side code that used to make
// it work is deleted, so nothing is left to mask a broken engine path. That is a render gate.
//
// Three things are asserted, and the first is what makes the rest mean anything:
//
//  1. The resident region keys are STAC ITEM IDS (`cbofs`, …), never `__default__`. A single
//     declared cell arms `__default__`; only the catalogue path arms an item id. This is the
//     difference between "a coverage loaded" and "the catalogue resolved the viewport".
//  2. The frame is actually PAINTED on WebGl2Device (`backend === 'webgl2'` asserted, so a
//     silent fallback cannot green it).
//  3. Panning to another domain changes the resident set — with no app code left to do it.
//
// Needs network egress to the NOAA bucket through the vite proxy. Skips loudly without it,
// rather than passing vacuously.

import { test, expect } from '@playwright/test'

/** Chesapeake — cbofs' domain, the demo's own opening view. */
const CHESAPEAKE = { lon: -76.1, lat: 37.9, zoom: 7.4 }
/** San Francisco Bay, framed INSIDE the local domain — a continent away from cbofs.
 *
 *  The zoom is load-bearing. `itemsForView` ranks by overlap AREA and only breaks a TIE toward
 *  the smaller bbox, so a view WIDER than sfbofs (z8 spans ~4.9° against sfbofs' 1.9°) gives the
 *  basin-wide `wcofs` strictly more overlap and it leads legitimately. The tie — and with it the
 *  "prefer the local, higher-resolution cell" rule this is here to pin — only exists once the
 *  view sits inside BOTH domains. z10 spans ~1.2°, which does. */
const SF_BAY = { lon: -122.35, lat: 37.75, zoom: 10 }

interface Probe {
  ok: boolean
  reason?: string
  backend?: string
  regions?: string[]
  painted?: number
}

function probe(): Probe {
  const w = window as unknown as {
    __xgisMap?: {
      ctx?: { rhi?: { backend?: string; gl?: WebGL2RenderingContext } }
      rawDatasets?: Map<string, { _coverage?: ReadonlyMap<string, unknown> }>
      coverageRenderer?: { residentRegions(): string[] }
    }
  }
  const m = w.__xgisMap
  const gl = m?.ctx?.rhi?.gl
  if (!gl) return { ok: false, reason: 'no gl' }
  const W = gl.drawingBufferWidth
  const H = gl.drawingBufferHeight
  const buf = new Uint8Array(W * H * 4)
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
  let painted = 0
  for (let i = 0; i < W * H; i++) {
    const o = i * 4
    if (buf[o]! + buf[o + 1]! + buf[o + 2]! > 24) painted++
  }
  return {
    ok: true,
    backend: m?.ctx?.rhi?.backend,
    // The RENDERER's resident set — what is actually on the GPU, not what some map believes.
    regions: m?.coverageRenderer?.residentRegions() ?? [],
    painted: painted / (W * H),
  }
}

async function boot(page: import('@playwright/test').Page, at: typeof CHESAPEAKE) {
  await page.setViewportSize({ width: 900, height: 700 })
  // Block the satellite basemap: imagery paints every pixel, so a painted-fraction that
  // included it would read ~1.0 whatever the coverage did (the exact vacuity the multi-region
  // gate was fixed for). The claim here is about COVERAGE residency.
  await page.route(/arcgisonline\.com/, (r) => void r.abort())
  await page.goto(`/demo.html?id=s111_live&forcegl2=1&e2e=1#${at.zoom}/${at.lat}/${at.lon}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 30_000 },
  )
}

/** Wait until the resident set has SETTLED — unchanged across two polls a second apart — or
 *  report that the network did not deliver. A fixed sleep is what made this gate lie once
 *  already: it read the set 1.5 s in, while the second cell of the view was still streaming,
 *  and reported the first arrival as the final answer. */
async function waitForResidency(page: import('@playwright/test').Page): Promise<boolean> {
  const regions = (): Promise<string[]> =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            __xgisMap?: { coverageRenderer?: { residentRegions(): string[] } }
          }
        ).__xgisMap?.coverageRenderer?.residentRegions() ?? [],
    )
  // TWO phases, because the no-egress case must be cheap. A CI leg without NOAA reachability
  // should give up in ~45 s, not sit out a settle deadline it can never meet.
  const firstBy = Date.now() + 45_000
  while (Date.now() < firstBy) {
    await page.waitForTimeout(1000)
    if ((await regions()).length > 0) break
  }
  if ((await regions()).length === 0) return false

  const settleBy = Date.now() + 120_000
  let prev = ''
  while (Date.now() < settleBy) {
    const now = JSON.stringify(await regions())
    if (now !== '[]' && now === prev) return true
    prev = now
    await page.waitForTimeout(1000)
  }
  return false
}

test.describe('S-111 live: the catalogue resolves the viewport (#1453)', () => {
  test('resident regions are STAC item ids, the frame paints, and a pan re-resolves', async ({
    page,
  }) => {
    test.setTimeout(300_000)

    await boot(page, CHESAPEAKE)
    if (!(await waitForResidency(page))) {
      test.skip(true, 'no NOAA egress — the live cell never arrived, so nothing is proven')
      return
    }
    const chesapeake = await page.evaluate(probe)

    expect(chesapeake.ok, 'WebGL2 context present').toBe(true)
    expect(chesapeake.backend, 'running on the WebGL2 backend').toBe('webgl2')
    await page.screenshot({ path: 'test-results/s111-catalogue-chesapeake.png' })

    // THE GATE: a declared single cell arms `__default__`. An item id can only come from the
    // catalogue path, so this one assertion separates "a coverage loaded" from "the engine
    // resolved the viewport against a catalogue".
    expect(chesapeake.regions, 'the catalogue armed a region').not.toHaveLength(0)
    expect(chesapeake.regions).not.toContain('__default__')
    expect(chesapeake.regions, 'Chesapeake resolves to cbofs').toContain('cbofs')
    expect(chesapeake.painted, 'the coverage actually painted').toBeGreaterThan(0.01)

    // ── Pan a continent away. No app code is left to do this. ──
    await boot(page, SF_BAY)
    if (!(await waitForResidency(page))) {
      test.skip(true, 'no NOAA egress for the second domain')
      return
    }
    const sf = await page.evaluate(probe)
    await page.screenshot({ path: 'test-results/s111-catalogue-sfbay.png' })

    console.log(
      `[s111-catalogue] chesapeake regions=${JSON.stringify(chesapeake.regions)} ` +
        `painted=${chesapeake.painted?.toFixed(4)} | sf regions=${JSON.stringify(sf.regions)} ` +
        `painted=${sf.painted?.toFixed(4)}`,
    )

    expect(sf.regions, 'San Francisco resolves to sfbofs').toContain('sfbofs')
    expect(sf.regions, 'and not to the Chesapeake domain').not.toContain('cbofs')
    expect(sf.painted, 'the second domain painted too').toBeGreaterThan(0.01)
  })
})
