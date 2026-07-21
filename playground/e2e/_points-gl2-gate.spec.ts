import { test, expect, type Page } from '@playwright/test'

// #1057 ACCEPTANCE GATE — point features render on the WebGL2 backend
// (?forcegl2=1) across BOTH point paths. Points never drew on the forced-
// WebGL2 twin (renderFrameViaRhi): pointRenderer.render's only call site was the
// WebGPU pass-chain, and the VT tile-points inline flush (VectorTileRenderer's
// per-tile flushTilePoints) only ran inside the WebGPU encoder. This spec proves
// each path end-to-end through the shared PointDraper Material GLSL twin
// (emitPointGlsl — storage buffers lowered to data-texture samplers via
// emulateStorage), the writePointFrameUniform pack, and the SDF quad buffers:
//
//   1. DIRECT-LAYER points (inc1) — GeoJSON sources routed through
//      pointRenderer.addLayer draw via renderFrameViaRhi -> pointRenderer.renderRhi
//      after the translucent bucket. Witness demo: fixture_inline_push.
//   2. VT TILE-POINTS (inc2) — MVT / GeoJSON-VT point features accumulate via
//      VectorTileRenderer.emitTilePointsRhi and flush via flushTilePointsRhi INSIDE
//      the opaque loop (per opaque show, after its fills+strokes), mirroring the
//      WebGPU per-VTR placement. Witness demo: fixture_point.
//
// Witness = a DISTINCTIVE marker colour that cannot appear vacuously.
//
// fixture_inline_push (source tracks { type: geojson } populated via setSourceData)
// routes through pointRenderer.addLayer — probed under ?forcegl2=1: layerCount 1,
// expanded feat + vertex buffers built. Its paint is fill-rose-500 size-40
// (rgb ~244,63,94), five dots at (-30,0),(0,0),(30,0),(0,30),(0,-30). The demo-
// runner AUTO-PUSHES this data when ?e2e=1 is ABSENT (applyFixtureAutoPush), so
// the goto URL omits it.
//
// fixture_point is the TILE-POINTS witness. Its URL-geojson source (a single
// Point at (0,0)) routes through the virtual-PMTiles VT pipeline, so its dot
// draws via the VT tile-points inline path — NOT pointRenderer.addLayer, which
// stays empty on BOTH backends (inc1 documented this as a TRAP for the direct-
// layer test; here it is exactly the RIGHT path). Its paint is fill-red-500
// size-80 stroke-white (rgb ~239,68,68). On the twin BEFORE inc2 the opaque loop
// never accumulated/flushed tile points → zero red pixels → this gate FAILS
// (fail-before witness); with the port emitTilePointsRhi draws the disc → red
// pixels exceed the floor. Both fixtures sit over a black background — nothing
// else in either scene is red/rose, so the marker-colour count is unambiguous.
//
// Headless SwiftShader (HEADED=0 XGIS_SOFTWARE_GPU=1) — GPU-less, like the
// sibling _graticule-gl2-gate / _fills-gl2-gate / _lines-gl2-gate.

type MapWin = {
  __xgisReady?: boolean
  __xgisActiveBackend?: string
  __xgisMap?: {
    invalidate?: () => void
    ctx?: {
      rhi?: { backend?: string; gl?: WebGL2RenderingContext }
      _validationErrors?: { message: string }[]
    }
  }
}

const invalidate = (page: Page) =>
  page.evaluate(() => (window as unknown as MapWin).__xgisMap?.invalidate?.())

// Count red-dominant pixels via a direct GL readback (no big buffer crosses the
// CDP bridge — scalars only). A pixel counts as point fill when red clearly
// dominates green + blue — robust to alpha-blended disc edges and the exact
// palette value, and matches BOTH rose-500 (~244,63,94) and red-500 (~239,68,68).
const readRedFrame = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as MapWin
    const ctx = w.__xgisMap?.ctx
    const gl = ctx?.rhi?.gl
    if (!gl) return { ok: false as const }
    const W = gl.drawingBufferWidth
    const H = gl.drawingBufferHeight
    const buf = new Uint8Array(W * H * 4)
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
    let red = 0
    for (let p = 0; p < W * H; p++) {
      const i = p * 4
      const r = buf[i]
      const g = buf[i + 1]
      const b = buf[i + 2]
      if (r > 170 && g < 120 && b < 120 && r - g > 70 && r - b > 70) red++
    }
    return {
      ok: true as const,
      backend: ctx?.rhi?.backend,
      marker: w.__xgisActiveBackend,
      validation: (ctx?._validationErrors ?? []).map((e) => e.message).slice(0, 5),
      glError: gl.getError(),
      total: W * H,
      red,
    }
  })

// Boot a fixture under ?forcegl2=1, settle until red pixels clear the 0.05%
// floor (or the deadline), then assert the twin drew the marker-colour points
// with zero gl/validation/page errors. Shared by both point-path tests.
async function runGate(
  page: Page,
  testInfo: import('@playwright/test').TestInfo,
  opts: {
    demoId: string
    screenshot: string
  },
): Promise<void> {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push(m.text().slice(0, 300))
  })

  await page.setViewportSize({ width: 600, height: 600 })
  // No ?e2e=1 param: applyFixtureAutoPush (the setSourceData that drives
  // fixture_inline_push's direct-layer points) only fires when it is ABSENT.
  // It is a no-op for fixture_point (URL-geojson source loads on its own), so
  // omitting it is safe for both.
  // &preserve=1 (#1153 M2): readPixels-after-present needs the preserved buffer,
  // but this gate deliberately omits ?e2e=1 (its fixtures must auto-push).
  await page.goto(`/demo.html?id=${opts.demoId}&forcegl2=1&preserve=1`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(() => (window as unknown as MapWin).__xgisReady === true, {
    timeout: 30_000,
  })
  // No camera set: the demo boots at the default whole-world view, where the
  // dots (|lon|,|lat| <= 30) are visible.

  let f = await readRedFrame(page)
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline && !(f.ok && f.red > f.total * 0.0005)) {
    await invalidate(page)
    await page.waitForTimeout(1500)
    f = await readRedFrame(page)
  }

  expect(f.ok, 'forced-WebGL2 context present').toBe(true)
  if (!f.ok) return
  expect(f.marker, 'window.__xgisActiveBackend').toBe('webgl2')
  expect(f.backend, 'host.ctx.rhi.backend').toBe('webgl2')
  expect(f.glError, 'no gl error').toBe(0)
  expect(f.validation, 'no validation errors').toEqual([])
  expect(errors, 'no page/console errors').toEqual([])

  // Fail-before witness: marker-colour pixels only exist if the points drew.
  expect(f.red, `point-fill pixels ${f.red}/${f.total}`).toBeGreaterThan(f.total * 0.0005)

  // §5 — persist the ON frame so the pixel-count verdict can be image-inspected
  // (a scalar count is a tripwire, not a verdict).
  await page
    .locator('#xg-canv, canvas')
    .first()
    .screenshot({ path: testInfo.outputPath(opts.screenshot) })
}

test('direct-layer GeoJSON points render on WebGl2Device (?forcegl2=1)', async ({
  page,
}, testInfo) => {
  await runGate(page, testInfo, { demoId: 'fixture_inline_push', screenshot: 'points-on.png' })
})

test('VT tile-points render on WebGl2Device (?forcegl2=1)', async ({ page }, testInfo) => {
  await runGate(page, testInfo, { demoId: 'fixture_point', screenshot: 'tile-points-on.png' })
})
