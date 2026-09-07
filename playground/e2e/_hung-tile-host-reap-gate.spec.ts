import { expect, test } from '@playwright/test'

/** #2626 — the production path for a tile host that ACCEPTS the connection and never
 *  answers. #2574's reap is witnessed by a unit test against `InflightLedger` directly;
 *  nothing drives a real never-answering host through `loadImageBitmap` -> the renderer's
 *  load loop -> `pendingLoadCount()` -> `getMissingTileCount()`, which is the wiring the
 *  wedge actually lived in.
 *
 *  `page.route` intercepts BEFORE the network, so a handler that never calls
 *  `fulfill`/`abort`/`continue` black-holes the request inside the browser: deterministic,
 *  offline, and independent of this container's egress. Every other routing spec in this
 *  suite resolves its handler (measured: 18 specs, 0 black-holes), which is why this
 *  failure mode had no coverage.
 *
 *  The two quantities are deliberately different, so one severed mechanism cannot green by
 *  looking like the other:
 *    - REQUEST COUNT watches `onReaped` (raster-renderer.ts:278). Without it the reaped key
 *      is not recorded as a failed attempt, so `requestable(key)` is true again next frame
 *      and the dead host is re-asked every deadline forever.
 *    - DISTINCT KEY COUNT watches the budget. `MAX_CONCURRENT_LOADS` slots pinned by dead
 *      entries mean no NEW key is ever requested — the pre-#2574 wedge, whose signature is
 *      `pendingLoadCount()` reading 0 while the budget stays full. */
const TILE_HOST = /tile\.openstreetmap\.org/

/** map/src/render/tile-retry.ts:190 + :56 — read here so a change to either constant
 *  shows up as this gate failing rather than as a silently re-tuned budget. */
const KEEP_WARM_MS = 10_000
const MAX_TILE_ATTEMPTS = 4

/** Longer than two keep-warm deadlines: a host still being re-asked cannot be quiet this
 *  long, so quiet is the signal that the retry ledger actually gave up. */
const HOLD_MS = 25_000

test.describe.configure({ timeout: 300_000 })

test.describe('#2626 — a hung tile host must not wedge the load loop', () => {
  test('the reap frees the budget, the stream recovers, and the host is not re-asked forever', async ({
    page,
  }) => {
    const requested: string[] = []
    // The black hole: recorded, then never fulfilled, aborted or continued.
    await page.route(TILE_HOST, (route) => {
      requested.push(route.request().url())
    })

    // ?adaptive=0 — the quality controller samples wall-clock frame intervals and moves the
    // tile selector's error ceiling with them (§12), which would make the tile set a
    // function of machine speed. Pin it.
    await page.goto('/demo.html?id=raster&e2e=1&adaptive=0#3/30/10', {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      undefined,
      { timeout: 30_000 },
    )

    const rasterFetchCount = () =>
      page.evaluate(() => {
        const m = (
          window as unknown as {
            __xgisMap?: { _pendingWork?: { count?: (s: readonly string[]) => number } }
          }
        ).__xgisMap
        return m?._pendingWork?.count?.(['raster-fetch']) ?? -1
      })

    // PRECONDITION. Everything below is vacuous if the map never asked for a tile — a
    // black-holed host and a map that requests nothing look identical downstream.
    await expect
      .poll(() => requested.length, { timeout: 30_000, message: 'the map must request tiles' })
      .toBeGreaterThan(0)
    const inflightWhilePinned = await rasterFetchCount()
    expect(inflightWhilePinned, 'the registry must see the in-flight fetches').toBeGreaterThan(0)

    const keysOf = (urls: readonly string[]) => new Set(urls.map((u) => new URL(u).pathname))
    const keysBeforeDeadline = keysOf(requested).size

    // THE REAP. Past the keep-warm deadline the hung entries are dropped, so the
    // deadline-bounded count returns to 0 even though nothing ever answered. Polled, not
    // slept through: the assertion is on the value, and the budget only bounds how long we
    // will wait for it.
    await expect
      .poll(() => rasterFetchCount(), {
        timeout: KEEP_WARM_MS * 3,
        message: 'the hung entries must be reaped, so the deadline-bounded count drains',
      })
      .toBe(0)

    // THE BUDGET FREED. `size` reaps too, so slots come back and keys the concurrency limit
    // had blocked get their turn. Pinned slots would freeze this number.
    await expect
      .poll(() => keysOf(requested).size, {
        timeout: KEEP_WARM_MS * 6,
        message: 'freed slots must let previously-blocked tile keys be requested',
      })
      .toBeGreaterThan(keysBeforeDeadline)

    // NO RE-ASK STORM — measured as a CEILING THAT HOLDS, not as a count read once.
    //
    // Two instruments were tried and discarded, both recorded here because each looked
    // decisive and was not:
    //   1. "the worst key's attempt count at an arbitrary moment" — severing `onReaped`
    //      reproduced the fixed path's numbers EXACTLY (18 keys / 42 requests / worst 3),
    //      because inside any window short enough that the fix has not yet reached its
    //      ceiling both paths re-ask on the same keep-warm cadence. An assertion that
    //      passes either way (§12).
    //   2. "wait for the request log to go quiet" — the fixed path does not go quiet
    //      quickly, and not because of a storm: once a tile is abandoned the renderer
    //      falls back to its PARENT (raster-renderer.ts:813), and each new ancestor key
    //      gets its own attempts. Measured: keys 18 -> 24 -> 30 from t=100 s while the
    //      per-key ceiling stayed pinned at 4. Quiet is a property of the parent chain
    //      draining, not of the retry ledger, so it answers a different question.
    //
    // What only the fix does is STOP RETRYING A GIVEN KEY. So: poll until some key has
    // actually reached the ceiling — that is the non-vacuity guard, it proves the ledger
    // was exercised to its limit — then keep watching for longer than two deadlines and
    // assert the ceiling still holds. A severed `onReaped` re-asks every deadline, so it
    // walks straight through 4 during the second window.
    const worstAttempts = () => {
      const perKey = new Map<string, number>()
      for (const url of requested) {
        const k = new URL(url).pathname
        perKey.set(k, (perKey.get(k) ?? 0) + 1)
      }
      return Math.max(0, ...perKey.values())
    }

    await expect
      .poll(worstAttempts, {
        timeout: 150_000,
        intervals: [1_000],
        message:
          'no key ever reached MAX_TILE_ATTEMPTS — the retry ledger was never exercised to ' +
          'its limit, so anything this test concludes about the ceiling would be vacuous',
      })
      .toBe(MAX_TILE_ATTEMPTS)

    // The RATE window. This is a measurement interval for a rate, not a settle: the
    // quantity under test is "how often is a dead key re-asked", and a rate needs a span.
    // Sized at two keep-warm deadlines plus slack, so a path that re-asks on that cadence
    // cannot cross it unnoticed.
    const held = await page.evaluate(
      (ms) => new Promise<true>((r) => setTimeout(() => r(true), ms)),
      HOLD_MS,
    )
    expect(held).toBe(true)

    const keys = new Set(requested.map((u) => new URL(u).pathname))
    const worst = worstAttempts()
    console.log(
      `[#2626] distinctKeys=${keys.size} requests=${requested.length} worstKeyAttempts=${worst}`,
    )
    expect(
      worst,
      `a dead host must be abandoned after MAX_TILE_ATTEMPTS, not re-asked every deadline ` +
        `forever — the worst key saw ${worst} attempts, still climbing ${HOLD_MS / 1000} s ` +
        `after the ceiling was first reached (onReaped, raster-renderer.ts:278)`,
    ).toBe(MAX_TILE_ATTEMPTS)
  })
})
