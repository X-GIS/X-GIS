// ═══ Globe atmosphere / limb-glow render gate (#1258) ═══
//
// #1258's Phase 1: a screen-space limb-glow gradient banded around the globe's projected
// silhouette, drawn by its own pass (`atmosphere-pass.ts`) immediately after the background
// clear — behind the earth surface, in front of deep space. `XGISMap.setAtmosphere` is the
// off-by-default style flag (`null` → the frame is byte-identical to pre-#1258); this gate
// proves the ON state actually paints a glow ring just outside the disc, and that deep space
// well past the disc stays undisturbed.
//
// FIXTURE: `fixture_bg_pattern` — the SAME fixture `_bg-pattern-globe-gate.spec.ts` (#1128)
// already proved fills the WHOLE globe disc with a red/blue checker on `proj=globe`, so the
// disc's screen extent can be measured from the checker's own pixel bounds (self-referential,
// no absolute pixel constants — CLAUDE.md §5) rather than guessed from camera math. The
// checker's colours (red/blue) and the glow's colour (orange, chosen below) are mutually
// exclusive, so the two layers cannot be confused in the pixel scan.
//
// BEFORE/AFTER ON ONE BOOT (CLAUDE.md §5's directional-diff spirit, applied in-page): capture
// the settled frame with the atmosphere OFF (the default), call `setAtmosphere(...)`, capture
// again — the glow band must be EMPTY before and non-empty after (DC>0: proves the new pass
// painted something), and deep space in the canvas corner must stay near-black in BOTH frames
// (the glow is a THIN rim, not a wash over the whole background).
//
// Backend-parameterized (both WebGPU — the default — and WebGL2 via `?forcegl2=1`), asserted
// via `window.__xgisActiveBackend` next to the pixel work so a silent fallback cannot green
// this (CLAUDE.md §5's "assert the backend in the spec" rule; sibling idiom, e.g.
// `_symbol-anchor-inline-gate.spec.ts` / `_1581-static-camera-render-gate.spec.ts`).
//
// AUTHORED, NOT RUN: this environment's headless SwiftShader path is the ORCHESTRATOR's
// verification step (CLAUDE.md §5) for this change — this spec has not been executed here.
// Thresholds are deliberately generous (existence + direction, not exact counts) so a
// first real run is expected to pass without recalibration; if it does not, tune the pixel
// predicates / sample window against a persisted screenshot (this spec saves one), not the
// underlying assertions.

import { test, expect, type Page } from '@playwright/test'
import { PNG } from 'pngjs'

type MapWin = {
  __xgisReady?: boolean
  __xgisActiveBackend?: string
  __xgisMap?: {
    invalidate?: () => void
    setAtmosphere?: (
      a: {
        innerColor?: [number, number, number, number]
        outerColor?: [number, number, number, number]
      } | null,
    ) => void
  }
}

async function pump(page: Page, frames = 25): Promise<void> {
  for (let i = 0; i < frames; i++) {
    await page.evaluate(() => (window as unknown as MapWin).__xgisMap?.invalidate?.())
    await page.waitForTimeout(80)
  }
}

async function screenshotPng(page: Page): Promise<PNG> {
  return PNG.sync.read(await page.locator('#xg-canv, canvas').first().screenshot())
}

const isCheckerRed = (r: number, g: number, b: number) => r > 150 && g < 100 && b < 100
const isCheckerBlue = (r: number, b: number) => b > 150 && r < 100
// The glow's inner colour (set below) is a saturated orange — far from both checker colours
// and from black, so a tolerant "dominant warm channel" predicate cannot collide with either.
const isGlow = (r: number, g: number, b: number) => r > 170 && g > 60 && g < 210 && b < 100
const isNearBlack = (r: number, g: number, b: number) => r < 14 && g < 14 && b < 14

/** The checker disc's horizontal extent on ONE row — self-referential geometry (CLAUDE.md
 *  §5), not an assumed camera-to-pixel projection. Scans the row at `y` for the min/max x
 *  where a checker pixel appears; `null` if the row misses the disc entirely (camera/zoom
 *  drift — the caller must not silently treat that as "no glow either"). */
function checkerRowExtent(png: PNG, y: number): { xMin: number; xMax: number } | null {
  let xMin = -1
  let xMax = -1
  for (let x = 0; x < png.width; x++) {
    const i = (y * png.width + x) * 4
    const r = png.data[i]!,
      g = png.data[i + 1]!,
      b = png.data[i + 2]!
    if (isCheckerRed(r, g, b) || isCheckerBlue(r, b)) {
      if (xMin === -1) xMin = x
      xMax = x
    }
  }
  return xMin === -1 ? null : { xMin, xMax }
}

/** Count glow-coloured pixels in `[x0, x1)` on row `y`. */
function countGlowOnRow(png: PNG, y: number, x0: number, x1: number): number {
  let n = 0
  for (let x = Math.max(0, x0); x < Math.min(png.width, x1); x++) {
    const i = (y * png.width + x) * 4
    const r = png.data[i]!,
      g = png.data[i + 1]!,
      b = png.data[i + 2]!
    if (isGlow(r, g, b)) n++
  }
  return n
}

async function runGate(page: Page, forcegl2: boolean): Promise<void> {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))

  await page.goto(
    `/demo.html?id=fixture_bg_pattern&e2e=1&sprite=/fixture-sprite&proj=globe${
      forcegl2 ? '&forcegl2=1' : ''
    }#1.8/10/20`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(() => (window as unknown as MapWin).__xgisReady === true, {
    timeout: 30_000,
  })
  // Backend PIN, asserted next to the pixel work (CLAUDE.md §5) — a silent fallback must not
  // be able to green either leg.
  expect(await page.evaluate(() => (window as unknown as MapWin).__xgisActiveBackend)).toBe(
    forcegl2 ? 'webgl2' : 'webgpu',
  )

  await pump(page)
  const before = await screenshotPng(page)

  const disc = checkerRowExtent(before, Math.floor(before.height / 2))
  expect(
    disc,
    'the checker disc did not paint on the centre row — camera/zoom/fixture drift, not an ' +
      'atmosphere regression (this is the SAME precondition `_bg-pattern-globe-gate.spec.ts` ' +
      'depends on)',
  ).not.toBeNull()
  if (!disc) return
  const y = Math.floor(before.height / 2)
  // Just past the measured right edge of the disc — the glow band starts exactly at the
  // silhouette and falls off outward (atmosphere.ts's own header), so a window anchored ON
  // the measured edge is the correct place to look, not a fixed offset guessed from camera
  // math. 24px is generous slack for the falloff band at any zoom this fixture might settle
  // at, and stays well short of the canvas edge for the `#1.8/10/20` framing.
  const bandX0 = disc.xMax
  const bandX1 = disc.xMax + 24

  // Deep space — far outside the disc, near the canvas corner. Must read empty in BOTH
  // frames: the glow is a thin rim, not a wash over the whole background.
  const cornerBefore = before.data.subarray(0, 3)
  expect(
    isNearBlack(cornerBefore[0]!, cornerBefore[1]!, cornerBefore[2]!),
    `canvas corner is not near-black before enabling the atmosphere (rgb=${[...cornerBefore]}) ` +
      '— the fixture/camera precondition is wrong, not the fix',
  ).toBe(true)

  const beforeGlow = countGlowOnRow(before, y, bandX0, bandX1)
  expect(
    beforeGlow,
    `glow-coloured pixels present BEFORE setAtmosphere was ever called (n=${beforeGlow}) — the ` +
      'default must be OFF (byte-identical to pre-#1258)',
  ).toBe(0)

  // ON: a saturated orange the checker (red/blue) and deep space (black) cannot produce.
  await page.evaluate(() => {
    ;(window as unknown as MapWin).__xgisMap?.setAtmosphere?.({
      innerColor: [1, 0.55, 0, 0.95],
      outerColor: [0.05, 0.02, 0.1, 0],
    })
  })
  await pump(page)
  const after = await screenshotPng(page)

  const cornerAfter = after.data.subarray(0, 3)
  expect(
    isNearBlack(cornerAfter[0]!, cornerAfter[1]!, cornerAfter[2]!),
    `canvas corner is no longer near-black with the atmosphere on (rgb=${[...cornerAfter]}) — ` +
      'the glow is washing over deep space instead of staying a thin rim',
  ).toBe(true)

  const afterGlow = countGlowOnRow(after, y, bandX0, bandX1)
  console.log(
    `[atmosphere-globe] backend=${forcegl2 ? 'webgl2' : 'webgpu'} disc=[${disc.xMin},${disc.xMax}] ` +
      `band=[${bandX0},${bandX1}) beforeGlow=${beforeGlow} afterGlow=${afterGlow}`,
  )
  // THE #1258 CLAIM: enabling the atmosphere paints glow-coloured pixels just outside the
  // disc's own measured edge, where none existed a moment ago on the identical camera.
  expect(
    afterGlow,
    `no glow-coloured pixels appeared just outside the disc edge after setAtmosphere ` +
      `(band=[${bandX0},${bandX1}), row y=${y}) — the pass did not draw, or drew somewhere ` +
      'other than the silhouette band',
  ).toBeGreaterThan(0)

  expect(errors, 'no page errors').toEqual([])
}

test.describe.configure({ timeout: 90_000 })

test.describe('globe atmosphere limb-glow (#1258)', () => {
  test('WebGPU: glow paints just outside the disc edge when enabled, off by default', async ({
    page,
  }) => {
    await runGate(page, false)
  })

  test('WebGL2 (?forcegl2=1): glow paints just outside the disc edge when enabled, off by default', async ({
    page,
  }) => {
    await runGate(page, true)
  })
})
