// ═══ Does #1616's content signal actually settle? (the unproven half) ═══
//
// #1616 moved `TileCatalog.contentGeneration()` to `setSlice`, the one chokepoint
// every slice write passes, so a tile ARRIVING under an already-selected key is
// visible to the tile-point pack key. Correctness needed that. But it put the
// counter in the pack key, and the counter is per-CATALOG — so ANY slice write
// (a different source-layer, a prefetched tile the camera cannot see, a sub-tile
// for a layer with no points at all) repacks EVERY point show on that source.
//
// The commit claimed "#1581's win is preserved by construction: a frame in which
// no slice is written does not bump it". The first half is pinned by a unit
// control. The half that decides whether the optimization survives — does a real
// settled camera actually stop writing? — had NO evidence, and the unit control
// cannot produce it: it drives no frame loop, no prefetch, no eviction.
//
// Review named three churn paths that would keep it moving, none measured:
//   · sub-tile convergence at overzoom / high pitch (its own comment in
//     tile-catalog.ts documents ~1s of writing frames, restarting on camera move)
//   · prefetch/evict cycling at the byte cap while the camera is IDLE — the
//     evict-shield TTL is 2s and `prefetchAdjacent` re-requests every 10 frames,
//     so a ring key could cycle evict → re-prefetch → land → write, forever
//   · empty/404 results, which also write an empty TileData
//
// This measures it instead of arguing about it. A stationary camera, a real
// streaming source, ~30s of samples: report how many times the counter moves
// after the scene has settled. Zero moves refutes the churn concern for this
// scenario; periodic moves confirm it and quantify the cost.
//
// This spec ASSERTS the settled behaviour, so it is also the regression gate: if
// a future change starts writing slices at a settled camera, the tile-point pack
// silently rebuilds every frame and this goes red.

import { test, expect, type Page } from '@playwright/test'

type MapWin = {
  __xgisReady?: boolean
  __xgisMap?: {
    invalidate?: () => void
    getMissingTileCount?: () => number
    vtSources?: Map<string, { source?: { contentGeneration?: () => number } }>
    ctx?: { rhi?: { backend?: string } }
  }
}

/** Sum of every attached catalog's content generation — the quantity the pack key reads. */
const readGen = (page: Page) =>
  page.evaluate(() => {
    const m = (window as unknown as MapWin).__xgisMap
    let total = 0
    let sources = 0
    for (const [, v] of m?.vtSources ?? []) {
      const g = v.source?.contentGeneration?.()
      if (typeof g === 'number') {
        total += g
        sources++
      }
    }
    return { total, sources, inFlight: m?.getMissingTileCount?.() ?? -1 }
  })

// Two scenarios, because the single-point fixture alone proves almost nothing: it
// has one tiny source and cannot reach the byte cap, so prefetch/evict cycling and
// sub-tile generation — the paths actually under suspicion — never fire. The
// megacities arm carries TWO sources and a real populated-places point layer, and
// runs pitched and overzoomed so the sub-tile generator is live.
const SCENARIOS = [
  { id: 'fixture_point', hash: '', label: 'single-point fixture (baseline)' },
  { id: 'megacities', hash: '#5.2/35.6/139.7@55', label: 'two sources, pitched + overzoomed' },
] as const

for (const sc of SCENARIOS) {
  test(`#1616 — contentGeneration settles at a stationary camera: ${sc.label}`, async ({
    page,
  }) => {
    test.setTimeout(240_000)
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)))

    await page.setViewportSize({ width: 800, height: 600 })
    // `adaptive=0` so the quality ladder cannot add its own frame-to-frame
    // variation (#1620) — this measures writes, not render scale.
    await page.goto(`/demo.html?id=${sc.id}&forcegl2=1&adaptive=0${sc.hash}`, {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(() => (window as unknown as MapWin).__xgisReady === true, {
      timeout: 30_000,
    })
    expect(
      await page.evaluate(() => (window as unknown as MapWin).__xgisMap?.ctx?.rhi?.backend),
    ).toBe('webgl2')

    // Settle: drive frames until nothing is in flight AND the counter has stopped
    // moving, so what follows measures the STEADY state, not the load.
    const settleDeadline = Date.now() + 60_000
    let prev = await readGen(page)
    let quiet = 0
    while (Date.now() < settleDeadline && quiet < 5) {
      await page.evaluate(() => (window as unknown as MapWin).__xgisMap?.invalidate?.())
      await page.waitForTimeout(200)
      const cur = await readGen(page)
      quiet = cur.total === prev.total && cur.inFlight === 0 ? quiet + 1 : 0
      prev = cur
    }
    expect(
      prev.sources,
      'the fixture must have attached a vector source to measure',
    ).toBeGreaterThan(0)

    // Measured window: the camera is NEVER touched from here on. Keep rendering —
    // prefetch runs on a frame cadence, so an idle-but-not-rendering page would
    // trivially show no churn and prove nothing.
    const settled = prev.total
    const samples: number[] = []
    for (let i = 0; i < 150; i++) {
      await page.evaluate(() => (window as unknown as MapWin).__xgisMap?.invalidate?.())
      await page.waitForTimeout(200)
      samples.push((await readGen(page)).total)
    }

    const moves = samples.filter((v, i) => v !== (i === 0 ? settled : samples[i - 1])).length
    const drift = samples[samples.length - 1] - settled
    // Reported either way — a green run should still say what it measured, or the
    // next reader cannot tell "settled" from "never looked".
    console.log(
      `CHURN[${sc.id}] settled=${settled} final=${samples[samples.length - 1]} ` +
        `drift=${drift} moves=${moves}/150 samples over ~30s (sources=${prev.sources})`,
    )

    expect(
      moves,
      `contentGeneration moved ${moves} times over ~30s at a stationary camera (drift ${drift}). ` +
        'It is per-catalog and sits in TilePointPackKey, so every move repacks every ' +
        'point show on that source — the cost #1581 exists to remove. If this is a ' +
        'legitimate steady-state write (prefetch/evict cycling, sub-tile convergence), ' +
        'the counter needs narrowing to the slices a pack actually consumed, not relaxing here.',
    ).toBe(0)

    expect(errors, 'no page errors').toEqual([])
  })
}
