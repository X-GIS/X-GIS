import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Reduced-motion §5 gate (#1260, WCAG 2.3.3) — proves that an OS
// prefers-reduced-motion:reduce request collapses the symbol-fade animation to
// its instant path ON REAL RASTER, not just in the unit-tested resolver:
//
//   1. MECHANISM — with a non-zero fade requested (`?fade=12000`) AND the
//      browser emulating reduced motion, the in-page fade ledger reports
//      enabled:false (effectiveFadeDurationMs resolved to 0 at TextStage
//      construction). A control boot WITHOUT the emulation reports
//      enabled:true, so the toggle is what flips it.
//   2. NO RAMP — the frame captured right after the shields FIRST become
//      visible already carries essentially ALL the converged vivid pixels
//      (instant appearance), where the fade-on control shows far fewer (a real
//      ramp). The reduced-motion boot never renders an intermediate alpha.
//   3. PARITY — the reduced-motion frame is byte-identical (SHA-256 over
//      readPixels) to a `?fade=0` boot: reduced motion routes to the exact
//      pre-fade path (already the load-bearing invariant of _label-fade-gate).
//   4. PRESENCE — the converged frame carries >200 vivid shield pixels, so the
//      equality can never pass vacuously on a blank frame (#1221).
//
// Same offline fixture as _label-fade-gate (fixture_symbol_icon_textfit + the
// local /fixture-sprite atlas, forced WebGL2 + SwiftShader) so the frame is
// deterministic across boots. Reduced motion is toggled via Playwright's
// page.emulateMedia (the real matchMedia the engine reads), NOT a URL param.

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__reduced-motion-gate__')

interface Frame {
  ok: boolean
  hash: string
  vivid: number
  lit: number
  glError: number
}

interface LedgerState {
  present: boolean
  enabled: boolean
}

async function boot(page: import('@playwright/test').Page, fade: number): Promise<void> {
  await page.setViewportSize({ width: 800, height: 600 })
  await page.goto(
    `/demo.html?id=fixture_symbol_icon_textfit&sprite=/fixture-sprite&forcegl2=1&preserve=1&fade=${fade}`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 30_000 },
  )
}

function readFrame(page: import('@playwright/test').Page): Promise<Frame> {
  return page.evaluate(async () => {
    const w = window as unknown as {
      __xgisMap?: { invalidate?: () => void; ctx?: { rhi?: { gl?: WebGL2RenderingContext } } }
    }
    w.__xgisMap?.invalidate?.()
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
    const gl = w.__xgisMap?.ctx?.rhi?.gl
    if (!gl) return { ok: false, hash: '', vivid: 0, lit: 0, glError: 0 }
    const W = gl.drawingBufferWidth
    const H = gl.drawingBufferHeight
    const buf = new Uint8Array(W * H * 4)
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
    const digest = await crypto.subtle.digest('SHA-256', buf)
    const hash = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    let vivid = 0
    let lit = 0
    for (let p = 0; p < W * H; p++) {
      const i = p * 4
      const r = buf[i]!
      const g = buf[i + 1]!
      const b = buf[i + 2]!
      if ((r > 150 && g < 120 && b < 120) || (b > 150 && r < 120 && g < 120)) vivid++
      if (r + g + b > 45) lit++
    }
    return { ok: true, hash, vivid, lit, glError: gl.getError() }
  })
}

function readLedger(page: import('@playwright/test').Page): Promise<LedgerState> {
  return page.evaluate(() => {
    const m = (
      window as unknown as {
        __xgisMap?: { textStage?: { getFadeLedger?: () => { enabled: boolean } } | null }
      }
    ).__xgisMap
    const ledger = m?.textStage?.getFadeLedger?.()
    return { present: ledger != null, enabled: ledger?.enabled ?? false }
  })
}

/** Poll to a settled frame: two consecutive equal hashes with shields up. */
async function converge(page: import('@playwright/test').Page, timeoutMs: number): Promise<Frame> {
  const deadline = Date.now() + timeoutMs
  let prev = await readFrame(page)
  for (;;) {
    await page.waitForTimeout(500)
    const cur = await readFrame(page)
    if (cur.ok && prev.ok && cur.vivid > 200 && cur.hash === prev.hash) return cur
    if (Date.now() > deadline) return cur
    prev = cur
  }
}

/** Capture the frame right after the shields first cross into visibility. When
 *  the shields are ALREADY up on the first read (an instant, reduced-motion
 *  boot), return that frame at once — there is no ramp to wait for. Otherwise
 *  poll on the LOW `lit` threshold (crosses at ~alpha 0.18) so a genuine ramp
 *  is caught early, well before the near-solid `vivid` pixels fill in. */
async function firstVisible(page: import('@playwright/test').Page): Promise<Frame> {
  const base = await readFrame(page)
  if (base.ok && base.vivid > 200) return base
  let early = base
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline && !(early.ok && early.lit > base.lit + 50)) {
    await page.waitForTimeout(120)
    early = await readFrame(page)
  }
  return early
}

test('reduced motion collapses symbol fade to the instant path', async ({ page }) => {
  test.setTimeout(420_000)
  mkdirSync(OUT, { recursive: true })

  // A LONG fade (12 s) makes the ramp observable at poll granularity — a 300 ms
  // fade completes within one poll, so an early capture already looks converged
  // (the same reason _label-fade-gate uses ?fade=12000). Reduced motion routes
  // this same 12 s request to 0, so the contrast is ramp vs instant, not slow
  // vs fast.
  const LONG = 12_000

  // ── Control: fade disabled outright (the pre-fade path) — the parity target. ──
  await boot(page, 0)
  const zero = await converge(page, 90_000)
  writeFileSync(join(OUT, 'fade-0.png'), await page.locator('#map').screenshot({ type: 'png' }))

  // ── Control: fade ON, motion allowed — proves the ledger is enabled and the
  //    fixture genuinely ramps (early vivid << converged vivid). ──
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await boot(page, LONG)
  const motionEarly = await firstVisible(page)
  const motionLedger = await readLedger(page)
  const motionFinal = await converge(page, 150_000)

  // ── Subject: same 12 s fade request, but the OS asks for reduced motion →
  //    effectiveFadeDurationMs collapses it to 0, so the shields appear at once. ──
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await boot(page, LONG)
  const rmLedger = await readLedger(page)
  const rmEarly = await firstVisible(page)
  const rmFinal = await converge(page, 90_000)
  writeFileSync(
    join(OUT, 'reduced-motion.png'),
    await page.locator('#map').screenshot({ type: 'png' }),
  )

  for (const [name, f] of Object.entries({ zero, motionFinal, rmFinal })) {
    expect(f.ok, `${name}: WebGL2 context present`).toBe(true)
    expect(f.glError, `${name}: no gl error`).toBe(0)
  }

  // (4) PRESENCE — the equality below cannot pass on a blank frame.
  expect(zero.vivid, `vivid shields ${zero.vivid}`).toBeGreaterThan(200)

  // (1) MECHANISM — the same fade=300 boot yields an ENABLED ledger with motion
  //     allowed and a DISABLED one under reduced motion. The toggle flips it.
  expect(motionLedger.present && rmLedger.present, 'ledger present both boots').toBe(true)
  expect(motionLedger.enabled, 'fade ledger enabled when motion allowed').toBe(true)
  expect(rmLedger.enabled, 'fade ledger disabled under reduced motion').toBe(false)

  // (2) NO RAMP — reduced motion appears at full vivid immediately; the motion
  //     control is caught mid-ramp (strictly fewer vivid pixels early).
  expect(motionEarly.vivid, 'motion control ramps (early << final)').toBeLessThan(
    motionFinal.vivid * 0.75,
  )
  expect(rmEarly.vivid, 'reduced motion appears instantly (early ≈ final)').toBeGreaterThan(
    rmFinal.vivid * 0.9,
  )

  // (3) PARITY — reduced motion renders the EXACT fade=0 frame.
  expect(rmFinal.hash, 'reduced-motion converged ≡ fade=0').toBe(zero.hash)
})
