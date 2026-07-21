import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Paint-transition §5 gate (#1255) — the setPaintProperty ramp's render
// contract, proved at the strongest rung reachable on this fixture (hash
// equality; the render-gate ladder note in CLAUDE.md §12):
//
//   1. PARITY   — after `setPaintProperty('the_square','fill-color',BLUE)`,
//                 a `?ptdur=0` boot (transitions disabled = the legacy
//                 instant set) and a `?ptdur=300` boot CONVERGE to
//                 byte-identical frames (SHA-256 over readPixels). The ramp
//                 only interpolates toward the same steady state; settle()
//                 swaps the shape back to the identical constant.
//   2. RAMP     — on a `?ptdur=12000` boot the polled mid frame differs
//                 from BOTH endpoints (genuinely intermediate colour — a
//                 no-transition regression can never produce it), the
//                 in-page registry reports an active ramp at that moment,
//                 and the long ramp STILL converges to the exact
//                 `?ptdur=0` final hash with the fill shape settled back
//                 to `kind:'constant'`.
//   3. PRESENCE — the start frame carries a large emerald interior and the
//                 final frame a large blue one, so the equalities can never
//                 pass vacuously on blank frames (#1221 lesson).
//
// Fixture: fixture_square (offline geojson square, `layer the_square |
// fill-emerald-500`) under forced WebGL2 + headless SwiftShader with a
// pinned camera — deterministic across boots. emerald-500 = #10b981,
// target blue-500 = #3b82f6.

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__paint-transition-gate__')

const BLUE = '#3b82f6'
const CAM = { center: [0, 0] as [number, number], zoom: 2 }

interface Frame {
  ok: boolean
  hash: string
  green: number
  blue: number
  total: number
  glError: number
}

async function boot(page: import('@playwright/test').Page, ptdur: number): Promise<void> {
  await page.setViewportSize({ width: 800, height: 600 })
  await page.goto(`/demo.html?id=fixture_square&forcegl2=1&preserve=1&ptdur=${ptdur}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 30_000 },
  )
  await page.evaluate((cam) => {
    ;(window as unknown as { __xgisMap?: { jumpTo?: (o: object) => void } }).__xgisMap?.jumpTo?.(
      cam,
    )
  }, CAM)
}

function readFrame(page: import('@playwright/test').Page): Promise<Frame> {
  return page.evaluate(async () => {
    const w = window as unknown as {
      __xgisMap?: {
        invalidate?: () => void
        ctx?: { rhi?: { gl?: WebGL2RenderingContext } }
      }
    }
    w.__xgisMap?.invalidate?.()
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
    const gl = w.__xgisMap?.ctx?.rhi?.gl
    if (!gl) return { ok: false, hash: '', green: 0, blue: 0, total: 0, glError: 0 }
    const W = gl.drawingBufferWidth
    const H = gl.drawingBufferHeight
    const buf = new Uint8Array(W * H * 4)
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
    const digest = await crypto.subtle.digest('SHA-256', buf)
    const hash = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    // The fill-pixel gate's colour buckets: emerald reads green-dominant,
    // blue-500 blue-dominant. A mid-ramp teal sits in NEITHER bucket.
    let green = 0
    let blue = 0
    for (let p = 0; p < W * H; p++) {
      const i = p * 4
      const r = buf[i]!
      const g = buf[i + 1]!
      const b = buf[i + 2]!
      if (g > 120 && r < 100 && g > b) green++
      if (b > 150 && r < 120 && g < 175) blue++
    }
    return { ok: true, hash, green, blue, total: W * H, glError: gl.getError() }
  })
}

/** Set the fixture's fill to BLUE through the public API; returns
 *  setPaintProperty's own success flag (false = layer lookup failed —
 *  fail loudly instead of asserting on an unchanged frame). */
function setBlue(page: import('@playwright/test').Page): Promise<boolean> {
  return page.evaluate((blue) => {
    const m = (
      window as unknown as {
        __xgisMap?: { setPaintProperty?: (l: string, p: string, v: unknown) => boolean }
      }
    ).__xgisMap
    return m?.setPaintProperty?.('the_square', 'fill-color', blue) === true
  }, BLUE)
}

function transitionState(
  page: import('@playwright/test').Page,
): Promise<{ active: boolean; fillKind: string }> {
  return page.evaluate(() => {
    interface ShowLike {
      layerName?: string
      paintShapes?: { fill?: { fill?: { kind?: string } | null } }
    }
    const m = (
      window as unknown as {
        __xgisMap?: {
          _paintTransitions?: { hasActive(): boolean }
          showCommands?: ShowLike[]
        }
      }
    ).__xgisMap
    const show = (m?.showCommands ?? []).find((s) => s.layerName === 'the_square')
    return {
      active: m?._paintTransitions?.hasActive() ?? false,
      fillKind: show?.paintShapes?.fill?.fill?.kind ?? 'absent',
    }
  })
}

/** Poll until two consecutive frames hash identically AND the given colour
 *  bucket exceeds `floor` — the pumped-convergence read. */
async function converge(
  page: import('@playwright/test').Page,
  bucket: 'green' | 'blue',
  floor: number,
  timeoutMs: number,
): Promise<Frame> {
  const deadline = Date.now() + timeoutMs
  let prev = await readFrame(page)
  for (;;) {
    await page.waitForTimeout(400)
    const cur = await readFrame(page)
    if (cur.ok && prev.ok && cur[bucket] > floor && cur.hash === prev.hash) return cur
    if (Date.now() > deadline) return cur
    prev = cur
  }
}

test('paint transition — ptdur=0 / ptdur=300 converge byte-identically; long ramp is visibly intermediate', async ({
  page,
}) => {
  test.setTimeout(420_000)
  mkdirSync(OUT, { recursive: true })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push(m.text().slice(0, 300))
  })

  // ── Arm A: transitions disabled (the legacy instant set). ──
  await boot(page, 0)
  const startA = await converge(page, 'green', 5000, 60_000)
  expect(await setBlue(page), 'A: setPaintProperty accepted').toBe(true)
  const finalA = await converge(page, 'blue', 5000, 60_000)
  writeFileSync(join(OUT, 'ptdur-0.png'), await page.locator('#map').screenshot({ type: 'png' }))

  // ── Arm B: the library-default duration. ──
  await boot(page, 300)
  const startB = await converge(page, 'green', 5000, 60_000)
  expect(await setBlue(page), 'B: setPaintProperty accepted').toBe(true)
  const finalB = await converge(page, 'blue', 5000, 60_000)
  writeFileSync(join(OUT, 'ptdur-300.png'), await page.locator('#map').screenshot({ type: 'png' }))

  // ── Arm C: 12 s ramp — catch a genuinely intermediate frame. ──
  await boot(page, 12_000)
  const startC = await converge(page, 'green', 5000, 60_000)
  expect(await setBlue(page), 'C: setPaintProperty accepted').toBe(true)
  let mid = await readFrame(page)
  {
    const deadline = Date.now() + 60_000
    while (
      Date.now() < deadline &&
      !(mid.ok && mid.hash !== startC.hash && mid.hash !== finalA.hash)
    ) {
      await page.waitForTimeout(250)
      mid = await readFrame(page)
    }
  }
  const midState = await transitionState(page)
  writeFileSync(
    join(OUT, 'ptdur-12000-mid.png'),
    await page.locator('#map').screenshot({ type: 'png' }),
  )
  const finalC = await converge(page, 'blue', 5000, 150_000)
  const settledState = await transitionState(page)
  writeFileSync(
    join(OUT, 'ptdur-12000-final.png'),
    await page.locator('#map').screenshot({ type: 'png' }),
  )

  for (const [name, f] of Object.entries({ startA, finalA, startB, finalB, startC, mid, finalC })) {
    expect(f.ok, `${name}: WebGL2 context present`).toBe(true)
    expect(f.glError, `${name}: no gl error`).toBe(0)
  }
  expect(errors, 'no page errors').toEqual([])

  // (3) PRESENCE — the equalities below cannot pass on blank frames.
  expect(startA.green, `emerald interior ${startA.green}/${startA.total}`).toBeGreaterThan(5000)
  expect(finalA.blue, `blue interior ${finalA.blue}/${finalA.total}`).toBeGreaterThan(5000)

  // (1) PARITY — identical starts, and the default-duration ramp converges
  //     to the EXACT instant-set frame.
  expect(startB.hash, 'ptdur=300 start ≡ ptdur=0 start').toBe(startA.hash)
  expect(finalB.hash, 'ptdur=300 converged ≡ ptdur=0').toBe(finalA.hash)

  // (2) RAMP — the mid frame is neither endpoint (an instant-set regression
  //     can never produce it), the registry was live at that moment, and
  //     the long ramp still lands on the identical final frame with the
  //     fill shape settled back to a constant.
  expect(mid.hash, 'mid ≠ start').not.toBe(startC.hash)
  expect(mid.hash, 'mid ≠ final').not.toBe(finalA.hash)
  expect(midState.active, 'registry active mid-ramp').toBe(true)
  expect(midState.fillKind, 'mid-ramp fill shape is the time ramp').toBe('time-interpolated')
  expect(finalC.hash, 'ptdur=12000 converged ≡ ptdur=0').toBe(finalA.hash)
  expect(settledState.active, 'registry drained after settle').toBe(false)
  expect(settledState.fillKind, 'settled fill shape is a constant').toBe('constant')
})
