import { test, expect, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'

// #2118 ACCEPTANCE GATE — `circle-pitch-alignment: map` reaches the GPU and bends
// the disc into the ground plane, `circle-pitch-scale: map` moves the far-field
// radius, and an UNPITCHED frame is byte-identical across all three arms.
//
// WHAT THIS MEASURES, AND WHY IT IS NOT A PIXEL COUNT. The sibling gate for
// labels (_label-pitch-alignment-gate) records that its first version measured
// per-arm ink AREA, watched it fall by almost exactly cos(pitch), and reproduced
// the same numbers with the feature pinned off — the signal was collision, not
// foreshortening. A circle has no collision, but AREA alone is still the wrong
// statistic here for a different reason: BOTH knobs shrink area. `scale: map`
// shrinks it isotropically and `alignment: map` shrinks it anisotropically, so an
// area gate cannot tell them apart and would stay green with the two wired to each
// other. The statistic that separates them is the ink box's ASPECT RATIO:
//
//   alignment map  → aspect moves      (an ellipse: the north axis foreshortens)
//   scale map      → aspect UNCHANGED  (a smaller circle is still a circle)
//
// so the gate asserts aspect for one knob and effective RADIUS for the other, and
// asserts the cross terms hold still. Wire either knob to the other's uniform lane
// and one of the four assertions below names which.
//
// THE PITCH-0 RUNG IS A HASH, NOT A TOLERANCE — all three arms SHA-256'd over the
// whole framebuffer and required equal. That is the top rung of §5's ladder, and it
// is reachable only because the frame is CONVERGED rather than waited on: the first
// version of this spec slept 5 s and its own noise-floor guard caught two identical
// runs hashing differently. A guessed duration samples whatever the frame happened
// to be; `settle()` below pumps `invalidate()` until the hash repeats three times
// with no tiles in flight (#1620, the recipe _1678-hillshade-bake-hash-gate uses).
// The noise floor is still measured FIRST, on the same code, so "equal" is known to
// mean something on this rasteriser before any arm is compared to another.
//
// Headless SwiftShader (HEADED=0 XGIS_SOFTWARE_GPU=1), `?forcegl2=1`, backend
// asserted in-spec so a silent WebGPU/CPU fallback cannot green it.

// 'test-results/…' is the convention every other parity spec here uses, and the
// reason is mechanical: playground/test-results/ is gitignored, so the artifacts a
// gate writes on every run never show up as untracked strays.
const OUT = 'test-results/circle-pitch'
const W = 700
const H = 700
// Camera: flat Mercator, bearing 0, so "north" is straight up the screen and the
// far field is unambiguous.
//
// THE PROBE OFFSET IS MEASURED, NOT GUESSED, AND THE FIRST GUESS WAS WRONG. A
// degree of LATITUDE is not a fixed number of Mercator metres — it carries the
// 1/cos(lat) scale factor, so at 48.8° one degree is ~169 km of merc-y, not
// ~111 km. The first version of this spec used +0.02° reasoning from 111 km, put
// the disc ~354 px above centre, and pushed it clean off the top of the 609 px
// canvas: every arm rendered a BLANK frame, and the pitch-0 hash rung then
// "passed" by comparing three identical black images. That is the §12
// assertion-that-failed-either-way in its purest form, and only reading the frames
// caught it. +0.01° puts the disc ~178 px above centre at pitch 0 and ~76 px at
// pitch 60 — comfortably whole in both — while leaving w_ref/clip.w at 0.856 at
// pitch 60, well clear of the 1.0 it would be at the camera target where the scale
// arm is EXACTLY a no-op. The whole-disc assertions below are what keep this
// honest if the canvas size ever changes.
const CENTER_LON = 2.34
const CENTER_LAT = 48.83
const PROBE_LAT = CENTER_LAT + 0.01
const ZOOM = 13

type Arm = 'default' | 'align' | 'scale'
const SOURCES: Record<Arm, string> = {
  default: 'pt_default',
  align: 'pt_align',
  scale: 'pt_scale',
}

interface Ink {
  readonly area: number
  readonly boxW: number
  readonly boxH: number
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
}
interface Frame {
  readonly hash: string
  readonly ink: Ink
  readonly backend: string
  readonly livePitch: number
  readonly bufW: number
  readonly bufH: number
}

/** Aspect = ink-box height / width. A screen-facing disc is 1; a disc lying in a
 *  ground plane tilted by `pitch` and viewed along bearing 0 foreshortens its
 *  north–south extent and drops below 1. */
const aspect = (i: Ink): number => i.boxH / i.boxW
/** Effective radius from AREA, not from a box extent: it is the same statistic for
 *  a circle and an ellipse (area = π·a·b), so the two knobs can be compared on one
 *  scale without a shape assumption. */
const effR = (i: Ink): number => Math.sqrt(i.area / Math.PI)

const invalidate = (page: Page): Promise<void> =>
  page.evaluate(() =>
    (window as unknown as { __xgisMap?: { invalidate?(): void } }).__xgisMap?.invalidate?.(),
  )

/** Full-frame RGBA readback → SHA-256 + the ink box. Only scalars cross the CDP
 *  bridge. The non-background test is deliberately generous: the disc's AA rim is a
 *  blend toward the background, and excluding it would make the ink box depend on
 *  the rim's own width, which pitch also changes. Background is sampled from a
 *  CORNER rather than hardcoded — the fixture has no basemap, so whatever the clear
 *  colour is, that is what the corner holds. */
const readFrame = (page: Page): Promise<Frame> =>
  page.evaluate(async () => {
    const w = window as unknown as {
      __xgisMap: {
        ctx?: { rhi?: { gl?: WebGL2RenderingContext; backend?: string } }
        getCamera(): { pitch: number }
      }
    }
    const gl = w.__xgisMap.ctx?.rhi?.gl
    if (!gl) throw new Error('no WebGL2 context — the forcegl2 arm did not take')
    const bw = gl.drawingBufferWidth
    const bh = gl.drawingBufferHeight
    const buf = new Uint8Array(bw * bh * 4)
    gl.readPixels(0, 0, bw, bh, gl.RGBA, gl.UNSIGNED_BYTE, buf)
    const b0 = buf[0]!,
      b1 = buf[1]!,
      b2 = buf[2]!
    let area = 0,
      minX = bw,
      minY = bh,
      maxX = -1,
      maxY = -1
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const i = (y * bw + x) * 4
        const d = Math.abs(buf[i]! - b0) + Math.abs(buf[i + 1]! - b1) + Math.abs(buf[i + 2]! - b2)
        if (d > 24) {
          area++
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }
    const digest = await crypto.subtle.digest('SHA-256', buf)
    const hash = [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, '0')).join('')
    return {
      hash,
      ink: { area, boxW: maxX - minX + 1, boxH: maxY - minY + 1, minX, minY, maxX, maxY },
      backend: w.__xgisMap.ctx?.rhi?.backend ?? 'unknown',
      livePitch: w.__xgisMap.getCamera().pitch,
      bufW: bw,
      bufH: bh,
    }
  })

/** Wait for CONVERGENCE, not a guessed duration (#1620): three consecutive identical
 *  frame hashes with ink actually present. The ink predicate matters — a hash-only
 *  loop accepts the all-background plateau before the point layer has drawn at all,
 *  and two arms that both settle on "empty" would hash-match perfectly and green a
 *  dead feature (the §12 "assertion that failed either way"). */
async function settle(page: Page, timeoutMs = 90_000): Promise<Frame> {
  const deadline = Date.now() + timeoutMs
  let prev = await readFrame(page)
  let stable = 0
  while (Date.now() < deadline) {
    await invalidate(page)
    await page.waitForTimeout(150)
    const cur = await readFrame(page)
    if (cur.hash === prev.hash && cur.ink.area > 500) {
      if (++stable >= 2) return cur
    } else {
      stable = 0
    }
    prev = cur
  }
  return prev
}

async function frameFor(page: Page, arm: Arm, pitch: number): Promise<Frame> {
  await page.setViewportSize({ width: W, height: H })
  await page.goto(`/demo.html?id=fixture_circle_pitch&forcegl2=1&e2e=1`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 30_000 },
  )
  const seeded = await page.evaluate(
    ({ src, p, clon, clat, plat, zoom, sources }) => {
      const m = (
        window as unknown as {
          __xgisMap: {
            setSourceData(id: string, d: unknown): void
            getCamera(): {
              zoom: number
              centerX: number
              centerY: number
              bearing: number
              pitch: number
            }
            markCameraPositioned(): void
            invalidate?(): void
          }
        }
      ).__xgisMap
      // Exactly ONE arm carries the feature; the other two are explicitly emptied
      // rather than left unset, so a stale source from a previous navigation can
      // never contribute a second disc to the bbox.
      for (const s of sources) {
        m.setSourceData(s, {
          type: 'FeatureCollection',
          features:
            s === src
              ? [
                  {
                    type: 'Feature',
                    properties: {},
                    geometry: { type: 'Point', coordinates: [clon, plat] },
                  },
                ]
              : [],
        })
      }
      // The camera is driven through the map, not the URL hash — the hash form is
      // what left pitch at 0 in the sibling label gate and made two pitches come
      // back pixel-identical. `livePitch` below pins that it took.
      const R = 6378137
      const RAD = Math.PI / 180
      const c = m.getCamera()
      c.zoom = zoom
      c.centerX = clon * RAD * R
      c.centerY = Math.log(Math.tan(Math.PI / 4 + (clat * RAD) / 2)) * R
      c.bearing = 0
      c.pitch = p
      m.markCameraPositioned()
      m.invalidate?.()
      return 1
    },
    {
      src: SOURCES[arm],
      p: pitch,
      clon: CENTER_LON,
      clat: CENTER_LAT,
      plat: PROBE_LAT,
      zoom: ZOOM,
      sources: Object.values(SOURCES),
    },
  )
  expect(seeded).toBe(1)
  return settle(page)
}

/** EVERY frame this gate reasons about must contain ONE WHOLE DISC.
 *
 *  This is not defensive tidiness — it is the assertion the first version of this
 *  spec lacked, and its absence made the headline rung meaningless. With the probe
 *  offset mis-derived the disc sat entirely off the top of the canvas, all three
 *  arms rendered pure black, and "the three hashes are equal" was true of three
 *  blank images. A hash rung is only evidence when something is in the frame, and a
 *  CLIPPED disc is just as bad in the other direction: its bbox is then governed by
 *  the viewport edge, so its aspect ratio — the statistic the alignment knob is
 *  judged on — would move for a reason that has nothing to do with the ground
 *  plane. Both failure modes are checked here, on every frame, before any
 *  comparison uses it. */
function wholeDisc(f: Frame, where: string): void {
  expect(
    f.ink.area,
    `${where}: NO DISC IN FRAME — any equality below would be vacuous`,
  ).toBeGreaterThan(1500)
  expect(f.ink.minX, `${where}: disc clipped at the left edge`).toBeGreaterThan(1)
  expect(f.ink.minY, `${where}: disc clipped at the top edge`).toBeGreaterThan(1)
  expect(f.ink.maxX, `${where}: disc clipped at the right edge`).toBeLessThan(f.bufW - 2)
  expect(f.ink.maxY, `${where}: disc clipped at the bottom edge`).toBeLessThan(f.bufH - 2)
}

test('#2118 circle pitch knobs — pitch-0 hash identity, and a measured ellipse at pitch 60', async ({
  page,
}) => {
  test.setTimeout(600_000)
  mkdirSync(OUT, { recursive: true })
  const log: Record<string, unknown> = {}

  // ── 0. NOISE FLOOR, measured before anything is compared to anything ─────────
  // Two runs of the SAME arm through the SAME code. If these differ, every
  // equality below is meaningless and every inequality is suspect — so this is
  // asserted first rather than assumed (§5's "measure the same-code noise floor").
  // It has already earned its place once: it caught the sleep-based version of
  // this spec sampling unconverged frames.
  const n1 = await frameFor(page, 'default', 60)
  const n2 = await frameFor(page, 'default', 60)
  expect(n1.backend, 'the WebGL2 arm did not take — a fallback would green this').toContain(
    'webgl2',
  )
  expect(n1.livePitch).toBeCloseTo(60, 5)
  log.noiseFloor = { hashA: n1.hash, hashB: n2.hash, inkA: n1.ink, inkB: n2.ink }
  expect(
    n2.hash,
    'SAME-CODE NOISE FLOOR: two identical runs disagree — the harness is not deterministic',
  ).toBe(n1.hash)
  expect(n2.ink.area).toBe(n1.ink.area)

  wholeDisc(n1, 'noise-floor default @60')

  // ── 1. PITCH 0 — all three arms byte-identical ──────────────────────────────
  const p0: Record<Arm, Frame> = {
    default: await frameFor(page, 'default', 0),
    align: await frameFor(page, 'align', 0),
    scale: await frameFor(page, 'scale', 0),
  }
  log.pitch0 = {
    default: p0.default.hash,
    align: p0.align.hash,
    scale: p0.scale.hash,
    ink: p0.default.ink,
  }
  expect(p0.default.livePitch).toBe(0)
  // Non-vacuity FIRST, then equality — in that order, because equality between two
  // empty frames is the trap this exists to close.
  wholeDisc(p0.default, 'default @0')
  wholeDisc(p0.align, 'align @0')
  wholeDisc(p0.scale, 'scale @0')
  // THE REGRESSION RUNG. Not "close", not a DC threshold — the same bytes. The
  // renderer suppresses the ground-alignment mode on `camera.pitch`, and
  // w_ref/clip.w is exactly 1 over an unpitched flat MVP (its perspective term
  // over the ground plane is zero, so clip.w is the constant mvp[15]), so both
  // knobs reduce to literally the historical arithmetic path.
  expect(
    p0.align.hash,
    'circle-pitch-alignment:map CHANGED an unpitched frame — that is a regression, not a feature',
  ).toBe(p0.default.hash)
  expect(
    p0.scale.hash,
    'circle-pitch-scale:map CHANGED an unpitched frame — that is a regression, not a feature',
  ).toBe(p0.default.hash)

  // ── 2. PITCH 60 — the two knobs move DIFFERENT statistics ───────────────────
  const p60: Record<Arm, Frame> = {
    default: n1,
    align: await frameFor(page, 'align', 60),
    scale: await frameFor(page, 'scale', 60),
  }
  const A = {
    default: { aspect: aspect(p60.default.ink), r: effR(p60.default.ink), ink: p60.default.ink },
    align: { aspect: aspect(p60.align.ink), r: effR(p60.align.ink), ink: p60.align.ink },
    scale: { aspect: aspect(p60.scale.ink), r: effR(p60.scale.ink), ink: p60.scale.ink },
  }
  log.pitch60 = A
  writeFileSync(`${OUT}/measurements.json`, JSON.stringify(log, null, 2))
  wholeDisc(p60.align, 'align @60')
  wholeDisc(p60.scale, 'scale @60')

  // (a) alignment:map FLATTENS the disc. The un-tilted arms are circles, so their
  //     aspect sits at 1; the ground-plane arm's north axis foreshortens.
  expect(
    A.default.aspect,
    'the viewport-aligned arm is not circular — the measurement is wrong before any knob is judged',
  ).toBeGreaterThan(0.93)
  expect(A.default.aspect).toBeLessThan(1.07)
  expect(
    A.align.aspect,
    `alignment:map did not flatten the disc (aspect ${A.align.aspect} vs default ${A.default.aspect})`,
  ).toBeLessThan(A.default.aspect * 0.85)

  // (b) scale:map leaves the SHAPE alone — a smaller circle is still a circle.
  //     This is the assertion that stops the two knobs being wired to each other:
  //     if scale reached the basis lane, this aspect would collapse too.
  expect(
    A.scale.aspect,
    `scale:map changed the SHAPE (aspect ${A.scale.aspect}) — it must only change the size`,
  ).toBeGreaterThan(A.default.aspect * 0.9)

  // (c) scale:map MOVES the far-field radius; the default does not. Directional,
  //     not an absolute px figure: the reference is the same frame's own default
  //     arm, so a change in camera, viewport or rasteriser cannot drift the bar.
  expect(
    A.scale.r,
    `scale:map did not shrink the far-field radius (${A.scale.r} vs ${A.default.r})`,
  ).toBeLessThan(A.default.r * 0.95)

  // (d) …and alignment:map is NOT merely the scale arm wearing a different name:
  //     the three frames must differ, or one knob is silently driving another.
  expect(p60.align.hash).not.toBe(p60.scale.hash)
  expect(p60.align.hash).not.toBe(p60.default.hash)
  expect(p60.scale.hash).not.toBe(p60.default.hash)
})
