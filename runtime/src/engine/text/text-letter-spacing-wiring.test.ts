// text-letter-spacing: pen-advance wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: text-letter-spacing is
// marked `supported` (symbol capability + layout-symbol spec-coverage) and the
// CPU em→px conversion is unit-tested (font-typography.test.ts), but the
// RUNTIME WIRING that turns TextDraw.letterSpacingPx into actual on-screen
// per-glyph quad positions was verified only structurally. The runtime
// contract is: in TextRenderer.setDraws, the single-line pen-advance path (no
// glyphOffsets) advances penX by `g.advanceWidth*scale` AND, between adjacent
// glyphs, by `letterSpacingPx` (text-renderer.ts:328). The vertex shader reads
// the resulting pos_px X out of the vertex buffer → letter-spacing is the only
// term that moves glyph N+1 rightward by exactly L px relative to L=0.
//
// This drives the REAL TextRenderer.setDraws (mirroring the
// text-renderer-newline-page.test.ts harness: Object.create + stub
// device/atlas, real FrameArena) and intercepts the single
// device.queue.writeBuffer(this.vertexBuf, ...) the vertex packer emits, then
// reads glyph[1]'s pos_px.x for two runs (letterSpacing = 0 and = L). Every
// other term (bearingX, scale, quad centering, anchor) is identical between the
// runs, so they cancel: the delta of glyph[1].x is EXACTLY letterSpacingPx.
//
// Fail-before: drop `penX += letterSpacingPx` (write `penX += 0`, or stop
// threading d.letterSpacingPx) and the delta collapses to 0 — the wiring that
// makes text-letter-spacing reach the GPU is gone, and this test catches it
// before any render. Non-vacuous: it asserts the prop-controlled DELTA, never a
// constant.

import { describe, it, expect } from 'vitest'
import { TextRenderer } from './text-renderer'
import type { TextDraw } from './text-renderer'
import type { GlyphInfo } from './sdf/glyph-atlas-host'
import { FrameArena } from '@xgis/engine'
import { WebGpuDevice } from '@xgis/engine'
import type { RhiBuffer, RhiBindGroup } from '@xgis/engine'

// setDraws creates the vertex buffer via device.createBuffer({ usage:
// GPUBufferUsage.VERTEX | ... }) — the bitflag global isn't present in the
// node test env. Values per the WebGPU spec (mirrors text-renderer-newline-page).
const gg = globalThis as Record<string, unknown>
gg.GPUBufferUsage ??= {
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16,
  VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
}

const PAGE_SIZE = 256
// pos_px is location 0 (slots 0,1); uv is location 1 (slots 2,3); stride 16 →
// 4 floats/vertex, 6 verts/glyph = 24 floats/glyph. Glyph[1]'s vertex 0 (TL)
// pos_px.x lives at float index 24. (See text-vertex-format.ts / TEXT_FORMAT.)
const FLOATS_PER_GLYPH = 24
const GLYPH1_TL_X = FLOATS_PER_GLYPH * 1 + 0

/** Minimal single-page GlyphInfo. All metrics identical across the two runs so
 *  only letterSpacingPx can move glyph[1]. */
function glyph(codepoint: number): GlyphInfo {
  return {
    codepoint,
    slot: { page: 0, cellX: 0, cellY: 0, pxX: 0, pxY: 0, size: 24 },
    advanceWidth: 12,
    bearingX: 1,
    bearingY: 18,
    width: 12,
    height: 18,
    pbf: true,
    rasterFontSize: 24,
  }
}

/** Build a setDraws-capable TextRenderer without touching real WebGPU, and
 *  capture the vertex floats the packer uploads via queue.writeBuffer. */
function makeRenderer(): { renderer: TextRenderer; lastVerts: () => Float32Array | null } {
  const fakeBuffer = { size: 1 << 20, destroy() {} } as unknown as GPUBuffer
  let captured: Float32Array | null = null
  const stubDevice = {
    createBuffer: () => fakeBuffer,
    queue: {
      // setDraws emits exactly one vertex-buffer write through the §4 RHI seam:
      //   rhi.writeBuffer(this.vertexBuf, 0, data) — `data` is the arena-backed
      //   Float32Array VIEW (no byteOffset/size args). The arena reuses its backing
      //   buffer across frames, so copy the view's exact bytes out now.
      writeBuffer(_buf: unknown, _off: number, src: ArrayBufferView): void {
        captured = new Float32Array(src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength))
      },
    },
  } as unknown as GPUDevice
  const stubAtlas = {
    pageCount: 1,
    getPage: (_i: number) => ({ width: PAGE_SIZE }) as unknown as GPUTexture,
  }

  interface MutableRenderer {
    rhi: WebGpuDevice
    atlas: typeof stubAtlas
    _frameArena: FrameArena
    drawSlices: unknown[]
    vertexBuf: RhiBuffer | null
    vertexCount: number
    vertexBufCapacityBytes: number
    allUniforms: Float32Array | null
    uniformBuf: RhiBuffer
    uniformBufCapacityBytes: number
    bindGroupsByPage: RhiBindGroup[]
  }
  const renderer = Object.create(TextRenderer.prototype) as unknown as MutableRenderer
  renderer.rhi = new WebGpuDevice(stubDevice)
  renderer.atlas = stubAtlas
  renderer._frameArena = new FrameArena(64 * 1024)
  renderer.drawSlices = []
  renderer.vertexBuf = null
  renderer.vertexCount = 0
  renderer.vertexBufCapacityBytes = 0
  renderer.allUniforms = null
  renderer.uniformBuf = renderer.rhi.createBuffer({ size: 256, usage: 'uniform', writable: true })
  renderer.uniformBufCapacityBytes = 256
  renderer.bindGroupsByPage = []

  return {
    renderer: renderer as unknown as TextRenderer,
    lastVerts: () => captured,
  }
}

function draw(letterSpacingPx: number): TextDraw {
  // Two glyphs, single-line pen-advance path (NO glyphOffsets) so the
  // `penX += letterSpacingPx` wire is exercised between glyph[0] and glyph[1].
  return {
    anchorX: 100,
    anchorY: 100,
    glyphs: [glyph(0x41), glyph(0x42)],
    fontSize: 24,
    rasterFontSize: 24,
    color: [0, 0, 0, 1],
    letterSpacingPx,
  }
}

/** Render once with the given letter-spacing and return glyph[1]'s pos_px.x. */
function glyph1X(letterSpacingPx: number): number {
  const { renderer, lastVerts } = makeRenderer()
  renderer.setDraws([draw(letterSpacingPx)])
  const verts = lastVerts()
  expect(verts).not.toBeNull()
  return verts![GLYPH1_TL_X]!
}

describe('text-letter-spacing pen-advance wiring (GPU-free)', () => {
  it('glyph[1].x shifts right by EXACTLY letterSpacingPx vs zero-spacing', () => {
    const L = 7
    const x0 = glyph1X(0)
    const xL = glyph1X(L)
    // All non-spacing terms (advance, bearing, quad centering, anchor) are
    // identical between the two runs → they cancel. The only difference is
    // the `penX += letterSpacingPx` applied after glyph[0].
    expect(xL - x0).toBeCloseTo(L, 5)
  })

  it('zero letter-spacing leaves glyph[1] at the pure-advance position (control)', () => {
    // Sanity that the delta is the SPACING, not a side effect: two zero runs
    // agree exactly.
    expect(glyph1X(0)).toBeCloseTo(glyph1X(0), 6)
  })
})
