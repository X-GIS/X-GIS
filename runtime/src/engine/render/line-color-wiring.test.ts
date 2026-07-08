// line-color: stroke-RGB wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: line-color is marked
// `supported` (constant / zoom-interp / data-driven) in the line capability
// table (runtime/src/capabilities/line.ts:9-11), but the ONLY runtime test of
// the colour path was the PURE-FUNCTION packer unit test
// (line-renderer.test.ts "writes color, width, and mpp to their fixed slots").
// That asserts packLineLayerUniform's return value in isolation — it would NOT
// catch a BROKEN DATA PATH where the packed colour stops being staged into the
// layer-ring or stops being uploaded to the GPU (the heatmap-class wiring bug).
//
// This drives the REAL LineRenderer.writeLayerSlot + endFrame against the
// WebGPU stub (no GPU) and intercepts `device.queue.writeBuffer` to read the
// bytes the renderer actually uploads to its layer-uniform ring. The line
// layer uniform's slot [0..2] is the stroke colour RGB — exactly what
// paint.line-color controls. (Alpha slot [3] is co-determined by line-opacity
// and the sub-px width-alpha scale, so this test pins only the RGB slots,
// which are uniquely line-color's.)
//
// Fail-before: in packLineLayerUniform (line-pattern.ts) replace
//   buf[0] = strokeColor[0]
//   buf[1] = strokeColor[1]
//   buf[2] = strokeColor[2]
// with constant zeros, and the RGB assertions fail — the wiring that makes
// line-color actually reach the GPU is gone, and this test catches it before
// any render runs.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installWebGPUStub, type StubInstallation } from '../../__test-support__/webgpu-stub'
import { initGPU, type GPUContext } from '@xgis/rhi-webgpu'
import { LineRenderer } from '@xgis/map'

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

// The layer-uniform ring is 512 slots × 256 B = 131072 B (LineRenderer
// LAYER_SLOT = 256, layerRingCapacity = 512). endFrame() uploads the dirty
// range of THIS buffer via device.queue.writeBuffer — its byte-size is
// distinct from every other buffer the renderer creates, so we key the
// writeBuffer interception on it.
const LAYER_RING_BYTES = 512 * 256

// Stroke colour: three DISTINCT channel values so each RGB slot assertion is
// non-vacuous and unambiguously tied to line-color (not a shared constant).
const STROKE_COLOR: [number, number, number, number] = [0.2, 0.4, 0.6, 1]
const WIDTH_PX = 3
const OPACITY = 1
const MPP = 1000

/** Drive writeLayerSlot(STROKE_COLOR, …) + endFrame() and capture the f32
 *  bytes the renderer uploads to its layer-uniform ring (slot 0 = first
 *  layer, so f32[0..3] = packed stroke colour). */
function captureFirstLayerSlot(ctx: GPUContext): Float32Array | undefined {
  // The LineRenderer constructor needs a tile bind-group layout; a trivial
  // one off the stub device is sufficient (the stub returns an opaque token).
  const tileBGL = ctx.device.createBindGroupLayout({
    label: 'test-tile-bgl',
    entries: [],
  })
  const renderer = new LineRenderer(ctx, tileBGL)

  let captured: Float32Array | undefined
  const device = ctx.device as unknown as {
    queue: {
      writeBuffer: (
        buf: unknown,
        off: number,
        data: ArrayBufferView | ArrayBuffer,
        dOff?: number,
        sz?: number,
      ) => void
    }
  }
  device.queue.writeBuffer = (
    buf: unknown,
    _off: number,
    data: ArrayBufferView | ArrayBuffer,
    dataOffset?: number,
    size?: number,
  ): void => {
    if ((buf as { size?: number })?.size !== LAYER_RING_BYTES) return
    // endFrame calls writeBuffer(layerRing, lo, stagingBuffer, byteOffset+lo, hi-lo).
    // `data` is the staging ArrayBuffer; `dataOffset` is the absolute byte
    // start of the dirty range. The first layer slot starts at byte 0.
    const ab = data instanceof ArrayBuffer ? data : (data as ArrayBufferView).buffer
    const base =
      (dataOffset ?? (data instanceof ArrayBuffer ? 0 : (data as ArrayBufferView).byteOffset)) | 0
    const lenBytes =
      size ?? (data instanceof ArrayBuffer ? data.byteLength : (data as ArrayBufferView).byteLength)
    captured = new Float32Array(ab, base, Math.min(lenBytes, 16) / 4) // first 4 f32 = colour vec4
  }

  // First layer → slot offset 0. Defaults for the rest mirror a plain stroke.
  renderer.writeLayerSlot(STROKE_COLOR, WIDTH_PX, OPACITY, MPP)
  renderer.endFrame()

  return captured
}

describe('line-color stroke-RGB wiring (GPU-free)', () => {
  it('uploads the packed stroke colour to the layer-uniform ring', async () => {
    const ctx = await makeCtx()
    const slot = captureFirstLayerSlot(ctx)
    expect(slot, 'layer-uniform ring write should have been captured').toBeTruthy()
  })

  it('layer uniform slot [0..2] carries line-color RGB', async () => {
    const ctx = await makeCtx()
    const slot = captureFirstLayerSlot(ctx)
    expect(slot).toBeTruthy()
    // Break `buf[0..2] = strokeColor[0..2]` in packLineLayerUniform → these fail.
    expect(slot![0]).toBeCloseTo(STROKE_COLOR[0], 5) // R
    expect(slot![1]).toBeCloseTo(STROKE_COLOR[1], 5) // G
    expect(slot![2]).toBeCloseTo(STROKE_COLOR[2], 5) // B
  })
})
