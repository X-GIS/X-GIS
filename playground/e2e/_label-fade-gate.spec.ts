import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Symbol-fade §5 gate — the fadeDuration feature's render contract, proved at
// the strongest rung reachable on this fixture (hash equality; the render-gate
// ladder note in CLAUDE.md §12):
//
//   1. PARITY   — a `?fade=0` boot (fading disabled = the pre-fade legacy
//                 path) and a `?fade=300` boot CONVERGE to byte-identical
//                 frames (SHA-256 over the readPixels buffer). Fading only
//                 ramps alpha toward the same steady state; once settled the
//                 uniform/vertex bytes equal the unfaded pack (base × 1).
//   2. RAMP     — on a long-fade boot (`?fade=12000`), the frame captured
//                 right after the symbols FIRST become visible carries FEWER
//                 near-solid pixels than the converged frame (the fade-in is
//                 real on raster output), the in-page fade state at that
//                 moment shows BOTH renderers mid-ramp (text uniform slices
//                 AND icon vertex patches at alpha < 0.9), and the long fade
//                 STILL converges to the exact `?fade=0` frame hash.
//   3. PRESENCE — the converged frame carries >200 vivid shield pixels, so
//                 the equality assertions can never pass vacuously on blank
//                 frames (#1221 lesson: equality of two broken images is
//                 not a gate).
//
// Fixture: fixture_symbol_icon_textfit + the LOCAL `/fixture-sprite` atlas
// (dev-server-served, no external network) under forced WebGL2 + headless
// SwiftShader, so the frame is deterministic across boots (fixed default
// camera). The shield points ride a STATIC-URL geojson source → the DEFAULT
// VirtualPMTilesBackend route → the VECTOR-TILE dispatch arm, the one that
// carries the #728 collisionId the fade ledger keys on (the inline
// rawDatasets arm has no collisionId and is fade-exempt by design). The
// sprite URL builds the REAL URL-sprite IconStage, so the paired-icon fade
// (fadeId → shared ledger record → per-vertex opacity patch) is exercised
// end-to-end alongside the text uniform-alpha patch.

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__label-fade-gate__')

interface Frame {
  ok: boolean
  hash: string
  /** Vivid shield pixels (strongly red OR strongly blue — the fixture
   *  sprite's two panel colours). A fading-in shield crosses the 150
   *  channel floor only at alpha > ~0.6, so this is the near-solid
   *  coverage metric; the early mid-ramp frame counts ~0 here. */
  vivid: number
  /** ANY visibly lit pixel (r+g+b > 45) — catches symbols from ~alpha 0.1,
   *  so the ramp's midsection is observable (white alone is blind to it). */
  lit: number
  total: number
  glError: number
  validation: string[]
}

/** In-page fade-machinery introspection — ties the pixel evidence to the
 *  mechanism: which renderer slices/patches carry a fade box, and at what
 *  alpha. TS-private fields are runtime-readable; this is a test-only probe. */
interface FadeState {
  active: boolean
  textFadeSlices: number
  textAlphas: number[]
  iconPatches: number
  iconAlphas: number[]
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
      __xgisMap?: {
        invalidate?: () => void
        ctx?: {
          rhi?: { gl?: WebGL2RenderingContext }
          _validationErrors?: { message: string }[]
        }
      }
    }
    // One explicit repaint so readPixels-after-present sees a fresh frame.
    w.__xgisMap?.invalidate?.()
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
    const gl = w.__xgisMap?.ctx?.rhi?.gl
    if (!gl) return { ok: false, hash: '', vivid: 0, lit: 0, total: 0, glError: 0, validation: [] }
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
    return {
      ok: true,
      hash,
      vivid,
      lit,
      total: W * H,
      glError: gl.getError(),
      validation: (w.__xgisMap?.ctx?._validationErrors ?? []).map((e) => e.message).slice(0, 5),
    }
  })
}

function readFadeState(page: import('@playwright/test').Page): Promise<FadeState> {
  return page.evaluate(() => {
    interface Slice {
      fade?: { ref: { a: number } }
    }
    interface Patch {
      ref: { a: number }
    }
    const m = (
      window as unknown as {
        __xgisMap?: {
          textStage?: {
            getFadeLedger?: () => { hasActive(): boolean }
            renderer?: { drawSlices?: Slice[] }
          } | null
          iconStage?: { renderer?: { fadePatches?: Patch[] } } | null
        }
      }
    ).__xgisMap
    const slices = m?.textStage?.renderer?.drawSlices ?? []
    const patches = m?.iconStage?.renderer?.fadePatches ?? []
    const withFade = slices.filter((s) => s.fade !== undefined)
    return {
      active: m?.textStage?.getFadeLedger?.().hasActive() ?? false,
      textFadeSlices: withFade.length,
      textAlphas: withFade.map((s) => s.fade!.ref.a),
      iconPatches: patches.length,
      iconAlphas: patches.map((p) => p.ref.a),
    }
  })
}

/** Poll until two consecutive frames hash identically AND symbols are up
 *  (vivid > floor) — the pumped-convergence read. Returns the settled frame. */
async function converge(
  page: import('@playwright/test').Page,
  floor: number,
  timeoutMs: number,
): Promise<Frame> {
  const deadline = Date.now() + timeoutMs
  let prev = await readFrame(page)
  for (;;) {
    await page.waitForTimeout(500)
    const cur = await readFrame(page)
    if (cur.ok && prev.ok && cur.vivid > floor && cur.hash === prev.hash) return cur
    if (Date.now() > deadline) return cur
    prev = cur
  }
}

test('symbol fade — fade=0 / fade=300 converge byte-identically; long fade ramps then converges', async ({
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

  // ── Arm A: fading disabled (the pre-fade byte-identical legacy path). ──
  await boot(page, 0)
  const a = await converge(page, 200, 90_000)
  writeFileSync(join(OUT, 'fade-0.png'), await page.locator('#map').screenshot({ type: 'png' }))

  // ── Arm B: the library-default duration. ──
  await boot(page, 300)
  const b = await converge(page, 200, 90_000)
  writeFileSync(join(OUT, 'fade-300.png'), await page.locator('#map').screenshot({ type: 'png' }))

  // ── Arm C: 12 s ramp — capture right after symbols FIRST appear, then
  //    pump to convergence. ──
  await boot(page, 12_000)
  // First-visible poll on the LOW threshold, measured AGAINST the pre-symbol
  // baseline (the background itself may be lit) so a frame with no symbols
  // at all can never satisfy it — the gate cannot pass vacuously. `lit`
  // crosses the +50px delta at ~alpha 0.18 of the red/blue shields, so the
  // captured frame sits early on the 12 s ramp; its near-solid (`vivid`)
  // count must then be far below the converged frame's (a no-fade
  // regression appears at full alpha and fails the strict inequality).
  const base = await readFrame(page)
  let early = base
  {
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline && !(early.ok && early.lit > base.lit + 50)) {
      await page.waitForTimeout(250)
      early = await readFrame(page)
    }
  }
  const earlyState = await readFadeState(page)
  writeFileSync(
    join(OUT, 'fade-12000-early.png'),
    await page.locator('#map').screenshot({ type: 'png' }),
  )
  const c = await converge(page, 200, 150_000)
  writeFileSync(
    join(OUT, 'fade-12000-final.png'),
    await page.locator('#map').screenshot({ type: 'png' }),
  )

  for (const [name, f] of Object.entries({ a, b, c })) {
    expect(f.ok, `${name}: WebGL2 context present`).toBe(true)
    expect(f.glError, `${name}: no gl error`).toBe(0)
    expect(f.validation, `${name}: no validation errors`).toEqual([])
  }
  expect(errors, 'no page errors').toEqual([])

  // (3) PRESENCE — equality below cannot pass on blank frames.
  expect(a.vivid, `vivid shield pixels ${a.vivid}/${a.total}`).toBeGreaterThan(200)

  // (1) PARITY — default-duration fading converges to the EXACT disabled frame.
  expect(b.hash, 'fade=300 converged ≡ fade=0').toBe(a.hash)

  // (2) RAMP — at first visibility both renderers are mid-ramp (mechanism),
  //     the frame carries fewer solid pixels than converged (pixels), and the
  //     long fade still lands on the identical final frame (convergence).
  expect(early.lit, 'early frame caught the symbols while visible').toBeGreaterThan(base.lit + 50)
  expect(earlyState.active, 'ledger mid-ramp at the early capture').toBe(true)
  expect(earlyState.textFadeSlices, 'text slices carry fade boxes').toBeGreaterThan(0)
  expect(earlyState.iconPatches, 'icon draws carry fade patches').toBeGreaterThan(0)
  for (const al of [...earlyState.textAlphas, ...earlyState.iconAlphas]) {
    expect(al, 'early alphas sit below the solid threshold').toBeLessThan(0.9)
  }
  expect(early.vivid, `early vivid ${early.vivid} < final vivid ${c.vivid}`).toBeLessThan(c.vivid)
  expect(c.hash, 'fade=12000 converged ≡ fade=0').toBe(a.hash)
})
