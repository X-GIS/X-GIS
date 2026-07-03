// icon-color: SDF tint per-vertex wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: icon-color is marked
// `supported` (constant / zoom-interp / data-driven) in
// compiler/src/convert/spec-coverage symbol paint, but the runtime had no
// behavioral wiring test — only the structural/compile path. The runtime
// contract is: IconRenderer.setDraws stamps the per-icon `tint` (the lowered
// `icon-color`, sRGB 0..1) onto EVERY vertex of the quad at the ICON_FORMAT
// `tint` slot (r,g,b = floats 5,6,7 of a 9-float vertex), and the SDF branch
// of the icon FS multiplies the texture by it. If that threading breaks, an
// icon-color layer silently renders white — the heatmap-class "supported but
// the data path is dead" bug.
//
// This drives the REAL IconRenderer.setDraws against the WebGPU stub (no GPU)
// and intercepts `device.queue.writeBuffer` to read the per-vertex bytes the
// renderer uploads, asserting the tint slots carry the supplied colour (not 1).
//
// Fail-before: replace `const tr = t ? t[0] : 1, tg = t ? t[1] : 1, tb = t ?
// t[2] : 1` with `const tr = 1, tg = 1, tb = 1` (drop the icon-color prop) and
// the tint assertions fail — the wire that makes icon-color reach the GPU is
// gone, caught before any render.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installWebGPUStub, type StubInstallation } from '../../__test-support__/webgpu-stub'
import { initGPU, type GPUContext } from '@xgis/engine'
import { IconRenderer, type IconDraw } from '@xgis/map'
import { WebGpuDevice } from '@xgis/engine'
import { ICON_FORMAT } from '@xgis/map'
import { vertexField } from '@xgis/compiler'
import type { SpriteInfo } from '@xgis/map'

let stub: StubInstallation

beforeEach(() => {
  if (typeof HTMLCanvasElement === 'undefined') {
    ;(globalThis as { HTMLCanvasElement?: unknown }).HTMLCanvasElement = class {
      width = 800
      height = 600
      getContext(_t: string): unknown {
        return null
      }
    } as never
  }
  stub = installWebGPUStub()
})
afterEach(() => {
  stub.uninstall()
})

async function makeCtx(): Promise<GPUContext> {
  const canvas = { width: 1024, height: 768 } as unknown as HTMLCanvasElement
  Object.setPrototypeOf(canvas, HTMLCanvasElement.prototype)
  return initGPU(canvas) as unknown as Promise<GPUContext>
}

// Derived from the single-source ICON_FORMAT so the test cannot drift from the
// packer / GPUVertexBufferLayout. tint r,g,b live at floats 5,6,7; sdf at 8.
const FLOATS_PER_VERT = ICON_FORMAT.stride / 4 // 9
const TINT_SLOT = vertexField(ICON_FORMAT, 'tint').offset / 4 // 5
const SDF_SLOT = vertexField(ICON_FORMAT, 'sdf').offset / 4 // 8

// One SDF sprite → one quad → 6 verts × 9 floats = 54 floats = 216 B. The
// vertex buffer is created at max(1024, grown) = 1024 B, distinct from the
// icon uniform buffer (16 B) — key the capture on size 1024.
const VERTEX_BUF_BYTES = 1024

// Non-trivial, per-channel-distinct tint so the assertion is non-vacuous: a
// dropped-prop / constant-white break (1,1,1) cannot pass, nor can a channel
// swap. This is the lowered `icon-color`.
const TINT: [number, number, number] = [0.2, 0.4, 0.6]

const SPRITE: SpriteInfo = {
  name: 'marker',
  x: 0,
  y: 0,
  width: 16,
  height: 16,
  pixelRatio: 1,
  sdf: true,
}

const DRAW: IconDraw = {
  anchorX: 100,
  anchorY: 200,
  sprite: SPRITE,
  sizeScale: 1,
  tint: TINT,
}

// IconRenderer.setDraws only calls atlas.size(); a minimal non-zero atlas is
// enough to get past the early-return at setDraws (atlasSize.width === 0).
const FAKE_ATLAS = { size: () => ({ width: 256, height: 256 }) }

/** Build a real IconRenderer against the stub, run setDraws once with the
 *  given draw, and return the captured first-vertex Float32Array (9 floats)
 *  from the vertex-buffer writeBuffer. */
function capturedFirstVertex(ctx: GPUContext, draw: IconDraw): Float32Array | undefined {
  const renderer = new IconRenderer(
    ctx.device,
    new WebGpuDevice(ctx.device),
    FAKE_ATLAS as never,
    ctx.format,
    1,
  )

  let firstVert: Float32Array | undefined
  const device = ctx.device as unknown as {
    queue: {
      writeBuffer: (
        buf: unknown,
        bufOff: number,
        data: ArrayBufferView | ArrayBuffer,
        dataOff?: number,
        size?: number,
      ) => void
    }
  }
  device.queue.writeBuffer = (
    buf: unknown,
    _bufOff: number,
    data: ArrayBufferView | ArrayBuffer,
    dataOff?: number,
    _size?: number,
  ): void => {
    if ((buf as { size?: number })?.size !== VERTEX_BUF_BYTES) return
    // setDraws uploads `data.buffer` (an ArrayBuffer) with a byteOffset.
    const ab = data instanceof ArrayBuffer ? data : (data as ArrayBufferView).buffer
    const baseOff =
      data instanceof ArrayBuffer ? (dataOff ?? 0) : (data as ArrayBufferView).byteOffset
    firstVert = new Float32Array(ab, baseOff, FLOATS_PER_VERT)
  }

  renderer.setDraws([draw])
  return firstVert
}

describe('icon-color SDF tint wiring (GPU-free)', () => {
  it('per-vertex tint slot carries the lowered icon-color (r,g,b)', async () => {
    const ctx = await makeCtx()
    const v = capturedFirstVertex(ctx, DRAW)
    expect(v, 'icon vertex buffer (1024 B) should have been written').toBeTruthy()
    // Break `const tr = t ? t[0] : 1, ...` → these fail (white = 1,1,1).
    expect(v![TINT_SLOT + 0]).toBeCloseTo(TINT[0], 6)
    expect(v![TINT_SLOT + 1]).toBeCloseTo(TINT[1], 6)
    expect(v![TINT_SLOT + 2]).toBeCloseTo(TINT[2], 6)
    // The SDF flag must be 1 so the FS actually applies the tint.
    expect(v![SDF_SLOT]).toBe(1)
  })

  it('omitted icon-color defaults to identity white (1,1,1)', async () => {
    const ctx = await makeCtx()
    const v = capturedFirstVertex(ctx, { ...DRAW, tint: undefined })
    expect(v).toBeTruthy()
    expect(v![TINT_SLOT + 0]).toBe(1)
    expect(v![TINT_SLOT + 1]).toBe(1)
    expect(v![TINT_SLOT + 2]).toBe(1)
  })
})
