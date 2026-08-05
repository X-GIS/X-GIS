// ═══ What anticipatory prefetch actually costs and buys — MEASUREMENT, not a gate (#1587) ═══
//
// Both prefetch routes had never run in the product (`beginFrame` cleared the selection the pump
// reads, sixteen lines earlier). #1587 moves the pump after the frame's draw passes, so they run
// for the first time. The issue is explicit that this must not be assumed beneficial:
//
//   "Since the routes have never run, no measurement exists for what enabling them costs or gains.
//    Whatever fix lands should be measured, not assumed beneficial — the `_evictShield` /
//    catalog-concurrency concerns in the pump's own doc are real and were reasoned about for a code
//    path that then never executed."
//
// So this file MEASURES and reports. It is not a pass/fail gate on prefetch being *better*, because
// a threshold picked from one run on one machine would be exactly the kind of number CLAUDE.md §12
// warns about ("a metric gradient whose x-axis is the order I happened to run things"). The A/B is
// run by executing this same spec on the fix branch and on its base — the base IS the
// prefetch-disabled arm, since prefetch is dead there, so no toggle has to be invented.
//
// The assertions it DOES make are the ones that must hold whatever the numbers say: the scene still
// converges, and the pan does not leave permanent holes. Those are regressions the risk surface
// makes plausible — the pump shields up to 16 speculative keys per frame per source against a
// bounded tile cache, and competes with visible tiles for the catalog's concurrency budget.
//
// WebGL2 rather than WebGPU: there is no software WebGPU adapter here or on CI (CLAUDE.md §5), and
// the twin arm is the one a gate can actually drive.

import { test, expect } from '@playwright/test'

interface Sample {
  t: number
  missed: number
  needed: number
  catalogLoading: number
  catalogCached: number
}

/** Sum of `missed` over the sampled window, in missed-tiles × ms — the "how much empty map did the
 *  user look at" integral. A single peak reading cannot express that; a pan that misses 4 tiles for
 *  a moment is not the same experience as one that misses 4 for two seconds. */
const missedIntegral = (s: Sample[]): number =>
  s.slice(1).reduce((acc, cur, i) => acc + cur.missed * (cur.t - s[i]!.t), 0)

test.describe('anticipatory prefetch — measurement (#1587)', () => {
  test('a scripted pan: missed-tile integral and time to converge', async ({ page }) => {
    test.setTimeout(180_000)
    await page.setViewportSize({ width: 900, height: 700 })
    await page.goto('/demo.html?id=import_maplibre_demo&forcegl2=1&e2e=1&adaptive=0#4/35.0/135.0', {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      { timeout: 30_000 },
    )
    // Asserted, not assumed — a silent fallback would measure a different backend than the one
    // this file makes claims about.
    const backend = await page.evaluate(
      () =>
        (window as unknown as { __xgisMap?: { ctx?: { rhi?: { backend?: string } } } }).__xgisMap
          ?.ctx?.rhi?.backend,
    )
    expect(backend, 'running on the WebGL2 twin — the arm a gate can drive').toBe('webgl2')

    // Settle before measuring: the initial load is not what a prefetch route affects, and folding
    // it in would swamp the pan's signal with cold-start noise.
    await page.waitForTimeout(3000)

    const result = await page.evaluate(async () => {
      const w = window as unknown as {
        __xgisMap?: {
          getTileLoadDiagnostic(): Record<
            string,
            {
              needed: number
              missed: number
              catalogLoading: number
              catalogCached: number
            }
          >
          setCenter?: (lon: number, lat: number) => void
          getCenter?: () => [number, number]
        }
      }
      const map = w.__xgisMap
      if (!map) return { ok: false as const, reason: 'no map' }

      const sample = (t: number) => {
        const all = Object.values(map.getTileLoadDiagnostic())
        return {
          t,
          missed: all.reduce((a, d) => a + d.missed, 0),
          needed: all.reduce((a, d) => a + d.needed, 0),
          catalogLoading: all.reduce((a, d) => a + d.catalogLoading, 0),
          catalogCached: all.reduce((a, d) => a + d.catalogCached, 0),
        }
      }

      const t0 = performance.now()
      const during: typeof samples = []
      const samples: ReturnType<typeof sample>[] = []
      const start = map.getCenter?.() ?? [0, 0]

      // A steady eastward pan — the motion route 2's velocity vector is built for. Stepped rather
      // than jumped so the camera has a real dt each frame; a single setCenter teleport produces a
      // speed the pan-speculation route deliberately discards. 1.5 deg/step suits the MapLibre
      // demo tiles' z0..5 world range, where a fraction of a degree would not cross a tile at all.
      const STEPS = 40
      for (let i = 1; i <= STEPS; i++) {
        map.setCenter?.(start[0] + i * 1.5, start[1])
        await new Promise((r) => requestAnimationFrame(() => r(null)))
        during.push(sample(performance.now() - t0))
      }
      const panEnd = performance.now() - t0

      // Then hold still and watch it converge. Time-to-zero is the direct "did the tiles arrive
      // sooner" reading; the integral above is "how much hole did the pan show".
      let convergedAt = -1
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 50))
        const s = sample(performance.now() - t0)
        samples.push(s)
        if (s.missed === 0 && convergedAt < 0) {
          convergedAt = s.t
          break
        }
      }
      return { ok: true as const, during, after: samples, panEnd, convergedAt }
    })

    expect(result.ok, 'the probe reached the map').toBe(true)
    if (!result.ok) return

    const integral = missedIntegral(result.during as Sample[])
    const peak = Math.max(...(result.during as Sample[]).map((s) => s.missed))
    const peakNeeded = Math.max(...(result.during as Sample[]).map((s) => s.needed))

    // PRECONDITION, and the reason this file is not self-deceiving. Prefetch only acts on a
    // TileCatalog archive, and every such source in the playground is fetched over the network.
    // With no network the pan needs ONE tile, misses none, and every number below reads perfect —
    // a probe that reports "nothing missed, converged instantly" over a scene that never loaded.
    // This fails first and names the reason instead. It is why this spec cannot run in a sandbox
    // without egress; CI has it.
    expect(
      peakNeeded,
      `the tile source must actually be serving tiles — peak needed was ${peakNeeded}. If this is ` +
        `~1 the archive did not load (no network?) and every measurement below is vacuous`,
    ).toBeGreaterThan(8)
    const last = (result.after as Sample[]).at(-1)
    console.log(
      `[prefetch-probe] missedIntegral=${integral.toFixed(0)} (missed-tiles·ms) ` +
        `peakMissed=${peak} panEnd=${result.panEnd.toFixed(0)}ms ` +
        `convergedAt=${result.convergedAt < 0 ? 'NEVER' : result.convergedAt.toFixed(0) + 'ms'} ` +
        `(${(result.convergedAt - result.panEnd).toFixed(0)}ms after the pan stopped) ` +
        `finalCached=${last?.catalogCached ?? -1} finalLoading=${last?.catalogLoading ?? -1}`,
    )

    // ── The assertions, which are about REGRESSION, not about prefetch being better ──
    //
    // The pump shields up to 16 speculative keys per frame per source (TTL 2 s) against a bounded
    // cache, and competes with visible tiles for the catalog's concurrency budget. The failure
    // that would cause is a scene that stops converging — visible tiles evicted or starved in
    // favour of speculative ones. That is what these pin.
    expect(
      result.convergedAt,
      'the scene must still reach zero missed tiles after the pan — if this is NEVER, prefetch is ' +
        'starving or evicting the visible set, which is the risk its own doc names',
    ).toBeGreaterThan(-1)
    expect(
      last?.catalogLoading ?? -1,
      'and nothing may be left permanently in flight',
    ).toBeLessThan(1)
  })
})
