// ═══ D5 INC-3 (#2539) — the ground surface actually moves ═══
//
// THE VACUITY THIS EXISTS TO KILL, named by #2268 and hit for real by #2525: a
// terrain gate passes if the displacement works AND if it silently does nothing.
// The four hillshade gates all draw at exaggeration 0, where the vertex is
// bit-identical to the pre-terrain one by construction — so every one of them is
// green whether or not `dem_height` ever reaches a vertex. They prove terrain-OFF
// is inert. NOTHING proved terrain-ON does anything until this file.
//
// WHAT IS MEASURED, and why not the obvious things. A pixel COUNT passes on a
// broken image (§12), and a silhouette row does not move here because the
// hillshade sheet covers the frame edge to edge, so its topmost lit row is the
// viewport, not the terrain. What DOES carry the signal is the DIRECTIONAL diff
// §5 prescribes: the fraction of pixels that differ from the SAME scene at
// exaggeration 0 (DC), read as a LADDER. A displacement that reaches the vertex
// makes DC grow with exaggeration; a dead `dem_height` pins every rung at 0.
//
// ORDER IS LOAD-BEARING (§12, #1444): the lever is asserted BEFORE the pixels. A
// dead setter and a live setter feeding a dead shader produce the same DC of 0, so
// if the pixel assertion ran first a severed shader would be reported as a broken
// setter. `terrainExaggeration()` is read back from the renderer for exactly this.
//
// Pitched on purpose. At pitch 0 a vertical displacement is nearly parallel to the
// view direction and moves a pixel only through perspective, which on a 2 km hill
// is sub-pixel; at 60° it swings across the screen. The gate would still be
// CORRECT at pitch 0 and would have almost no signal to measure.
//
// THE NOISE FLOOR IS MEASURED, NOT ASSUMED, and the first draft of this file is why.
// It settled arms with `waitForTimeout` (which §5 forbids for exactly this reason) and
// the cut-check then reported DC 56.7% with the displacement SEVERED — the scene was
// still converging between arms, so more than half the frame differed for reasons that
// had nothing to do with terrain. A `> 0.1%` threshold over that is a coin toss. Arms
// now settle with `awaitMapIdle`, and a SECOND exaggeration-0 arm is captured last as
// the control: its DC against the first is the floor every terrain rung must clear.
//
// WebGL2 (`?forcegl2=1`) for the readback the sibling hillshade gates already use.

import { test, expect } from '@playwright/test'
import { awaitMapIdle } from './helpers/visual'

interface TerrainWindow {
  __xgisActiveBackend?: string
  __xgisMap?: {
    setPitch?: (p: number) => void
    invalidate?: () => void
    hillshadeRenderer?: {
      setTerrainExaggeration?: (e: number) => void
      terrainExaggeration?: () => number
    }
    ctx?: { rhi?: { backend?: string; gl?: WebGL2RenderingContext } }
  }
}

test('terrain exaggeration displaces the hillshade surface, and 0 leaves it flat (#2539)', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push(m.text().slice(0, 300))
  })

  await page.goto('/demo.html?id=fixture_hillshade_local&forcegl2=1&e2e=1&adaptive=0', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 30_000 },
  )

  // `?adaptive=0` above pins the quality controller: it samples WALL-CLOCK frame
  // intervals and feeds the tile selector, so on a slow SwiftShader run the arms
  // below could otherwise be comparing DIFFERENT TILE SETS and calling it terrain
  // (#2120). The pitch is set once, before any arm is captured, for the same reason
  // — every arm must differ in exactly one thing.
  await page.evaluate(() => {
    ;(window as unknown as TerrainWindow).__xgisMap?.setPitch?.(60)
  })

  /** Read the forced-WebGL2 frame back as raw RGBA. */
  const grab = () =>
    page.evaluate(() => {
      const w = window as unknown as TerrainWindow
      const gl = w.__xgisMap?.ctx?.rhi?.gl
      if (!gl) return { ok: false as const }
      const W = gl.drawingBufferWidth
      const H = gl.drawingBufferHeight
      const buf = new Uint8Array(W * H * 4)
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
      let lit = 0
      for (let p = 0; p < W * H; p++) if (buf[p * 4 + 3] !== 0) lit++
      return {
        ok: true as const,
        backend: w.__xgisMap?.ctx?.rhi?.backend,
        marker: w.__xgisActiveBackend,
        glError: gl.getError(),
        w: W,
        h: H,
        lit,
        px: Array.from(buf),
      }
    })

  /** Set the exaggeration, settle the frame, read it back. Also returns what the
   *  RENDERER says the exaggeration is — the lever, read at its destination. */
  const arm = async (exaggeration: number) => {
    const got = await page.evaluate((e: number) => {
      const hs = (window as unknown as TerrainWindow).__xgisMap?.hillshadeRenderer
      hs?.setTerrainExaggeration?.(e)
      ;(window as unknown as TerrainWindow).__xgisMap?.invalidate?.()
      return hs?.terrainExaggeration?.()
    }, exaggeration)
    // Settle on the map's OWN idle signal, never a sleep: a fixed wait either
    // under-settles (and the fade-in / tile arrival lands in the measured pixels) or
    // wastes wall clock, and under SwiftShader it is the former.
    const settled = await awaitMapIdle(page, 60_000)
    return { reported: got, settled, frame: await grab() }
  }

  // Arm 0 is the reference: the pre-terrain surface, and the frame every DC below
  // is measured against.
  const a0 = await arm(0)
  expect(a0.settled, 'the reference frame reached idle').toBe('idle')
  expect(a0.frame.ok, 'forced-WebGL2 context present').toBe(true)
  if (!a0.frame.ok) return
  expect(a0.frame.marker, 'window.__xgisActiveBackend').toBe('webgl2')
  expect(a0.frame.backend, 'host.ctx.rhi.backend').toBe('webgl2')
  expect(a0.frame.glError, 'no gl error').toBe(0)
  // A frame that drew nothing would make every DC below 0 for a reason that has
  // nothing to do with terrain (#1625: prove the population).
  expect(a0.frame.lit, 'the reference frame drew the DEM sheet').toBeGreaterThan(
    a0.frame.w * a0.frame.h * 0.05,
  )

  /** Fraction of pixels differing from arm 0, on any channel by more than a
   *  quantisation step. This is §5's DC, per arm. */
  const dcAgainstRef = (px: number[]): number => {
    const ref = a0.frame.ok ? a0.frame.px : []
    let n = 0
    for (let i = 0; i < px.length; i += 4)
      if (
        Math.abs(px[i] - ref[i]) > 2 ||
        Math.abs(px[i + 1] - ref[i + 1]) > 2 ||
        Math.abs(px[i + 2] - ref[i + 2]) > 2 ||
        Math.abs(px[i + 3] - ref[i + 3]) > 2
      )
        n++
    return n / (px.length / 4)
  }

  const a1 = await arm(1)
  const a8 = await arm(8)
  // THE CONTROL, and the gate is worthless without it: the same state as arm 0,
  // captured after everything the other arms did. Its DC is the harness's own noise
  // — convergence, fade, any residual non-determinism — and it is what the terrain
  // rungs are measured against rather than against 0.
  const aCtl = await arm(0)
  expect(a1.frame.ok && a8.frame.ok && aCtl.frame.ok, 'every arm read back').toBe(true)
  if (!a1.frame.ok || !a8.frame.ok || !aCtl.frame.ok) return

  // ── THE CAUSE, asserted first ──
  expect(a0.reported, 'exaggeration 0 reached the renderer').toBe(0)
  expect(a1.reported, 'exaggeration 1 reached the renderer').toBe(1)
  expect(a8.reported, 'exaggeration 8 reached the renderer').toBe(8)

  // ── THE EFFECT ──
  const dc1 = dcAgainstRef(a1.frame.px)
  const dc8 = dcAgainstRef(a8.frame.px)
  const floor = dcAgainstRef(aCtl.frame.px)

  console.log(
    `terrain DC: e=1 ${(dc1 * 100).toFixed(3)}%  e=8 ${(dc8 * 100).toFixed(3)}%  ` +
      `floor(e=0 again) ${(floor * 100).toFixed(3)}%`,
  )

  // The floor is the instrument's own reading of "nothing changed". If it is not
  // small, no terrain conclusion can be drawn from this run at all, so it is
  // asserted before anything is concluded from dc1 / dc8.
  expect(floor, 'same-state control differs — the harness is not settling').toBeLessThan(0.02)

  // A dead `dem_height` — the shader never reaching the DEM, `dem_sub.w` never
  // reaching the shader, the binding filled with the stub — collapses BOTH rungs
  // onto the floor while every other gate in the repo stays green.
  expect(dc1, 'exaggeration 1 moved the surface, beyond the harness floor').toBeGreaterThan(
    Math.max(0.02, floor * 5),
  )
  // Direction, not just difference: more exaggeration must move MORE of the frame.
  // A constant offset (say, a displacement that ignored its scalar) would give
  // dc8 === dc1 and pass a bare "it changed" assertion.
  expect(dc8, 'exaggeration 8 moved more of the frame than exaggeration 1').toBeGreaterThan(dc1)
  expect(aCtl.reported, 'the control arm returned the renderer to 0').toBe(0)

  expect(errors, 'no page/console errors').toEqual([])
})
