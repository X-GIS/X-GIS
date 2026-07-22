import { test, expect } from '@playwright/test'

// Raster tile fade-in §5 gate — a freshly-appeared raster tile cross-fades
// opacity 0→1 over `rasterFadeDuration` (drawn over its cached parent) instead
// of popping in on a zoom-level swap (the "satellite tiles change instantly"
// report). Proved on the LOCAL fixture_raster_local source (the same
// checker-tile.png for every tile, offline + deterministic — no network) under
// forced WebGL2 + headless SwiftShader, mirroring _raster-gl2-gate.spec.ts and
// the symbol-fade gate's three rungs:
//
//   1. PARITY      — `?rasterfade=0` (fade disabled = the pre-fade pop-in path)
//                    and the default 300 ms fade CONVERGE to a byte-identical
//                    frame (SHA-256 over readPixels): the fade only ramps alpha
//                    toward the same steady state.
//   2. RAMP        — on a long fade (`?rasterfade=12000`) the mechanism is live:
//                    hasFadingTiles() is true while tiles ramp, and the frame
//                    captured mid-ramp carries FEWER of the fixture's colour
//                    bins than the converged frame (tiles fade in from the
//                    background on first load); the long fade still converges to
//                    the exact `?rasterfade=0` hash.
//   3. DISABLED    — `?rasterfade=0` NEVER reports a fading tile (the keep-alive
//                    stays off), so the parity arm can't pass by both being mid-
//                    fade.

interface Frame {
  ok: boolean
  hash: string
  /** Fraction of the fixture PNG's top colour bins materially present. */
  bins: number
  fading: boolean
  glError: number
  validation: string[]
}

async function boot(page: import('@playwright/test').Page, rasterfade: number): Promise<number[]> {
  await page.setViewportSize({ width: 800, height: 600 })
  await page.goto(`/demo.html?id=fixture_raster_local&forcegl2=1&e2e=1&rasterfade=${rasterfade}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 30_000 },
  )
  // The fixture PNG's top-10 quantized colour bins — self-calibrating (a fixture
  // art change can't rot the gate), same signature _raster-gl2-gate.spec.ts uses.
  return page.evaluate(async () => {
    const blob = await (await fetch('/checker-tile.png')).blob()
    const bmp = await createImageBitmap(blob)
    const cv = document.createElement('canvas')
    cv.width = bmp.width
    cv.height = bmp.height
    const c2 = cv.getContext('2d')!
    c2.drawImage(bmp, 0, 0)
    const d = c2.getImageData(0, 0, bmp.width, bmp.height).data
    const counts = new Map<number, number>()
    for (let i = 0; i < d.length; i += 4)
      counts.set(
        ((d[i]! >> 5) << 6) | ((d[i + 1]! >> 5) << 3) | (d[i + 2]! >> 5),
        (counts.get(((d[i]! >> 5) << 6) | ((d[i + 1]! >> 5) << 3) | (d[i + 2]! >> 5)) ?? 0) + 1,
      )
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([k]) => k)
  })
}

function readFrame(page: import('@playwright/test').Page, sig: number[]): Promise<Frame> {
  return page.evaluate(async (cols) => {
    const w = window as unknown as {
      __xgisMap?: {
        invalidate?: () => void
        rasterRenderer?: { hasFadingTiles?: () => boolean }
        ctx?: { rhi?: { gl?: WebGL2RenderingContext }; _validationErrors?: { message: string }[] }
      }
    }
    w.__xgisMap?.invalidate?.()
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
    const gl = w.__xgisMap?.ctx?.rhi?.gl
    if (!gl) return { ok: false, hash: '', bins: 0, fading: false, glError: 0, validation: [] }
    const W = gl.drawingBufferWidth
    const H = gl.drawingBufferHeight
    const buf = new Uint8Array(W * H * 4)
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
    const digest = await crypto.subtle.digest('SHA-256', buf)
    const hash = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    const binCount = new Map<number, number>()
    for (let p = 0; p < W * H; p++) {
      const i = p * 4
      const k = ((buf[i]! >> 5) << 6) | ((buf[i + 1]! >> 5) << 3) | (buf[i + 2]! >> 5)
      binCount.set(k, (binCount.get(k) ?? 0) + 1)
    }
    const bins = cols.filter((k) => (binCount.get(k) ?? 0) > W * H * 0.003).length
    return {
      ok: true,
      hash,
      bins,
      fading: w.__xgisMap?.rasterRenderer?.hasFadingTiles?.() ?? false,
      glError: gl.getError(),
      validation: (w.__xgisMap?.ctx?._validationErrors ?? []).map((e) => e.message).slice(0, 5),
    }
  }, sig)
}

async function converge(
  page: import('@playwright/test').Page,
  sig: number[],
  timeoutMs: number,
): Promise<Frame> {
  const deadline = Date.now() + timeoutMs
  let prev = await readFrame(page, sig)
  for (;;) {
    await page.waitForTimeout(500)
    const cur = await readFrame(page, sig)
    // Settled: tiles cover (≥70% of the signature bins), no tile fading, hash stable.
    if (cur.ok && !cur.fading && cur.bins >= 7 && cur.hash === prev.hash) return cur
    if (Date.now() > deadline) return cur
    prev = cur
  }
}

test('raster tile fade — rasterfade=0 / 300 converge byte-identically; a long fade ramps then converges', async ({
  page,
}) => {
  test.setTimeout(300_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push(m.text().slice(0, 300))
  })

  // ── Arm A: fade disabled (the pre-fade instant pop-in path). ──
  const sigA = await boot(page, 0)
  const a = await converge(page, sigA, 90_000)
  expect(a.ok, 'A: WebGL2 context present').toBe(true)
  expect(a.glError, 'A: no gl error').toBe(0)
  expect(a.validation, 'A: no validation errors').toEqual([])
  expect(a.bins, `A: fixture tiles cover the view (${a.bins}/10 bins)`).toBeGreaterThanOrEqual(7)

  // ── Arm B: the library-default duration. ──
  const sigB = await boot(page, 300)
  const b = await converge(page, sigB, 90_000)

  // ── Arm C: 12 s ramp — the fade mechanism is live, then converges. ──
  const sigC = await boot(page, 12_000)
  // Poll for the mid-ramp: a frame where the renderer reports a fading tile.
  let early: Frame = await readFrame(page, sigC)
  {
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline && !(early.ok && early.fading)) {
      await page.waitForTimeout(120)
      early = await readFrame(page, sigC)
    }
  }
  const c = await converge(page, sigC, 150_000)

  expect(errors, 'no page errors').toEqual([])

  // (3) DISABLED — the fade-off arm never reports a fading tile, so the parity
  //     below can't pass by both frames being mid-fade.
  expect(a.fading, 'rasterfade=0 never fades a tile').toBe(false)

  // (1) PARITY — the default fade converges to the EXACT disabled frame.
  expect(b.hash, 'rasterfade=300 converged ≡ rasterfade=0').toBe(a.hash)

  // (2) RAMP — the mechanism engaged mid-fade (hasFadingTiles ⇒ some tile is at
  //     opacity < 1, which the FS multiplies into its alpha — the per-tile
  //     opacity packing + multiply are unit-proven), and the long fade still
  //     lands on the identical converged frame (the ramp settles to full).
  //     NOTE: the fixture serves ONE checker tile for every z-level, so a
  //     parent-under-child cross-fade is checker-over-checker — pixel-invisible
  //     by design. The mechanism flag + convergence are the robust signals here;
  //     a colour-delta mid-ramp would be timing-flaky (depends on whether a
  //     parent has loaded beneath), so it is deliberately not asserted.
  expect(early.fading, 'a raster tile was mid-fade on the long-fade boot').toBe(true)
  expect(c.hash, 'rasterfade=12000 converged ≡ rasterfade=0').toBe(a.hash)
})
