// Regression: issue #416 — italic labels must slant their CJK/Hangul/Kana
// glyphs (synthetic oblique), because the italic glyph PBF serves ideographs
// UPRIGHT while Latin runs carry a real italic in their SDF.
//
// setDraws shears the quad corners of ideographic-codepoint glyphs in an
// `italic: true` draw: the TOP edge shifts +x relative to the BOTTOM edge by
// OBLIQUE_TAN × drawHeight (a forward lean about the baseline). Latin glyphs
// and non-italic draws are left axis-aligned (top.x === bottom.x).
//
// GPU-light harness mirrors text-renderer-newline-page.test.ts: an
// Object.create'd TextRenderer with a stub device whose queue.writeBuffer
// CAPTURES the vertex float data, so we can read each glyph's corner x.

import { describe, it, expect } from 'vitest'
import { TextRenderer } from './text-renderer'
import type { TextDraw } from './text-renderer'
import type { GlyphInfo } from '@xgis/map'
import { FrameArena } from '@xgis/engine'
import { WebGpuDevice } from '@xgis/engine'
import type { RhiBuffer, RhiBindGroup } from '@xgis/engine'

const g = globalThis as Record<string, unknown>
g.GPUBufferUsage ??= {
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16,
  VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
}

const PAGE_SIZE = 256
const FLOATS_PER_VERT = 4          // posX, posY, uvX, uvY
const VERTS_PER_GLYPH = 6
const OBLIQUE_TAN = 0.21           // must match text-renderer.ts
const SLOT = 24                    // glyph slot size (px)

/** GlyphInfo at the given codepoint. rasterFontSize == fontSize so the
 *  slot→display scale is 1 and drawHeight == SLOT. */
function glyph(codepoint: number): GlyphInfo {
  return {
    codepoint,
    slot: { page: 0, cellX: 0, cellY: 0, pxX: 0, pxY: 0, size: SLOT },
    advanceWidth: 12, bearingX: 1, bearingY: 18, width: 12, height: 18,
    pbf: true, rasterFontSize: SLOT,
  }
}

function makeRenderer(): { renderer: TextRenderer; verts: () => Float32Array } {
  let captured: Float32Array | null = null
  const fakeBuffer = { size: 1 << 20, destroy() {} } as unknown as GPUBuffer
  const stubDevice = {
    createBuffer: () => fakeBuffer,
    queue: {
      // The §4 seam routes vertex upload through rhi.writeBuffer(buf, 0, data) where
      // `data` is the arena-backed Float32Array VIEW (no byteOffset/size args). Copy
      // its exact bytes out now (the arena reuses its backing buffer across frames).
      writeBuffer(_b: unknown, _o: number, src: ArrayBufferView) {
        captured = new Float32Array(src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength))
      },
    },
  } as unknown as GPUDevice
  const stubAtlas = {
    pageCount: 1,
    getPage: () => ({ width: PAGE_SIZE }) as unknown as GPUTexture,
  }
  interface MutableRenderer {
    rhi: WebGpuDevice; atlas: typeof stubAtlas; _frameArena: FrameArena
    drawSlices: unknown[]; vertexBuf: RhiBuffer | null; vertexCount: number
    vertexBufCapacityBytes: number
    allUniforms: Float32Array | null; uniformBuf: RhiBuffer
    uniformBufCapacityBytes: number; bindGroupsByPage: RhiBindGroup[]
  }
  const r = Object.create(TextRenderer.prototype) as unknown as MutableRenderer
  r.rhi = new WebGpuDevice(stubDevice); r.atlas = stubAtlas; r._frameArena = new FrameArena(64 * 1024)
  r.drawSlices = []; r.vertexBuf = null; r.vertexCount = 0; r.vertexBufCapacityBytes = 0; r.allUniforms = null
  r.uniformBuf = r.rhi.createBuffer({ size: 256, usage: 'uniform', writable: true }); r.uniformBufCapacityBytes = 256; r.bindGroupsByPage = []
  return {
    renderer: r as unknown as TextRenderer,
    verts: () => { if (!captured) throw new Error('no vertex data captured'); return captured },
  }
}

/** x of corner `vert` (0=TL, 1=BL, 5=TR) of glyph `gi`. */
function cornerX(buf: Float32Array, gi: number, vert: number): number {
  return buf[gi * VERTS_PER_GLYPH * FLOATS_PER_VERT + vert * FLOATS_PER_VERT]!
}
/** Top-minus-bottom x: the oblique shear of glyph `gi` (0 = upright). */
function shearOf(buf: Float32Array, gi: number): number {
  return cornerX(buf, gi, 0) - cornerX(buf, gi, 1) // TL.x − BL.x
}

function draw(glyphs: GlyphInfo[], italic: boolean): TextDraw {
  return { anchorX: 100, anchorY: 100, glyphs, fontSize: SLOT, rasterFontSize: SLOT, color: [0, 0, 0, 1], italic }
}

const HANGUL = 0xc7a5  // 장
const LATIN = 0x41     // A

describe('TextRenderer italic synthetic oblique (#416)', () => {
  it('shears the CJK/Hangul glyphs of an italic label by OBLIQUE_TAN × height', () => {
    const { renderer, verts } = makeRenderer()
    renderer.setDraws([draw([glyph(LATIN), glyph(HANGUL)], true)])
    const buf = verts()
    // Hangul (idx 1): top edge leans +x by tan × drawHeight (forward italic).
    expect(shearOf(buf, 1)).toBeCloseTo(OBLIQUE_TAN * SLOT, 3)
    expect(shearOf(buf, 1)).toBeGreaterThan(0)
    // Latin (idx 0) in the SAME italic draw keeps its real-italic SDF — the
    // renderer must NOT also shear it (that would double-slant).
    expect(shearOf(buf, 0)).toBeCloseTo(0, 5)
  })

  it('leaves a non-italic label upright (no shear even for CJK)', () => {
    const { renderer, verts } = makeRenderer()
    renderer.setDraws([draw([glyph(HANGUL)], false)])
    expect(shearOf(verts(), 0)).toBeCloseTo(0, 5)
  })

  it('leaves the default (italic-unset) draw upright', () => {
    const { renderer, verts } = makeRenderer()
    const d: TextDraw = { anchorX: 100, anchorY: 100, glyphs: [glyph(HANGUL)], fontSize: SLOT, rasterFontSize: SLOT, color: [0, 0, 0, 1] }
    renderer.setDraws([d])
    expect(shearOf(verts(), 0)).toBeCloseTo(0, 5)
  })
})
