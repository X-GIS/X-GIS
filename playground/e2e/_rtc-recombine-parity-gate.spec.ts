// ═══ #2042 INC-1 — in-VS RTC recombination: interactive §5 A/B parity gate ═══
//
// The polygon VS can derive the RTC offset from the ABSOLUTE anchors
// (`__XGIS_RTC_RECOMBINE`, cam_ecef_center_h.w flag) instead of the
// CPU-packed cam_ecef_off pair. The divergence between the two paths is
// ulp-RELATIVE (rtc-recombine-precision.test.ts: measured ≤ 2.3e-4 px
// whole-domain) — small enough that frames are pixel-comparable, but a
// correctly-rounded ulp CAN deterministically flip a rasterized pixel whose
// triangle edge passes within that distance of a sample centre. So the A/B
// rung here is BOUNDED PIXEL DIFF (count ≤ MAX_DIFF_PX per step), not hash
// equality — hash equality is asserted only where the paths are bit-equal by
// construction (the OFF+skew witness arm).
//
// Vacuity guards (the #996 lesson — "both arms equal" proves nothing if the
// flag never reached the shader): two single-pose WITNESS arms cut the
// mechanism from both sides via the __XGIS_RTC_RECOMBINE_SKEW test hook
// (vector-tile-renderer._writeRtcAnchors adds a metre skew to the tile
// anchor X):
//   • ON + skew 5e5 m  → geometry MUST move (≫100 px of diff vs the ON arm)
//     — proves the VS actually consumes tile_ecef_center when the flag is on;
//     if the flag plumbing is dead this arm renders the legacy frame and the
//     gate goes red naming it.
//   • OFF + skew 5e5 m → what this arm must show DEPENDS ON THE BIND PATH,
//     and #2165 is the bill for not saying so. On the LEGACY monolithic bind
//     the shader carries a flag select (merc-cam-rel.ts / polygon.ts's
//     `camCH.w.gt(0.5)`), so flag-off reads the CPU-packed cam_ecef_off pair
//     and the frame MUST equal the OFF arm byte-for-byte. On the SPLIT bind
//     the cam_ecef_off vec4s are RETIRED (uniform-split-partition's RETIRING
//     set) — polygon-split.ts rewrites cam_h/cam_l to the recombined arm
//     ALONE, "with no flag select" (merc-cam-rel.ts's own header) — so there
//     is no legacy arm to bypass to and the skew MUST move the frame.
//
// EACH TEST THEREFORE PINS ITS BIND PATH (`__XGIS_SPLIT_BIND`, via an
// addInitScript set once before the first navigation, so it is live at the
// pipeline-factory build() that reads it). #2151 flipped the default from
// opt-in to opt-out and this gate — a CONSUMER of the bind path, not part of
// the split-bind feature — silently changed subject and went red asserting
// the retired path's semantics against the shipping one (#2165). Inheriting
// the default is what made that possible; it is not inherited any more.
//
// Scene/settle harness mirrors _bundle-replay-parity-gate.spec.ts (the same
// hard-won constraints): committed demotiles mirror (offline, TERMINAL tile
// content → history-independent hashes), zoom < 2 band (mirror coverage +
// SwiftShader raster budget), idle-event settle with the listener registered
// BEFORE the camera moves, full-script warmup per arm (glyph ranges), reduced
// motion, clipped page.screenshot (element screenshots never stabilize),
// post-ready page.evaluate flag injection for the PER-ARM flags (addInitScript
// stacking measured broken across arm navigations) — the per-TEST bind path is
// a single constant and so does ride an addInitScript, added once up front.
//
// That post-ready injection rests on "the flags are read LIVE per frame at the
// uniform write site". #2042 INC-4b quietly retired that for the tile anchors:
// TileUniformArena packs a slot ONCE and reuses it forever, so a skew set after
// boot could never reach an already-resident tile and Witness 1 measured 0 on
// the shipping path. tile-uniform-arena.ts's `packedSkew` restores the premise
// by dropping resident packs when the witness moves (#2165).

import { test, expect, type Page } from '@playwright/test'
import { hideDemoChrome } from './helpers/visual'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { PNG } from 'pngjs'

const SCRIPT: ReadonlyArray<{ bearing: number; zoom: number; pitch: number }> = [
  { bearing: 0, zoom: 1.5, pitch: 0 },
  { bearing: 25, zoom: 1.5, pitch: 0 },
  { bearing: 55, zoom: 1.8, pitch: 15 },
  { bearing: 55, zoom: 1.6, pitch: 15 },
  { bearing: 25, zoom: 1.5, pitch: 0 },
]

/** Per-step pixel-diff budget between the OFF and ON arms. Expected ~0-2
 *  (ulp edge flips); a real recombine bug (wrong lane, swapped hi/lo, dead
 *  select) moves geometry by metres = thousands of pixels at this viewport. */
const MAX_DIFF_PX = 12

/** Witness skew (metres) — shifts geometry ~35 px at this zoom band, far
 *  above MAX_DIFF_PX and far below wrap-around ambiguity. */
const WITNESS_SKEW_M = 5e5

/** #2042 INC-6 — the LINE-only witness scene, injected rather than committed.
 *
 *  THE GEOMETRY MUST HAVE EXTENT PERPENDICULAR TO THE SKEW, and that is not a detail —
 *  it is the whole reason this scene is coastlines and not the parallels it started as.
 *  The witness skew translates the tile anchor along X. `fixture-long-chords.geojson` is
 *  4 constant-latitude LineStrings spanning lon -180..180, i.e. horizontal image lines
 *  wider than the frame; translating one along X maps its pixel set to ITSELF, so the
 *  skew is invisible by construction in every projection. Measured, it was: 20 differing
 *  pixels at 5 isolated x-positions (join residue where translation symmetry breaks),
 *  IDENTICAL in Mercator and equirectangular — a witness that cannot witness.
 *  `ne_110m_coastline.geojson` is 4994 segments with 36% steeper than 45 degrees, so an
 *  X shift displaces real edges.
 *
 *  No fill layer and no label layer, both deliberate. A fill would let the polygon path
 *  satisfy the witness on the line half's behalf (the flat arm's existing defect); an
 *  along-path label moves through the TEXT stage, so a shifted label would be
 *  indistinguishable from a wired line recombination. Both are the same failed-either-way
 *  shape (CLAUDE.md 12) at different layers.
 *
 *  Injected through `__xgisRunSource` (playground/src/demo-runner.ts) rather than committed
 *  as a fixture, so the scene sits next to the assertion that depends on it; `XGISMap`
 *  exposes no layer-visibility API, so trimming a shipped scene in-page is not an option. */
const LINE_ONLY_SRC = `xgis 1
source coast { type: geojson, url: "ne_110m_coastline.geojson" }
layer coastline {
  source: coast
  | stroke-rose-500 stroke-3
}
`

/** Whether line.ts CONSUMES the Mercator anchor lanes yet (#2042 INC-6, the LINE half).
 *
 *  TRUE as of the INC-6 LINE half: `line.ts` un-padded `cam_ecef_center_h` (its `.w` is the
 *  umbrella recombine flag), `tile_origin_merc_hl` and `cam_merc_center_hl`, and routes all
 *  three cam_h/cam_l read sites through `mercCamRel()`. So a skewed anchor now MOVES stroke
 *  pixels, and the witness below asserts that instead of asserting inertness.
 *
 *  This constant flipped in the SAME diff that un-padded the lanes, and the false side was
 *  MEASURED on pre-#2042-INC-6 sources (pads verified present, line-endpoint.ts verified
 *  absent, before measuring): skew moved count=0 maxD=0 in BOTH arms. With the lanes wired
 *  the same scene gives 1679 px (Mercator) / 1714 px (equirectangular). Neither assertion
 *  was rewritten by the change under test — only this one documented flag — so the gate
 *  judged the increment rather than being edited to agree with it.
 *
 *  The earlier 0 recorded against the PARALLELS scene does not count and is not cited: that
 *  scene is translation-invariant along the skew axis (see LINE_ONLY_SRC), so its 0 was the
 *  scene being blind, not the lanes being pads. Same number, no information. */
const LINE_HALF_WIRED = true

type Arm = { recombine: boolean; skewM: number }

let _clip: { x: number; y: number; width: number; height: number } | null = null
let _stepIdx = 0

async function bootArm(
  page: Page,
  arm: Arm,
  globe: boolean,
  lineOnly = false,
  projOverride: string | null = null,
): Promise<void> {
  _clip = null
  await page.emulateMedia({ reducedMotion: 'reduce' })
  // proj=globe — the ECEF RTC recombination (INC-1) lives in the projection
  // ladder's 3D arm, which only globe(7) takes (measured: on the flat scene
  // an ECEF anchor skew changed ZERO pixels — the witness refused to certify
  // a vacuous A/B, twice, before this URL carried the projection). The FLAT
  // scene became meaningful at INC-6: its Mercator cam-rel recombination is
  // what the flat test below exercises (the skew hook moves BOTH anchors'
  // X, so each scene's witness bites on its own arm).
  // `adaptive=0` is load-bearing for a BOUNDED-PIXEL-DIFF rung, for the same reason
  // `_bundle-replay-parity-gate` needs it (#2116): the adaptive quality controller reads
  // MEASURED rendered-frame intervals and moves the render down a ladder, so the frame is a
  // function of wall-clock and the two arms — which boot separately, one on a cold HTTP
  // cache — can land on different notches. Measured on this scene: notch 0 -> 3 -> 4 and
  // `adaptiveFarLodBoost` 1 -> 4 within two script steps.
  //
  // Attribution, one cut at a time (§12). With the chrome hidden but the ladder still live,
  // the flat step-0 diff was 3497 px / maxD 159 (down from 7448 / 129 with the chrome in the
  // frame), and a +-3 px shift search found its MINIMUM at (0,0) — every translation made it
  // worse. So the residue is NOT a moved geometry, which is what a wrong recombined offset
  // would look like and what this spec's error message asserts. It is a whole-frame
  // resample: the diff sits on all 55 rows and 287 of 288 columns at ~25 px/row, with a
  // spike on the one thin dashed feature (rows 11-14: 223/265/270/195). That is the ladder's
  // dpr notch, not arithmetic.
  const sceneId = lineOnly ? 'line_styles' : 'import_maplibre_mirror'
  const proj = projOverride !== null ? `&proj=${projOverride}` : globe ? '&proj=globe' : ''
  await page.goto(`/demo.html?id=${sceneId}${proj}&e2e=1&msaa=1&adaptive=0#1.5/20/140`, {
    waitUntil: 'domcontentloaded',
  })
  console.log(`[rtc-parity] boot(${JSON.stringify(arm)}): navigated, waiting ready`)
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 240_000 },
  )
  // Line-only arms: swap the shipped `long_chords` scene for the stroke-only one. Booting
  // that demo first (rather than injecting over an arbitrary scene) means its geojson is
  // already fetched, so the re-run does not re-race the network. `runSource` takes the same
  // path as the Run button and rebuilds the map, so wait for readiness AGAIN — map.ts clears
  // `__xgisReady` on the teardown and re-sets it once the new map enters the render loop.
  if (lineOnly) {
    await page.evaluate(async (src: string) => {
      ;(window as unknown as { __xgisReady?: boolean }).__xgisReady = false
      await (
        window as unknown as { __xgisRunSource: (s: string) => Promise<unknown> }
      ).__xgisRunSource(src)
    }, LINE_ONLY_SRC)
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null,
      { timeout: 240_000 },
    )
    const layers = await page.evaluate(
      () =>
        (
          window as unknown as { __xgisMap?: { getLayers?: () => readonly { name?: string }[] } }
        ).__xgisMap
          ?.getLayers?.()
          ?.map((l) => l?.name ?? '?') ?? null,
    )
    console.log(`[rtc-parity] line-only scene layers: ${JSON.stringify(layers)}`)
    // ASSERTED, not just logged. If the injection silently no-ops the arm renders the
    // shipped `long_chords` — label layer included — and every stroke verdict below becomes
    // a text-stage measurement wearing a line-shader label. That is the exact false positive
    // this scene was built to remove, so it must fail loudly here rather than pass quietly.
    expect(
      layers,
      'line-only scene injection produced no layer list — cannot certify the label layer is gone',
    ).not.toBeNull()
    expect(
      layers,
      `line-only scene must contain the stroke layer ALONE; got ${JSON.stringify(layers)}`,
    ).toEqual(['coastline'])

    // ASSERT the arm is running the projection it NAMES. Without this the equirectangular
    // arm silently rendered Mercator frames — identical witness numbers to the Mercator arm
    // (count=20, maxD=244), i.e. an arm that looks like second-projection coverage and is
    // not. That is the same vacuity this whole witness exists to remove, one level up.
    const projName = await page.evaluate(
      () =>
        (
          window as unknown as { __xgisMap?: { getProjectionName?: () => string } }
        ).__xgisMap?.getProjectionName?.() ?? null,
    )
    console.log(`[rtc-parity] line-only projection: ${JSON.stringify(projName)}`)
    expect(
      projName,
      `line-only arm must render the projection it claims; asked for ` +
        `${JSON.stringify(projOverride ?? 'mercator')}, got ${JSON.stringify(projName)}`,
    ).toBe(projOverride ?? 'mercator')
  }
  // Flags are read LIVE per frame at the uniform write site, so a post-ready
  // evaluate is sufficient (and addInitScript stacking is not reliable
  // across per-arm navigations — measured in the bundle gate's history).
  await page.evaluate((a: Arm) => {
    ;(globalThis as { __XGIS_RTC_RECOMBINE?: boolean }).__XGIS_RTC_RECOMBINE = a.recombine
    ;(globalThis as { __XGIS_RTC_RECOMBINE_SKEW?: number }).__XGIS_RTC_RECOMBINE_SKEW = a.skewM
    ;(globalThis as { __XGIS_INVARIANTS?: boolean }).__XGIS_INVARIANTS = true
    // Force the DIRECT ECEF-chord fill draw in ALL arms (equal conditions):
    // on the globe the #599 vector drape bakes fills tile-locally (no RTC in
    // the bake's ortho MVP), so with the drape active the polygon ladder's
    // ECEF arm — the mechanism under test — never executes on this scene.
    // The first witness run PROVED that: ON + 5e5 m skew changed ZERO pixels.
    // Chord fills are the accepted globe behaviour whenever the drape is
    // inactive (VTR's own fallback comment), so this stays a real render path.
    ;(globalThis as { __XGIS_DISABLE_VECTOR_DRAPE?: boolean }).__XGIS_DISABLE_VECTOR_DRAPE = true
  }, arm)
  const flags = await page.evaluate(() => ({
    rc: (globalThis as { __XGIS_RTC_RECOMBINE?: unknown }).__XGIS_RTC_RECOMBINE,
    skew: (globalThis as { __XGIS_RTC_RECOMBINE_SKEW?: unknown }).__XGIS_RTC_RECOMBINE_SKEW,
  }))
  console.log(`[rtc-parity] page flags: ${JSON.stringify(flags)}`)
  // The measured pixels must be MAP pixels. `page.screenshot({clip})` over the canvas box
  // still catches every demo-chrome element that OVERLAPS that box — `DEMO_CHROME_IDS`
  // (helpers/visual.ts) exists precisely because they do — and the saved failing frames
  // proved it: the hash badge `#1.50/20.00000/140.00000` and the style title were inside
  // the 288x55 clip, i.e. a large fraction of what this gate was hashing was DOM text whose
  // rasterisation has nothing to do with the recombination under test. CLAUDE.md §5 forbids
  // exactly this capture shape (owner-mandated 2026-08-25). Re-applied per arm because each
  // arm re-navigates and the style mutation does not survive that.
  console.log(`[rtc-parity] chromeHidden=${JSON.stringify(await hideDemoChrome(page))}`)
  await page.waitForTimeout(8_000) // cold-start tile + glyph cascade
  // Full-script warmup in EVERY arm (identical histories → comparable
  // settled frames; un-warmed first-visit glyph races measured in the
  // bundle gate).
  for (const step of SCRIPT) await stepAndSettle(page, step, /* warmup */ true)
}

async function shot(page: Page): Promise<{ hash: string; png: Buffer }> {
  if (!_clip) {
    const box = await page.locator('#xg-canv, canvas').first().boundingBox()
    if (!box) throw new Error('canvas has no bounding box')
    _clip = {
      x: Math.max(0, Math.floor(box.x)),
      y: Math.max(0, Math.floor(box.y)),
      width: Math.floor(box.width),
      height: Math.floor(box.height),
    }
    console.log(`[rtc-parity] clip=${JSON.stringify(_clip)}`)
  }
  const png = await page.screenshot({ clip: _clip, animations: 'disabled', timeout: 120_000 })
  return { hash: createHash('sha256').update(png).digest('hex'), png }
}

/** Pixels whose colour differs from the frame's corner pixel — i.e. DRAWN content.
 *
 *  The line-only witness asserts "the skew moved 0 pixels", and a BLANK canvas satisfies
 *  that just as well as an inert-but-rendering one (§12: a pixel-COUNT gate passes on broken
 *  images — assert structure). This is the structural floor that separates the two: on a
 *  scene whose only drawable is a stroke layer, drawn pixels ARE stroke pixels. */
function drawnPixelCount(png: Buffer): number {
  const p = PNG.sync.read(png)
  const [br, bg, bb] = [p.data[0]!, p.data[1]!, p.data[2]!]
  let n = 0
  for (let i = 0; i < p.data.length; i += 4) {
    if (
      Math.abs(p.data[i]! - br) > 8 ||
      Math.abs(p.data[i + 1]! - bg) > 8 ||
      Math.abs(p.data[i + 2]! - bb) > 8
    )
      n++
  }
  return n
}

/** Count pixels differing in ANY channel (+ max channel delta) between two
 *  same-size PNG screenshots. */
function pixelDiff(a: Buffer, b: Buffer): { count: number; maxDelta: number } {
  const pa = PNG.sync.read(a)
  const pb = PNG.sync.read(b)
  if (pa.width !== pb.width || pa.height !== pb.height)
    throw new Error(`size mismatch ${pa.width}x${pa.height} vs ${pb.width}x${pb.height}`)
  let count = 0
  let maxDelta = 0
  for (let i = 0; i < pa.data.length; i += 4) {
    let d = 0
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(pa.data[i + c]! - pb.data[i + c]!))
    if (d > 0) {
      count++
      if (d > maxDelta) maxDelta = d
    }
  }
  return { count, maxDelta }
}

/** Apply one script step; settle via the map 'idle' event (listener FIRST,
 *  then move the camera — same completion-driven pattern as the bundle
 *  gate); double-hash sanity; return the settled screenshot. */
async function stepAndSettle(
  page: Page,
  step: { bearing: number; zoom: number; pitch: number },
  warmup = false,
): Promise<{ hash: string; png: Buffer }> {
  const stepIdx = _stepIdx++
  console.log(
    `[rtc-parity] step ${stepIdx}${warmup ? ' (warmup)' : ''} apply ${JSON.stringify(step)}`,
  )
  await page.evaluate(
    async ({ s, timeoutMs }) => {
      const m = (
        window as unknown as {
          __xgisMap: {
            getCamera: () => { bearing: number; pitch: number }
            setZoom: (z: number) => void
            invalidate: () => void
            on: (t: string, cb: () => void) => unknown
          }
        }
      ).__xgisMap
      await new Promise<void>((res, rej) => {
        const t = setTimeout(() => rej(new Error(`idle timeout after ${timeoutMs}ms`)), timeoutMs)
        m.on('idle', () => {
          clearTimeout(t)
          res()
        })
        const cam = m.getCamera()
        cam.bearing = s.bearing
        cam.pitch = s.pitch
        m.setZoom(s.zoom)
        m.invalidate()
      })
    },
    { s: step, timeoutMs: 220_000 },
  )
  if (warmup) return { hash: '', png: Buffer.alloc(0) }
  // FIXED-POINT settle: rounds of [wiggle ±2° + re-idle + hash] until two
  // consecutive rounds produce the SAME hash. One wiggle round (the bundle
  // gate's mechanic) was not enough here: a first-settle frame is STABLE
  // (double-hash equal) yet content-wise divergent between arms — per-frame
  // animations (fades) advance with RENDERED FRAME COUNT, which varies with
  // load timing, so two arms at the same pose can idle a frame or two apart
  // in animation state (measured: 47%-of-frame Δ1-dominated diffs at step 0,
  // while a direct single-pose A/B measured 0 pixels, twice — flat AND
  // globe). Each round advances those animations; the fixed point is the
  // TERMINAL state, which is history-independent — the thing to compare.
  let prev = ''
  let s1: { hash: string; png: Buffer } | null = null
  for (let round = 0; round < 8; round++) {
    await page.evaluate(async (baseBearing: number) => {
      const m = (
        window as unknown as {
          __xgisMap: { getCamera: () => { bearing: number }; invalidate: () => void }
        }
      ).__xgisMap
      const cam = m.getCamera()
      for (let i = 0; i < 6; i++) {
        cam.bearing = baseBearing + (i % 2 === 0 ? 2 : -2)
        m.invalidate()
        await Promise.race([
          new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
          new Promise<void>((r) => setTimeout(r, 20_000)),
        ])
      }
      cam.bearing = baseBearing
      m.invalidate()
    }, step.bearing)
    await page.evaluate(async (timeoutMs: number) => {
      const m = (
        window as unknown as {
          __xgisMap: { on: (t: string, cb: () => void) => unknown; invalidate: () => void }
        }
      ).__xgisMap
      await new Promise<void>((res, rej) => {
        const t = setTimeout(
          () => rej(new Error(`re-idle timeout after ${timeoutMs}ms`)),
          timeoutMs,
        )
        m.on('idle', () => {
          clearTimeout(t)
          res()
        })
        m.invalidate()
      })
    }, 220_000)
    s1 = await shot(page)
    if (s1.hash === prev) {
      console.log(`[rtc-parity] step ${stepIdx} fixed point after ${round + 1} rounds`)
      return s1
    }
    prev = s1.hash
  }
  throw new Error(
    `step ${stepIdx}: no fixed point in 8 wiggle+idle rounds (last ${prev.slice(0, 12)})`,
  )
}

async function runScript(page: Page): Promise<{ hash: string; png: Buffer }[]> {
  const out: { hash: string; png: Buffer }[] = []
  for (const step of SCRIPT) out.push(await stepAndSettle(page, step))
  return out
}

async function runParity(
  page: Page,
  testInfo: { outputPath: (name: string) => string },
  globe: boolean,
  lineOnly = false,
  projOverride: string | null = null,
  /** Which uniform bind path this test measures. NEVER inherited from the
   *  shipping default — see the header: that is how #2165 happened. */
  splitBind = true,
): Promise<void> {
  // No '/' — the tag is spliced into testInfo.outputPath() for the §5 artifacts,
  // and a slash there makes the write ENOENT in a directory nobody created.
  const tag =
    (lineOnly ? (projOverride ?? 'line-merc') : globe ? 'globe' : 'flat') +
    (splitBind ? '' : '-legacy-bind')
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e)))
  await page.setViewportSize({ width: 288, height: 160 })
  // Added ONCE, before the first navigation: pipeline-factory reads
  // __XGIS_SPLIT_BIND at build(), so a post-ready evaluate is too late. One
  // constant for the whole test means no stacking across the four arms.
  await page.addInitScript((v: boolean) => {
    ;(globalThis as { __XGIS_SPLIT_BIND?: boolean }).__XGIS_SPLIT_BIND = v
  }, splitBind)

  // Arm A — legacy (flag off, no skew): the reference.
  await bootArm(page, { recombine: false, skewM: 0 }, globe, lineOnly, projOverride)
  const off = await runScript(page)

  // Arm B — recombine ON.
  await bootArm(page, { recombine: true, skewM: 0 }, globe, lineOnly, projOverride)
  const on = await runScript(page)

  // Arm C — recombine ON + witness skew: single pose, must move geometry
  // (globe: the ECEF anchor X; flat: the Mercator origin X — the hook skews
  // both, each scene's live arm reads its own).
  await bootArm(page, { recombine: true, skewM: WITNESS_SKEW_M }, globe, lineOnly, projOverride)
  const onSkew = await stepAndSettle(page, SCRIPT[0]!)

  // Arm D — recombine OFF + witness skew: single pose, must be inert.
  await bootArm(page, { recombine: false, skewM: WITNESS_SKEW_M }, globe, lineOnly, projOverride)
  const offSkew = await stepAndSettle(page, SCRIPT[0]!)

  // ── Verdicts ──
  // The bind path is the SUBJECT of every verdict below, so prove the page is
  // on the one this test names before reading a single pixel. The echo proves
  // the init script ran ahead of page scripts (hence ahead of build()); the
  // walk-skip counter is the executed-mechanism half — it increments only
  // inside VTR's split branch, so on a polygon scene it separates "split bind
  // declared" from "split bind actually taken" (§12: a flag you set is not a
  // mechanism you ran).
  const observed = await page.evaluate(() => ({
    flag: (globalThis as { __XGIS_SPLIT_BIND?: unknown }).__XGIS_SPLIT_BIND,
    walkSkips: (globalThis as { __xgisVtrWalkSkips?: number }).__xgisVtrWalkSkips ?? 0,
  }))
  console.log(`[rtc-parity:${tag}] bind path: ${JSON.stringify(observed)}`)
  expect(
    observed.flag,
    `${tag}: __XGIS_SPLIT_BIND did not survive to the page — the init script did not run ` +
      'before build(), so this test measured whatever the shipping default happens to be',
  ).toBe(splitBind)
  if (!splitBind) {
    // The counter increments ONLY inside VTR's split branch, so a non-zero here
    // means __XGIS_SPLIT_BIND=false did not take and the legacy select semantics
    // below would be asserted against the split path. Measured 0 on this arm.
    expect(
      observed.walkSkips,
      `${tag}: the split walk-skip fired ${observed.walkSkips}x on the legacy-bind arm — ` +
        '__XGIS_SPLIT_BIND=false did not take',
    ).toBe(0)
  } else if (!lineOnly && !globe) {
    // Flat polygon scene: every fill is an UNCLIPPED draw of a named slice, so it
    // establishes arena slots and the walk-skip engages (measured 2578). This is
    // the executed-mechanism half — a flag you set is not a mechanism you ran.
    //
    // NOT asserted on globe: with the vector drape disabled the globe arm draws
    // direct ECEF chord fills, whose per-tile draws do not all clear
    // `visibleKey < 0` — measured 0 there, on a run whose Witness 1 then moved
    // 3356 px on flat. A `> 0` bar on globe fails for a reason that has nothing
    // to do with the recombination, which is the opposite of what a witness is
    // for. Witness 1 below is the mechanism proof on that scene.
    expect(
      observed.walkSkips,
      `${tag}: the split walk-skip never fired — the arena slots are not being bound, so ` +
        'this test is measuring the ring path while claiming the split one',
    ).toBeGreaterThan(0)
  }
  expect(pageErrors, `page errors during parity run:\n${pageErrors.join('\n')}`).toEqual([])
  // Blank-canvas trap: distinct poses must produce distinct frames.
  expect(new Set(off.map((s) => s.hash)).size, 'reference frames all identical').toBeGreaterThan(1)

  for (let i = 0; i < SCRIPT.length; i++) {
    const equal = off[i]!.hash === on[i]!.hash
    const d = equal ? { count: 0, maxDelta: 0 } : pixelDiff(off[i]!.png, on[i]!.png)
    console.log(
      `[rtc-parity:${tag}] step ${i} ${JSON.stringify(SCRIPT[i])} off=${off[i]!.hash.slice(0, 12)} ` +
        `on=${on[i]!.hash.slice(0, 12)} ${equal ? 'EQUAL' : `DIFF count=${d.count} maxΔ=${d.maxDelta}`}`,
    )
    if (d.count > MAX_DIFF_PX) {
      // §5 artifacts — a failure must be reviewable at full resolution.
      const po = testInfo.outputPath(`rtc-${tag}-step${i}-off.png`)
      const pn = testInfo.outputPath(`rtc-${tag}-step${i}-on.png`)
      writeFileSync(po, off[i]!.png)
      writeFileSync(pn, on[i]!.png)
      console.log(`[rtc-parity:${tag}] saved failing frames: ${po} ${pn}`)
    }
    expect(
      d.count,
      `${tag} step ${i}: OFF↔ON pixel diff ${d.count} > ${MAX_DIFF_PX} (maxΔ=${d.maxDelta}) — ` +
        'beyond the ulp-flip envelope; the recombined offset is not equivalent',
    ).toBeLessThanOrEqual(MAX_DIFF_PX)
  }

  // Witness 1 — the recombine path is LIVE: skewing the tile anchor moves it.
  const cd = pixelDiff(on[0]!.png, onSkew.png)
  console.log(`[rtc-parity:${tag}] witness ON+skew vs ON: count=${cd.count} maxΔ=${cd.maxDelta}`)
  // The two line arms witness DIFFERENT sites, and neither one covers both. On Mercator
  // `finalize_corner` is the identity passthrough (line-corner.ts) so the VERTEX site is
  // dead and geometry cannot move; the live consumer is the fragment `line_endpoint`,
  // which feeds dash/SDF distance math — a per-fragment perturbation. On a non-Mercator
  // flat projType it is the exact inverse: `line_endpoint` returns p_h+p_l (cam unused)
  // while `finalize_corner` takes the flat_rel arm that DOES read the pair, so geometry
  // moves. One bar for both would be wrong in one direction or the other.
  // §5 — a witness verdict must be REVIEWABLE at full resolution, not just a scalar. The
  // A/B comparison above already saves its frames on failure; the witness did not, and that
  // gap cost a round: two projections reported an identical `count=20 maxD=244` and there
  // was no image to say whether those 20 pixels were a positional shift (paired red/blue
  // parallel edges) or an antialiasing edge flip (scattered isolated pixels). Saved for
  // every line arm — the frames are 288x55, the cost is nil, and the numbers alone have
  // now misled this gate twice.
  if (lineOnly) {
    const pOn = testInfo.outputPath(`rtc-${tag}-witness-on.png`)
    const pSkew = testInfo.outputPath(`rtc-${tag}-witness-on-skew.png`)
    writeFileSync(pOn, on[0]!.png)
    writeFileSync(pSkew, onSkew.png)
    console.log(`[rtc-parity:${tag}] witness frames: ${pOn} ${pSkew}`)

    // STRUCTURAL FLOOR — the reason `drawnPixelCount` exists (#2042 INC-6 wrote it, then
    // orphaned it by flipping LINE_HALF_WIRED to true in the same commit, which retired the
    // only arm that called it; TS6133 was the only thing that noticed). See #2148.
    //
    // It is needed MORE now, not less. Witness 2 below asserts `offSkew.hash === off.hash`,
    // and TWO BLANK CANVASES satisfy that perfectly — a live assertion that a scene drawing
    // nothing would pass. The skew-diff arms are self-protecting (a blank pair diffs to 0,
    // which fails their `> 0` / `> 100` bars), but the hash-equality one is not. Assert once,
    // here, that the stroke-only scene actually put ink on the canvas.
    const drawn = drawnPixelCount(on[0]!.png)
    console.log(`[rtc-parity:${tag}] drawn pixels on the stroke-only scene: ${drawn}`)
    expect(
      drawn,
      `${tag}: the stroke-only scene drew ${drawn} pixels — a BLANK frame satisfies Witness 2's ` +
        'hash equality and the skew diffs alike, so every verdict below would be vacuous. ' +
        'The scene, the fixture or the boot failed, not the recombination.',
    ).toBeGreaterThan(0)
  }
  const geometryWitness = lineOnly && projOverride !== null
  if (lineOnly && !LINE_HALF_WIRED) {
    // Measured pre-state: nothing reads the anchors, so the skew is inert on every site.
    expect(
      cd.count,
      `${tag}: ON + skew moved ${cd.count} px on a stroke-only scene while line.ts still ` +
        'declares the anchors as PADS — something is reading lanes it cannot see, or the ' +
        'scene is not stroke-only. Flip LINE_HALF_WIRED only in the commit that un-pads them.',
    ).toBe(0)
  } else if (lineOnly && !geometryWitness) {
    // Mercator: FRAGMENT-stage witness. The bar is "> 0", and it is categorical rather
    // than fitted — this arm measured EXACTLY 0 while the lanes were pads (#2141, merged),
    // so any non-zero is the pads-to-live transition. It is deliberately NOT "> 100": that
    // would demand a geometric shift this projection's dead vertex site cannot produce,
    // which is how the first draft of this gate failed.
    expect(
      cd.count,
      `${tag}: ON + skew moved 0 px — the FRAGMENT sites are not consuming the recombined ` +
        'pair (line_endpoint / clip mask). This arm measured exactly 0 pre-#2042-INC-6, so ' +
        'a return to 0 means the wiring regressed.',
    ).toBeGreaterThan(0)
  } else {
    expect(
      cd.count,
      `${tag}: ON + skew did not move geometry — the VS is NOT consuming the skewed anchor ` +
        '(flag plumbing dead or select wired to the legacy arm); the A/B above is vacuous',
    ).toBeGreaterThan(100)
  }

  // Witness 2 — what "flag OFF" MEANS, and it is not the same on both binds.
  console.log(
    `[rtc-parity:${tag}] witness OFF+skew vs OFF: off=${off[0]!.hash.slice(0, 12)} offSkew=${offSkew.hash.slice(0, 12)}`,
  )
  if (splitBind) {
    // No select exists to bypass to: polygon-split.ts rewrites cam_h/cam_l to
    // the recombined arm ALONE (merc-cam-rel.ts's header), and the legacy
    // cam_ecef_off vec4s are retired outright. So the anchors are read
    // unconditionally and the skew MUST move the frame with the flag off.
    // Asserting the opposite here is what reddened this gate in #2165.
    expect(
      offSkew.hash,
      `${tag}: OFF + skew left the frame byte-identical on the SPLIT bind — the split path has ` +
        'no flag select, so the anchors must be read unconditionally. An inert skew here means ' +
        'the tile lanes are not reaching the shader at all (a stale arena pack, or the draw ' +
        'silently fell back to the ring), and Witness 1 above is measuring something else.',
    ).not.toBe(off[0]!.hash)
  } else {
    // The legacy monolithic bind DOES carry the select, and this is the only
    // place its off-arm is pinned: the skewed lanes are staged into the
    // uniform and the CPU-packed cam_ecef_off pair is read instead.
    expect(
      offSkew.hash,
      `${tag}: OFF + skew changed the frame — the legacy path is reading the anchor lanes`,
    ).toBe(off[0]!.hash)
  }
}

test('#2042 INC-1 — globe: recombined ECEF RTC matches legacy; the flag provably reaches the shader', async ({
  page,
}, testInfo) => {
  test.setTimeout(2_100_000)
  await runParity(page, testInfo, true)
})

test('#2042 INC-6 — flat: recombined Mercator cam-rel matches legacy; the flag provably reaches the shader', async ({
  page,
}, testInfo) => {
  test.setTimeout(2_100_000)
  _stepIdx = 0
  await runParity(page, testInfo, false)
})

// The flat test above runs `import_maplibre_mirror`, whose frame is dominated by
// `countries-fill` / `crimea-fill`. Its `> 100 px` witness is satisfied by the POLYGON fill
// alone, so it cannot distinguish a wired line recombination from a dead one — both fail
// identically, which is §12's "assertion that failed either way". This third test removes
// that: every pixel it measures is a stroke, so its witness bites on the LINE half and
// nothing else.
//
// Landed BEFORE the line half deliberately. A gate written after the change it judges has
// no tree left on which to show it discriminates; written before, its `LINE_HALF_WIRED=false`
// arm MEASURES that the anchors are inert today, and the commit that un-pads them flips one
// documented constant to claim the opposite. That before/after pair is the fail-before.
test('#2042 INC-6 — line-only Mercator: the FRAGMENT sites consume the recombined pair', async ({
  page,
}, testInfo) => {
  test.setTimeout(2_100_000)
  _stepIdx = 0
  await runParity(page, testInfo, false, /* lineOnly */ true)
})

// The companion arm, and the reason there are two. Mercator's `finalize_corner` is the
// identity passthrough, so the VERTEX site — the one that positions geometry — never runs
// there: the Mercator arm above can only ever see a fragment-stage perturbation. On
// equirectangular (projType 1) the inverse holds, so this arm is the only place a wrong
// recombined offset shows up as MOVED STROKES rather than shaded ones.
test('#2042 INC-6 — line-only equirectangular: the VERTEX site moves geometry', async ({
  page,
}, testInfo) => {
  test.setTimeout(2_100_000)
  _stepIdx = 0
  await runParity(page, testInfo, false, /* lineOnly */ true, 'equirectangular')
})

// The four tests above all measure the SHIPPING (split) bind, where there is no
// flag select — so none of them can pin what `__XGIS_RTC_RECOMBINE` does, and the
// OFF↔ON parity loop is an identity check there rather than a parity one. This
// fifth test is where the select itself is pinned, on the cheapest scene that can
// carry it (the stroke-only Mercator arm, ~1.2m): legacy bind, both arms of the
// select live, Witness 2 in its classic direction. Without it, retiring the select
// by accident would be invisible — the exact §12 shape (#1444) of an assertion that
// passes whichever way the mechanism is wired.
test('#2042 INC-6 — legacy bind: the flag select still has BOTH arms', async ({
  page,
}, testInfo) => {
  test.setTimeout(2_100_000)
  _stepIdx = 0
  await runParity(page, testInfo, false, /* lineOnly */ true, null, /* splitBind */ false)
})
