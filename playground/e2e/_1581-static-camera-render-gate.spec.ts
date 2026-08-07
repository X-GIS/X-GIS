import { test, expect, type Page } from '@playwright/test'

// #1581 — render-verification gate for the static-camera memo fixes (CLAUDE.md
// §5, mandatory: this issue can change WHICH TILES draw).
//
// Leg A re-keys TileSelectionCache's per-margin memo on a camera signature +
// canvas + DPR + indexGeneration instead of frameId, and VTR.beginFrame() no
// longer clears it every rendered frame. Leg B gates emitTilePointsRhi's
// accumulate+repack+buffer-recreate chain on a TilePointPackKey and reuses the
// packed buffers via PointRenderer.redrawTilePointsCached when unchanged.
//
// Both are pure perf fixes: a static camera must render BYTE-IDENTICAL pixels
// whether or not the memo skipped work, and a real camera change (or return to
// a prior camera) must still select/pack fresh — the exact two failure modes
// the issue's landmine warns about (serve stale data forever, or never reuse
// at all). This drives the REAL VT tile-points path (fixture_point, VirtualPMTiles)
// headless on WebGL2 (SwiftShader — real rasterization, unlike WebGPU here).
//
// Fail-before: with VTR.beginFrame() still calling invalidateFrame()
// unconditionally (pre-leg-A) this test is vacuous (every frame re-walks
// anyway, so it can't discriminate); with the dirty-check gate cut instead
// (canSkipTilePointRepack forced false, per the unit-level fail-before in
// tile-point-dirty-check.test.ts) the static-camera pixels stay correct but
// createBuffer keeps climbing — this spec's job is the FIDELITY invariant
// (byte-identical pixels), not the buffer-count invariant (that's the vitest
// gate's job).

type MapWin = {
  __xgisReady?: boolean
  __xgisActiveBackend?: string
  __xgisMap?: {
    invalidate?: () => void
    setCenter?: (lon: number, lat: number) => void
    getCenter?: () => [number, number]
    getMissingTileCount?: () => number
    ctx?: { rhi?: { backend?: string; gl?: WebGL2RenderingContext } }
  }
}

const invalidate = (page: Page) =>
  page.evaluate(() => (window as unknown as MapWin).__xgisMap?.invalidate?.())

const setCenter = (page: Page, lon: number, lat: number) =>
  page.evaluate(
    ([lon, lat]) => (window as unknown as MapWin).__xgisMap?.setCenter?.(lon, lat),
    [lon, lat],
  )

// Direct GL readback (no big buffer over the CDP bridge for the hash — only a
// content hash and a non-background pixel count cross).
const readFrame = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as MapWin
    const gl = w.__xgisMap?.ctx?.rhi?.gl
    if (!gl) return { ok: false as const }
    const W = gl.drawingBufferWidth
    const H = gl.drawingBufferHeight
    const buf = new Uint8Array(W * H * 4)
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
    // FNV-1a over the full RGBA buffer — cheap, deterministic, and any single
    // pixel drift (a stale tile, a half-updated buffer) flips it.
    let h = 0x811c9dc5
    for (let i = 0; i < buf.length; i++) {
      h ^= buf[i]
      h = Math.imul(h, 0x01000193)
    }
    let nonBg = 0
    for (let p = 0; p < W * H; p++) {
      const i = p * 4
      if (buf[i] !== 0 || buf[i + 1] !== 0 || buf[i + 2] !== 0) nonBg++
    }
    return { ok: true as const, hash: h >>> 0, nonBg, total: W * H, backend: gl ? 'webgl2' : '' }
  })

type Frame = Awaited<ReturnType<typeof readFrame>>

/** #1620 — wait for the scene to CONVERGE, instead of sleeping a guessed duration.
 *
 *  Every wait in this spec used to be a fixed `waitForTimeout`, and all of this
 *  gate's observed flake modes were that one defect wearing different hats: a tile
 *  landing after the sleep read as `nonBg === 0` (settle), as hash drift across the
 *  static-camera loop, or as a post-`setCenter` frame that had not finished
 *  re-selecting. None of them were product bugs; the spec was asserting on a scene
 *  it had not waited for.
 *
 *  Convergence is TWO conditions, and both are load-bearing:
 *
 *   1. `getMissingTileCount() === 0` — the map's own "nothing is still resolving"
 *      signal, documented at `map.ts:1617-1624` as settling to 0 exactly when the
 *      scene converges.
 *   2. the same frame hash on three consecutive reads.
 *
 *  Neither alone is enough: a hash-only predicate accepts the plateau where tiles
 *  are still in flight but nothing has landed *yet*, so the frame is momentarily
 *  stable without being finished.
 *
 *  Bounded by a deadline so a genuinely stuck frame still fails (loudly, on the
 *  caller's own assertion) rather than hanging. Modeled on
 *  `_graticule-gl2-gate.spec.ts`'s `fillFraction` deadline loop.
 *
 *  This does NOT weaken anything: the invariants below are untouched, and the
 *  static-camera hash-equality assertion stays exactly as strict. Removing the
 *  still-loading confound is what lets that assertion mean what it claims. */
async function settleFrame(
  page: Page,
  opts: { requireContent?: boolean; timeoutMs?: number } = {},
): Promise<Frame> {
  const { requireContent = false, timeoutMs = 60_000 } = opts
  const deadline = Date.now() + timeoutMs
  let prev = await readFrame(page)
  let stable = 0
  while (Date.now() < deadline) {
    await invalidate(page)
    await page.waitForTimeout(100)
    const cur = await readFrame(page)
    const inFlight = await page.evaluate(
      () => (window as unknown as MapWin).__xgisMap?.getMissingTileCount?.() ?? 0,
    )
    const contentOk = !requireContent || (cur.ok && cur.nonBg > 0)
    if (inFlight === 0 && cur.ok && prev.ok && cur.hash === prev.hash && contentOk) {
      // Two confirmations after the first match — three identical reads in a row.
      if (++stable >= 2) return cur
    } else {
      stable = 0
    }
    prev = cur
  }
  return prev
}

test('static-camera memo (#1581): identical pixels across static frames, real change on camera move, converges back', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))

  await page.setViewportSize({ width: 600, height: 600 })
  // `adaptive=0` (#1620) — this gate compares a frame captured BEFORE its 20-frame
  // static loop against one captured after, and that loop invalidates every 30ms.
  // On a software rasterizer that reads as a struggling machine, so the adaptive
  // quality ladder does exactly its job and drops a notch: the scene target shrinks
  // and is upscaled, which makes the point cover ~38% more pixels (21,020 → 29,053,
  // linear ~1.18 — the shape of a sceneScale step, measured). The two frames are
  // then at different quality notches and the hash comparison is meaningless.
  // Pinning the ladder is what its sibling `_prefetch-effect-gl2-probe` already
  // does, and the ladder has its own gate (`_adaptive-quality-ladder-gate`) — this
  // one is about the #1581 memo's fidelity, so the notch must be held still.
  await page.goto('/demo.html?id=fixture_point&forcegl2=1&preserve=1&adaptive=0', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(() => (window as unknown as MapWin).__xgisReady === true, {
    timeout: 30_000,
  })
  expect(
    await page.evaluate(() => (window as unknown as MapWin).__xgisMap?.ctx?.rhi?.backend),
  ).toBe('webgl2')

  // Settle the initial tile load before the static-camera invariant starts —
  // otherwise a still-loading tile looks like drift. Waits for convergence
  // (#1620) rather than a fixed 5x300ms, which is what made `nonBg === 0` a
  // recurring flake here rather than the real signal it reads as.
  const settled = await settleFrame(page, { requireContent: true })
  expect(settled.ok).toBe(true)
  if (!settled.ok) return
  expect(settled.nonBg, 'the point fixture drew something').toBeGreaterThan(0)

  // §5 — persist the settled frame so the DC=0 hash-equality verdict above can
  // be image-inspected at full resolution (a scalar hash is a tripwire, not a
  // verdict): a 4x4 split, worst-tile-first, catches a shifted/half-rendered
  // dot a downscaled glance would hide.
  await page
    .locator('#xg-canv, canvas')
    .first()
    .screenshot({ path: testInfo.outputPath('settled.png') })

  // Static camera, N more rendered frames: leg A's memo must not re-walk the
  // selection differently, and leg B's dirty-check must reuse the SAME packed
  // buffers — so the pixels must stay byte-identical (hash equal).
  for (let i = 0; i < 20; i++) {
    await invalidate(page)
    await page.waitForTimeout(30)
  }
  const stillStatic = await readFrame(page)
  expect(stillStatic.ok).toBe(true)
  if (!stillStatic.ok || !settled.ok) return
  expect(stillStatic.hash, 'static camera: pixels unchanged after 20 more frames').toBe(
    settled.hash,
  )

  // CONTROL — a real camera move must still re-select/re-pack (the opposite
  // bug: a memo that never invalidates would leave the OLD frame on screen).
  await setCenter(page, 5, 5)
  const moved = await settleFrame(page, { requireContent: true })
  expect(moved.ok).toBe(true)
  if (!moved.ok) return
  expect(moved.hash, 'camera move: pixels must change').not.toBe(settled.hash)

  // Return to the original camera: must converge back to the SAME pixels —
  // proving re-selection at a revisited camera state is correct, not partial.
  // "Converge" is now waited for rather than assumed after 300ms (#1620) — the
  // assertion is unchanged, but a slow re-select no longer reads as a wrong frame.
  await setCenter(page, 0, 0)
  const back = await settleFrame(page, { requireContent: true })
  expect(back.ok).toBe(true)
  if (!back.ok) return
  expect(back.hash, 'camera returned to origin: pixels match the original frame').toBe(settled.hash)

  expect(errors, 'no page errors').toEqual([])
})
