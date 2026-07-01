// icon-rotate: per-icon quad-rotation wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: icon-rotate is marked
// `supported` (it lowers to IconDraw.rotateRad via lower-label →
// label-pass.ts:253 `rotateRad: ((def.iconRotate ?? 0) + tangent) * PI/180`),
// but the RUNTIME contract — that IconRenderer actually rotates the quad's
// corners by that angle when it builds the vertex buffer — was verified only
// structurally. A break in the consumer (icon-renderer.ts:219/234-244) would
// ship a non-rotating icon-rotate silently (the heatmap-class data-path bug).
//
// The runtime contract: IconRenderer.setDraws builds a 6-vertex quad per icon
// and uploads it via `device.queue.writeBuffer(vertexBuf, …)`. Each vertex's
// pos_px (f32 slots 0,1 — ICON_PX_SLOT) is the SCREEN-PIXEL corner. With
// rotateRad set, the four corners are rotated about the quad centre before
// being written; with rotateRad 0/undefined they are axis-aligned (and
// pixel-snapped). This drives the REAL IconRenderer.setDraws against the
// WebGPU stub (no GPU) and intercepts `device.queue.writeBuffer` to read the
// uploaded vertices, asserting vertex-0 pos_px equals the closed-form 90°
// rotation of the unrotated TL corner — and that it DIFFERS from the
// unrotated case (so the assertion cannot pass on a constant).
//
// Geometry (single 'center'-anchored icon, sizeScale 1):
//   anchor = (100, 200); sprite 20×10 design px ⇒ drawW=20, drawH=10.
//   Unrotated (snap): TL = (round(100-10), round(200-5)) = (90, 195),
//                     quad centre (cx,cy) = (100, 200).
//   rot = +PI/2 (c=cos=0, s=sin=1): rotate(x,y) = [cx-(y-cy), cy+(x-cx)].
//                     TL(90,195) ⇒ [100-(195-200), 200+(90-100)] = (105, 190).
//
// Fail-before: replace `const rot = d.rotateRad ?? 0` with `const rot = 0`
// (or otherwise drop the rotateRad threading) and vertex-0 pos_px collapses
// back to the unrotated (90,195) — the rotated assertion fails. The wiring
// that makes icon-rotate actually rotate the GPU quad is gone, and the test
// catches it before any render.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installWebGPUStub, type StubInstallation } from '../../__test-support__/webgpu-stub'
import { initGPU, type GPUContext } from '@xgis/engine'
import { IconRenderer, type IconDraw } from '@xgis/map'
import { WebGpuDevice } from '@xgis/engine'
import type { SpriteInfo } from '@xgis/map'

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

// Minimal stand-in for SpriteAtlasGPU. IconRenderer.setDraws only reads
// `atlas.size()` (must be non-zero so the build proceeds); the constructor
// keeps a reference but its other members (ensure/sampler) are only touched
// by draw(), which this test never calls.
function makeStubAtlas(): { size: () => { width: number; height: number }; ensure: () => null; sampler: unknown } {
  return {
    size: () => ({ width: 256, height: 256 }),
    ensure: () => null,
    sampler: {},
  }
}

const SPRITE: SpriteInfo = {
  name: 'r', x: 0, y: 0, width: 20, height: 10, pixelRatio: 1, sdf: false,
}
const ANCHOR_X = 100
const ANCHOR_Y = 200

// Derived geometry — see header. Unrotated TL is pixel-snapped; the 90°
// rotation is taken about the quad centre (100,200).
const TL_UNROTATED: [number, number] = [90, 195]
const TL_ROT_90: [number, number] = [105, 190]

// pos_px occupies f32 slots 0,1 of each vertex (ICON_PX_SLOT = 0). The
// icon-vertex buffer is the buffer the renderer writes whose size is NOT the
// 16-byte uniform buffer (setDraws issues exactly one writeBuffer — the
// vertex upload — so any non-16 size is the vertex buffer).
const UNIFORM_BYTES = 16

/** Build one icon with the given rotation, intercept the vertex upload, and
 *  return vertex-0 pos_px (the quad's TL corner) in screen pixels. */
function capturedFirstCorner(ctx: GPUContext, rotateRad: number | undefined): [number, number] {
  const renderer = new IconRenderer(
    ctx.device as unknown as GPUDevice,
    new WebGpuDevice(ctx.device as unknown as GPUDevice),
    makeStubAtlas() as never,
    ctx.format,
  )

  let corner: [number, number] = [Number.NaN, Number.NaN]
  const device = ctx.device as unknown as {
    queue: { writeBuffer: (buf: unknown, off: number, data: ArrayBufferView | ArrayBuffer, dataOff?: number, sz?: number) => void }
  }
  device.queue.writeBuffer = (
    buf: unknown, _off: number,
    data: ArrayBufferView | ArrayBuffer, dataOff?: number, _sz?: number,
  ): void => {
    if ((buf as { size?: number })?.size === UNIFORM_BYTES) return // not the vertex buffer
    const ab = data instanceof ArrayBuffer ? data : (data as ArrayBufferView).buffer
    const baseOff = data instanceof ArrayBuffer ? (dataOff ?? 0) : (data as ArrayBufferView).byteOffset
    const f32 = new Float32Array(ab, baseOff, 2) // first vertex pos_px (slots 0,1)
    corner = [f32[0]!, f32[1]!]
  }

  const draw: IconDraw = {
    anchorX: ANCHOR_X, anchorY: ANCHOR_Y,
    sprite: SPRITE, sizeScale: 1, anchor: 'center',
    ...(rotateRad === undefined ? {} : { rotateRad }),
  }
  renderer.setDraws([draw])
  return corner
}

describe('icon-rotate quad-rotation wiring (GPU-free)', () => {
  it('unrotated icon writes the axis-aligned TL corner', async () => {
    const ctx = await makeCtx()
    const [x, y] = capturedFirstCorner(ctx, undefined)
    expect(x).toBeCloseTo(TL_UNROTATED[0], 5)
    expect(y).toBeCloseTo(TL_UNROTATED[1], 5)
  })

  it('rotateRad = PI/2 rotates the quad corner about its centre', async () => {
    const ctx = await makeCtx()
    const [x, y] = capturedFirstCorner(ctx, Math.PI / 2)
    // Exact closed-form 90° rotation — fails if rotateRad stops being consumed.
    expect(x).toBeCloseTo(TL_ROT_90[0], 4)
    expect(y).toBeCloseTo(TL_ROT_90[1], 4)
  })

  it('rotated corner DIFFERS from the unrotated corner (non-vacuous)', async () => {
    const ctx = await makeCtx()
    const rotated = capturedFirstCorner(ctx, Math.PI / 2)
    const flat = capturedFirstCorner(ctx, undefined)
    // The prop must change the written bytes — guards against a constant.
    expect(Math.hypot(rotated[0] - flat[0], rotated[1] - flat[1])).toBeGreaterThan(1)
  })
})
