// Repro for the leading-newline atlas-page bug in TextRenderer.setDraws.
//
// setDraws seeds `slicePage` from `d.glyphs[0].slot.page`. The composition
// loop SKIPS hard-newline glyphs (codepoint 10) BEFORE the page-boundary
// check, and that check was gated on `sliceGlyphCount > 0`. So when a label
// STARTS with a newline (e.g. concat(name:latin, "\n", name:nonlatin) with an
// empty latin → "\n성남시") and the newline's slot.page differs from the first
// DRAWABLE glyph's page (CJK-heavy multi-page atlas), the slice kept the
// newline's page. draw() then binds atlas.getPage(slice.page) = the WRONG
// page → wrong/blank glyph. Vertex UVs are per-glyph (correct); only the
// bound page was wrong.
//
// Harness: setDraws is GPU-light — it only touches `this.atlas` (pageCount +
// getPage(0).width for the UV denominator), `this._frameArena`, a single
// `this.device.queue.writeBuffer`, and `this.drawSlices`. So we build a
// TextRenderer via Object.create (no real WebGPU pipeline construction),
// install a real FrameArena, a stub atlas (pageCount + getPage(0).width), and
// a stub device whose queue.writeBuffer is a no-op + createBuffer returns a
// fake buffer. Then we read back the recorded drawSlices.

import { describe, it, expect } from 'vitest'
import { TextRenderer } from './text-renderer'
import type { TextDraw } from './text-renderer'
import type { GlyphInfo } from './sdf/glyph-atlas-host'
import { FrameArena } from '@xgis/rhi-webgpu'
import { WebGpuDevice } from '@xgis/rhi-webgpu'
import type { RhiBuffer, RhiBindGroup } from '@xgis/engine'

// setDraws creates the vertex buffer via device.createBuffer({ usage:
// GPUBufferUsage.VERTEX | ... }) — the bitflag global isn't present in the
// node test env. Values per the WebGPU spec (mirrors the stub in
// bilingual-prepare-scatter.test.ts).
const g = globalThis as Record<string, unknown>
g.GPUBufferUsage ??= {
  MAP_READ: 1,
  MAP_WRITE: 2,
  COPY_SRC: 4,
  COPY_DST: 8,
  INDEX: 16,
  VERTEX: 32,
  UNIFORM: 64,
  STORAGE: 128,
  INDIRECT: 256,
  QUERY_RESOLVE: 512,
}

const PAGE_SIZE = 256

/** Minimal GlyphInfo on a given atlas page. cp 10 = hard newline. */
function glyph(codepoint: number, page: number): GlyphInfo {
  return {
    codepoint,
    slot: { page, cellX: 0, cellY: 0, pxX: 0, pxY: 0, size: 24 },
    advanceWidth: 12,
    bearingX: 1,
    bearingY: 18,
    width: 12,
    height: 18,
    pbf: true,
    rasterFontSize: 24,
  }
}

interface RecordedSlice {
  first: number
  count: number
  page: number
}

/** Build a setDraws-capable TextRenderer without touching real WebGPU. */
function makeRenderer(): { renderer: TextRenderer; slices: () => RecordedSlice[] } {
  const fakeBuffer = { size: 1 << 20, destroy() {} } as unknown as GPUBuffer
  const stubDevice = {
    createBuffer: () => fakeBuffer,
    queue: { writeBuffer() {} },
  } as unknown as GPUDevice
  const stubAtlas = {
    pageCount: 4,
    getPage: (_i: number) => ({ width: PAGE_SIZE }) as unknown as GPUTexture,
  }

  // Object.create + a structural cast: TextRenderer's fields are private,
  // so we can't intersect the class type (it collapses to `never`). Name
  // only the fields setDraws touches via a standalone mutable shape. Buffers
  // route through the §4 RHI seam, so `rhi` is a WebGpuDevice over the stub and
  // the buffer handles are RhiBuffer (rhi.createBuffer wraps the fake).
  interface MutableRenderer {
    rhi: WebGpuDevice
    atlas: typeof stubAtlas
    _frameArena: FrameArena
    drawSlices: RecordedSlice[]
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
    // Cast back to TextRenderer for the setDraws() call — the object IS one
    // (created from TextRenderer.prototype); only the field-injection above
    // needed the structural view.
    renderer: renderer as unknown as TextRenderer,
    slices: () => renderer.drawSlices,
  }
}

function draw(glyphs: GlyphInfo[]): TextDraw {
  return {
    anchorX: 100,
    anchorY: 100,
    glyphs,
    fontSize: 24,
    rasterFontSize: 24,
    color: [0, 0, 0, 1],
  }
}

describe('TextRenderer leading-newline atlas page', () => {
  it('binds the first DRAWABLE glyph page when the label starts with a newline on a different page', () => {
    // glyphs[0] = hard newline on page 0; first real glyph on page 1.
    // "\n성남시" — empty-latin concat result. cp 10 sits on P0, 성남시 on P1.
    const glyphs = [
      glyph(10, 0), // hard newline, page 0 — skipped, must NOT seed the slice
      glyph(0xc131, 1), // 성, page 1
      glyph(0xb0a8, 1), // 남, page 1
      glyph(0xc2dc, 1), // 시, page 1
    ]
    const { renderer, slices } = makeRenderer()
    renderer.setDraws([draw(glyphs)])

    const recorded = slices()
    // One slice (all drawable glyphs share page 1).
    expect(recorded.length).toBe(1)
    // The drawable glyphs live on page 1; draw() binds getPage(slice.page).
    // Before the fix this was 0 (the skipped newline's page) → wrong/blank.
    expect(recorded[0]!.page).toBe(1)
    // 3 drawable glyphs × 6 verts.
    expect(recorded[0]!.count).toBe(3 * 6)
  })

  it('still flushes a mid-label page boundary into separate slices', () => {
    // No leading newline: real glyphs split across pages mid-label. The
    // page-boundary flush must still produce two slices on the right pages.
    const glyphs = [
      glyph(0x41, 0), // A, page 0
      glyph(0x42, 0), // B, page 0
      glyph(0xc131, 2), // 성, page 2 — boundary
      glyph(0xb0a8, 2), // 남, page 2
    ]
    const { renderer, slices } = makeRenderer()
    renderer.setDraws([draw(glyphs)])

    const recorded = slices()
    expect(recorded.length).toBe(2)
    expect(recorded[0]!.page).toBe(0)
    expect(recorded[0]!.count).toBe(2 * 6)
    expect(recorded[1]!.page).toBe(2)
    expect(recorded[1]!.count).toBe(2 * 6)
  })

  it('single-page label still emits exactly one slice on its page', () => {
    const glyphs = [glyph(0x41, 3), glyph(0x42, 3), glyph(0x43, 3)]
    const { renderer, slices } = makeRenderer()
    renderer.setDraws([draw(glyphs)])

    const recorded = slices()
    expect(recorded.length).toBe(1)
    expect(recorded[0]!.page).toBe(3)
    expect(recorded[0]!.count).toBe(3 * 6)
  })
})
