import { test, expect } from '@playwright/test'

// Regression gate for #799 / #800 / #803 — the globe low-zoom cluster.
//
// ROOT CAUSE: the playground hash/style camera writers poked camera.centerY
// (Mercator) directly WITHOUT resyncing camera.centerLatDeg (the TRUE centre
// latitude the globe/sphere family renders + selects tiles from). So a globe
// hash camera silently drove the sphere at lat≈0 regardless of the requested
// latitude — the shared cause of "only a hemisphere renders" (#799), "labels
// render off the globe" (#800), and "blank / seams at z6.73" (#803, whose
// intended lat-48.4 land view collapsed to a lat≈-3 ocean → blank frame).
//
// This gate pins the fix by a DETERMINISTIC, non-raster invariant that fails
// on unmodified main and passes after: after loading each issue's pinned hash
// on the globe, camera.centerLatDeg MUST equal the hash latitude. It runs
// GPU-less under headless SwiftShader (?forcegl2=1, HEADED=0 XGIS_SOFTWARE_GPU=1)
// exactly like the sibling _fills-gl2-gate, and uses the LOCAL `minimal` demo
// (ne_110m, no network) so it is CI-safe. The centerLatDeg desync is camera-
// path (not style-specific), so the local demo pins all three positions.
//
// #803 additionally asserts land coverage: at #6.73/48.42584/115.40697 the
// ne_110m country fills must cover the frame (the desync rendered it blank).

interface Case {
  issue: string
  hash: string
  lat: number
  /** require land-fill coverage (proves the blank→covered fix) */
  requireLand?: boolean
}

const CASES: Case[] = [
  { issue: '799', hash: '#2.40/15.12559/177.84100/300.0/0.0', lat: 15.12559 },
  { issue: '800', hash: '#1.5/55.64329/147.08576/315.0/0.0', lat: 55.64329 },
  { issue: '803', hash: '#6.73/48.42584/115.40697', lat: 48.42584, requireLand: true },
]

for (const c of CASES) {
  test(`globe hash camera lands at the requested latitude (#${c.issue})`, async ({ page }) => {
    test.setTimeout(120_000)
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
    page.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
        errors.push(m.text().slice(0, 300))
    })

    await page.goto(`/demo.html?id=minimal&proj=globe&forcegl2=1&e2e=1${c.hash}`, {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      { timeout: 30_000 },
    )

    // Camera-state invariant (the fix). Read after ready — applyHashToCamera
    // has run and, on a fixed build, resynced centerLatDeg to the hash lat.
    const cam = await page.evaluate(() => {
      const w = window as unknown as {
        __xgisMap?: {
          getCamera?: () => { centerLatDeg: number; globeMode?: boolean; projType?: number }
          ctx?: { rhi?: { backend?: string } }
        }
        __xgisActiveBackend?: string
      }
      const c = w.__xgisMap?.getCamera?.()
      return {
        centerLatDeg: c?.centerLatDeg ?? NaN,
        globeMode: c?.globeMode ?? false,
        projType: c?.projType ?? -1,
        backend: w.__xgisMap?.ctx?.rhi?.backend ?? w.__xgisActiveBackend ?? 'unknown',
      }
    })

    console.log(
      `[globe-hash #${c.issue}] centerLatDeg=${cam.centerLatDeg.toFixed(4)} (want ${c.lat}) globeMode=${cam.globeMode} backend=${cam.backend}`,
    )

    expect(cam.globeMode, 'globe mode active').toBe(true)
    // The regression: WITHOUT the syncCenterLat() fix this is ~0 (or a stale
    // value) regardless of the hash. WITH the fix it equals the hash latitude.
    expect(
      Math.abs(cam.centerLatDeg - c.lat),
      `centerLatDeg ${cam.centerLatDeg.toFixed(4)} must match hash lat ${c.lat} (globe renders from centerLatDeg; a desync drives the sphere at lat≈0)`,
    ).toBeLessThan(0.5)
    expect(cam.backend, 'WebGl2Device (forcegl2)').toBe('webgl2')
    expect(errors, 'no page/console errors').toEqual([])

    if (c.requireLand) {
      // Poll invalidate + readback until ne_110m land fills the frame — proves
      // the desync-driven BLANK view (#803) is now the correct land view.
      const FILL: [number, number, number] = [231, 229, 228] // stone-200 country fill
      const readLand = () =>
        page.evaluate((fill: [number, number, number]) => {
          const w = window as unknown as {
            __xgisMap?: { ctx?: { rhi?: { gl?: WebGL2RenderingContext } } }
          }
          const gl = w.__xgisMap?.ctx?.rhi?.gl
          if (!gl) return { ok: false as const, land: 0, total: 0 }
          const W = gl.drawingBufferWidth
          const H = gl.drawingBufferHeight
          const buf = new Uint8Array(W * H * 4)
          gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
          let land = 0
          for (let p = 0; p < W * H; p++) {
            const i = p * 4
            if (
              Math.abs(buf[i]! - fill[0]) < 14 &&
              Math.abs(buf[i + 1]! - fill[1]) < 14 &&
              Math.abs(buf[i + 2]! - fill[2]) < 14
            )
              land++
          }
          return { ok: true as const, land, total: W * H }
        }, FILL)

      let r = await readLand()
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline && !(r.ok && r.land > r.total * 0.05)) {
        await page.evaluate(() => {
          ;(
            window as unknown as { __xgisMap?: { invalidate?: () => void } }
          ).__xgisMap?.invalidate?.()
        })
        await page.waitForTimeout(2000)
        r = await readLand()
      }

      console.log(`[globe-hash #${c.issue}] land=${r.land}/${r.total}`)
      expect(r.ok, 'forced-WebGL2 context present').toBe(true)
      // Mongolia/N-China at z6.73 is land-dense; the desync blank had ~0. A
      // conservative >5% absorbs SwiftShader tile pop-in without flaking.
      expect(
        r.ok ? r.land : 0,
        `#803 land coverage ${r.ok ? r.land : 0}/${r.ok ? r.total : 0} — the desync rendered this BLANK`,
      ).toBeGreaterThan(r.ok ? r.total * 0.05 : Infinity)
    }
  })
}
