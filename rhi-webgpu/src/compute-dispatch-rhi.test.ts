// ═══ dispatchKernelRhi — guard-before-unwrap (#1046 F4 Inc-C, review MINOR-2) ═══
//
// The house seam protocol (markRhi / resolveOnRhi): every early-out runs
// BEFORE the unwrap, proven with a booby-trapped unwrap surface — the foreign
// encoder THROWS on `nativeEncoder` access, so a mutant that unwraps first
// trips where a passive stub would absorb it. Matters for the WebGL2 chain
// frame: an empty tile's dispatch must be a no-op, never an unattributed
// TypeError deep in the adapter.

import { describe, it, expect, vi } from 'vitest'
import { ComputeDispatcher } from './compute'
import type { RhiCommandEncoder } from '@xgis/rhi'

type DK = Parameters<ComputeDispatcher['dispatchKernelRhi']>[1]
const KERNEL = { name: 'k' } as unknown as DK
const BUF = {} as GPUBuffer

describe('dispatchKernelRhi — sprinkle-unconditionally safety', () => {
  it('no-ops BEFORE unwrapping when featureCount <= 0', () => {
    const dispatcher = Object.create(ComputeDispatcher.prototype) as ComputeDispatcher
    const foreignEnc = {
      get nativeEncoder(): never {
        throw new Error('dispatchKernelRhi unwrapped before its guard ran')
      },
    } as unknown as RhiCommandEncoder
    expect(() => dispatcher.dispatchKernelRhi(foreignEnc, KERNEL, BUF, BUF, BUF, 0)).not.toThrow()
  })

  it('delegates to dispatchKernel with the UNWRAPPED native encoder when live', () => {
    const dispatcher = Object.create(ComputeDispatcher.prototype) as ComputeDispatcher
    const spy = vi.spyOn(dispatcher, 'dispatchKernel').mockImplementation(() => {})
    const native = { sentinel: 'native-frame-encoder' } as unknown as GPUCommandEncoder
    const wrapped = { nativeEncoder: native } as unknown as RhiCommandEncoder
    dispatcher.dispatchKernelRhi(wrapped, KERNEL, BUF, BUF, BUF, 7, null)
    expect(spy).toHaveBeenCalledTimes(1)
    // Identity on the unwrapped handle + the tail args ride through untouched.
    expect(spy.mock.calls[0]![0]).toBe(native)
    expect(spy.mock.calls[0]![5]).toBe(7)
  })
})
