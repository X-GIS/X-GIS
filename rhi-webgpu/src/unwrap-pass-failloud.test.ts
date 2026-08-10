// ═══ unwrapWebGpuPass fails LOUD on a foreign wrapper (#1046 Inc-E2, arch F3) ═══
//
// The silent failure this closes cost half the first WebGL2 chain frame's
// debugging: a WebGl2 pass handed to `unwrapWebGpuPass` returned `undefined`
// (a property read on a wrapper that has no `nativePass`), the `as
// GPURenderPassEncoder` cast laundered it, and the frame died far away at the
// first native method call ("Cannot read properties of undefined") with no
// pointer to the real cause — a native-bodied terminal reached on a
// non-WebGPU backend. During the terminal-port campaign every remaining
// native terminal fails exactly this way, so the unwrap must name the
// problem AT the boundary instead.

import { describe, it, expect, vi } from 'vitest'
import { unwrapWebGpuPass, wrapWebGpuPass } from './rhi-webgpu'
import type { RhiRenderPass } from '@xgis/rhi'

describe('unwrapWebGpuPass — foreign-wrapper fail-loud (#1046 Inc-E2 F3)', () => {
  it('throws a NAMED error on a non-WebGPU pass wrapper (never silent undefined)', () => {
    // Shaped like a WebGl2 backend pass: an RhiRenderPass implementor with
    // no nativePass. Before the guard this returned undefined and the crash
    // surfaced downstream, attributed to nothing.
    const foreign = {
      setPipeline: () => {},
      draw: () => {},
      end: () => {},
    } as unknown as RhiRenderPass
    expect(() => unwrapWebGpuPass(foreign)).toThrow(/native-bodied terminal|not a WebGPU pass/)
  })

  it('unwraps a real WebGPU wrapper to the SAME native encoder (identity preserved)', () => {
    const native = {
      setPipeline: vi.fn(),
      draw: vi.fn(),
      end: vi.fn(),
    } as unknown as GPURenderPassEncoder
    const wrapped = wrapWebGpuPass(native)
    expect(unwrapWebGpuPass(wrapped)).toBe(native)
  })
})
