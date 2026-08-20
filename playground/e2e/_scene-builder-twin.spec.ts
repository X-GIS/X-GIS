// ═══ SceneBuilder runScene ↔ run() twin-render gate (#1194 A1b) ═══
//
// The A1a parity gate proves builder AST ≡ parsed AST byte-for-byte at the
// compiler level; this gate proves the RUNTIME half: a page mounted via
// `map.runScene(twin)` (`?runscene=1`, compiler twin-corpus) renders
// PIXEL-IDENTICAL to the same demo mounted via `map.run(xgisText)`. Two CLEAN
// first-mount page loads — deliberately NOT a live swap: run()→run() itself
// is not pixel-stable across swaps under forcegl2 (a pre-existing VTR
// re-upload "vertex compile failed" drop on the first swap — tracked
// separately; a control probe pinned it with zero runScene involvement).
// Offline geojson (minimal) so SwiftShader rasters deterministically; with
// identical camera + data + code, the ONLY variable is the entry path.
//
// ── #1895: this gate used to be a coin flip, and the cause was a fixed sleep ──
//
// Both arms used to screenshot after a fixed 25 × 80 ms invalidate pump, i.e.
// 2.0 s, and the threshold below was calibrated on a claimed "~78 px same-code
// floor". Neither held. Measured under SwiftShader on unmodified `main`:
//
//     pumps=25   run vs runScene ->  48749 / 619200   (7.9% of the frame)
//     pumps=100  run vs runScene ->      0 / 619200   (byte-identical)
//
// The two paths do not disagree; they CONVERGE AT DIFFERENT TIMES, and 2.0 s
// screenshots them mid-flight. Two frames captured from `run()` in different
// invocations compare 0 against each other, so neither arm is noisy — the
// outcome was simply which side of convergence each load happened to be on.
// That made the gate bimodal (0 or ~48 700, nothing in between), so a 309.6 px
// threshold adjudicated nothing: it went red on #1887 and green on #1892, a
// strict SUPERSET of #1887's diff, in the same hour.
//
// The cameras were never the difference — probed identical on both paths
// (`center [0, -1.0135431476587295]`, `zoom 0.5`, canvas 860×720, dpr 1).
//
// The fix is the one #1620 already established for `_1581-static-camera-render-
// gate`, whose flake modes were this same defect wearing different hats: wait
// for the scene to CONVERGE instead of sleeping a guessed duration. Both halves
// of that predicate are load-bearing — `getMissingTileCount() === 0` (the map's
// own "nothing is still resolving" signal, `map.ts:1737`) AND three identical
// consecutive frame hashes, because a hash-only predicate accepts the plateau
// where tiles are in flight but nothing has landed yet.
//
// Each half of that predicate is load-bearing, and cutting either one reds this
// spec on the SAME assertion — `the run() arm drew something`, nonBg 0: ignoring
// `getMissingTileCount`, or accepting the first hash match instead of three,
// both return the opening plateau where the canvas is still blank. Restoring the
// old fixed 25-pump reds it the other way, at 48 749 px.
//
// The threshold is deliberately LEFT AS IT WAS. With convergence the measured
// same-code floor is 0 — three consecutive runs, exactly 0/619200 each — which
// puts hash equality (§12 rung 3) within reach. But that floor is measured HERE,
// not on CI, and tightening a gate onto an environment you have not measured is
// precisely how the 78 px claim above came to exist. Promote it once CI has
// reported the converged floor for a few runs.

import { test, expect, type Page } from '@playwright/test'
import { PNG } from 'pngjs'

type MapWin = {
  __xgisReady?: boolean
  __xgisMap?: {
    invalidate?: () => void
    getMissingTileCount?: () => number
    ctx?: { rhi?: { gl?: WebGL2RenderingContext } }
  }
}

/** A content hash of the drawing buffer + a non-background pixel count, read
 *  straight from GL so only two numbers cross the CDP bridge. */
const readFrame = (page: Page) =>
  page.evaluate(() => {
    const gl = (window as unknown as MapWin).__xgisMap?.ctx?.rhi?.gl
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
    let nonBg = 0
    for (let p = 0; p < W * H; p++) {
      const i = p * 4
      if (buf[i] !== 0 || buf[i + 1] !== 0 || buf[i + 2] !== 0) nonBg++
    }
    return { ok: true as const, hash: h >>> 0, nonBg }
  })

/** Pump until the scene converges: no tile still resolving AND three identical
 *  frame hashes in a row. Bounded by a deadline so a genuinely stuck frame fails
 *  on the caller's own assertion instead of hanging. */
async function settle(page: Page, timeoutMs = 60_000): Promise<{ hash: number; nonBg: number }> {
  const deadline = Date.now() + timeoutMs
  let prev = await readFrame(page)
  let stable = 0
  while (Date.now() < deadline) {
    await page.evaluate(() => (window as unknown as MapWin).__xgisMap?.invalidate?.())
    await page.waitForTimeout(80)
    const cur = await readFrame(page)
    const inFlight = await page.evaluate(
      () => (window as unknown as MapWin).__xgisMap?.getMissingTileCount?.() ?? 0,
    )
    if (inFlight === 0 && cur.ok && prev.ok && cur.hash === prev.hash) {
      if (++stable >= 2) return { hash: cur.hash, nonBg: cur.nonBg }
    } else {
      stable = 0
    }
    prev = cur
  }
  return prev.ok ? { hash: prev.hash, nonBg: prev.nonBg } : { hash: 0, nonBg: 0 }
}

async function loadAndShoot(page: Page, extra: string): Promise<{ png: PNG; nonBg: number }> {
  await page.goto(`/demo.html?id=minimal&e2e=1&forcegl2=1${extra}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(() => (window as unknown as MapWin).__xgisReady === true, {
    timeout: 30_000,
  })
  const { nonBg } = await settle(page)
  return { png: PNG.sync.read(await page.locator('#xg-canv, canvas').first().screenshot()), nonBg }
}

test('runScene first-mount renders pixel-identical to its run() twin', async ({ page }) => {
  test.setTimeout(150_000)
  const a = await loadAndShoot(page, '') // DSL path: demo-runner → map.run(text)
  const b = await loadAndShoot(page, '&runscene=1') // builder path: → map.runScene(twin)

  // Two BLANK frames compare equal, so the comparison below would pass having
  // proven nothing. Both arms must have drawn.
  expect(a.nonBg, 'the run() arm drew something').toBeGreaterThan(0)
  expect(b.nonBg, 'the runScene() arm drew something').toBeGreaterThan(0)

  expect(b.png.width).toBe(a.png.width)
  expect(b.png.height).toBe(a.png.height)
  let diff = 0
  for (let i = 0; i < a.png.data.length; i += 4) {
    if (
      a.png.data[i] !== b.png.data[i] ||
      a.png.data[i + 1] !== b.png.data[i + 1] ||
      a.png.data[i + 2] !== b.png.data[i + 2]
    )
      diff++
  }
  const total = a.png.width * a.png.height
  console.log(`[scene-builder-twin] diffPixels=${diff}/${total}`)
  expect(
    diff,
    `run() and runScene() disagree on ${diff}/${total} px after BOTH converged ` +
      '(no tile in flight, three identical frame hashes). Under the fixed-sleep ' +
      'harness this number was 0 or ~48 700 depending on which side of convergence ' +
      'the screenshot landed (#1895); with the settle predicate in place a non-zero ' +
      'value here is a real twin divergence, not a timing artifact.',
  ).toBeLessThan(total * 0.0005)
})
