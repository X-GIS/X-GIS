// ═══ Compute dispatch reaches the GPU through the RHI (#1046 F4 — Inc-C) ═══
//
// The compute thread was the loop tail's LAST consumer of the unwrapped
// native encoder: render-loop → Renderer → FrameRenderer → registry →
// handle → TileComputeResources → ComputeDispatcher, all typed
// `GPUCommandEncoder`. The seam: the whole map-side thread retypes to
// `RhiCommandEncoder` (+ the adapter-exported `ComputeTimestampProvider`),
// and the ONE unwrap moves inside `ComputeDispatcher.dispatchKernelRhi`
// (rhi-webgpu — the adapter, where natives are legal). With it, the loop's
// `unwrapWebGpuCommandEncoder` local dies: no pass OR tail consumer holds
// the native frame encoder any more.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const loopSrc = (): string =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'render-loop.ts'), 'utf8')

describe('compute-dispatch seam (#1046 F4 Inc-C)', () => {
  it('render-loop never unwraps the frame encoder', () => {
    // The STRONG pin: with compute converted, nothing in the loop needs the
    // native encoder — the unwrap helper must be gone entirely.
    expect(loopSrc().match(/unwrapWebGpuCommandEncoder/g) ?? []).toHaveLength(0)
  })

  it('both compute dispatch sites hand over the RHI frame encoder', () => {
    expect(loopSrc().match(/dispatchComputePass\(frameEnc, /g) ?? []).toHaveLength(2)
  })
})
