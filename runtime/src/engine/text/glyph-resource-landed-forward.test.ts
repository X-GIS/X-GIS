// Audit ① B1 — TextStage must FORWARD the PBF rasterizer's `onLanded`
// (an async glyph range arriving after the requesting frame drew) to the
// host-supplied `onResourceLanded` callback. Without it the atlas slot is
// invalidated but the map's frame loop is never re-armed, so the S16 skip
// keeps replaying the stale zero-SDF glyph until the camera moves.
//
// Mirrors pbf-rasterizer.test.ts's "miss → schedule fetch → land" timing,
// but drives it through a real TextStage to prove the constructor's onLanded
// closure rings the bell.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TextStage } from './text-stage'
import { MockRasterizer, FONT_KEY_SENTINEL } from './sdf/glyph-rasterizer'
import { WebGpuDevice } from '@xgis/engine'
import { GlyphPbfCache } from './sdf/pbf/glyph-pbf-cache'
import type { PbfRasterizer } from './sdf/pbf-rasterizer'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, 'sdf', 'pbf', '__fixtures__', 'open-sans-semibold-0-255.pbf')
const PBF_BYTES = readFileSync(FIXTURE)

// WebGPU bitflag globals the GPU classes touch at construction.
const g = globalThis as Record<string, unknown>
g.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 }
g.GPUBufferUsage ??= {
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16,
  VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
}
g.GPUTextureUsage ??= {
  COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16,
}
g.GPUColorWrite ??= { RED: 1, GREEN: 2, BLUE: 4, ALPHA: 8, ALL: 15 }

function stubDevice(): GPUDevice {
  const stub: unknown = new Proxy(function () { return stub }, {
    get(_t, p) {
      if (p === 'size') return 1 << 22
      if (p === 'width' || p === 'height') return 4096
      if (p === 'limits') return { maxTextureDimension2D: 8192 }
      if (p === Symbol.toPrimitive) return () => 0
      return stub
    },
    apply() { return stub },
  })
  return stub as GPUDevice
}

function fontKeyOf(style: string, weight: number, family: string): string {
  return `${FONT_KEY_SENTINEL}${style}${FONT_KEY_SENTINEL}${weight}${FONT_KEY_SENTINEL}${family}`
}

describe('TextStage onLanded → onResourceLanded forward (Audit ① B1)', () => {
  it('rings onResourceLanded when a PBF glyph range lands async', async () => {
    const onResourceLanded = vi.fn()
    const fetchOK = () => Promise.resolve(new Response(PBF_BYTES, { status: 200 }))
    const cache = new GlyphPbfCache({ glyphsUrl: 'https://x/{fontstack}/{range}.pbf', fetch: fetchOK })

    const stage = new TextStage(stubDevice(), new WebGpuDevice(stubDevice()), 'bgra8unorm', {
      glyphProviders: [cache],
      onResourceLanded,
    })
    // The constructor wires the PbfRasterizer with TextStage's onLanded
    // closure; reach it to trigger the miss → schedule-fetch → land path.
    const ras = (stage as unknown as { pbfRasterizer: PbfRasterizer }).pbfRasterizer
    expect(ras, 'PbfRasterizer should exist when glyphProviders is set').toBeDefined()

    const fontKey = fontKeyOf('normal', 600, 'Open Sans')
    // Miss: no cached range yet → emits a fallback disc + schedules the fetch.
    ras.rasterize({ fontKey, fontSize: 32, codepoint: 0x41, sdfRadius: 8, slotSize: 64 })
    expect(onResourceLanded).not.toHaveBeenCalled() // hasn't landed yet

    // Let the fetch → arrayBuffer → decode microtask chain settle.
    await new Promise<void>((r) => setTimeout(r, 30))

    expect(onResourceLanded).toHaveBeenCalled()
  })

  it('no PbfRasterizer (no glyph sources) → no crash, callback never fires', () => {
    const onResourceLanded = vi.fn()
    const stage = new TextStage(stubDevice(), new WebGpuDevice(stubDevice()), 'bgra8unorm', {
      rasterizer: new MockRasterizer(),
      onResourceLanded,
    })
    expect((stage as unknown as { pbfRasterizer: PbfRasterizer | null }).pbfRasterizer).toBeNull()
    expect(onResourceLanded).not.toHaveBeenCalled()
  })

  it('invalidateAllGlyphs() bumps the atlas generation so glyphs re-raster (WOFF font-land invalidate half)', () => {
    // Closes the ② coverage gap: the device-free map test exercises only the
    // render-kick (markLabelDirty, textStage null there); this pins the
    // invalidate half — the generation bump that breaks the stringInfoCache
    // short-circuit so a Canvas2D fallback glyph re-rasters once the WOFF lands.
    const stage = new TextStage(stubDevice(), new WebGpuDevice(stubDevice()), 'bgra8unorm', { rasterizer: new MockRasterizer() })
    stage.host.ensureString(fontKeyOf('normal', 400, 'X'), 'A') // populate one glyph
    const g0 = stage.host.getGeneration()
    stage.invalidateAllGlyphs()
    expect(stage.host.getGeneration(), 'invalidateAllGlyphs must bump the atlas generation').toBe(g0 + 1)
  })
})
