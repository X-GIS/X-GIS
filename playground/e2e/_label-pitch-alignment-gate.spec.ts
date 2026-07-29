import { test, expect } from '@playwright/test'

// #777 IV3-a ACCEPTANCE GATE — a `text-pitch-alignment: map` label's ground basis
// reaches the RENDERER, and is withheld when the camera is unpitched.
//
// WHY THIS ASSERTS A COUNT AND NOT PIXELS. The first version of this gate
// measured per-arm ink area and was discarded: it saw the map-aligned arm fall
// from ink-ratio 1.078 at pitch 0 to 0.462 at pitch 65 — close enough to
// cos(65°) = 0.42 to look exactly like the foreshortening under test — and it
// reproduced the SAME numbers with the producer pinned to return `undefined`.
// The signal was collision dropping three labels under pitch, not a quad lying
// down. That is the pixel-COUNT tripwire CLAUDE.md §12 names, and the gate would
// have shipped green over a feature that did nothing.
//
// `labels.groundAligned` is counted at the one place the draws are handed to the
// renderer (text-stage.ts, `renderer.setDraws`), so it distinguishes the two
// states this gate exists to tell apart, and no property of the frame's pixels
// can confuse it:
//
//   pitch 0  ⇒ 0   the basis is the identity there and is WITHHELD, so an
//                  unpitched frame stays bit-identical to the pre-IV3 path
//   pitch 65 ⇒ >0  the basis was produced AND survived to a draw
//
// Non-vacuity is established rather than assumed: on the tree this was written
// against, pitch 65 read 0 — the shipped wiring was inert because `groundBasisAt`
// held three tuples from a projector that returns a REUSED scratch array, so
// every basis collapsed to a singular matrix and was rejected. With that fixed it
// reads 2. The gate fails on the broken tree and passes on the fixed one.
//
// Headless SwiftShader (HEADED=0 XGIS_SOFTWARE_GPU=1), `?forcegl2=1`, backend
// asserted so a silent fallback cannot green it.

const URL_BASE = '/demo.html?id=fixture_label_pitch_alignment&forcegl2=1&e2e=1'

interface Labels {
  submitted: number
  drawn: number
  groundAligned: number
}

async function frameAt(
  page: import('@playwright/test').Page,
  pitch: number,
): Promise<{ labels: Labels; backend: string; livePitch: number }> {
  await page.setViewportSize({ width: 700, height: 600 })
  await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 30_000 },
  )
  const seeded = await page.evaluate((p) => {
    // Anchors along a MERIDIAN so the row spans the pitch gradient — near field
    // at the bottom, far field at the top. A longitude spread put four of five
    // off a 700 px viewport at z13 and left only the anchor at the camera
    // centre, which is the one point pitch cannot move.
    const features: unknown[] = []
    for (let i = 0; i < 5; i++) {
      features.push({
        type: 'Feature',
        properties: { name: `AAAA${i}` },
        geometry: { type: 'Point', coordinates: [2.34, 48.836 + i * 0.007] },
      })
    }
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
    m.setSourceData('pins', { type: 'FeatureCollection', features })
    // The camera is driven through the map, not the URL hash: the hash form left
    // pitch at 0 and pitch 0 vs 65 came back pixel-identical, which is how that
    // was caught. `livePitch` below pins that it took.
    const R = 6378137
    const RAD = Math.PI / 180
    const c = m.getCamera()
    c.zoom = 13
    c.centerX = 2.34 * RAD * R
    c.centerY = Math.log(Math.tan(Math.PI / 4 + (48.85 * RAD) / 2)) * R
    c.bearing = 0
    c.pitch = p
    m.markCameraPositioned()
    m.invalidate?.()
    return features.length
  }, pitch)
  expect(seeded).toBe(5)
  await page.waitForTimeout(6000)
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

test('#777 IV3-a — the ground basis reaches the renderer under pitch, and only under pitch', async ({
  page,
}) => {
  test.setTimeout(300_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))

  const flat = await frameAt(page, 0)
  const tilted = await frameAt(page, 65)

  console.log(
    `\n  pitch  0: ${JSON.stringify(flat.labels)}` +
      `\n  pitch 65: ${JSON.stringify(tilted.labels)}` +
      `\n  backend=${tilted.backend}\n`,
  )

  expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([])
  expect(tilted.backend).toBe('webgl2')
  expect(flat.livePitch).toBeCloseTo(0, 3)
  expect(tilted.livePitch).toBeCloseTo(65, 3)

  // Both frames must be drawing, or every count below is vacuous.
  expect(flat.labels.drawn, 'nothing drawn at pitch 0').toBeGreaterThan(0)
  expect(tilted.labels.drawn, 'nothing drawn at pitch 65').toBeGreaterThan(0)

  // THE CLAIM: the producer's basis survived to a draw.
  expect(
    tilted.labels.groundAligned,
    `no drawn label carried a ground basis at pitch 65 (drawn ${tilted.labels.drawn}) — the ` +
      `producer ran but nothing reached the renderer. This is the state the shipped wiring ` +
      `was in: groundBasisAt held three tuples from a projector that reuses one scratch ` +
      `array, so every basis collapsed to a singular matrix and was rejected.`,
  ).toBeGreaterThan(0)

  // THE NO-REGRESSION RUNG: at pitch 0 the basis is the identity and is withheld,
  // so an unpitched frame takes exactly the pre-IV3 billboard path. It is also
  // what makes the assertion above non-vacuous — a producer that handed out a
  // basis unconditionally would fail here.
  expect(
    flat.labels.groundAligned,
    `a ground basis was supplied at pitch 0 (${flat.labels.groundAligned} of ` +
      `${flat.labels.drawn} draws) — the identity must be withheld, or unpitched frames stop ` +
      `being bit-identical to the pre-IV3 path`,
  ).toBe(0)
})
