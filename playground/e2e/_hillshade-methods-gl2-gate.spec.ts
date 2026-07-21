import { test, expect } from '@playwright/test'

// hillshade-method MATRIX GATE — every MapLibre v5 shading model renders real
// relief on the WebGL2 backend AND differs from `standard` (proving the
// hs_light.w method flag actually dispatches distinct shader branches, not a
// single shared fallback). Runs the four method fixtures over the SAME local
// Terrain-RGB DEM (dem-fixture.png, offline + deterministic):
//
//   fixture_hillshade_local     → standard (the #1187 acceptance baseline)
//   fixture_hillshade_basic     → basic (GDAL Lambert)
//   fixture_hillshade_combined  → combined (slope-weighted Lambert angle)
//   fixture_hillshade_igor      → igor (aspect-weighted slope strength)
//   fixture_hillshade_multidir  → multidirectional (3 tinted Lambert sources)
//
// Structure assertion (per §5: numbers never decide alone, a pixel-COUNT gate
// passes on broken images): each frame must carry a genuine luminance SPREAD
// (≥3 histogram bins + range ≥24 — the _hillshade-gl2-gate relief signature),
// and the per-method frame must differ from standard on ≥2% of lit pixels.
//
// Headless SwiftShader (HEADED=0 XGIS_SOFTWARE_GPU=1) — GPU-less, CI-safe.

interface Frame {
  ok: boolean
  lit?: number
  nonEmptyBins?: number
  spread?: number
  total?: number
  pixels?: number[]
  w?: number
  h?: number
}

async function captureDemo(
  page: import('@playwright/test').Page,
  id: string,
  errors: string[],
): Promise<Frame> {
  await page.goto(`/demo.html?id=${id}&forcegl2=1&e2e=1`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 30_000 },
  )
  const readFrame = () =>
    page.evaluate(() => {
      const w = window as unknown as {
        __xgisMap?: { ctx?: { rhi?: { gl?: WebGL2RenderingContext } } }
      }
      const gl = w.__xgisMap?.ctx?.rhi?.gl
      if (!gl) return { ok: false as const }
      const W = gl.drawingBufferWidth
      const H = gl.drawingBufferHeight
      const buf = new Uint8Array(W * H * 4)
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
      const bins = new Array<number>(16).fill(0)
      let lit = 0
      let minL = 255
      let maxL = 0
      // Downsample to a 64×64 luminance grid for the cross-method diff so the
      // returned payload stays small and resolution-independent.
      const GRID = 64
      const pixels = new Array<number>(GRID * GRID).fill(-1)
      for (let p = 0; p < W * H; p++) {
        const i = p * 4
        if (buf[i + 3] === 0) continue
        const lum = (buf[i] * 0.299 + buf[i + 1] * 0.587 + buf[i + 2] * 0.114) | 0
        bins[Math.min(15, lum >> 4)]++
        lit++
        if (lum < minL) minL = lum
        if (lum > maxL) maxL = lum
        const x = p % W
        const y = (p / W) | 0
        const g = (((y * GRID) / H) | 0) * GRID + (((x * GRID) / W) | 0)
        // Keep the max-luminance representative per cell (stable reduction).
        if (lum > pixels[g]) pixels[g] = lum
      }
      return {
        ok: true as const,
        total: W * H,
        lit,
        nonEmptyBins: bins.filter((b) => b > lit * 0.002).length,
        spread: lit ? maxL - minL : 0,
        pixels,
        w: GRID,
        h: GRID,
      }
    })
  const relief = (r: Frame): boolean =>
    !!r.ok &&
    (r.lit ?? 0) > (r.total ?? 1) * 0.05 &&
    (r.nonEmptyBins ?? 0) >= 3 &&
    (r.spread ?? 0) >= 24
  let r: Frame = await readFrame()
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline && !relief(r)) {
    await page.evaluate(() => {
      ;(window as unknown as { __xgisMap?: { invalidate?: () => void } }).__xgisMap?.invalidate?.()
    })
    await page.waitForTimeout(2000)
    r = await readFrame()
  }
  expect(errors, `no page/console errors while rendering ${id}`).toEqual([])
  return r
}

/** Fraction of populated 64×64 cells whose luminance differs by >8 levels. */
function diffFraction(a: Frame, b: Frame): number {
  const pa = a.pixels ?? []
  const pb = b.pixels ?? []
  let both = 0
  let diff = 0
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    if (pa[i] < 0 || pb[i] < 0) continue
    both++
    if (Math.abs(pa[i] - pb[i]) > 8) diff++
  }
  return both > 0 ? diff / both : 0
}

test('every hillshade-method renders relief and differs from standard (?forcegl2=1)', async ({
  page,
}) => {
  test.setTimeout(420_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push(m.text().slice(0, 300))
  })

  const standard = await captureDemo(page, 'fixture_hillshade_local', errors)
  expect(standard.ok, 'standard baseline rendered').toBe(true)
  expect(standard.spread ?? 0, 'standard relief spread').toBeGreaterThanOrEqual(24)
  expect(standard.nonEmptyBins ?? 0, 'standard luminance levels').toBeGreaterThanOrEqual(3)

  for (const id of [
    'fixture_hillshade_basic',
    'fixture_hillshade_combined',
    'fixture_hillshade_igor',
    'fixture_hillshade_multidir',
  ]) {
    const frame = await captureDemo(page, id, errors)
    expect(frame.ok, `${id} rendered`).toBe(true)
    expect(frame.spread ?? 0, `${id} relief spread`).toBeGreaterThanOrEqual(24)
    expect(frame.nonEmptyBins ?? 0, `${id} luminance levels`).toBeGreaterThanOrEqual(3)
    const df = diffFraction(standard, frame)
    expect(
      df,
      `${id} differs from standard on ≥2% of cells (got ${(df * 100).toFixed(1)}%)`,
    ).toBeGreaterThanOrEqual(0.02)
  }
})
