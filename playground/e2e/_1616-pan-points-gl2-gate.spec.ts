// ═══ Points must appear in tiles a PAN brought into view (#1616 S1, pixels) ═══
//
// The unit gate (tile-point-dirty-check.test.ts) proves the pack KEY discriminates
// a pan. It cannot prove the CALL SITE feeds it the right things —
// `vector-tile-renderer.ts` builds the key from `this.stableKeys`,
// `source.contentGeneration()` and `pointWorldCopies(...)`, and every unit test
// hand-builds keys instead. This drives the real tiler, the real camera and the
// real GPU buffers, and asserts what a user would notice: after panning, the
// points belonging to newly-entered tiles are ON SCREEN.
//
// FAIL-BEFORE, measured by severing the pack key back to its PRE-FIX form (XOR
// fold + neither `contentGeneration` nor `worldCopyMask` compared):
//     fixed   origin red=8030  →  moved red=6724   PASS
//     pre-fix origin red=7100  →  moved red=0, nonBg=0   FAIL
// A completely blank frame: the pack still holds the origin's points and the
// camera is now looking somewhere they are not.
//
// ── Two things had to be measured before this gate could discriminate ──
//
// 1. WHY A PURPOSE-BUILT FIXTURE. Pre-#1632, `PointRenderer` held ONE pack-key
//    slot for the whole scene (`_lastTilePointPackKey`; `scene-renderers.ts` builds
//    one PointRenderer per map), so a style with two point layers thrashes it and the
//    memo NEVER HITS. Every shipped point demo is exactly that shape — a halo
//    layer plus a pin layer — so none of them can exhibit a stale-pack bug at
//    all. Two attempts on `megacities` failed here before that was understood:
//    the first classified pins by red dominance and counted the 500km opacity-25
//    halos instead (43% of the frame, reading HIGHER on the buggy build than the
//    fixed one), the second counted the white stroke and got 33 vs 12 pixels.
//    `fixture_tile_point_memo` is one point layer over no basemap, so the memo
//    hits and every non-background pixel IS a point.
//    (#1632 gave the cache one slot PER SHOW, so a two-point-layer style would
//    now memo-hit too. The single-layer fixture stays: every non-background pixel
//    being a point is what makes the red count readable, not the memo.)
//
// 2. WHY THESE TWO CENTRES. The even×even XOR cancellation is exact for a
//    single-zoom RECTANGLE, but a live `stableKeys` is `neededKeys ++
//    protectedAncestors` (vector-tile-renderer.ts) and therefore mixes zooms —
//    measured here as `zs=[3,2,1]`, e.g. `[78,76,75,73, 19,18, 4]` — so the
//    `1<<2z` terms no longer pair off and most pans DO move the old fold. A
//    temporary probe over seven centres found the pair that still collides:
//    (-75,35) and (90,0) both fold to 5 with completely disjoint key sets. That
//    is the precondition this gate stands on. If the tile selector changes, the
//    collision can evaporate and this spec would go green without being able to
//    fail — re-measure the fold at both centres before trusting a green run after
//    any change to selection or ancestor protection.
//
// It also exists because the gate previously cited as render evidence for this
// fix, `_1581-static-camera-render-gate`, was MEASURED passing 4/4 with the S1
// bug fully reintroduced: "pixels changed after setCenter" is satisfied by the
// FILLS moving whether or not the point pack was reused, and "pixels match after
// returning to the origin" is satisfied TRIVIALLY by a pack that was never
// rebuilt, because it is still the origin's pack.

import { test, expect, type Page } from '@playwright/test'

type MapWin = {
  __xgisReady?: boolean
  __xgisMap?: {
    invalidate?: () => void
    setCenter?: (lon: number, lat: number) => void
    getMissingTileCount?: () => number
    vtSources?: Map<string, { source?: { contentGeneration?: () => number } }>
    ctx?: { rhi?: { backend?: string; gl?: WebGL2RenderingContext } }
  }
}

/** red-500 is #ef4444 and the fixture draws nothing else, so `red` and `nonBg`
 *  are two readings of the same quantity — both are reported so a background
 *  that is not black cannot be mistaken for coverage. `gen` rides along because
 *  a pan that FETCHES new slices bumps `contentGeneration`, which rebuilds the
 *  pack for a reason other than the tile-set hash; it moved 17 → 33 across this
 *  pan, which is why the fail-before above had to sever that field too rather
 *  than the hash alone. */
const sample = (page: Page) =>
  page.evaluate(() => {
    const m = (window as unknown as MapWin).__xgisMap
    const gl = m?.ctx?.rhi?.gl
    if (!gl) return { ok: false as const }
    const W = gl.drawingBufferWidth
    const H = gl.drawingBufferHeight
    const buf = new Uint8Array(W * H * 4)
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
    let red = 0
    let nonBg = 0
    for (let p = 0; p < W * H; p++) {
      const i = p * 4
      const r = buf[i]
      const g = buf[i + 1]
      const b = buf[i + 2]
      if (r !== 0 || g !== 0 || b !== 0) nonBg++
      if (r > 150 && g < 120 && b < 120) red++
    }
    let gen = 0
    for (const [, v] of m?.vtSources ?? []) gen += v.source?.contentGeneration?.() ?? 0
    return { ok: true as const, red, nonBg, gen, inFlight: m?.getMissingTileCount?.() ?? -1 }
  })

/** Drive frames until nothing is in flight and the coverage stops moving. */
async function settle(page: Page): Promise<{ red: number; nonBg: number; gen: number }> {
  const deadline = Date.now() + 60_000
  let prev = -1
  let stable = 0
  let last = { red: 0, nonBg: 0, gen: 0 }
  while (Date.now() < deadline) {
    await page.evaluate(() => (window as unknown as MapWin).__xgisMap?.invalidate?.())
    await page.waitForTimeout(120)
    const r = await sample(page)
    if (!r.ok) continue
    last = { red: r.red, nonBg: r.nonBg, gen: r.gen }
    if (r.inFlight === 0 && r.red === prev) {
      if (++stable >= 3) return last
    } else stable = 0
    prev = r.red
  }
  return last
}

test('#1616 — a pan renders the points of the tiles it brought into view', async ({ page }) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)))

  await page.setViewportSize({ width: 800, height: 600 })
  // `preserve=1` is mandatory — without preserveDrawingBuffer every readPixels
  // after present returns zeros, which reads as "nothing rendered" rather than as
  // a missing flag. `adaptive=0` pins the quality ladder (#1620) so a notch change
  // cannot be mistaken for a coverage change.
  await page.goto(
    '/demo.html?id=fixture_tile_point_memo&forcegl2=1&preserve=1&adaptive=0#3/35/-75',
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(() => (window as unknown as MapWin).__xgisReady === true, {
    timeout: 30_000,
  })
  expect(
    await page.evaluate(() => (window as unknown as MapWin).__xgisMap?.ctx?.rhi?.backend),
  ).toBe('webgl2')

  // Origin: the US east coast.
  const origin = await settle(page)

  // Destination: the Bay of Bengal. See header note 2 — this pair was picked
  // because their live key sets are disjoint yet fold to the same value under
  // the hash this fix replaced.
  await page.evaluate(() => (window as unknown as MapWin).__xgisMap?.setCenter?.(90, 0))
  const moved = await settle(page)

  console.log(
    `PAN origin red=${origin.red} nonBg=${origin.nonBg} gen=${origin.gen} | ` +
      `moved red=${moved.red} nonBg=${moved.nonBg} gen=${moved.gen}`,
  )

  // Non-vacuity first: the origin view must actually draw points, or the
  // assertion below is comparing two zeros.
  expect(origin.red, 'the origin view must draw city points').toBeGreaterThan(2000)
  expect(
    moved.red,
    'after panning to a disjoint tile set the destination drew almost no points — the ' +
      "tile-point pack was not rebuilt, so it still holds the ORIGIN's points, which are " +
      'positioned outside this view. The user-visible shape of #1616 S1 (measured 0 here ' +
      'with the pre-fix key).',
  ).toBeGreaterThan(2000)

  expect(errors, 'no page errors').toEqual([])
})
