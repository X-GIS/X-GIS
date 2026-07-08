// line-translate: viewport-offset wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: paint.line-translate is
// marked `supported` (compiler/src/convert/spec-coverage/paint-line.ts) and the
// compiler has lower/warn tests, but the RUNTIME contract — that the pre-baked
// NDC-per-pixel translate actually reaches the line layer uniform the GPU reads
// — rested only on structural/compile coverage. A break that stops threading
// lineTranslateX/Y into the layer ring would ship silently (the heatmap-class
// data-path bug): the prop stays "supported" on paper while the GPU sees 0.
//
// The runtime contract (vs_line, runtime/src/engine/shaders/dsl/line.ts:1062-1063 reads
// `layer.line_translate_x` / `_y` to offset clip post-MVP): when a line layer
// slot is written with lineTranslateX/Y, the 208-byte line layer uniform's f32
// slot 47 carries line_translate_x and slot 48 carries line_translate_y.
//
// This drives the REAL LineRenderer.writeLayerSlot + endFrame() against a fake
// device (no GPU — mirrors line-renderer-layer-ring.test.ts) and intercepts the
// single `device.queue.writeBuffer` the layer-ring flush emits, then reads back
// f32 slots 47/48 from the staged bytes.
//
// Fail-before: drop `buf[47] = lineTranslateX` / `buf[48] = lineTranslateY` in
// packLineLayerUniform (or stop threading them through writeLayerSlot) and the
// slot-47/48 assertions fail — the wiring that makes line-translate actually
// reach the GPU is gone, and the test catches it before any render.

import { describe, expect, it } from 'vitest'

// WebGPU globals don't exist under happy-dom — stub the few constants
// LineRenderer touches in its constructor (mirrors line-renderer-layer-ring).
;(
  globalThis as unknown as { GPUShaderStage: { VERTEX: number; FRAGMENT: number } }
).GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 }
;(globalThis as unknown as { GPUBufferUsage: Record<string, number> }).GPUBufferUsage = {
  UNIFORM: 1,
  COPY_DST: 2,
  STORAGE: 4,
  VERTEX: 8,
  INDEX: 16,
}

import { LineRenderer, lineUniformSize } from '@xgis/map'
import { WebGpuDevice } from '@xgis/rhi-webgpu'
import type { GPUContext } from '@xgis/rhi-webgpu'

// f32 slots in the 208-byte line layer uniform (see line-pattern.ts header):
//   [47] line_translate_x, [48] line_translate_y.
const SLOT_TRANSLATE_X = 47
const SLOT_TRANSLATE_Y = 48

// Distinct, non-trivial NDC-per-pixel offsets so the assertion is non-vacuous:
// neither slot can pass by coincidence with a constant or a default of 0.
const TRANSLATE_X = 0.0123
const TRANSLATE_Y = -0.0456

interface CapturedWrite {
  offset: number
  bytes: Float32Array
}

/** A fake GPU device that records the layer-ring flush and exposes the staged
 *  f32 bytes. Mirrors line-renderer-layer-ring.test.ts's fakeDevice. */
function makeFakeContext(writes: CapturedWrite[]): GPUContext {
  const fakeBuffer = {} as GPUBuffer
  const fakeDevice = {
    createBuffer: () => fakeBuffer,
    createBindGroup: () => ({}) as GPUBindGroup,
    createBindGroupLayout: () => ({}) as GPUBindGroupLayout,
    createPipelineLayout: () => ({}) as GPUPipelineLayout,
    createRenderPipeline: () => ({}) as GPURenderPipeline,
    createShaderModule: () => ({}) as GPUShaderModule,
    createSampler: () => ({}) as GPUSampler,
    createTexture: () => ({ createView: () => ({}) }) as unknown as GPUTexture,
    queue: {
      writeBuffer: (
        _buf: GPUBuffer,
        offset: number,
        data: ArrayBufferView | ArrayBuffer,
        dataOffset?: number,
        _size?: number,
      ) => {
        // endFrame() flushes with (layerRing, lo, layerStaging.buffer, dataOff, len).
        const ab = data instanceof ArrayBuffer ? data : (data as ArrayBufferView).buffer
        const baseOff =
          (data instanceof ArrayBuffer ? 0 : (data as ArrayBufferView).byteOffset) +
          (dataOffset ?? 0)
        // Read the full uniform (52 f32) of the first staged slot.
        const bytes = new Float32Array(ab, baseOff, lineUniformSize() / 4)
        writes.push({ offset, bytes: bytes.slice(0, lineUniformSize() / 4) })
      },
    },
  }
  return {
    device: fakeDevice as unknown as GPUDevice,
    format: 'bgra8unorm',
    canvas: {} as HTMLCanvasElement,
    context: {} as GPUCanvasContext,
    rhi: new WebGpuDevice(fakeDevice as unknown as GPUDevice),
  } as unknown as GPUContext
}

/** Write one layer slot carrying the given line-translate, flush, and return
 *  the captured uniform f32 view. The full writeLayerSlot positional tail is:
 *  (strokeColor, strokeWidthPx, opacity, mppAtCenter, cap, join, miterLimit,
 *   dash, patterns, offsetPx, viewportHeight, blurPx, dpr,
 *   lineTranslateX, lineTranslateY, roundLimit). */
function captureLineTranslate(tx: number, ty: number): Float32Array {
  const writes: CapturedWrite[] = []
  const lr = new LineRenderer(makeFakeContext(writes), {} as GPUBindGroupLayout)

  lr.beginFrame()
  lr.writeLayerSlot(
    [1, 0, 0, 1],
    2,
    1,
    1, // strokeColor, width, opacity, mppAtCenter
    undefined,
    undefined,
    undefined, // cap, join, miterLimit (defaults)
    null,
    [],
    0,
    1,
    0,
    1, // dash, patterns, offsetPx, viewportH, blur, dpr
    tx,
    ty, // lineTranslateX, lineTranslateY
  )
  lr.endFrame()

  expect(writes, 'endFrame should flush exactly one layer-ring write').toHaveLength(1)
  expect(writes[0].offset).toBe(0)
  return writes[0].bytes
}

describe('line-translate viewport-offset wiring (GPU-free)', () => {
  it('threads lineTranslateX into f32 slot 47 and lineTranslateY into slot 48', () => {
    const u = captureLineTranslate(TRANSLATE_X, TRANSLATE_Y)
    // Break `buf[47] = lineTranslateX` / `buf[48] = lineTranslateY` → these fail.
    expect(u[SLOT_TRANSLATE_X]).toBeCloseTo(TRANSLATE_X, 6)
    expect(u[SLOT_TRANSLATE_Y]).toBeCloseTo(TRANSLATE_Y, 6)
  })

  it('default (no translate) leaves slots 47/48 at 0', () => {
    const u = captureLineTranslate(0, 0)
    expect(u[SLOT_TRANSLATE_X]).toBe(0)
    expect(u[SLOT_TRANSLATE_Y]).toBe(0)
  })
})
