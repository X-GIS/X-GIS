// Reproduces the user-reported "too many tiles drawn for viewport"
// problem. Real-device iPhone inspector at Tokyo zoom 11.5 / pitch
// 0° showed:
//
//   currentZ      : 12
//   drawn by zoom : z=10:6 z=11:24 z=12:60   ← 22 unique total
//   viewport math : ~6 unique tiles for z=12 (430/179 × 429/179
//                   = 2.4 × 2.4 cover) on a 430×429 canvas
//
// Spec drives the same camera + viewport in headless Chromium so
// we can measure visibleTilesFrustum + per-zoom drawn counts and
// pin a regression bound.

import { test, expect } from '@playwright/test'

interface VTRDiag {
  getDrawStats?: () => { tilesVisible: number; drawCalls: number }
  _frameDrawnByZoom?: Map<number, number>
  _hysteresisZ?: number
  gpuCache?: Map<string, Map<number, { tileZoom?: number }>>
}
interface XGISMap {
  vtSources?: Map<string, { renderer: VTRDiag }>
  camera?: { zoom: number; centerX: number; centerY: number; pitch?: number }
}
declare global {
  interface Window { __xgisMap?: XGISMap; __xgisReady?: boolean }
}

test.describe('Mobile flat-pitch over-draw', () => {
  test.use({ viewport: { width: 430, height: 715 } })

  test('Tokyo z=12 pitch=0: drawn unique tile count stays bounded', async ({ page }) => {
    test.setTimeout(60_000)

    await page.addInitScript(() => {
      ;(window as unknown as { __DBG_FRUSTUM: boolean }).__DBG_FRUSTUM = true
    })
    page.on('console', m => {
      if (m.text().includes('[FRUSTUM')) console.log(m.text())
    })
    await page.goto(
      `/demo.html?id=pmtiles_layered#11.52/35.7553/139.6973/0/0`,
      { waitUntil: 'domcontentloaded' },
    )
    await page.waitForFunction(
      () => window.__xgisReady === true,
      null, { timeout: 30_000 },
    )
    await page.waitForFunction(() => {
      const map = window.__xgisMap
      if (!map?.vtSources) return false
      let v = 0
      for (const { renderer } of map.vtSources.values()) {
        v += renderer.getDrawStats?.().tilesVisible ?? 0
      }
      return v > 0
    }, null, { timeout: 60_000 })
    await page.waitForTimeout(5000)

    const result = await page.evaluate(() => {
      const map = window.__xgisMap
      if (!map?.vtSources) return null
      const out: {
        cameraZoom: number; pitch: number
        canvasW: number; canvasH: number
        currentZ: number | null
        drawnByZoom: Record<string, number>
        drawnTotal: number
        drawnUniqueByZoom: Record<string, number>
        gpuRetainedByZoom: Record<string, number>
        layerCount: number
      } = {
        cameraZoom: map.camera?.zoom ?? 0,
        pitch: map.camera?.pitch ?? 0,
        canvasW: 0, canvasH: 0,
        currentZ: null,
        drawnByZoom: {},
        drawnTotal: 0,
        drawnUniqueByZoom: {},
        gpuRetainedByZoom: {},
        layerCount: 0,
      }
      const canvas = document.querySelector('canvas') as HTMLCanvasElement | null
      if (canvas) { out.canvasW = canvas.width; out.canvasH = canvas.height }
      for (const { renderer } of map.vtSources.values()) {
        const r = renderer as VTRDiag
        out.currentZ = r._hysteresisZ ?? null
        const dz = r._frameDrawnByZoom
        if (dz) {
          for (const [z, n] of dz) {
            out.drawnByZoom[z] = (out.drawnByZoom[z] ?? 0) + n
            out.drawnTotal += n
          }
        }
        if (r.gpuCache) {
          out.layerCount = r.gpuCache.size
          // unique key per zoom (sample first slot)
          const first = r.gpuCache.values().next().value
          if (first) {
            for (const tile of first.values()) {
              const tz = tile.tileZoom
              if (typeof tz === 'number') {
                out.drawnUniqueByZoom[tz] = (out.drawnUniqueByZoom[tz] ?? 0) + 1
              }
            }
          }
          // gpu retained across all layers
          for (const inner of r.gpuCache.values()) {
            for (const tile of inner.values()) {
              const tz = tile.tileZoom
              if (typeof tz === 'number') {
                out.gpuRetainedByZoom[tz] = (out.gpuRetainedByZoom[tz] ?? 0) + 1
              }
            }
          }
        }
      }
      return out
    })

    if (!result) throw new Error('no map')
    console.log('[viewport]', result.canvasW, '×', result.canvasH)
    console.log('[camera] zoom=', result.cameraZoom, 'pitch=', result.pitch)
    console.log('[currentZ]', result.currentZ)
    console.log('[layers]', result.layerCount)
    console.log('[drawn by zoom]', result.drawnByZoom, 'total', result.drawnTotal)
    console.log('[drawn unique by zoom (single layer sample)]', result.drawnUniqueByZoom)
    console.log('[gpu retained by zoom (all layers)]', result.gpuRetainedByZoom)

    // ── Coverage 1: VIEWPORT MATH ─────────────────────────────
    // Compute the set of z=currentZ tile (x, y) pairs that the
    // camera frustum actually projects onto. At pitch 0 this is
    // a simple AABB; the centre tile + every neighbour whose
    // bounds intersect the canvas rectangle. We derive it from
    // first principles, not from visibleTilesFrustum, so this is
    // an independent oracle for what *should* be drawn.
    const expected = await page.evaluate(() => {
      const map = window.__xgisMap!
      const camera = map.camera!
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cz = (([...map.vtSources!.values()][0]).renderer as any)._hysteresisZ as number
      const canvas = document.querySelector('canvas') as HTMLCanvasElement
      const cw = canvas.width, ch = canvas.height
      // Mercator → tile-y at zoom z.
      const R = 6378137
      const camLon = (camera.centerX / R) * (180 / Math.PI)
      const camLat = (2 * Math.atan(Math.exp(camera.centerY / R)) - Math.PI / 2) * (180 / Math.PI)
      const n = Math.pow(2, cz)
      // tile size at the camera's zoom (camera.zoom is fractional)
      const tileSizePx = 256 * Math.pow(2, camera.zoom - cz)
      // viewport half in tile units
      const halfTilesX = (cw / 2) / tileSizePx
      const halfTilesY = (ch / 2) / tileSizePx
      const camTX = (camLon + 180) / 360 * n
      const camTY = (1 - Math.log(Math.tan(Math.PI / 4 + camLat * Math.PI / 360)) / Math.PI) / 2 * n
      const minTX = Math.floor(camTX - halfTilesX)
      const maxTX = Math.floor(camTX + halfTilesX)
      const minTY = Math.floor(camTY - halfTilesY)
      const maxTY = Math.floor(camTY + halfTilesY)
      const expected: { x: number; y: number }[] = []
      for (let x = minTX; x <= maxTX; x++) {
        for (let y = minTY; y <= maxTY; y++) {
          if (y < 0 || y >= n) continue
          expected.push({ x: ((x % n) + n) % n, y })
        }
      }
      // Read what visibleTilesFrustum actually returned (cached).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cache = (([...map.vtSources!.values()][0]).renderer as any)._frameTileCache
      const actualAtZ: { x: number; y: number }[] = []
      if (cache?.tiles) {
        for (const t of cache.tiles) {
          if (t.z === cz) actualAtZ.push({ x: t.x, y: t.y })
        }
      }
      return { expected, actualAtZ, cz, tileSizePx, camTX, camTY }
    })
    console.log(`[expected at z=${expected.cz}] tile size ${expected.tileSizePx.toFixed(0)} px,`,
      `camTile (${expected.camTX.toFixed(2)}, ${expected.camTY.toFixed(2)})`,
      `→ ${expected.expected.length} tiles:`,
      expected.expected.map(t => `${t.x},${t.y}`).join(' '))
    console.log(`[actual visibleTilesFrustum at z=${expected.cz}] ${expected.actualAtZ.length} tiles:`,
      expected.actualAtZ.map(t => `${t.x},${t.y}`).join(' '))

    // Every expected tile must appear in the actual visible set.
    const actualSet = new Set(expected.actualAtZ.map(t => `${t.x},${t.y}`))
    const missing = expected.expected.filter(t => !actualSet.has(`${t.x},${t.y}`))
    console.log(`[coverage gaps] ${missing.length} expected tiles missing from visible set`)
    expect(missing.length).toBe(0)

    // (Pixel-readback-from-WebGPU-canvas check intentionally omitted:
    //  WebGPU swap chain's preserveDrawingBuffer defaults to false,
    //  so drawImage(canvas) into a 2D context returns black under
    //  Playwright headless. Coverage is verified via the AABB
    //  intersection check above — every tile the camera projects
    //  onto must be in the visible set for canvas to fill correctly.)

    // Direct visibleTilesFrustum invocation — bypasses VTR's frame
    // cache so we see exactly what the cap is producing this call.
    const direct = await page.evaluate(async () => {
      const map = window.__xgisMap
      if (!map) return null
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m = map as any
      const ctx = m.ctx
      // The runtime exports we need: visibleTilesFrustum +
      // mercator. Reach into the bundled module via the live
      // gpu/map references — the test harness already exposed them.
      const renderers = [...(m.vtSources?.values() ?? [])]
      const r0 = renderers[0]?.renderer
      if (!r0 || !r0.source) return null
      // Find one bundled `tiles` import via well-known global if any.
      // Easier: instrument directly — we know the runtime calls
      // visibleTilesFrustum once per frame with the cached
      // result. Read VTR's _frameTileCache.
      const cache = r0._frameTileCache
      const tiles: { z: number; x: number; y: number }[] = cache?.tiles ?? []
      const byZ = new Map<number, number>()
      for (const t of tiles) byZ.set(t.z, (byZ.get(t.z) ?? 0) + 1)
      return {
        cacheTilesLength: tiles.length,
        byZoom: Object.fromEntries(byZ),
        cacheCurrentZ: cache?.currentZ,
        cacheMarginPx: cache?.marginPx,
      }
    })
    console.log('[visibleTilesFrustum cached]', direct)

    // Viewport math: at zoom 11.52 the z=12 tile ≈ 179 px on a 430-
    // wide viewport. ~6 unique cover. Allow up to 16 to absorb the
    // 3×3 camera-tile inject + the visibleTilesFrustum cap (~12 on
    // a tiny canvas). The original bug (5×5 inject, 25+ uniques)
    // sits well above this floor.
    const uniqueAtCurrentZ = result.drawnUniqueByZoom[String(result.currentZ ?? 12)] ?? 0
    expect(uniqueAtCurrentZ).toBeLessThan(16)
  })
})
