// text-rotate: rotateRad glyph-quad wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: `text-rotate`
// is marked `supported` (constant) in runtime/src/capabilities/symbol.ts
// (and paint/layout spec-coverage), but its runtime wiring was only
// covered STRUCTURALLY. The render contract is: TextDraw.rotateRad
// (= Mapbox text-rotate degrees × π/180, threaded from def.rotate in
// render-loop-helpers.ts) rotates every glyph quad corner around the
// label anchor (anchorX, anchorY) BEFORE the vertices are uploaded —
// TextRenderer.setDraws, the `rotateXY` closure built from
// `const rot = d.rotateRad ?? 0` (text-renderer.ts:211-217), feeding
// the `device.queue.writeBuffer(vertexBuf, …)` at text-renderer.ts:345.
//
// This drives the REAL TextRenderer.setDraws against the WebGPU stub
// (no GPU) with a single non-ideographic glyph, twice — once with
// rotateRad = π/2 and once with rotateRad = undefined (no rotation) —
// and intercepts `device.queue.writeBuffer` to read the uploaded
// vertex positions. It asserts the rotated run is the EXACT 90°-CW
// rotation of the unrotated run about the anchor:
//   rotated = [ anchorX - (uy - anchorY), anchorY + (ux - anchorX) ].
//
// Fail-before: replace `const rot = d.rotateRad ?? 0` with `const rot
// = 0` (or otherwise stop honouring rotateRad) and the rotated run
// equals the unrotated run — the assertion that text-rotate actually
// moves the glyph vertices fails before any render runs.
//
// Non-vacuity: the test compares two runs that differ ONLY in
// rotateRad and pins the prop-dependent delta (a constant or a value
// independent of rotateRad would make the two runs identical and the
// rotation assertion fail).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installWebGPUStub, type StubInstallation } from '../../__test-support__/webgpu-stub'
import { initGPU, type GPUContext } from '@xgis/engine'
import { TextRenderer } from './text-renderer'
import { WebGpuDevice } from '@xgis/engine'
import type { TextDraw } from './text-renderer-types'
import type { GlyphInfo } from './sdf/glyph-atlas-host'

let stub: StubInstallation

beforeEach(() => {
  if (typeof HTMLCanvasElement === 'undefined') {
    ;(globalThis as { HTMLCanvasElement?: unknown }).HTMLCanvasElement = class {
      width = 800; height = 600
      getContext(_t: string): unknown { return null }
    } as never
  }
  stub = installWebGPUStub()
})
afterEach(() => { stub.uninstall() })

async function makeCtx(): Promise<GPUContext> {
  const canvas = { width: 1024, height: 768 } as unknown as HTMLCanvasElement
  Object.setPrototypeOf(canvas, HTMLCanvasElement.prototype)
  return initGPU(canvas) as unknown as Promise<GPUContext>
}

// Minimal atlas stub: setDraws only reads `pageCount` (0 → pageSize
// defaults to 1 and getPage is never called) so the vertex-position
// wiring runs without a real GPU atlas texture.
const FAKE_ATLAS = { pageCount: 0, getPage: () => undefined } as never

// Anchor in screen px and a single non-ideographic glyph ('A', cp 65 →
// no synthetic-oblique shear) with concrete metrics so each quad corner
// has a fixed unrotated position. The exact values don't matter — the
// test compares the rotated run against the unrotated run of the SAME
// glyph, so any non-degenerate metrics work.
const ANCHOR_X = 100
const ANCHOR_Y = 200
const GLYPH: GlyphInfo = {
  codepoint: 65,
  slot: { page: 0, cellX: 0, cellY: 0, pxX: 0, pxY: 0, size: 24 },
  advanceWidth: 14,
  bearingX: 2,
  bearingY: 18,
  width: 12,
  height: 16,
  pbf: true,
  rasterFontSize: 24,
}

function makeDraw(rotateRad: number | undefined): TextDraw {
  return {
    anchorX: ANCHOR_X,
    anchorY: ANCHOR_Y,
    glyphs: [GLYPH],
    fontSize: 24,
    rasterFontSize: 24,
    color: [0, 0, 0, 1],
    rotateRad,
  }
}

// setDraws uploads exactly one buffer — the vertex buffer — via
// device.queue.writeBuffer(vertexBuf, 0, data.buffer, byteOffset,
// byteLength). For a single 6-vertex glyph the buffer is created at
// size = max(1024, 96) = 1024 (distinct from the 256-B uniform slot,
// which is only written in draw(), not setDraws()). We key on that.
const VERTEX_BUF_SIZE = 1024
// TEXT_FORMAT: 4 floats/vert (posX, posY, uvX, uvY); pos at slot 0.
const FLOATS_PER_VERT = 4
const VERTS_PER_GLYPH = 6

/** Run setDraws once for the given rotateRad and return the uploaded
 *  vertex Float32Array (24 floats = 6 verts × 4 floats). */
function capturedVerts(ctx: GPUContext, rotateRad: number | undefined): Float32Array {
  const renderer = new TextRenderer(ctx.device, new WebGpuDevice(ctx.device), FAKE_ATLAS, ctx.format)

  let verts: Float32Array | undefined
  const device = ctx.device as unknown as {
    queue: {
      writeBuffer: (
        buf: unknown, off: number,
        data: ArrayBuffer | ArrayBufferView,
        dataOffset?: number, size?: number,
      ) => void
    }
  }
  device.queue.writeBuffer = (
    buf: unknown, _off: number,
    data: ArrayBuffer | ArrayBufferView,
    dataOffset?: number, size?: number,
  ): void => {
    if ((buf as { size?: number })?.size !== VERTEX_BUF_SIZE) return
    const ab = data instanceof ArrayBuffer ? data : (data as ArrayBufferView).buffer
    const byteOff = data instanceof ArrayBuffer ? (dataOffset ?? 0) : (data as ArrayBufferView).byteOffset
    const byteLen = size ?? (VERTS_PER_GLYPH * FLOATS_PER_VERT * 4)
    verts = new Float32Array(ab, byteOff, byteLen / 4).slice(0, VERTS_PER_GLYPH * FLOATS_PER_VERT)
  }

  renderer.setDraws([makeDraw(rotateRad)])

  if (verts === undefined) throw new Error('vertex buffer was not uploaded')
  return verts
}

describe('text-rotate rotateRad glyph-quad wiring (GPU-free)', () => {
  it('rotateRad = π/2 rotates every glyph vertex 90° CW about the anchor', async () => {
    const ctx = await makeCtx()
    const plain = capturedVerts(ctx, undefined)        // text-rotate = 0
    const rotated = capturedVerts(ctx, Math.PI / 2)    // text-rotate = 90°

    // Sanity: rotation must have MOVED the geometry (else the assertion
    // below could pass vacuously on a degenerate at-anchor quad).
    let moved = false
    for (let i = 0; i < plain.length; i++) {
      if (Math.abs(plain[i]! - rotated[i]!) > 1e-3) { moved = true; break }
    }
    expect(moved, 'rotateRad must change the uploaded vertex positions').toBe(true)

    // For each of the 6 vertices, the rotated position must be the
    // exact 90°-CW rotation of the unrotated position about the anchor:
    //   cos(π/2)=0, sin(π/2)=1  ⇒
    //   rx = anchorX + dx*0 - dy*1 = anchorX - (uy - anchorY)
    //   ry = anchorY + dx*1 + dy*0 = anchorY + (ux - anchorX)
    for (let v = 0; v < VERTS_PER_GLYPH; v++) {
      const o = v * FLOATS_PER_VERT
      const ux = plain[o + 0]!, uy = plain[o + 1]!
      const dx = ux - ANCHOR_X, dy = uy - ANCHOR_Y
      const expX = ANCHOR_X - dy
      const expY = ANCHOR_Y + dx
      expect(rotated[o + 0]!, `vertex ${v} x`).toBeCloseTo(expX, 4)
      expect(rotated[o + 1]!, `vertex ${v} y`).toBeCloseTo(expY, 4)
      // UVs (slots 2,3) are rotation-invariant — unchanged by the prop.
      expect(rotated[o + 2]!, `vertex ${v} u`).toBeCloseTo(plain[o + 2]!, 4)
      expect(rotated[o + 3]!, `vertex ${v} v`).toBeCloseTo(plain[o + 3]!, 4)
    }
  })
})
