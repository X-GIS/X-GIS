import { test, expect } from '@playwright/test'

// Backend-toggle acceptance gate — the demo toolbar's WebGL2 ⟷ WebGPU toggle
// (`?backend=`). Runs GPU-LESS (HEADED=0 XGIS_SOFTWARE_GPU=1: SwiftShader
// rasterises WebGL2 in software), which is the toggle's whole point: a machine
// with no GPU can still boot, render, and verify demos by pinning WebGL2.
//
// Proves in one run:
//   1. `?backend=webgl2` pins the boot — the LIVE identity (ctx.rhi.backend →
//      window.__xgisActiveBackend + the toolbar badge) is 'webgl2' AND land
//      fill pixels actually render. Identity is asserted NEXT TO the pixel
//      assertion (the green-on-the-wrong-GPU lesson: a fallback chain makes an
//      output-only assertion ambiguous).
//   2. The toggle mechanics: changing the select swaps in a FRESH canvas node
//      (a canvas's context type is sticky — the old node can never host the
//      other backend), reboots the map, and syncs `?backend=` in the URL.

const FILL: [number, number, number] = [231, 229, 228] // minimal demo stone-200 fills

test('demo backend toggle — ?backend=webgl2 pins a software-rasterised boot; the select reboots onto a fresh canvas', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))

  // ── 1. Pinned boot: ?backend=webgl2 ──
  await page.goto('/demo.html?id=minimal&backend=webgl2&e2e=1', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 60_000 },
  )

  // Identity: the pin took, and every surface agrees (global, badge, select).
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __xgisActiveBackend?: string }).__xgisActiveBackend,
      ),
    )
    .toBe('webgl2')
  await expect(page.locator('#backend-tag')).toHaveText('WebGL2')
  await expect(page.locator('#backend-select')).toHaveValue('webgl2')

  // Output: land fills actually rasterised (SwiftShader). Poll — tile decode +
  // upload settle at software-rasteriser speed.
  const countFillPixels = () =>
    page.evaluate((fill) => {
      const w = window as unknown as {
        __xgisMap?: { ctx?: { rhi?: { gl?: WebGL2RenderingContext }; canvas?: HTMLCanvasElement } }
        __xgisInvalidate?: () => void
      }
      const gl = w.__xgisMap?.ctx?.rhi?.gl
      if (!gl) return -1
      const W = gl.drawingBufferWidth
      const H = gl.drawingBufferHeight
      const buf = new Uint8Array(W * H * 4)
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
      let n = 0
      for (let p = 0; p < W * H; p++) {
        const i = p * 4
        if (
          Math.abs(buf[i]! - fill[0]) < 12 &&
          Math.abs(buf[i + 1]! - fill[1]) < 12 &&
          Math.abs(buf[i + 2]! - fill[2]) < 12
        )
          n++
      }
      return n
    }, FILL)
  await expect.poll(countFillPixels, { timeout: 90_000, intervals: [1000] }).toBeGreaterThan(500)

  // ── 2. Toggle mechanics: webgl2 → auto → webgl2 ──
  // Mark the current canvas + map instance so the reboot is provable: the
  // handler must swap in a FRESH canvas (sticky context types) and construct
  // a NEW XGISMap.
  await page.evaluate(() => {
    const w = window as unknown as { __xgisMap?: object }
    ;(document.getElementById('map') as HTMLCanvasElement & { __gen?: string }).__gen = 'old'
    ;(w.__xgisMap as { __gen?: string }).__gen = 'old'
  })
  await page.selectOption('#backend-select', '')
  await page.waitForFunction(
    () => {
      const w = window as unknown as { __xgisMap?: { __gen?: string }; __xgisReady?: boolean }
      const c = document.getElementById('map') as (HTMLCanvasElement & { __gen?: string }) | null
      return (
        w.__xgisReady === true &&
        c !== null &&
        c.__gen === undefined &&
        w.__xgisMap?.__gen === undefined
      )
    },
    { timeout: 60_000 },
  )
  // URL param cleared; auto boot resolved to a REAL backend (whichever the
  // headless environment provides — identity is reported, not assumed).
  expect(new URL(page.url()).searchParams.get('backend')).toBeNull()
  const autoBackend = await page.evaluate(
    () => (window as unknown as { __xgisActiveBackend?: string }).__xgisActiveBackend,
  )
  expect(['webgpu', 'webgl2']).toContain(autoBackend)

  // Back to the pin: URL + identity + badge again agree.
  await page.selectOption('#backend-select', 'webgl2')
  await page.waitForFunction(
    () =>
      (window as unknown as { __xgisReady?: boolean; __xgisActiveBackend?: string }).__xgisReady ===
        true &&
      (window as unknown as { __xgisActiveBackend?: string }).__xgisActiveBackend === 'webgl2',
    { timeout: 60_000 },
  )
  expect(new URL(page.url()).searchParams.get('backend')).toBe('webgl2')
  await expect(page.locator('#backend-tag')).toHaveText('WebGL2')
  await expect.poll(countFillPixels, { timeout: 90_000, intervals: [1000] }).toBeGreaterThan(500)

  expect(errors, `page errors:\n${errors.join('\n')}`).toEqual([])
})
