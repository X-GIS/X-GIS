import { describe, it, expect } from 'vitest'
import { WebGpuDevice, unwrapWebGpuCommandEncoder, unwrapWebGpuTextureView } from './rhi-webgpu'

// ═══ Frame-shell RHI sourcing gate (#1046 F2 / #991 G2+G3) ═══
//
// F2 sources the WebGPU frame's command encoder + swapchain view through the RHI
// (`acquireFrameEncoder` / `acquireScreenView`) instead of raw
// `device.createCommandEncoder` / `context.getCurrentTexture().createView()`
// (doc §3-F2). This pins the two invariants the frame shell depends on:
//   • BYTE-IDENTITY — the RHI handles UNWRAP to the SAME native objects the raw
//     path used, so the not-yet-converted passes see identical inputs (the pass-body
//     retype to RhiRenderPass is F3/P5).
//   • ALLOC-NEUTRALITY — both `acquire*` return a REUSED wrapper (frame-invariant,
//     §5.5): a fresh NATIVE object is minted each frame, but the wrapper object is
//     not re-allocated, so the 60 Hz loop's allocation-paranoia holds.
// GPU-free — a fake device/context is enough (the seam touches no real GPU state).

interface FakeEncoder {
  readonly id: number
  finish(): { id: number }
}

function fakeContextAndDevice(): {
  context: GPUCanvasContext
  device: GPUDevice
  submitted: unknown[][]
} {
  let viewSeq = 0
  let encSeq = 0
  const submitted: unknown[][] = []
  // Each frame's getCurrentTexture().createView() is a DISTINCT object (the swapchain
  // rotates) — so a reused wrapper must rebind to prove frame-invariance.
  const context = {
    getCurrentTexture: () => ({ createView: () => ({ view: ++viewSeq }) }),
  } as unknown as GPUCanvasContext
  const device = {
    features: { has: () => false },
    createCommandEncoder: (): FakeEncoder => {
      const id = ++encSeq
      return { id, finish: () => ({ id }) }
    },
    queue: { submit: (b: unknown[]) => submitted.push(b) },
  } as unknown as GPUDevice
  return { context, device, submitted }
}

describe('frame shell sources encoder + swapchain view through the RHI (#1046 F2)', () => {
  it('acquireScreenView unwraps to the native swapchain view and reuses the wrapper', () => {
    const { context, device } = fakeContextAndDevice()
    const dev = new WebGpuDevice(device, context)
    const v1 = dev.acquireScreenView()
    // Byte-identity: unwraps to context.getCurrentTexture().createView().
    expect(unwrapWebGpuTextureView(v1)).toEqual({ view: 1 })
    const v2 = dev.acquireScreenView()
    expect(v2).toBe(v1) // REUSED wrapper (frame-invariant, §5.5)
    expect(unwrapWebGpuTextureView(v2)).toEqual({ view: 2 }) // rebound to this frame's native
  })

  it('acquireFrameEncoder unwraps to the native encoder and reuses the wrapper', () => {
    const { context, device } = fakeContextAndDevice()
    const dev = new WebGpuDevice(device, context)
    const e1 = dev.acquireFrameEncoder()
    expect((unwrapWebGpuCommandEncoder(e1) as unknown as FakeEncoder).id).toBe(1)
    const e2 = dev.acquireFrameEncoder()
    expect(e2).toBe(e1) // REUSED wrapper
    // Fresh native encoder each frame (WebGPU requires it); wrapper rebinds to it.
    expect((unwrapWebGpuCommandEncoder(e2) as unknown as FakeEncoder).id).toBe(2)
  })

  it('the frame encoder owns the single per-frame submit (finish → queue.submit)', () => {
    const { context, device, submitted } = fakeContextAndDevice()
    const dev = new WebGpuDevice(device, context)
    const enc = dev.acquireFrameEncoder()
    enc.finish()
    // queue.submit([nativeEncoder.finish()]) — the byte-identical raw submit.
    expect(submitted).toEqual([[{ id: 1 }]])
  })
})
