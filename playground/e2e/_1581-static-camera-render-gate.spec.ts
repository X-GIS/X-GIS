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

test('static-camera memo (#1581): identical pixels across static frames, real change on camera move, converges back', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))

  await page.setViewportSize({ width: 600, height: 600 })
  await page.goto('/demo.html?id=fixture_point&forcegl2=1&preserve=1', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(() => (window as unknown as MapWin).__xgisReady === true, {
    timeout: 30_000,
  })
  expect(
    await page.evaluate(() => (window as unknown as MapWin).__xgisMap?.ctx?.rhi?.backend),
  ).toBe('webgl2')

  // Settle the initial tile load (a few frames) before the static-camera
  // invariant starts — otherwise a still-loading tile would look like drift.
  for (let i = 0; i < 5; i++) {
    await invalidate(page)
    await page.waitForTimeout(300)
  }
  const settled = await readFrame(page)
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
  await invalidate(page)
  await page.waitForTimeout(300)
  const moved = await readFrame(page)
  expect(moved.ok).toBe(true)
  if (!moved.ok) return
  expect(moved.hash, 'camera move: pixels must change').not.toBe(settled.hash)

  // Return to the original camera: must converge back to the SAME pixels —
  // proving re-selection at a revisited camera state is correct, not partial.
  await setCenter(page, 0, 0)
  await invalidate(page)
  await page.waitForTimeout(300)
  const back = await readFrame(page)
  expect(back.ok).toBe(true)
  if (!back.ok) return
  expect(back.hash, 'camera returned to origin: pixels match the original frame').toBe(settled.hash)

  expect(errors, 'no page errors').toEqual([])
})
