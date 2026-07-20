import { test, expect } from '@playwright/test'
import { writeFileSync } from 'node:fs'

// #1059 ACCEPTANCE GATE — vector-tile fill-PATTERN renders as the TILED sprite
// texture on the WebGL2 twin (?forcegl2=1), not a flat colour swatch.
//
// The fixture_fill_pattern demo fills a square polygon with the local `pat`
// sprite (a 16×16 half red (220,40,40) / half blue (40,80,220) tile) via
// fs_fill_pattern. The pre-#1059 twin never sampled the atlas: renderFillsRhi
// resolved its colour from resolvedShow.fill, which falls back to the sprite's
// CENTRE pixel (a single colour) — so the whole interior rendered ONE flat
// colour. The witness is therefore pattern VARIATION inside the fill: BOTH the
// red and the blue sprite halves must appear above a floor. The flat-swatch
// failure mode renders exactly one of them (the other collapses to ~0), so this
// is a real fail-before shape, not a presence smoke.
//
// NOTE: the fixture pattern demos REQUIRE `&sprite=/fixture-sprite` in the URL —
// without it the sprite atlas never loads, the UV never resolves, and the fill
// renders solid (the Stage-1 centre-pixel fallback). Baked into the goto below.
//
// Headless SwiftShader renders WebGL2 (HEADED=0 XGIS_SOFTWARE_GPU=1) — GPU-less,
// same as the sibling _fills-gl2-gate / _graphics-retained-gl2-gate.

// sprite `pat` halves — the tiled pattern must show BOTH; a flat swatch shows one.
const RED: [number, number, number] = [220, 40, 40]
const BLUE: [number, number, number] = [40, 80, 220]

test('fill-pattern renders the tiled sprite on WebGl2Device (?forcegl2=1)', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push(m.text().slice(0, 300))
  })

  await page.goto('/demo.html?id=fixture_fill_pattern&forcegl2=1&e2e=1&sprite=/fixture-sprite', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 30_000 },
  )
  await page.evaluate(() =>
    (window as unknown as { __xgisMap?: { jumpTo?: (o: object) => void } }).__xgisMap?.jumpTo?.({
      center: [0, 0],
      zoom: 1.5,
    }),
  )

  const readFrame = () =>
    page.evaluate(
      ([red, blue]) => {
        const w = window as unknown as {
          __xgisActiveBackend?: string
          __xgisMap?: {
            ctx?: {
              rhi?: { backend?: string; gl?: WebGL2RenderingContext }
              _validationErrors?: { message: string }[]
            }
          }
        }
        const ctx = w.__xgisMap?.ctx
        const gl = ctx?.rhi?.gl
        if (!gl) return { ok: false as const }
        const W = gl.drawingBufferWidth
        const H = gl.drawingBufferHeight
        const buf = new Uint8Array(W * H * 4)
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
        const near = (i: number, c: number[], tol: number) =>
          Math.abs(buf[i] - c[0]) < tol &&
          Math.abs(buf[i + 1] - c[1]) < tol &&
          Math.abs(buf[i + 2] - c[2]) < tol
        let redN = 0
        let blueN = 0
        for (let p = 0; p < W * H; p++) {
          const i = p * 4
          if (near(i, red, 55)) redN++
          else if (near(i, blue, 55)) blueN++
        }
        return {
          ok: true as const,
          backend: ctx?.rhi?.backend,
          marker: w.__xgisActiveBackend,
          validation: (ctx?._validationErrors ?? []).map((e) => e.message).slice(0, 5),
          glError: gl.getError(),
          total: W * H,
          redN,
          blueN,
        }
      },
      [RED, BLUE] as const,
    )

  // Poll (invalidate + readback) until BOTH sprite halves appear — worker tiling
  // + async atlas load settle at SwiftShader speed, so trust the pixels, not a wait.
  let r = await readFrame()
  const deadline = Date.now() + 70_000
  while (Date.now() < deadline && !(r.ok && r.redN > r.total * 0.01 && r.blueN > r.total * 0.01)) {
    await page.evaluate(() => {
      ;(window as unknown as { __xgisMap?: { invalidate?: () => void } }).__xgisMap?.invalidate?.()
    })
    await page.waitForTimeout(2000)
    r = await readFrame()
  }

  // Persist the frame for image inspection (§5 — a scalar count is a tripwire; keep
  // the pixels so a regression can be read in a crop, not just a failing number).
  const png = await page.locator('canvas').first().screenshot()
  writeFileSync(testInfo.outputPath('fill-pattern-gl2.png'), png)

  expect(r.ok, 'forced-WebGL2 context present').toBe(true)
  if (!r.ok) return
  expect(r.marker, 'window.__xgisActiveBackend').toBe('webgl2')
  expect(r.backend, 'host.ctx.rhi.backend').toBe('webgl2')
  expect(r.glError, 'no gl error').toBe(0)
  expect(r.validation, 'no validation errors').toEqual([])
  expect(errors, 'no page/console errors').toEqual([])

  // The witness: pattern VARIATION inside the fill. BOTH the red and blue sprite
  // halves must cover a non-trivial share of the frame — the flat-swatch failure
  // renders ONE colour across the whole interior, collapsing the minority to ~0.
  expect(r.redN, `red sprite-half pixels ${r.redN}/${r.total}`).toBeGreaterThan(r.total * 0.01)
  expect(r.blueN, `blue sprite-half pixels ${r.blueN}/${r.total}`).toBeGreaterThan(r.total * 0.01)
})
