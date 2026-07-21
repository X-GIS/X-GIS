import { test, expect } from '@playwright/test'

// #1261 §5 gate — a raw-.xgis host-atlas icon layer (spriteUrl-less, fed by
// inline geojson + map.addImage) builds the IconStage and DISPATCHES icons on
// the WebGL2 backend. The deferred #797 end-to-end gate: the old
// _icons-gl2-gate counted white pixels that the POINT features' default markers
// alone satisfied, so it stayed green while `iconStage === null` — the bug.
//
// Root cause (fixed here): GraphicsManager.hostAtlas() filtered to
// `instanceof HostSpriteAtlasGPU`, returning null for the WebGL2 RHI twin
// (HostSpriteAtlasRhi), so the label-pass host-atlas gate never built the
// IconStage on WebGL2. This gate proves the MECHANISM directly — iconStage
// non-null + a non-zero icon vertexCount — which the point markers cannot fake
// (they never touch iconStage). Headless SwiftShader (HEADED=0
// XGIS_SOFTWARE_GPU=1).

interface Probe {
  ok: boolean
  iconStagePresent: boolean
  iconVertexCount: number
  backend?: string
  glError: number
  validation: string[]
  lit: number
}

test('host-atlas icons build + dispatch on WebGl2Device (#1261)', async ({ page }) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push(m.text().slice(0, 300))
  })

  await page.goto('/demo.html?id=fixture_symbol_icon&forcegl2=1&e2e=1', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 30_000 },
  )

  // ?e2e=1 opts out of auto-push — register a solid marker + the labelled points
  // ourselves (the documented host-image recipe; zero network).
  await page.evaluate(() => {
    const map = (
      window as unknown as {
        __xgisMap?: {
          addImage?: (name: string, image: ImageData) => void
          setSourceData?: (id: string, fc: unknown) => void
        }
      }
    ).__xgisMap
    const px = new Uint8ClampedArray(32 * 32 * 4)
    for (let i = 0; i < px.length; i += 4) {
      px[i] = 255
      px[i + 1] = 255
      px[i + 2] = 255
      px[i + 3] = 255
    }
    map?.addImage?.('e2e-marker', new ImageData(px, 32, 32))
    map?.setSourceData?.('pois', {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [0, 20] },
          properties: { name: 'Alpha' },
        },
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [40, 0] },
          properties: { name: 'Beta' },
        },
      ],
    })
  })

  const probe = (): Promise<Probe> =>
    page.evaluate(() => {
      const w = window as unknown as {
        __xgisMap?: {
          invalidate?: () => void
          iconStage?: { renderer?: { vertexCount?: number } } | null
          ctx?: {
            rhi?: { backend?: string; gl?: WebGL2RenderingContext }
            _validationErrors?: { message: string }[]
          }
        }
      }
      w.__xgisMap?.invalidate?.()
      const m = w.__xgisMap
      const gl = m?.ctx?.rhi?.gl
      if (!gl)
        return {
          ok: false,
          iconStagePresent: false,
          iconVertexCount: 0,
          glError: 0,
          validation: [],
          lit: 0,
        }
      const W = gl.drawingBufferWidth
      const H = gl.drawingBufferHeight
      const buf = new Uint8Array(W * H * 4)
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
      let lit = 0
      for (let p = 0; p < W * H; p++) {
        const i = p * 4
        if (buf[i]! + buf[i + 1]! + buf[i + 2]! > 120) lit++
      }
      return {
        ok: true,
        iconStagePresent: m?.iconStage != null,
        iconVertexCount: m?.iconStage?.renderer?.vertexCount ?? 0,
        backend: m?.ctx?.rhi?.backend,
        glError: gl.getError(),
        validation: (m?.ctx?._validationErrors ?? []).map((e) => e.message).slice(0, 5),
        lit,
      }
    })

  // Converge on the MECHANISM: the host-atlas IconStage built AND dispatched
  // icon quads (point markers never touch iconStage → cannot fake this).
  let r = await probe()
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline && !(r.ok && r.iconStagePresent && r.iconVertexCount > 0)) {
    await page.waitForTimeout(1500)
    r = await probe()
  }

  expect(r.ok, 'forced-WebGL2 context present').toBe(true)
  expect(r.backend, 'host.ctx.rhi.backend').toBe('webgl2')
  expect(r.glError, 'no gl error').toBe(0)
  expect(r.validation, 'no validation errors').toEqual([])
  expect(errors, 'no page/console errors').toEqual([])

  // THE FIX — the host-atlas IconStage now builds on WebGL2 (was null: #1261).
  expect(r.iconStagePresent, 'host-atlas IconStage built on WebGL2').toBe(true)
  // And icons are actually DISPATCHED (2 points × 6 verts = 12) — point markers
  // never write here, so this cannot pass on the old default-marker path.
  expect(r.iconVertexCount, `icon vertexCount ${r.iconVertexCount}`).toBeGreaterThan(0)
  // Non-vacuous: the frame carries lit pixels (icons + labels rendered).
  expect(r.lit, `lit pixels ${r.lit}`).toBeGreaterThan(500)
})
