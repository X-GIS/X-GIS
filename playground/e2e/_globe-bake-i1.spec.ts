/// <reference types="@webgpu/types" />
import { test, expect } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// #599 I1 — offscreen per-tile vector bake (globe vector drape approach B, bake→
// texture→drape). Proves the FIRST rung: VectorTileRenderer.bakeTileToTexture
// rasterizes a resident fill tile into an offscreen colour RT in tile-local ortho.
// The probe is inlined in page.evaluate (reaching the already-exposed
// window.__xgisMap) so nothing outside this spec + the lib method is touched.
// Verified by GPU readback (coverage) + a PNG the main context reads (§5 tile-crop).
// Real NVIDIA adapter (headed WebGPU) — headless would fall back to a null adapter.

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__globe-bake-i1__')

type ProbeResult = {
  sliceLayer?: string
  key?: number
  coverage?: number
  sizePx?: number
  preview?: string
  error?: string
}

test('#599 I1 — offscreen tile-bake rasterizes a resident fill tile', async ({ page }) => {
  test.setTimeout(90_000)
  mkdirSync(OUT, { recursive: true })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.setViewportSize({ width: 900, height: 900 })

  // Tokyo z14 — dense building / land-use fills, so a resident fill tile is
  // guaranteed once tiles upload.
  await page.goto('/demo.html?id=pmtiles_layered#14/35.66/139.78', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 30_000 },
  )

  // Poll until a fill tile is resident + bakes (tiles upload over a few frames).
  let res: ProbeResult = { error: 'not run' }
  for (let attempt = 0; attempt < 12; attempt++) {
    await page.waitForTimeout(1500)
    res = await page.evaluate(async (sizePx: number) => {
      const MAP_READ = 0x0001
      const COPY_DST = 0x0008
      const w = window as unknown as {
        __xgisMap?: {
          vtSources: Map<
            string,
            {
              renderer: {
                gpuCache: Map<string, Map<number, { indexCount: number; extruded?: boolean }>>
                bakeTileToTexture: (
                  s: string,
                  k: number,
                  f: [number, number, number, number],
                  n: number,
                ) => { native: GPUTexture } | null
              }
            }
          >
          ctx?: { device: GPUDevice; format: string }
        }
      }
      const map = w.__xgisMap
      if (!map?.ctx) return { error: 'no ctx (device not ready)' }
      const dev = map.ctx.device
      const isBGRA = (map.ctx.format || '').startsWith('bgra')
      for (const { renderer: vtr } of map.vtSources.values()) {
        for (const [sliceLayer, tiles] of vtr.gpuCache) {
          for (const [key, tile] of tiles) {
            if (tile.indexCount <= 0 || tile.extruded) continue
            const tex = vtr.bakeTileToTexture(sliceLayer, key, [1, 0, 0, 1], sizePx)
            if (!tex) continue
            const gpuTex = tex.native
            const bpr = Math.ceil((sizePx * 4) / 256) * 256
            const rb = dev.createBuffer({ size: bpr * sizePx, usage: MAP_READ | COPY_DST })
            const enc = dev.createCommandEncoder()
            enc.copyTextureToBuffer(
              { texture: gpuTex },
              { buffer: rb, bytesPerRow: bpr, rowsPerImage: sizePx },
              { width: sizePx, height: sizePx },
            )
            dev.queue.submit([enc.finish()])
            await rb.mapAsync(MAP_READ)
            const srcArr = new Uint8Array(rb.getMappedRange().slice(0))
            rb.unmap()
            rb.destroy()
            gpuTex.destroy()

            let covered = 0
            const rgba = new Uint8ClampedArray(sizePx * sizePx * 4)
            for (let y = 0; y < sizePx; y++) {
              for (let x = 0; x < sizePx; x++) {
                const s = y * bpr + x * 4
                const d = (y * sizePx + x) * 4
                const a = srcArr[s + 3]!
                if (a > 0) covered++
                rgba[d] = isBGRA ? srcArr[s + 2]! : srcArr[s]!
                rgba[d + 1] = srcArr[s + 1]!
                rgba[d + 2] = isBGRA ? srcArr[s]! : srcArr[s + 2]!
                rgba[d + 3] = a
              }
            }
            const cv = document.createElement('canvas')
            cv.width = sizePx
            cv.height = sizePx
            cv.getContext('2d')!.putImageData(new ImageData(rgba, sizePx, sizePx), 0, 0)
            return {
              sliceLayer,
              key,
              coverage: covered / (sizePx * sizePx),
              sizePx,
              preview: cv.toDataURL('image/png'),
            }
          }
        }
      }
      return { error: 'no resident fill tile (pan/zoom to a filled view first)' }
    }, 256)
    if (!res.error) break
  }

  console.log(
    'BAKE_I1',
    JSON.stringify({ ...res, preview: res.preview ? `[png ${res.preview.length}b]` : undefined }),
  )
  console.log('BAKE_I1 pageerrors', errors.length, errors.slice(0, 3))

  if (res.preview) {
    const b64 = res.preview.replace(/^data:image\/png;base64,/, '')
    writeFileSync(join(OUT, 'baked-tile.png'), Buffer.from(b64, 'base64'))
  }

  expect(res.error, `probe error: ${res.error}`).toBeUndefined()
  // A resident fill tile must rasterize SOME footprint in the bake RT.
  expect(res.coverage ?? 0).toBeGreaterThan(0.001)
})
