// ═══ S-111 multi-region residency — the reported bug, rendered (#1272 E-④) ═══
//
// The report was "여러 s-111이 동시에 안 보인다": several S-111 domains were never visible at
// the same time. Every arm landed on one region key, so each new domain evicted the last.
//
// This gate renders it, on WebGl2Device under headless SwiftShader — the same software
// rasteriser the CI render-gate leg uses. There IS a WebGL2 context here; "no GPU" was never
// the reason this went unrendered.
//
// CONTROL   : the s111_currents demo as shipped — ONE coverage cell (the declared source).
// EXPERIMENT: the same page plus an EASTERN twin pushed under a second region key. The twin
//             is the west fixture shifted east by exactly its own width (so the two abut) and
//             re-banded to 6.5 kn, so the domains read as different colours.
//
// The assertion is DIRECTIONAL, not a pixel count: a count gate passes on broken images (§12).
// The east half must be background in the control and painted in the experiment, while the
// west half stays painted in BOTH — a regression there would mean the second push evicted the
// first, which is the original bug in mirror image.

import { test, expect } from '@playwright/test'

// West fixture spans lon [-76.58, -75.78]; the twin abuts it at [-75.78, -74.98].
// Both span lat [36.85, 39.49]. Centre of the PAIR, framed so each domain owns one half:
const CENTRE_LON = -75.78
const CENTRE_LAT = 38.17
const ZOOM = 7

const EAST_FIXTURE = '/data/synthetic-currents-east.h5'

/** Painted fraction of the left and right halves, read from the live WebGL2 drawing buffer.
 *  Halves rather than a whole-frame ratio: one number cannot tell "both domains drew" from
 *  "one drew twice as wide". */
function readHalves() {
  const w = window as unknown as {
    __xgisMap?: { ctx?: { rhi?: { backend?: string; gl?: WebGL2RenderingContext } } }
  }
  const gl = w.__xgisMap?.ctx?.rhi?.gl
  if (!gl) return { ok: false as const, reason: 'no gl' }
  const W = gl.drawingBufferWidth
  const H = gl.drawingBufferHeight
  const buf = new Uint8Array(W * H * 4)
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
  let left = 0
  let right = 0
  let leftTot = 0
  let rightTot = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      const painted = buf[i]! > 24 || buf[i + 1]! > 24 || buf[i + 2]! > 24
      if (x < W / 2) {
        leftTot++
        if (painted) left++
      } else {
        rightTot++
        if (painted) right++
      }
    }
  }
  return {
    ok: true as const,
    backend: w.__xgisMap?.ctx?.rhi?.backend,
    W,
    H,
    left: left / leftTot,
    right: right / rightTot,
  }
}

/** The demo, framed on the domain pair, with its declared coverage actually resident. */
async function boot(page: import('@playwright/test').Page) {
  await page.setViewportSize({ width: 900, height: 700 })
  await page.goto(
    `/demo.html?id=s111_currents&forcegl2=1&e2e=1#${ZOOM}/${CENTRE_LAT}/${CENTRE_LON}`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 20000 },
  )
  // The declared coverage must actually be loaded before any of this means anything — a
  // silently-failed source load would make BOTH captures empty and the delta trivially zero.
  await page.waitForFunction(
    () =>
      (
        window as unknown as { __xgisMap?: { getCoverage(id: string): unknown } }
      ).__xgisMap?.getCoverage('currents') != null,
    { timeout: 20000 },
  )
  await page.waitForTimeout(800)
}

test.describe('S-111 multi-region residency (#1272 E-④)', () => {
  test('one region paints its half only; two regions paint BOTH halves', async ({ page }) => {
    test.setTimeout(180_000)

    // ── CONTROL: the demo's single declared cell. ──
    await boot(page)
    const single = await page.evaluate(readHalves)
    expect(single.ok, 'WebGL2 context present').toBe(true)
    if (!single.ok) return
    expect(single.backend, 'running on the WebGL2 backend').toBe('webgl2')
    await page.screenshot({ path: 'test-results/s111-single-region.png' })

    // ── EXPERIMENT: same page, plus the eastern twin under its OWN region key. ──
    await boot(page)
    await page.evaluate(async (file) => {
      const w = window as unknown as {
        __xgisMap?: {
          setCoverageData(
            id: string,
            bytes: ArrayBuffer,
            opts?: { region?: string; url?: string },
          ): Promise<void>
          invalidate?: () => void
        }
      }
      const res = await fetch(file)
      if (!res.ok) throw new Error(`east fixture ${file}: HTTP ${res.status}`) // loud, not silent
      await w.__xgisMap!.setCoverageData('currents', await res.arrayBuffer(), {
        region: 'east',
        url: file,
      })
      w.__xgisMap!.invalidate?.()
    }, EAST_FIXTURE)
    await page.waitForTimeout(1500)
    const multi = await page.evaluate(readHalves)
    expect(multi.ok).toBe(true)
    if (!multi.ok) return
    await page.screenshot({ path: 'test-results/s111-multi-region.png' })

    console.log(
      `[s111-multiregion] control L=${single.left.toFixed(4)} R=${single.right.toFixed(4)} | ` +
        `multi L=${multi.left.toFixed(4)} R=${multi.right.toFixed(4)} (${multi.W}x${multi.H})`,
    )

    // The west domain draws in BOTH — the second push must not evict the first.
    expect(single.left, 'control: west half painted').toBeGreaterThan(0.02)
    expect(multi.left, 'multi: west half STILL painted').toBeGreaterThan(0.02)

    // THE FIX: the east half gains paint only when a second region is resident.
    expect(multi.right, 'multi: east half painted').toBeGreaterThan(single.right + 0.02)
  })
})
