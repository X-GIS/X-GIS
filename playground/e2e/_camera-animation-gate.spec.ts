import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Camera-animation §5 gate (#1256) — the easeTo/flyTo render contract,
// proved at the strongest rung reachable (hash equality; CLAUDE.md §12):
//
//   1. TERMINAL ≡ jumpTo — after an easeTo (and a flyTo) completes, the
//      settled frame hashes IDENTICALLY (SHA-256 over readPixels) to a
//      direct jumpTo(target) frame. The animator lands its final tick on
//      the exact original target through the same jumpTo, so arrival is
//      bit-identical by construction; this proves it on real raster.
//   2. IN-FLIGHT — mid-ease, the map reports `isAnimating()` true, the
//      live camera zoom sits STRICTLY between start and target (the sample
//      is genuinely intermediate — an instant-jump alias can never produce
//      it), and the mid frame differs from BOTH endpoints.
//   3. PRESENCE — start / target frames carry a large, DIFFERENT green
//      area (the fixture square at two zooms), so the equalities can never
//      pass vacuously on blank or identical frames (#1221 lesson).
//
// Fixture: fixture_square (offline emerald polygon) under forced WebGL2 +
// headless SwiftShader, `?nomotion=1` so reduced-motion can't collapse the
// animation. Deterministic across boots (pinned cameras).

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__camera-animation-gate__')

const START = { center: [0, 0] as [number, number], zoom: 2, bearing: 0, pitch: 0 }
const TARGET = { center: [0, 0] as [number, number], zoom: 3.6, bearing: 0, pitch: 0 }
const FLY_TARGET = { center: [25, 15] as [number, number], zoom: 3, bearing: 0, pitch: 0 }

interface Frame {
  ok: boolean
  hash: string
  green: number
  zoom: number
  animating: boolean
  glError: number
}

async function boot(page: import('@playwright/test').Page): Promise<void> {
  await page.setViewportSize({ width: 800, height: 600 })
  await page.goto('/demo.html?id=fixture_square&forcegl2=1&preserve=1&nomotion=1', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 30_000 },
  )
}

interface MapApi {
  jumpTo?: (o: object) => void
  easeTo?: (o: object) => void
  flyTo?: (o: object) => void
  getZoom?: () => number
  invalidate?: () => void
  cameraController?: { isAnimating(): boolean }
  ctx?: { rhi?: { gl?: WebGL2RenderingContext } }
}
// NOTE: browser-side lookups inline `window.__xgisMap` inside each
// page.evaluate — a Node-scope helper cannot cross the evaluate boundary.
async function jump(page: import('@playwright/test').Page, cam: object): Promise<void> {
  await page.evaluate((c) => {
    ;(window as unknown as { __xgisMap?: MapApi }).__xgisMap?.jumpTo?.(c)
  }, cam)
}

function readFrame(page: import('@playwright/test').Page): Promise<Frame> {
  return page.evaluate(async () => {
    const m = (window as unknown as { __xgisMap?: MapApi }).__xgisMap ?? {}
    m.invalidate?.()
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
    const gl = m.ctx?.rhi?.gl
    if (!gl) return { ok: false, hash: '', green: 0, zoom: 0, animating: false, glError: 0 }
    const W = gl.drawingBufferWidth
    const H = gl.drawingBufferHeight
    const buf = new Uint8Array(W * H * 4)
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
    const digest = await crypto.subtle.digest('SHA-256', buf)
    const hash = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    let green = 0
    for (let p = 0; p < W * H; p++) {
      const i = p * 4
      if (buf[i + 1]! > 120 && buf[i]! < 100 && buf[i + 1]! > buf[i + 2]!) green++
    }
    return {
      ok: true,
      hash,
      green,
      zoom: m.getZoom?.() ?? 0,
      animating: m.cameraController?.isAnimating() ?? false,
      glError: gl.getError(),
    }
  })
}

/** Poll to a stable, non-animating frame WITH the fixture content present
 *  (green > minGreen) — the settled read. The content floor prevents an
 *  early return on two matching pre-render blank frames (the square's
 *  auto-push lands a beat after __xgisReady). */
async function settle(
  page: import('@playwright/test').Page,
  timeoutMs: number,
  minGreen = 3000,
): Promise<Frame> {
  const deadline = Date.now() + timeoutMs
  let prev = await readFrame(page)
  for (;;) {
    await page.waitForTimeout(200)
    const cur = await readFrame(page)
    if (cur.ok && !cur.animating && cur.green > minGreen && prev.ok && cur.hash === prev.hash)
      return cur
    if (Date.now() > deadline) return cur
    prev = cur
  }
}

test('camera animation — easeTo/flyTo land ≡ jumpTo; flight is genuinely intermediate', async ({
  page,
}) => {
  test.setTimeout(300_000)
  mkdirSync(OUT, { recursive: true })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push(m.text().slice(0, 300))
  })

  await boot(page)

  // ── Reference frames via jumpTo. ──
  await jump(page, START)
  const start = await settle(page, 40_000)
  writeFileSync(join(OUT, 'start.png'), await page.locator('#map').screenshot({ type: 'png' }))
  await jump(page, TARGET)
  const jumpTarget = await settle(page, 40_000)
  writeFileSync(
    join(OUT, 'jump-target.png'),
    await page.locator('#map').screenshot({ type: 'png' }),
  )

  // ── easeTo the target from START; sample mid-flight, then settle. ──
  await jump(page, START)
  await settle(page, 40_000)
  await page.evaluate((t) => {
    ;(window as unknown as { __xgisMap?: MapApi }).__xgisMap?.easeTo?.({ ...t, duration: 2500 })
  }, TARGET)
  // Poll a genuinely intermediate moment: animating, zoom strictly between.
  let mid: Frame = start
  {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const f = await readFrame(page)
      if (f.ok && f.animating && f.zoom > START.zoom + 0.05 && f.zoom < TARGET.zoom - 0.05) {
        mid = f
        break
      }
      await page.waitForTimeout(60)
    }
  }
  writeFileSync(join(OUT, 'ease-mid.png'), await page.locator('#map').screenshot({ type: 'png' }))
  const easeSettled = await settle(page, 40_000)
  writeFileSync(
    join(OUT, 'ease-settled.png'),
    await page.locator('#map').screenshot({ type: 'png' }),
  )

  // ── flyTo a distinct target; compare its terminal to a jumpTo of same. ──
  await jump(page, START)
  await settle(page, 40_000)
  await page.evaluate((t) => {
    ;(window as unknown as { __xgisMap?: MapApi }).__xgisMap?.flyTo?.({ ...t, duration: 2500 })
  }, FLY_TARGET)
  let flyAnimated = false
  {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const f = await readFrame(page)
      if (f.ok && f.animating) flyAnimated = true
      if (f.ok && !f.animating && flyAnimated) break
      await page.waitForTimeout(60)
    }
  }
  const flySettled = await settle(page, 40_000)
  await jump(page, FLY_TARGET)
  const flyJump = await settle(page, 40_000)

  for (const [name, f] of Object.entries({
    start,
    jumpTarget,
    mid,
    easeSettled,
    flySettled,
    flyJump,
  })) {
    expect(f.ok, `${name}: WebGL2 context present`).toBe(true)
    expect(f.glError, `${name}: no gl error`).toBe(0)
  }
  expect(errors, 'no page errors').toEqual([])

  // (3) PRESENCE — non-blank and the two zooms differ visibly.
  expect(start.green, `start green ${start.green}`).toBeGreaterThan(3000)
  expect(jumpTarget.green, `target green ${jumpTarget.green}`).toBeGreaterThan(3000)
  expect(Math.abs(jumpTarget.green - start.green)).toBeGreaterThan(2000)

  // (2) IN-FLIGHT — mid ease is genuinely intermediate.
  expect(mid.animating, 'ease was in flight at the sampled frame').toBe(true)
  expect(mid.zoom, `mid zoom ${mid.zoom} ∈ (2, 3.6)`).toBeGreaterThan(START.zoom + 0.05)
  expect(mid.zoom).toBeLessThan(TARGET.zoom - 0.05)
  expect(mid.hash, 'mid ≠ start').not.toBe(start.hash)
  expect(mid.hash, 'mid ≠ target').not.toBe(jumpTarget.hash)

  // (1) TERMINAL ≡ jumpTo — the load-bearing invariant.
  expect(easeSettled.hash, 'easeTo settled ≡ jumpTo(target)').toBe(jumpTarget.hash)
  expect(flyAnimated, 'flyTo actually animated (was in flight)').toBe(true)
  expect(flySettled.hash, 'flyTo settled ≡ jumpTo(flyTarget)').toBe(flyJump.hash)
})
