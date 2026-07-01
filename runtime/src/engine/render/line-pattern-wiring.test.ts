// line-pattern data-path wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: line-pattern is marked
// `supported` for the line layer, but its runtime wiring rested on structural
// tests (packLineLayerUniform unit math + a WGSL grep), not a behavioral test
// that drives the REAL LineRenderer and watches the bytes it uploads. A break
// in the data path — the resolved sprite shapeId no longer reaching the GPU
// uniform, or the has-pattern flag bit not being set — would ship silently
// (the heatmap-class bug).
//
// The runtime contract: when a line layer is written with a PatternSlot whose
// shapeId > 0, the per-layer uniform the renderer flushes to its layerRing
// carries that shapeId in pattern-slot-0 (u32 @ f32-index 20) and sets the
// has-pattern bit (1 << 6) in the flags word (u32 @ f32-index 8). The line FS
// gates its sprite-atlas sampling on that bit + slot.
//
// This drives the REAL LineRenderer.writeLayerSlot + endFrame against the
// WebGPU stub (no GPU) and intercepts `device.queue.writeBuffer` to read the
// 256-byte layer-ring slot the renderer uploads, asserting shapeId @20 and the
// flag bit @8.
//
// Fail-before: in line-pattern.ts, `u32[base] = p.shapeId | 0` writes the
// shapeId into the uniform. Drop it to `u32[base] = 0` and the shapeId
// assertion fails — the wiring that makes line-pattern actually reach the GPU
// is gone, and the test catches it before any render.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installWebGPUStub, type StubInstallation } from '../../__test-support__/webgpu-stub'
import { initGPU, type GPUContext } from '@xgis/engine'
import { LineRenderer, type PatternSlot, LINE_FLAG_HAS_PATTERN } from '@xgis/map'

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

// LineRenderer needs a VTR tile bind-group layout; a trivial single-entry
// layout is enough to construct it (the renderer only stores it for pipeline
// layout creation, which the stub accepts).
function makeTileBindGroupLayout(ctx: GPUContext): GPUBindGroupLayout {
  return ctx.device.createBindGroupLayout({
    label: 'test-tile-bgl',
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true } },
    ],
  })
}

// Layer-ring slot stride = 256 bytes (LineRenderer.LAYER_SLOT); the ring is
// 512 slots → the flushed buffer's byte-size is 512 * 256. Pattern slot 0 lives
// at f32 index 20 (u32 shapeId); the flags word is u32 index 8.
const LAYER_RING_BYTES = 512 * 256
const PATTERN0_SHAPEID = 20
const FLAGS_WORD = 8

const SHAPE_ID = 7 // a known, non-default sprite shapeId

interface Captured {
  shapeId?: number
  flags?: number
}

/** Write one line layer with the given pattern stack, flush the frame, and
 *  capture the pattern-slot-0 shapeId + the flags word from the layer-ring
 *  write by intercepting `device.queue.writeBuffer`. */
function captureLayerWrite(ctx: GPUContext, patterns: PatternSlot[]): Captured {
  const renderer = new LineRenderer(ctx, makeTileBindGroupLayout(ctx))

  const captured: Captured = {}
  const device = ctx.device as unknown as {
    queue: { writeBuffer: (buf: unknown, off: number, data: ArrayBufferView | ArrayBuffer) => void }
  }
  device.queue.writeBuffer = (buf: unknown, _off: number, data: ArrayBufferView | ArrayBuffer): void => {
    if ((buf as { size?: number })?.size !== LAYER_RING_BYTES) return
    // The flush covers the dirty range starting at slot-0 byte 0, so the
    // captured view begins at pattern-slot-0 / flags within slot 0.
    const u32 = data instanceof ArrayBuffer
      ? new Uint32Array(data)
      : new Uint32Array((data as ArrayBufferView).buffer, (data as ArrayBufferView).byteOffset,
          (data as ArrayBufferView).byteLength / 4)
    captured.shapeId = u32[PATTERN0_SHAPEID]
    captured.flags = u32[FLAGS_WORD]
  }

  // writeLayerSlot positional tail: (color, widthPx, opacity, mpp, cap, join,
  // miterLimit, dash, patterns, …). patterns is the 9th argument.
  renderer.writeLayerSlot(
    [1, 1, 1, 1], 4, 1, 1000,
    undefined, undefined, undefined, null, patterns,
  )
  renderer.endFrame()

  return captured
}

describe('line-pattern data-path wiring (GPU-free)', () => {
  it('threads the resolved sprite shapeId into pattern slot 0 of the layer uniform', async () => {
    const ctx = await makeCtx()
    const { shapeId } = captureLayerWrite(ctx, [{ shapeId: SHAPE_ID, spacing: 16, size: 8 }])
    expect(shapeId, 'layer-ring slot should have been written').not.toBeUndefined()
    // Break `u32[base] = p.shapeId | 0` (write 0) and this fails.
    expect(shapeId).toBe(SHAPE_ID)
  })

  it('sets the has-pattern flag bit when a pattern slot is active', async () => {
    const ctx = await makeCtx()
    const { flags } = captureLayerWrite(ctx, [{ shapeId: SHAPE_ID, spacing: 16, size: 8 }])
    expect(flags).not.toBeUndefined()
    expect((flags! & LINE_FLAG_HAS_PATTERN) !== 0).toBe(true)
  })

  it('leaves pattern slot 0 = 0 and the has-pattern bit clear for a plain stroke', async () => {
    const ctx = await makeCtx()
    const { shapeId, flags } = captureLayerWrite(ctx, [])
    expect(shapeId).toBe(0)
    expect((flags! & LINE_FLAG_HAS_PATTERN) !== 0).toBe(false)
  })
})
