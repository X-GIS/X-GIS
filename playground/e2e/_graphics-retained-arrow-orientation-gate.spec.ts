import { test, expect } from '@playwright/test'

// #825 aspect-skew regression gate for the retained ARROW vector-field primitive.
//
// The sibling _graphics-retained-arrow-gl2-gate proves the arrow RASTERISES, but it uses a SQUARE
// 600×600 viewport pointing due EAST (bearing 90) — a configuration where the screen-orientation
// math is exactly right REGARDLESS of the aspect bug (a pure-horizontal direction is aspect-
// invariant), so it cannot see the skew. The arrow VS derives its screen direction from the
// clip-space delta of two projected geo points; NDC is per-axis normalized, so on a NON-square
// viewport the raw delta is aspect-skewed unless each axis is scaled by the viewport extent before
// normalizing: without that scale tan(rendered) = tan(true) × (viewport.x / viewport.y).
//
// This gate pins the fix on the demo's non-square map area (a 1200-wide window whose canvas is
// ~780×600 after the side panel — a ~1.30 aspect). Two arrows anchored at the hash camera centre:
//   • BLUE bearing 90 (due east) — a CONTROL. A pure-horizontal direction is aspect-invariant, so
//     it renders at ~0° both with and without the fix; it proves the camera is north-up and the
//     readback harness is sane, so a green failure is unambiguously the aspect skew.
//   • GREEN bearing 45 (north-east). Mercator/globe are locally conformal at the camera centre
//     (the arrow anchor), so a 45° geographic bearing MUST render at 45° in SCREEN pixels. Without
//     the per-axis viewport scale it renders at atan2(780,600) ≈ 52.4° — a ~7° skew this asserts
//     away. (Red is avoided: the demo's left legend panel is red and would pollute the sample.)
//
// Runs on the WebGL2 backend (?forcegl2=1) under SwiftShader, headless.

test('a retained arrow keeps its geographic bearing on a non-square viewport (?forcegl2=1)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 600 }) // non-square map area exposes the skew
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text())
  })

  await page.goto('/demo.html?id=minimal&forcegl2=1&e2e=1#4/20/0', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 20000 },
  )
  await page.waitForTimeout(300)

  await page.evaluate(() => {
    const w = window as unknown as {
      __xgisMap?: { graphics: { add(spec: unknown): unknown }; invalidate?: () => void }
    }
    const map = w.__xgisMap!
    const add = (bearing: number, color: string) =>
      map.graphics.add({
        type: 'arrow',
        data: [0],
        getPosition: [0, 20], // [lon, lat] = hash camera centre (arrow tail)
        getBearing: bearing, // geo degrees, 0 = north CW
        getSize: 220,
        getColor: color,
      })
    add(90, '#3355ee') // east control (blue)
    add(45, '#22cc44') // north-east subject (green)
    map.invalidate?.()
  })
  await page.waitForTimeout(800)

  const r = await page.evaluate(() => {
    const w = window as unknown as {
      __xgisActiveBackend?: string
      __xgisMap?: {
        ctx?: {
          rhi?: { backend?: string; gl?: WebGL2RenderingContext }
          _validationErrors?: unknown[]
        }
      }
    }
    const ctx = w.__xgisMap?.ctx
    const gl = ctx?.rhi?.gl
    if (!gl) return { ok: false as const, reason: 'no gl' }
    const W = gl.drawingBufferWidth
    const H = gl.drawingBufferHeight
    const buf = new Uint8Array(W * H * 4)
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
    const cx = W / 2
    const cy = H / 2 // gl centre (y up) = arrow tail
    // Centroid ANGLE of a colour class, restricted to the map area (x > 170 skips the red left
    // legend panel) and to pixels ≥ 40 px out (skips the shared tail hub). atan2 in gl space →
    // 0° = east (screen +x), 90° = north (screen up).
    const angleOf = (hit: (r: number, g: number, b: number) => boolean) => {
      let sx = 0
      let sy = 0
      let n = 0
      for (let y = 0; y < H; y++)
        for (let x = 171; x < W; x++) {
          const i = (y * W + x) * 4
          if (!hit(buf[i], buf[i + 1], buf[i + 2])) continue
          const dx = x - cx
          const dy = y - cy
          if (dx * dx + dy * dy < 40 * 40) continue
          sx += dx
          sy += dy
          n++
        }
      return { angle: n ? (Math.atan2(sy, sx) * 180) / Math.PI : NaN, n }
    }
    return {
      ok: true as const,
      backendMarker: w.__xgisActiveBackend,
      rhiBackend: ctx?.rhi?.backend,
      validationErrors: (ctx?._validationErrors ?? []).length,
      glError: gl.getError(),
      east: angleOf((r, g, b) => b > 150 && r < 120 && g < 130),
      ne: angleOf((r, g, b) => g > 150 && r < 130 && b < 120),
      size: { W, H },
    }
  })

  expect(r.ok, 'forced-WebGL2 context present').toBe(true)
  if (!r.ok) return

  expect(r.backendMarker, 'window.__xgisActiveBackend').toBe('webgl2')
  expect(r.rhiBackend, 'host.ctx.rhi.backend').toBe('webgl2')
  expect(r.glError, 'no gl error').toBe(0)
  expect(r.validationErrors, 'no validation errors').toBe(0)
  expect(errors, 'no page/console errors').toEqual([])

  // Both arrows must actually have rasterised (a blank frame reads 0 samples).
  expect(r.east.n, `east control texels ${r.east.n}`).toBeGreaterThan(1500)
  expect(r.ne.n, `north-east texels ${r.ne.n}`).toBeGreaterThan(1500)

  // Control: the pure-horizontal east arrow proves north-up + a sane harness (≈ 0°).
  expect(
    Math.abs(r.east.angle),
    `east control angle ${r.east.angle}° (size ${JSON.stringify(r.size)})`,
  ).toBeLessThan(5)

  // The pin: north-east renders at the geographic 45°, not the ~52° aspect-skewed direction.
  // Pre-fix this reads ~52.4° on the ~1.30 canvas and fails; the fix lands it at ~45°.
  expect(
    r.ne.angle,
    `north-east arrow angle ${r.ne.angle}° — must be ~45° (aspect-correct), not ~52° (skewed); size ${JSON.stringify(r.size)}`,
  ).toBeGreaterThan(41)
  expect(
    r.ne.angle,
    `north-east arrow angle ${r.ne.angle}° — must be ~45°, not ~52° (skewed)`,
  ).toBeLessThan(49)
})
