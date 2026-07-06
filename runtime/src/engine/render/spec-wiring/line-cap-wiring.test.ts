// line-cap: cap-style flag wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: line-cap is marked
// `supported` in the converter's line spec-coverage + the line capability
// surface, but its RUNTIME wiring was only verified for the DEFAULT (omitted
// → butt = 0) case in line-renderer.test.ts. Because butt encodes to 0, that
// default test still PASSES even if the `cap` argument were dropped entirely
// from packFlags — it is vacuous for any non-zero cap. No test drives the
// real LineRenderer slot-allocator + GPU upload with a non-zero cap, so a
// break that stops threading line-cap into the GPU flags word would ship
// silently (the heatmap-class wiring bug).
//
// The runtime contract is: LineRenderer.writeLayerSlot(cap=…) packs the cap
// id into bits 0-2 of the layer uniform's `flags` u32 (slot 8, byte 32) via
// packFlags (cap & 7), with join occupying bits 3-4. endFrame() then uploads
// the staged layer ring through `device.queue.writeBuffer`. The vs/fs line
// shader reads those bits to choose butt/round/square/arrow cap geometry.
//
// This drives the REAL LineRenderer.writeLayerSlot + endFrame against the
// WebGPU stub (no GPU) and intercepts `device.queue.writeBuffer` to read the
// flags word the renderer actually uploads, asserting cap bits 0-2 carry the
// requested NON-ZERO cap id — independently of the join bits.
//
// Fail-before: force the cap argument to a constant in the packFlags call
// (e.g. `packFlags(LINE_CAP_BUTT, join, …)`) and the round-cap assertion
// fails — line-cap no longer reaches the GPU — while the join assertion still
// passes, proving the test pins the cap wire specifically.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installWebGPUStub, type StubInstallation } from '../../../__test-support__/webgpu-stub'
import { initGPU, type GPUContext } from '@xgis/rhi-webgpu'
import {
  LineRenderer,
  LINE_CAP_BUTT,
  LINE_CAP_ROUND,
  LINE_CAP_SQUARE,
  LINE_JOIN_BEVEL,
} from '@xgis/map'

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

// A minimal VTR tile bind-group-layout to satisfy the LineRenderer ctor — it
// is only stored, never validated on the writeLayerSlot → endFrame path.
function makeTileBGL(ctx: GPUContext): GPUBindGroupLayout {
  return ctx.device.createBindGroupLayout({
    label: 'line-cap-test-tile-bgl',
    entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }],
  })
}

// Layer uniform `flags` is a u32 at f32-slot 8 = byte offset 32. The first
// writeLayerSlot() allocates slot 0 → off 0, so the flags word sits at u32
// index 8 of the staged buffer the renderer uploads.
const FLAGS_U32_INDEX = 8
const CAP_MASK = 0x7 // bits 0-2
// The layer-uniform ring is 512 slots × 256 B — a size unique among the
// buffers the renderer creates, so it keys the writeBuffer interception
// unambiguously (mirrors line-color / line-miter-limit / line-pattern wiring).
const LAYER_RING_BYTES = 512 * 256
const JOIN_SHIFT = 3
const JOIN_MASK = 0x3 // bits 3-4

/** Allocate one layer slot with the given cap/join, flush via endFrame, and
 *  return the uploaded `flags` u32 by intercepting `device.queue.writeBuffer`
 *  keyed on the renderer's layer ring. */
function capturedFlags(ctx: GPUContext, cap: number, join: number): number {
  const renderer = new LineRenderer(ctx, makeTileBGL(ctx))

  let flags = Number.NaN
  const device = ctx.device as unknown as {
    queue: { writeBuffer: (buf: unknown, off: number, data: ArrayBufferView | ArrayBuffer) => void }
  }
  device.queue.writeBuffer = (
    buf: unknown,
    _off: number,
    data: ArrayBufferView | ArrayBuffer,
  ): void => {
    // Key on the native buffer's unique byte-size (§4 seam: `renderer.layerRing`
    // is now an opaque RhiBuffer, but writeBuffer still receives the UNWRAPPED
    // native GPUBuffer — its size is distinct among the renderer's buffers).
    if ((buf as { size?: number })?.size !== LAYER_RING_BYTES) return
    const u32 =
      data instanceof ArrayBuffer
        ? new Uint32Array(data)
        : new Uint32Array(
            (data as ArrayBufferView).buffer,
            (data as ArrayBufferView).byteOffset,
            (data as ArrayBufferView).byteLength / 4,
          )
    flags = u32[FLAGS_U32_INDEX]
  }

  // strokeColor, widthPx, opacity, mppAtCenter, cap, join …
  renderer.writeLayerSlot([1, 0, 0, 1], 4, 1, 1000, cap, join)
  renderer.endFrame()

  return flags
}

describe('line-cap flag wiring (GPU-free)', () => {
  it('packs cap=ROUND into flags bits 0-2 (independent of join bits)', async () => {
    const ctx = await makeCtx()
    const flags = capturedFlags(ctx, LINE_CAP_ROUND, LINE_JOIN_BEVEL)
    expect(Number.isNaN(flags), 'layer ring should have been uploaded').toBe(false)
    // Cap wire — break the cap threading (force butt) and this fails.
    expect(flags & CAP_MASK).toBe(LINE_CAP_ROUND)
    // Join occupies the next field and must NOT have absorbed the cap — proves
    // the cap assertion is pinned to bits 0-2 specifically.
    expect((flags >>> JOIN_SHIFT) & JOIN_MASK).toBe(LINE_JOIN_BEVEL)
  })

  it('packs cap=SQUARE into flags bits 0-2', async () => {
    const ctx = await makeCtx()
    const flags = capturedFlags(ctx, LINE_CAP_SQUARE, LINE_JOIN_BEVEL)
    expect(flags & CAP_MASK).toBe(LINE_CAP_SQUARE)
  })

  it('cap=BUTT (0) leaves bits 0-2 clear', async () => {
    const ctx = await makeCtx()
    const flags = capturedFlags(ctx, LINE_CAP_BUTT, LINE_JOIN_BEVEL)
    expect(flags & CAP_MASK).toBe(LINE_CAP_BUTT)
  })
})
