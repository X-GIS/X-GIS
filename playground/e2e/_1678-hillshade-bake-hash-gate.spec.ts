import { test, expect, type Page } from '@playwright/test'

// #1678 (phase A of #1484) RENDER GATE — a hillshade served from the COMMITTED shader
// bake must produce byte-identical pixels to the same scene emitted at runtime.
//
// The unit gates prove the artifact equals a live emit (`baked-sync.test.ts`) and that
// the pool answers from the seed without running the emitter (`seed-hillshade.test.ts`).
// Neither drives a pipeline. This one does: SwiftShader compiles the baked GLSL and
// rasterises it, so a source that is byte-equal in vitest and yet wrong on the way to
// `createPipeline` — the wrong permutation seeded under a key, a stage swapped, an
// empty string handed to the WebGL2 twin — shows up here and only here.
//
// RUNG 3, not a directional diff (CLAUDE.md §5's ladder). Emit is byte-deterministic
// across processes (measured, six independent runs bit-identical) and the two arms
// render the same fixture at the same camera on the same rasteriser, so the gate is
// HASH EQUALITY over the full RGBA readback — DC = 0. A tolerance here would accept
// exactly the sub-pixel drift the bake could introduce.
//
// ── The control arm and its flag ──
// `?nobake=1` (map/src/debug-flags.ts, `bakedShadersDisabled`) turns the seeding off for
// one boot. It is part of this change and exists for this gate: a comparison needs an arm
// that provably did NOT use the bake. `window.__xgisBakedShaderSeeds` publishes how many
// pool keys each boot seeded, and the gate asserts the two arms DIFFERED in it (> 0 vs 0)
// BEFORE comparing pixels — without that, two arms that both fell back to the runtime
// emit would hash-match and green a dead feature (the §12 "assertion that failed either
// way" trap).
//
// SEEDED ≠ SERVED, so the seed count is only half of it. `window.__xgisShaderEmits`
// (shader-emit-pool.ts) counts the emits the pool had to START this boot, and the two
// arms are required to differ there too: arm A must reach a converged hillshade frame
// having started ZERO emits — the frame was drawn from the artifact — and arm B must have
// started at least one. A bake that seeded keys the draper then missed (a key spelled
// under the wrong body epoch, say) would still publish seeds > 0; it could not publish
// zero emits.
//
// Both arms must also show real relief: a blank canvas equals a blank canvas.
//
// Headless SwiftShader (HEADED=0 XGIS_SOFTWARE_GPU=1) under ?forcegl2=1, so the
// backend assertion is load-bearing — a silent WebGPU boot would exercise the WGSL
// half and prove nothing about the GLSL artifact this leg targets.

type MapWin = {
  __xgisReady?: boolean
  __xgisActiveBackend?: string
  __xgisBakedShaderSeeds?: number
  __xgisShaderEmits?: number
  __xgisMap?: {
    invalidate?: () => void
    getMissingTileCount?: () => number
    ctx?: {
      rhi?: { backend?: string; gl?: WebGL2RenderingContext }
      _validationErrors?: { message: string }[]
    }
  }
}

const invalidate = (page: Page) =>
  page.evaluate(() => (window as unknown as MapWin).__xgisMap?.invalidate?.())

/** Full-frame RGBA readback → FNV-1a hash + the relief metrics. Only scalars cross the
 *  CDP bridge; the frame itself is also written to disk by the caller for the §5
 *  full-resolution read. `spread` is the dark→light luminance range that separates a
 *  real hillshade from a flat fill (the `_hillshade-gl2-gate` signature). */
const readFrame = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as MapWin
    const ctx = w.__xgisMap?.ctx
    const gl = ctx?.rhi?.gl
    if (!gl) return { ok: false as const }
    const W = gl.drawingBufferWidth
    const H = gl.drawingBufferHeight
    const buf = new Uint8Array(W * H * 4)
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
    let h = 0x811c9dc5
    for (let i = 0; i < buf.length; i++) {
      h ^= buf[i]
      h = Math.imul(h, 0x01000193)
    }
    let lit = 0
    let minL = 255
    let maxL = 0
    for (let p = 0; p < W * H; p++) {
      const i = p * 4
      if (buf[i + 3] === 0) continue
      const lum = (buf[i] * 0.299 + buf[i + 1] * 0.587 + buf[i + 2] * 0.114) | 0
      lit++
      if (lum < minL) minL = lum
      if (lum > maxL) maxL = lum
    }
    return {
      ok: true as const,
      hash: h >>> 0,
      lit,
      total: W * H,
      spread: lit ? maxL - minL : 0,
      backend: ctx?.rhi?.backend,
      marker: w.__xgisActiveBackend,
      seeds: w.__xgisBakedShaderSeeds,
      emits: w.__xgisShaderEmits ?? 0,
      validation: (ctx?._validationErrors ?? []).map((e) => e.message).slice(0, 5),
      glError: gl.getError(),
    }
  })

type Frame = Awaited<ReturnType<typeof readFrame>>

/** Wait for CONVERGENCE, not a guessed duration (#1620): no tiles still resolving AND
 *  three consecutive identical frame hashes. A hash-only predicate accepts the plateau
 *  where a DEM tile is in flight but has not landed yet, which is exactly how a
 *  cross-arm hash comparison turns into flake. */
async function settle(page: Page, timeoutMs = 90_000): Promise<Frame> {
  const deadline = Date.now() + timeoutMs
  let prev = await readFrame(page)
  let stable = 0
  while (Date.now() < deadline) {
    await invalidate(page)
    await page.waitForTimeout(150)
    const cur = await readFrame(page)
    const inFlight = await page.evaluate(
      () => (window as unknown as MapWin).__xgisMap?.getMissingTileCount?.() ?? 0,
    )
    const hasRelief = cur.ok && cur.lit > cur.total * 0.05 && cur.spread >= 24
    if (inFlight === 0 && cur.ok && prev.ok && cur.hash === prev.hash && hasRelief) {
      if (++stable >= 2) return cur
    } else {
      stable = 0
    }
    prev = cur
  }
  return prev
}

/** Boot one arm and return its settled frame. `errors` accumulates page/console noise,
 *  which is asserted empty per arm — a shader that failed to compile shows up there
 *  first, before it shows up as a pixel. */
async function renderArm(page: Page, query: string, errors: string[]): Promise<Frame> {
  errors.length = 0
  await page.goto(`/demo.html?id=fixture_hillshade_local&forcegl2=1&e2e=1&adaptive=0${query}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(() => (window as unknown as MapWin).__xgisReady === true, {
    timeout: 30_000,
  })
  return settle(page)
}

test('#1678 — a hillshade served from the shader bake is pixel-identical to one emitted at runtime (?forcegl2=1)', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push(m.text().slice(0, 300))
  })

  // A fixed viewport so both arms rasterise the same drawing buffer; `adaptive=0` pins
  // the quality ladder, which would otherwise be free to pick a different scene scale
  // per arm on a struggling software rasteriser and make the hash comparison meaningless
  // (the `_1581-static-camera-render-gate` lesson).
  await page.setViewportSize({ width: 600, height: 600 })

  // ── Arm A: the bake serves ──
  const baked = await renderArm(page, '', errors)
  expect(baked.ok, 'arm A: forced-WebGL2 context present').toBe(true)
  if (!baked.ok) return
  expect(baked.marker, 'arm A: window.__xgisActiveBackend').toBe('webgl2')
  expect(baked.backend, 'arm A: host.ctx.rhi.backend').toBe('webgl2')
  expect(
    baked.seeds ?? 0,
    'arm A must actually have been served from the bake — otherwise the comparison below ' +
      'is between two runtime emits and proves nothing about the artifact',
  ).toBeGreaterThan(0)
  expect(
    baked.emits,
    'arm A drew a converged hillshade having started ZERO shader emits — if this is > 0 the ' +
      'pool was seeded and the draper still asked for an emit, which means the bake was read ' +
      'but never SERVED',
  ).toBe(0)
  expect(
    baked.spread,
    'arm A: real relief, not a flat fill or a blank frame',
  ).toBeGreaterThanOrEqual(24)
  expect(baked.glError, 'arm A: no gl error').toBe(0)
  expect(baked.validation, 'arm A: no validation errors').toEqual([])
  expect(errors, 'arm A: no page/console errors').toEqual([])
  // §5 — the frames are persisted so the DC = 0 verdict can be image-read at full
  // resolution in a 4×4 split; a scalar hash is a tripwire, not a verdict.
  await page
    .locator('#xg-canv, canvas')
    .first()
    .screenshot({ path: testInfo.outputPath('baked.png') })

  // ── Arm B (CONTROL): ?nobake=1, the same scene emitted at runtime ──
  const emitted = await renderArm(page, '&nobake=1', errors)
  expect(emitted.ok, 'arm B: forced-WebGL2 context present').toBe(true)
  if (!emitted.ok) return
  expect(emitted.backend, 'arm B: host.ctx.rhi.backend').toBe('webgl2')
  expect(
    emitted.seeds ?? -1,
    '?nobake=1 must really have disabled the seeding — a control arm that also used the ' +
      'bake would make the hash equality below vacuous',
  ).toBe(0)
  expect(
    emitted.emits,
    'arm B must really have paid a runtime emit — an emit counter that stays 0 in BOTH arms ' +
      'is dead, and arm A‘s zero would then mean nothing',
  ).toBeGreaterThan(0)
  expect(
    emitted.spread,
    'arm B: real relief, not a flat fill or a blank frame',
  ).toBeGreaterThanOrEqual(24)
  expect(emitted.glError, 'arm B: no gl error').toBe(0)
  expect(emitted.validation, 'arm B: no validation errors').toEqual([])
  expect(errors, 'arm B: no page/console errors').toEqual([])
  await page
    .locator('#xg-canv, canvas')
    .first()
    .screenshot({ path: testInfo.outputPath('emitted.png') })

  // ── The verdict: DC = 0 ──
  expect(
    emitted.lit,
    'both arms must have drawn the same amount of relief (a coverage change would move the hash for the wrong reason)',
  ).toBe(baked.lit)
  expect(
    emitted.hash,
    'the baked shader must rasterise BYTE-IDENTICALLY to the runtime emit — a differing ' +
      'hash means the artifact and the emitter disagree somewhere between the string and ' +
      'the pipeline (wrong permutation under a key, swapped stage, empty GLSL twin)',
  ).toBe(baked.hash)
})
