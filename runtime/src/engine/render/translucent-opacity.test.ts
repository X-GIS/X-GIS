import { describe, expect, it } from 'vitest'

// WebGPU globals don't exist under happy-dom — stub the few constants
// LineRenderer touches in its constructor + ensureOffscreen.
;(globalThis as unknown as { GPUShaderStage: { VERTEX: number; FRAGMENT: number } }).GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 }
;(globalThis as unknown as { GPUBufferUsage: Record<string, number> }).GPUBufferUsage = {
  UNIFORM: 1, COPY_DST: 2, STORAGE: 4, VERTEX: 8, INDEX: 16,
}
;(globalThis as unknown as { GPUTextureUsage: Record<string, number> }).GPUTextureUsage = {
  RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4,
}
import { LineRenderer } from './line-renderer'
import { WebGpuDevice } from './rhi/rhi-webgpu'
import type { GPUContext } from '../gpu/gpu'

// ── Regression: translucent composite opacity must NOT clobber across layers ──
//
// Bug: composite() used to write every layer's opacity into ONE shared
// compositeUniformBuffer at offset 0 and draw against ONE static bind group.
// The TranslucentPass calls composite() once per translucent-stroke layer,
// all encoded into a single command encoder that submits once. Per WebGPU
// spec, every queue.writeBuffer for the frame is applied to the buffer
// BEFORE any submitted GPU command runs — so every composite draw sampled
// the buffer's FINAL value = the LAST layer's opacity. Two stroked line
// layers with opacities 0.5 and 0.8 both rendered at 0.8.
//
// Fix: a dynamic-offset compositeRing (mirroring layerRing). Each composite()
// allocates a fresh 256-byte slot, writes its own opacity there, and binds
// via setBindGroup(0, bg, [off]). Draw N reads slot N → its own opacity.
//
// Oracle (logic-level, no GPU): a mock device records every
// writeBuffer(buffer, offset, copyOf(data)); a mock pass records every
// setBindGroup(idx, bg, dynamicOffsets) + draw(). For each composite draw we
// reconstruct, from the draw's dynamic offset + the writes to the composite
// ring buffer at that offset, the f32 opacity the shader's CompUniform would
// sample at GPU-execution time. We assert draw#1 reads 0.5 and draw#2 reads
// 0.8 — i.e. each draw reads ITS OWN opacity, not a shared final value.

interface RecordedWrite { buffer: object; offset: number; bytes: Uint8Array }
interface RecordedBindGroup { idx: number; bg: object; dynamicOffsets: number[] | undefined }

function makeHarness() {
  const writes: RecordedWrite[] = []
  // Each createBuffer returns a distinct tagged identity so writes can be
  // attributed to the composite ring vs the layer ring vs segment buffers.
  const buffers: Array<{ label: string }> = []
  const fakeDevice = {
    createBuffer: (desc?: { label?: string }) => {
      const b = { label: desc?.label ?? '' }
      buffers.push(b)
      return b as unknown as GPUBuffer
    },
    createBindGroup: () => ({}) as GPUBindGroup,
    createBindGroupLayout: () => ({}) as GPUBindGroupLayout,
    createPipelineLayout: () => ({}) as GPUPipelineLayout,
    createRenderPipeline: () => ({}) as GPURenderPipeline,
    createShaderModule: () => ({}) as GPUShaderModule,
    createSampler: () => ({}) as GPUSampler,
    createTexture: () => ({
      createView: () => ({}),
      destroy: () => {},
    }) as unknown as GPUTexture,
    queue: {
      writeBuffer: (
        buf: GPUBuffer, offset: number, data: ArrayBufferView | ArrayBuffer,
        dataOffset?: number, size?: number,
      ) => {
        // Snapshot the bytes NOW (copyOf) — the caller may reuse the array.
        let view: Uint8Array
        if (ArrayBuffer.isView(data)) {
          view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        } else {
          view = new Uint8Array(data)
        }
        const start = dataOffset ?? 0
        const len = size ?? (view.byteLength - start)
        writes.push({ buffer: buf as unknown as object, offset, bytes: view.slice(start, start + len) })
      },
    },
  }

  const lr = new LineRenderer(
    { device: fakeDevice as unknown as GPUDevice, format: 'bgra8unorm', canvas: {} as HTMLCanvasElement, context: {} as GPUCanvasContext, rhi: new WebGpuDevice(fakeDevice as unknown as GPUDevice) } as unknown as GPUContext,
    {} as GPUBindGroupLayout,
  )

  const binds: RecordedBindGroup[] = []
  const draws: { vertexCount: number; bindAtDraw: RecordedBindGroup | null }[] = []
  let lastBind0: RecordedBindGroup | null = null
  const fakePass = {
    setPipeline: () => {},
    setBindGroup: (idx: number, bg: GPUBindGroup, dynamicOffsets?: number[]) => {
      const rec: RecordedBindGroup = { idx, bg: bg as unknown as object, dynamicOffsets }
      binds.push(rec)
      if (idx === 0) lastBind0 = rec
    },
    draw: (vertexCount: number) => {
      draws.push({ vertexCount, bindAtDraw: lastBind0 })
    },
  } as unknown as GPURenderPassEncoder

  // Identify the composite ring buffer by its label.
  const compositeRing = buffers.find((b) => b.label === 'line-composite-ring')
  return { lr, fakePass, writes, draws, compositeRing }
}

/** Reconstruct the f32 opacity the shader would sample for a given composite
 *  draw: take the draw's group-0 dynamic offset, find the LAST write to the
 *  composite ring buffer at that offset, and decode bytes[0..4] as f32. */
function opacitySampledByDraw(
  draw: { bindAtDraw: RecordedBindGroup | null },
  writes: RecordedWrite[],
  compositeRing: object | undefined,
): number {
  const dyn = draw.bindAtDraw?.dynamicOffsets
  // Before the fix there is no dynamic offset → the static bind group always
  // reads buffer offset 0. Model that explicitly.
  const off = dyn && dyn.length > 0 ? dyn[0] : 0
  const relevant = writes.filter((w) => w.buffer === compositeRing && w.offset === off)
  if (relevant.length === 0) throw new Error(`no composite-ring write at offset ${off}`)
  // GPU sees the LAST write to a given offset before submit.
  const last = relevant[relevant.length - 1]
  return new DataView(last.bytes.buffer, last.bytes.byteOffset, last.bytes.byteLength).getFloat32(0, true)
}

describe('translucent composite opacity (multi-layer clobber)', () => {
  it('two composite() calls in one frame read their OWN opacity (0.5, 0.8)', () => {
    const { lr, fakePass, writes, draws, compositeRing } = makeHarness()
    expect(compositeRing, 'composite ring buffer must be allocated').toBeTruthy()

    lr.ensureOffscreen(800, 600)
    lr.beginFrame()

    // Mimic TranslucentPass: composite once per translucent-stroke layer,
    // both encoded into the same command encoder (one mock pass), one frame.
    lr.composite(fakePass, 0.5)
    lr.composite(fakePass, 0.8)

    // Structural: two distinct dynamic offsets (not offset 0 twice).
    const compositeDraws = draws.filter((d) => d.vertexCount === 3)
    expect(compositeDraws).toHaveLength(2)
    const off1 = compositeDraws[0].bindAtDraw?.dynamicOffsets?.[0]
    const off2 = compositeDraws[1].bindAtDraw?.dynamicOffsets?.[0]
    expect(off1).toBe(0)
    expect(off2).toBe(256) // COMPOSITE_SLOT stride — distinct slot, not 0 again
    expect(off1).not.toBe(off2)

    // Semantic: each draw samples its own opacity at GPU-execution time.
    expect(opacitySampledByDraw(compositeDraws[0], writes, compositeRing)).toBeCloseTo(0.5, 6)
    expect(opacitySampledByDraw(compositeDraws[1], writes, compositeRing)).toBeCloseTo(0.8, 6)
  })

  it('single-layer case stays correct (one slot, one draw)', () => {
    const { lr, fakePass, writes, draws, compositeRing } = makeHarness()
    lr.ensureOffscreen(640, 480)
    lr.beginFrame()
    lr.composite(fakePass, 0.42)

    const compositeDraws = draws.filter((d) => d.vertexCount === 3)
    expect(compositeDraws).toHaveLength(1)
    expect(compositeDraws[0].bindAtDraw?.dynamicOffsets?.[0]).toBe(0)
    expect(opacitySampledByDraw(compositeDraws[0], writes, compositeRing)).toBeCloseTo(0.42, 6)
  })

  it('beginFrame() resets the composite slot cursor between frames', () => {
    const { lr, fakePass, draws } = makeHarness()
    lr.ensureOffscreen(320, 240)

    lr.beginFrame()
    lr.composite(fakePass, 0.3)
    lr.composite(fakePass, 0.6)

    lr.beginFrame() // reset
    lr.composite(fakePass, 0.9)

    const compositeDraws = draws.filter((d) => d.vertexCount === 3)
    expect(compositeDraws).toHaveLength(3)
    // Frame 1: slots 0, 256. Frame 2: slot 0 again (cursor reset).
    expect(compositeDraws[0].bindAtDraw?.dynamicOffsets?.[0]).toBe(0)
    expect(compositeDraws[1].bindAtDraw?.dynamicOffsets?.[0]).toBe(256)
    expect(compositeDraws[2].bindAtDraw?.dynamicOffsets?.[0]).toBe(0)
  })
})
