import { test, expect } from '@playwright/test'

// #2012 INC-4 ACCEPTANCE GATE — a CURVED line label's ground basis reaches the
// RENDERER under pitch, and is withheld when the camera is unpitched.
//
// The sibling gate (_label-pitch-alignment-gate) pins the POINT path the same way
// and its reasoning transfers verbatim, including why this asserts a COUNT and not
// pixels: the first version of that gate measured per-arm ink area, watched it fall
// close to cos(pitch), and reproduced the SAME numbers with the producer pinned to
// return `undefined` — the signal was collision dropping labels, not a quad lying
// down. That is the pixel-COUNT tripwire CLAUDE.md §12 names.
//
// `labels.groundAligned` is counted at the one place draws are handed to the
// renderer (text-stage.ts → `renderer.setDraws`), so it distinguishes the two
// states this gate exists to tell apart and no property of the frame's pixels can
// confuse it:
//
//   pitch 0  ⇒ 0   the pitch-0 twin of the polyline IS the polyline, the basis is
//                  the identity and is WITHHELD, so the frame stays bit-identical
//                  to the pre-INC-4 path (MEASURED: md5 dc829700… at z16.7/pitch 0
//                  is the same byte-for-byte before and after the increment)
//   pitch 60 ⇒ >0  the label plane was built, the basis survived to a draw
//
// Non-vacuity is established rather than assumed. On the pre-INC-4 tree this reads
// 0 at BOTH pitches — measured on a reverted worktree at the same cameras — while
// on this one pitch 60 reads 2, and the frame md5 changes only there (0.185 % DC,
// confined to two glyph runs; 14 of 16 diff tiles exactly 0.0 %).
//
// The fixture is purpose-built and OFFLINE for a reason the design records: the
// layers that resolve to `map` on a real basemap are line-placed road names, which
// need the network, and a §5 gate that cannot run without it silently degrades
// into the downscaled eyeball CLAUDE.md §5 forbids.
//
// Headless SwiftShader (HEADED=0 XGIS_SOFTWARE_GPU=1), `?forcegl2=1`, backend
// asserted so a silent fallback cannot green it.

const URL_BASE = '/demo.html?id=fixture_curved_label_ground&forcegl2=1&e2e=1'

interface Labels {
  submitted: number
  drawn: number
  groundAligned: number
}

async function frameAt(
  page: import('@playwright/test').Page,
  zoom: number,
  pitch: number,
  bearing: number,
): Promise<{ labels: Labels; backend: string; livePitch: number }> {
  await page.setViewportSize({ width: 1200, height: 800 })
  await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 60_000 },
  )
  await page.evaluate(
    (cam) => {
      // The camera is driven through the map, not the URL hash: the hash form left
      // pitch at 0 in the sibling gate and both frames came back identical, which
      // is how that was caught. `livePitch` below pins that it took.
      const R = 6378137
      const RAD = Math.PI / 180
      const m = (
        window as unknown as {
          __xgisMap: {
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
      const c = m.getCamera()
      c.zoom = cam.zoom
      c.centerX = 126.79102 * RAD * R
      c.centerY = Math.log(Math.tan(Math.PI / 4 + (37.79172 * RAD) / 2)) * R
      c.bearing = cam.bearing
      c.pitch = cam.pitch
      m.markCameraPositioned()
      m.invalidate?.()
    },
    { zoom, pitch, bearing },
  )
  await page.waitForTimeout(9000)
  return await page.evaluate(() => {
    const w = window as unknown as {
      __xgisMap: {
        inspectPipeline(): { labels: Labels }
        ctx?: { rhi?: { backend?: string } }
        getCamera(): { pitch: number }
      }
    }
    return {
      labels: w.__xgisMap.inspectPipeline().labels,
      backend: w.__xgisMap.ctx?.rhi?.backend ?? 'unknown',
      livePitch: w.__xgisMap.getCamera().pitch,
    }
  })
}

test.describe.configure({ mode: 'serial' })

test('#2012 INC-4 — a curved line label lies in the ground plane under pitch, and only under pitch', async ({
  page,
}) => {
  test.setTimeout(300_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))

  const flat = await frameAt(page, 16.7, 0, 0)
  const tilted = await frameAt(page, 16.7, 60, 0)

  console.log(
    `\n  z16.7 pitch  0: ${JSON.stringify(flat.labels)}` +
      `\n  z16.7 pitch 60: ${JSON.stringify(tilted.labels)}` +
      `\n  backend=${tilted.backend}\n`,
  )

  expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([])
  expect(tilted.backend).toBe('webgl2')
  expect(flat.livePitch).toBeCloseTo(0, 3)
  expect(tilted.livePitch).toBeCloseTo(60, 3)

  // Both frames must be drawing, or every count below is vacuous.
  expect(flat.labels.drawn, 'nothing drawn at pitch 0').toBeGreaterThan(0)
  expect(tilted.labels.drawn, 'nothing drawn at pitch 60').toBeGreaterThan(0)

  // THE CLAIM: the label plane was built for a curved run and its basis survived
  // to a draw. Reads 0 on the pre-INC-4 tree at this exact camera.
  expect(
    tilted.labels.groundAligned,
    `no drawn curved label carried a ground basis at pitch 60 (drawn ${tilted.labels.drawn}) — ` +
      `the chain exists but nothing reached the renderer. That is the #1081 shape of failure: ` +
      `a complete, correct chain fed from a dispatch site that never runs.`,
  ).toBeGreaterThan(0)

  // THE NO-REGRESSION RUNG: at pitch 0 the pitch-0 twin of the polyline is the
  // polyline itself, so the walk, the cadence and the basis all reduce to the
  // pre-INC-4 path and the frame is bit-identical. It is also what makes the
  // assertion above non-vacuous — a producer handing out a basis unconditionally
  // would fail here.
  expect(
    flat.labels.groundAligned,
    `a ground basis was supplied at pitch 0 (${flat.labels.groundAligned} of ` +
      `${flat.labels.drawn} draws) — the identity must be withheld, or unpitched frames stop ` +
      `being bit-identical to the pre-INC-4 path`,
  ).toBe(0)
})
