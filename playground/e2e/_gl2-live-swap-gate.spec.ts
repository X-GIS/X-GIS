// ═══ forcegl2 live-swap re-boot gate (#1196) ═══
//
// A second `map.run()` on a live forced-WebGL2 map re-boots the device on the
// SAME canvas-sticky GL context: the entry teardown loses the context, and the
// remount must restore it (rhi gl2-restore-token + the macrotask restore in
// gpu.ts ensureWebGl2ContextRestored). Pre-fix this either dropped a tile
// ("vertex compile failed", ~7 000 px) or failed the whole boot into the
// WebGPU-unavailable UX. The gate asserts the re-run frame equals the first
// mount within the same-code noise band, and that no real errors surface.

import { test, expect, type Page } from '@playwright/test'
import { PNG } from 'pngjs'
import { collectPageErrors } from './_page-errors'

const shootRaw = async (page: Page): Promise<Buffer> =>
  await page.locator('#xg-canv, canvas').first().screenshot()

/** The resolution the camera last built its MVP for — the quantity `?adaptive=0` pins, and
 *  the one whose silent change made this gate unreadable for three rounds (#1733). Read
 *  from the camera's own cache rather than the canvas element, because the element stays
 *  860x720 while the ladder moves the RENDER scale underneath it. */
const renderScale = async (page: Page): Promise<string> =>
  await page.evaluate(() => {
    const c = (window as unknown as { __xgisMap?: { camera?: Record<string, unknown> } }).__xgisMap
      ?.camera
    return `${String(c?._cacheW)}x${String(c?._cacheH)}@${String(c?._cacheDpr)}`
  })

/** Settle DETERMINISTICALLY, then capture (#1733).
 *
 * This was a 25 x 80 ms `invalidate()` pump — 2 s of wall clock — which made the gate's
 * verdict depend on how loaded the machine was. Two bounded stages replace it, neither an
 * unconditional sleep:
 *   1. the map's own `idle` event (the render loop reporting nothing left to draw), with
 *      `invalidate()` first so it RE-fires past the listener-attach race;
 *   2. captures until two consecutive ones are byte-identical, because streaming can
 *      re-dirty a frame after an `idle` (late tiles).
 *
 * Both fail LOUD and name which stage gave up, so a never-idle or never-stable regression
 * reports itself instead of arriving as an unexplained pixel diff. Ported from
 * `_webgl2-parity.spec.ts:53-109`, which already does exactly this.
 *
 * On its own this did NOT make the gate green under load, and that was the useful part:
 * with convergence no longer measured in seconds, the diff that remained could not be a
 * settle artifact, which is what pointed at the resolution ladder (see the `?adaptive=0`
 * note below). Both are needed — this one makes the capture deterministic, that one makes
 * the two captures comparable.
 *
 * The CAPTURE surface is deliberately unchanged: the 310 px threshold below is calibrated
 * against this element screenshot, so swapping in a canvas-native readback would silently
 * invalidate the calibration.
 */
async function settle(page: Page): Promise<Buffer> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const m = (
          window as unknown as {
            __xgisMap?: { on?: (t: string, cb: () => void) => void; invalidate?: () => void }
          }
        ).__xgisMap
        if (!m?.on)
          return reject(new Error('__xgisMap.on unavailable — demo did not expose the map'))
        const t = setTimeout(() => reject(new Error("map never fired 'idle' within 60s")), 60_000)
        m.on('idle', () => {
          clearTimeout(t)
          resolve()
        })
        m.invalidate?.()
      }),
  )
  let png = await shootRaw(page)
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(300)
    const next = await shootRaw(page)
    const stable = Buffer.compare(png, next) === 0
    png = next
    if (stable) return png
  }
  throw new Error('frame never settled: 15 consecutive captures kept changing after idle')
}

test('re-run() on a live forcegl2 map re-boots and renders the same frame', async ({ page }) => {
  test.setTimeout(240_000)
  const errors = collectPageErrors(page)

  // `adaptive=0` pins the resolution ladder OFF for the duration (#1733).
  //
  // Without it this gate silently compares two frames rendered at DIFFERENT resolutions.
  // Under batch load SwiftShader falls below the ladder's 33.4 ms step-down line, the
  // controller drops to its `{ farLod: 4, dpr: 0.85 }` notch
  // (`engine/src/gpu/adaptive-quality.ts:91`), and the FIRST capture lands at 731x612 —
  // 860 x 0.85 and 720 x 0.85, exactly. The `run()` re-boot resets the controller, so the
  // second capture is at 860x720. Same geometry, same camera, resampled differently: an
  // edge-only diff of 43089 px, byte-reproducible, with fills untouched.
  //
  // That confound cost three wrong diagnoses (flake, then a re-boot defect, then MSAA)
  // before the camera state was dumped whole rather than field-by-field. The ladder is
  // not this gate's subject; the re-boot is.
  //
  // A SECOND magnitude (~618073 px, 99.8% of the frame, logged three times) stayed
  // unexplained after #1733 and kept this gate dark. It is the SAME cause one rung lower:
  // the ladder has seven notches (`adaptive-quality.ts` LADDER) and under a saturated CPU
  // the controller walks to its FLOOR, `{ farLod: 6, dpr: 0.5 }`. Reproduced by pinning six
  // busy loops to a 4-core box: `diffPixels=618061`, `scale=430x360@0.5 → 619x518@0.72` —
  // 860 x 0.5 and 720 x 0.5 exactly, against a partially-restored second capture. At that
  // depth `farLod` also coarsens geometry, so unlike the 0.85 rung the diff is not
  // edge-only; it is the whole frame, which is why it read as a blank-frame boot failure.
  // It is not one: measured at the failure, `contextLost=false`, `drawCalls=3`,
  // `vertices=838638`, zero console errors, and capture A carries 1402 distinct colours.
  // Nothing is broken — the two frames are simply rendered at different resolutions.
  //
  // `?adaptive=0` covers this rung too, proven by A/B under identical saturation:
  // ladder on → 618061 px, 4/4 red; ladder pinned → 0 px, 4/4 green, scale 860x720@1 both
  // captures. That is what took this gate off KNOWN_DARK_GATES.
  await page.goto('/demo.html?id=minimal&e2e=1&forcegl2=1&adaptive=0', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 60_000 },
  )
  // The demo page's warning overlay would repaint over the canvas region on
  // the re-boot (the forced-webgl2 banner warn) — keep the shots map-only.
  await page.addStyleTag({ content: '#log-overlay { display: none !important; }' })
  // Pin the camera: run() re-fits bounds, and its fit differs from the demo
  // mount's — the gate compares RENDERING, not camera policy.
  await page.evaluate(() => {
    const m = (
      window as unknown as {
        __xgisMap?: { setZoom: (z: number) => void; setCenter: (lon: number, lat: number) => void }
      }
    ).__xgisMap!
    m.setZoom(0.5)
    m.setCenter(0, 0)
  })
  const a = PNG.sync.read(await settle(page))
  const scaleA = await renderScale(page)

  // Live swap: identical source through the public run() — the re-boot path.
  await page.evaluate(async () => {
    const w = window as unknown as { __xgisMap?: { run: (t: string, b: string) => Promise<void> } }
    await w.__xgisMap!.run(
      `xgis 1
source world { type: geojson, url: "ne_110m_countries.geojson" }
layer countries { source: world
  | fill-stone-200 stroke-stone-400 stroke-1
}`,
      '/data/',
    )
  })
  await page.evaluate(() => {
    const m = (
      window as unknown as {
        __xgisMap?: { setZoom: (z: number) => void; setCenter: (lon: number, lat: number) => void }
      }
    ).__xgisMap!
    m.setZoom(0.5)
    m.setCenter(0, 0)
  })
  const b = PNG.sync.read(await settle(page))
  const scaleB = await renderScale(page)

  let diff = 0
  for (let i = 0; i < a.data.length; i += 4) {
    if (
      a.data[i] !== b.data[i] ||
      a.data[i + 1] !== b.data[i + 1] ||
      a.data[i + 2] !== b.data[i + 2]
    )
      diff++
  }
  console.log(`[gl2-live-swap] diffPixels=${diff}/${a.width * a.height} scale=${scaleA}→${scaleB}`)
  // Fails LOUD if the ladder ever moves mid-test again, instead of surfacing as an
  // unexplained pixel diff — the whole failure mode of #1733. Asserted BEFORE the pixel
  // comparison so the message names the cause rather than the symptom.
  expect(
    scaleB,
    `render scale changed between the two captures (${scaleA} → ${scaleB}) — the adaptive ` +
      'ladder moved despite ?adaptive=0, so the frames are not comparable',
  ).toBe(scaleA)
  // Same calibration family as _scene-builder-twin.spec.ts: same-code page
  // loads differ by ~78 px under SwiftShader; the pre-fix tile drop was
  // ≈ 7 000 px and the pre-fix boot failure a blank frame (hundreds of
  // thousands). 0.05% (310 px) splits noise from both failure modes.
  expect(diff).toBeLessThan(a.width * a.height * 0.0005)
  expect(errors).toEqual([])
})
