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
// RUN, on this environment's headless SwiftShader path, both backends (CLAUDE.md §5).
// Every threshold below is calibrated against a measured run of this exact fixture and
// camera, quoted at its predicate.
//
// ── #2052 T5 PHASE 1: THE MapLibre `sky` ROOT ─────────────────────────────────────────
//
// Phase 1 hangs the sky root's zenith-angle ramp off the SAME pass and the same fragment.
// Three claims are gated, and the second is the one that a wash would also pass, so it is
// deliberately not a pixel count:
//
//   (a) ABSENT → PRESENT. With only the #1258 glow on, NOT ONE pixel of the frame is
//       sky-coloured; with a `sky` authored, the ramp paints. (Measured on the reverted
//       pre-#2052 render path: the canvas corner reads 0,0,0 and the whole outward scan
//       stays 0,0,0 — the sky is simply absent there.)
//   (b) IT IS A RAMP, ANCHORED ON THE LIMB. The gate authors sky-colour GREEN and
//       horizon-colour MAGENTA and then changes ONLY `sky-horizon-blend`. Under a sharp
//       ramp (0.02) the canvas corner reads sky-colour and the band just past the
//       silhouette reads horizon-colour; under MapLibre's own default (0.8) the SAME
//       corner reads horizon-colour, because from orbit the visible sky spans only ~6% of
//       the limb→zenith arc. No flat wash, and no ramp keyed to the screen or to
//       `dot(ray, up)`'s zero-plane, produces both frames.
//   (c) THE PLANET IS UNTOUCHED. No sky-coloured pixel anywhere strictly inside the
//       silhouette, under either ramp — the sky REPLACES the space background above the
//       horizon and never paints over the earth (ADR-0007's defined-coverage rule).
//
// Byte-identity is NOT asserted in-page: this fixture's globe disc churns for many frames
// after ANY `setAtmosphere` call (it tags DirtyDomain.STYLE, which re-rasterises the
// checker) — measured identically on the PRE-#2052 tree, so it is not this phase's doing
// and an in-page frame hash would be pinning that churn, not the sky. The byte-identity
// rung is taken across commits instead, on the atmosphere-OFF frame, which measures a
// noise floor of exactly zero on WebGPU (three identical whole-frame md5s).

import { test, expect, type Page } from '@playwright/test'
import { PNG } from 'pngjs'

/** The `sky` half of `setAtmosphere`'s patch (#2052) — mirrors TopLevelSkyPatch. */
type SkyPatch = {
  color?: [number, number, number, number]
  horizonColor?: [number, number, number, number]
  horizonBlend?: number
}

type MapWin = {
  __xgisReady?: boolean
  __xgisActiveBackend?: string
  __xgisImportMapbox?: (json: string) => void
  __xgisMap?: {
    invalidate?: () => void
    _atmosphere?: unknown
    setAtmosphere?: (
      a: {
        innerColor?: [number, number, number, number]
        outerColor?: [number, number, number, number]
        sky?: SkyPatch | null
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
// The glow's inner colour (set below) is a saturated orange, alpha-blended over black: a
// STRICTLY warm channel ORDER (r > g > b), not an absolute-brightness floor — the falloff
// band is only a few pixels wide (band-width derivation: atmosphere.ts's own header), so the
// tail pixels are dim. Checker red keeps g == b (40, 40) and checker blue keeps g < r < b, so
// neither can satisfy `r > g > b` at any AA blend fraction with black; only the glow can.
// Calibrated against a real SwiftShader/WebGL2 render of this exact fixture+camera (measured:
// (134,74,5), (41,22,6), (41,22,6) at the three pixels past the silhouette — see the #1258
// gate-regression comment in atmosphere.ts's `fsAtmosphere`), not guessed.
const isGlow = (r: number, g: number, b: number) => r > g && g > b && r > 15
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

// ── #2052 sky predicates ──
//
// The gate authors two colours no other layer in this frame can make. Checker RED keeps
// b < 100 and checker BLUE keeps r < 100, so neither can be magenta; both keep g < 100, so
// neither can be green. The glow is a warm r > g > b, and deep space is black. The disc's
// own red↔blue AA boundary pixels (measured: 141,58,119 / 119,63,141 / 150,56,111) sit
// mid-range on every channel and clear both floors. Calibrated against a real
// SwiftShader/WebGPU render: corner 0,255,0 (sharp ramp) and 253,2,253 (default ramp);
// band just past the silhouette 252,1,252.
const SKY_RGBA: [number, number, number, number] = [0, 1, 0, 1]
const HORIZON_RGBA: [number, number, number, number] = [1, 0, 1, 1]
const isSkyColor = (r: number, g: number, b: number) => g > 200 && r < 80 && b < 80
const isHorizonColor = (r: number, g: number, b: number) => r > 200 && b > 200 && g < 80

function rgbAt(png: PNG, x: number, y: number): [number, number, number] {
  const i = (y * png.width + x) * 4
  return [png.data[i]!, png.data[i + 1]!, png.data[i + 2]!]
}

/** Every sky-coloured pixel in the frame — the "absent" half of (a) is this being 0. */
function countSkyPixels(png: PNG): { sky: number; horizon: number } {
  let sky = 0,
    horizon = 0
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i]!,
      g = png.data[i + 1]!,
      b = png.data[i + 2]!
    if (isSkyColor(r, g, b)) sky++
    else if (isHorizonColor(r, g, b)) horizon++
  }
  return { sky, horizon }
}

/** Sky-coloured pixels strictly INSIDE the silhouette (claim (c)). The disc's centre and
 *  radius come from its own measured row extent — self-referential, no camera math — and
 *  the scan stays at 0.85 R so the limb's own AA and the glow band cannot contribute. */
function countSkyInsideDisc(png: PNG, disc: { xMin: number; xMax: number }, y: number): number {
  const cx = (disc.xMin + disc.xMax) / 2
  const rr = ((disc.xMax - disc.xMin) / 2) * 0.85
  let n = 0
  for (let yy = Math.max(0, Math.ceil(y - rr)); yy < Math.min(png.height, y + rr); yy++) {
    for (let xx = Math.max(0, Math.ceil(cx - rr)); xx < Math.min(png.width, cx + rr); xx++) {
      const dx = xx - cx,
        dy = yy - y
      if (dx * dx + dy * dy > rr * rr) continue
      const [r, g, b] = rgbAt(png, xx, yy)
      if (isSkyColor(r, g, b) || isHorizonColor(r, g, b)) n++
    }
  }
  return n
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

  // ═══ #2052 T5 Phase 1 — the MapLibre `sky` root, same boot, same camera ═══

  // (a) ABSENT. The glow is on and the sky is not: nothing in the frame can be
  // sky-coloured. This is the in-frame half of the fail-before — on the pre-#2052 render
  // path the same assertion holds for EVERY frame below it too.
  expect(
    countSkyPixels(after),
    'sky-coloured pixels present with only the #1258 glow enabled — the sky ramp must be ' +
      'OFF until a `sky` root is authored (that default is what keeps a sky-less style ' +
      'byte-identical)',
  ).toEqual({ sky: 0, horizon: 0 })

  // (b) PRESENT, and a RAMP. Sharp ramp first: the band just past the silhouette must read
  // the HORIZON colour and the far corner the SKY colour, in one frame.
  const setSky = async (horizonBlend: number): Promise<PNG> => {
    await page.evaluate(
      ([sky, horizon, blend]) => {
        ;(window as unknown as MapWin).__xgisMap?.setAtmosphere?.({
          innerColor: [1, 0.55, 0, 0.95],
          outerColor: [0.05, 0.02, 0.1, 0],
          sky: {
            color: sky as [number, number, number, number],
            horizonColor: horizon as [number, number, number, number],
            horizonBlend: blend as number,
          },
        })
      },
      [SKY_RGBA, HORIZON_RGBA, horizonBlend] as const,
    )
    await pump(page)
    return await screenshotPng(page)
  }

  // 0.02 — a ramp that COMPLETES inside the visible sky. 10px past the measured silhouette
  // is inside the horizon plateau and outside the glow band (measured: 252,1,252).
  const sharp = await setSky(0.02)
  const nearLimb = rgbAt(sharp, Math.min(sharp.width - 1, disc.xMax + 10), y)
  const cornerSharp = rgbAt(sharp, 0, 0)
  console.log(
    `[atmosphere-globe/sky] backend=${forcegl2 ? 'webgl2' : 'webgpu'} ` +
      `sharp nearLimb=${nearLimb} corner=${cornerSharp}`,
  )
  expect(
    isHorizonColor(...nearLimb),
    `the band just past the silhouette (x=${disc.xMax + 10}, y=${y}) does not read the ` +
      `authored horizon-color (rgb=${nearLimb}) — the sky ramp is not anchored on the limb`,
  ).toBe(true)
  expect(
    isSkyColor(...cornerSharp),
    `the canvas corner does not read the authored sky-color under a sharp ramp ` +
      `(rgb=${cornerSharp}) — the ramp never reaches the zenith end`,
  ).toBe(true)

  // (c) THE PLANET IS UNTOUCHED.
  expect(
    countSkyInsideDisc(sharp, disc, y),
    'sky-coloured pixels INSIDE the silhouette — the sky is painting over the earth ' +
      'instead of replacing the space background above the horizon',
  ).toBe(0)

  // (b, second half) MapLibre's own default ramp width. Only `sky-horizon-blend` changed,
  // and the corner must flip to the horizon colour: from orbit the visible sky is a small
  // fraction of the limb→zenith arc, so a 0.8-wide ramp has barely started there.
  const wide = await setSky(0.8)
  const cornerWide = rgbAt(wide, 0, 0)
  console.log(
    `[atmosphere-globe/sky] backend=${forcegl2 ? 'webgl2' : 'webgpu'} wide corner=${cornerWide}`,
  )
  expect(
    isHorizonColor(...cornerWide),
    `widening sky-horizon-blend 0.02 → 0.8 did not change what the canvas corner reads ` +
      `(rgb=${cornerWide}, was ${cornerSharp}) — the gradient is not parameterised by the ` +
      'limb→zenith arc; a flat wash or a screen-space ramp would land here',
  ).toBe(true)
  expect(
    isHorizonColor(...rgbAt(wide, Math.min(wide.width - 1, disc.xMax + 10), y)),
    'the band just past the silhouette left the horizon colour when only the ramp WIDTH ' +
      'changed — the limb end of the ramp must be fixed',
  ).toBe(true)
  expect(
    countSkyInsideDisc(wide, disc, y),
    'sky-coloured pixels INSIDE the silhouette under the default ramp width',
  ).toBe(0)

  expect(errors, 'no page errors').toEqual([])
}

// ═══ #2052 — the STYLE path, end to end and offline ═══
//
// runGate above drives `setAtmosphere` directly, which proves the pass and the shader but
// says nothing about the seam this phase actually adds: a MapLibre style's `sky` root →
// extractMapboxSky → setAtmosphere, in the demo-runner. `__xgisImportMapbox` is that exact
// function, so feeding it a style is the whole chain with no network (the style is
// embedded; the container's browser has no egress).
//
// The style declares no sources and no layers on purpose: the globe then renders as a black
// disc on black space, and EVERY non-black pixel in the frame is the sky. The wait on
// `_atmosphere` before the pixel read is what keeps one cut to one message — sever the
// runner wiring and the wait fails naming the host field; sever the shader and the wait
// passes and the pixels fail.
const SKY_STYLE = JSON.stringify({
  version: 8,
  sources: {},
  layers: [],
  sky: { 'sky-color': '#00ff00', 'horizon-color': '#ff00ff', 'sky-horizon-blend': 0.02 },
})

// The ONE page error this leg tolerates, and the evidence for tolerating it.
//
// `__xgisImportMapbox` destroys the live map and builds a new one; the atmosphere pass then
// switches on inside that teardown window and allocates its uniform buffer through the same
// upload queue, and a readback promise from the dying map rejects. Symptom: 1–8
// "Failed to execute 'mapAsync' on 'GPUBuffer': Buffer was unmapped before mapping was
// resolved", intermittent (measured 0, 1, 2, 4 and 8 across runs; WebGPU only).
//
// ATTRIBUTED, not assumed. Replacing THIS leg's payload with the pre-#2052 glow-only
// `setAtmosphere({})` — same call site, same instant — reproduces it (2 errors), while
// importing the same style with no setAtmosphere call at all produces 0. So the trigger is
// "#1258's pass starts during a style-import teardown", which #2052 is merely the first
// caller to reach; it is not the sky ramp, and it has no effect on the frame (this leg's
// pixel assertions above run after it and pass on both backends).
//
// Deliberately an EXACT message match, and only in this leg: any other page error, and
// every error in runGate (which never re-imports and asserts a strict `toEqual([])`), still
// fails. Fixing the underlying upload-queue/teardown ordering is engine-side and outside
// this phase — it wants its own issue.
const TEARDOWN_RACE = /Buffer was unmapped before mapping was resolved/

async function runStyleImportGate(page: Page, forcegl2: boolean): Promise<void> {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))

  await page.goto(`/demo.html?e2e=1&proj=globe${forcegl2 ? '&forcegl2=1' : ''}#1.8/10/20`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(() => (window as unknown as MapWin).__xgisReady === true, {
    timeout: 30_000,
  })
  expect(await page.evaluate(() => (window as unknown as MapWin).__xgisActiveBackend)).toBe(
    forcegl2 ? 'webgl2' : 'webgpu',
  )
  await page.waitForFunction(
    () => typeof (window as unknown as MapWin).__xgisImportMapbox === 'function',
    { timeout: 30_000 },
  )

  await pump(page, 12)
  // PRECONDITION ON HOST STATE, NOT ON A READBACK — the pixel half of absent→present is
  // runGate's, on a stricter fixture, and taking a canvas screenshot here only widens the
  // teardown window documented at TEARDOWN_RACE below.
  expect(
    await page.evaluate(() => (window as unknown as MapWin).__xgisMap?._atmosphere ?? null),
    'the atmosphere/sky host state is already set before any style was imported — the ' +
      'default must be off',
  ).toBeNull()

  await page.evaluate((json) => (window as unknown as MapWin).__xgisImportMapbox?.(json), SKY_STYLE)
  // The host field the runner's one wiring line writes. A cut there dies HERE, naming it.
  await page.waitForFunction(
    () => (window as unknown as MapWin).__xgisMap?._atmosphere != null,
    undefined,
    { timeout: 30_000 },
  )
  await pump(page)
  const after = await screenshotPng(page)

  const counts = countSkyPixels(after)
  const corner = rgbAt(after, 0, 0)
  console.log(
    `[atmosphere-globe/style] backend=${forcegl2 ? 'webgl2' : 'webgpu'} ` +
      `corner=${corner} counts=${JSON.stringify(counts)}`,
  )
  // The style's own two colours, both on screen: the ramp reached the host with its ends
  // intact, not merely "something painted".
  expect(
    isSkyColor(...corner),
    `the canvas corner does not read the STYLE's sky-color #00ff00 (rgb=${corner}) — the ` +
      '`sky` root did not reach setAtmosphere with its zenith end intact',
  ).toBe(true)
  expect(
    counts.horizon,
    "the STYLE's horizon-color #ff00ff is nowhere on screen — the ramp arrived with only " +
      'one end, or collapsed to a single colour',
  ).toBeGreaterThan(0)

  // Every page error EXCEPT one pre-existing, attributed teardown race — see TEARDOWN_RACE.
  expect(
    errors.filter((e) => !TEARDOWN_RACE.test(e)),
    'no page errors',
  ).toEqual([])
}

// Raised from 90 s for the sky legs: the WebGL2 leg drives four settled captures on
// SwiftShader (measured ~60 s for the two #1258 captures alone). Declared on the DESCRIBE
// so it covers fixture setup too, not just the body (CLAUDE.md §12).
test.describe.configure({ timeout: 300_000 })

test.describe('globe atmosphere limb-glow (#1258) + MapLibre sky root (#2052)', () => {
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

  test('WebGPU: a style`s `sky` root reaches the render host and paints its ramp', async ({
    page,
  }) => {
    await runStyleImportGate(page, false)
  })

  test('WebGL2 (?forcegl2=1): a style`s `sky` root reaches the render host and paints its ramp', async ({
    page,
  }) => {
    await runStyleImportGate(page, true)
  })
})
