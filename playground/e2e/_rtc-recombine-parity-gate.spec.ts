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
//   • OFF + skew 5e5 m → frame MUST equal the OFF arm byte-for-byte — the
//     skewed lanes are staged but the legacy path never reads them; proves
//     flag-off really bypasses the anchors.
//
// Scene/settle harness mirrors _bundle-replay-parity-gate.spec.ts (the same
// hard-won constraints): committed demotiles mirror (offline, TERMINAL tile
// content → history-independent hashes), zoom < 2 band (mirror coverage +
// SwiftShader raster budget), idle-event settle with the listener registered
// BEFORE the camera moves, full-script warmup per arm (glyph ranges), reduced
// motion, clipped page.screenshot (element screenshots never stabilize),
// post-ready page.evaluate flag injection (addInitScript stacking measured
// broken across arm navigations).

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

type Arm = { recombine: boolean; skewM: number }

let _clip: { x: number; y: number; width: number; height: number } | null = null
let _stepIdx = 0

async function bootArm(page: Page, arm: Arm, globe: boolean): Promise<void> {
  _clip = null
  await page.emulateMedia({ reducedMotion: 'reduce' })
  // proj=globe — the ECEF RTC recombination (INC-1) lives in the projection
  // ladder's 3D arm, which only globe(7) takes (measured: on the flat scene
  // an ECEF anchor skew changed ZERO pixels — the witness refused to certify
  // a vacuous A/B, twice, before this URL carried the projection). The FLAT
  // scene became meaningful at INC-6: its Mercator cam-rel recombination is
  // what the flat test below exercises (the skew hook moves BOTH anchors'
  // X, so each scene's witness bites on its own arm).
  await page.goto(
    `/demo.html?id=import_maplibre_mirror${globe ? '&proj=globe' : ''}&e2e=1&msaa=1#1.5/20/140`,
    { waitUntil: 'domcontentloaded' },
  )
  console.log(`[rtc-parity] boot(${JSON.stringify(arm)}): navigated, waiting ready`)
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 240_000 },
  )
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
): Promise<void> {
  const tag = globe ? 'globe' : 'flat'
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e)))
  await page.setViewportSize({ width: 288, height: 160 })

  // Arm A — legacy (flag off, no skew): the reference.
  await bootArm(page, { recombine: false, skewM: 0 }, globe)
  const off = await runScript(page)

  // Arm B — recombine ON.
  await bootArm(page, { recombine: true, skewM: 0 }, globe)
  const on = await runScript(page)

  // Arm C — recombine ON + witness skew: single pose, must move geometry
  // (globe: the ECEF anchor X; flat: the Mercator origin X — the hook skews
  // both, each scene's live arm reads its own).
  await bootArm(page, { recombine: true, skewM: WITNESS_SKEW_M }, globe)
  const onSkew = await stepAndSettle(page, SCRIPT[0]!)

  // Arm D — recombine OFF + witness skew: single pose, must be inert.
  await bootArm(page, { recombine: false, skewM: WITNESS_SKEW_M }, globe)
  const offSkew = await stepAndSettle(page, SCRIPT[0]!)

  // ── Verdicts ──
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
  expect(
    cd.count,
    `${tag}: ON + skew did not move geometry — the VS is NOT consuming the skewed anchor ` +
      '(flag plumbing dead or select wired to the legacy arm); the A/B above is vacuous',
  ).toBeGreaterThan(100)

  // Witness 2 — flag OFF really bypasses the anchors: the skewed lanes are
  // staged into the uniform but the legacy path never reads them.
  console.log(
    `[rtc-parity:${tag}] witness OFF+skew vs OFF: off=${off[0]!.hash.slice(0, 12)} offSkew=${offSkew.hash.slice(0, 12)}`,
  )
  expect(
    offSkew.hash,
    `${tag}: OFF + skew changed the frame — the legacy path is reading the anchor lanes`,
  ).toBe(off[0]!.hash)
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
