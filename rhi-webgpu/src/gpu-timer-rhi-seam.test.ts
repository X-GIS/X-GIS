// ═══ beginTimedPass / markRhi — the timestamp seam for the F3b chain retype ═══
//
// RhiRenderPassDesc deliberately does NOT model timestampWrites (rhi.ts pins
// that as a WebGPU-encoder concern "layered at the migration call-site — the
// gpuTimer seam"). These tests pin the seam's contracts so the #1046 F3b pass-
// body retype can rely on them:
//   • no live writes ⇒ the pass begins through the RHI encoder itself with the
//     UNTOUCHED descriptor — pure RHI, valid on any backend;
//   • live writes ⇒ the native descriptor is exactly rhiRenderPassToGpu(desc)
//     plus timestampWrites — descriptor-equivalent to the raw form the pass
//     bodies write today (undefined ≡ absent, the rhi-renderpass-parity
//     convention);
//   • markRhi never unwraps unless every mark() precondition already holds, so
//     chain bodies may sprinkle it unconditionally on any backend.

import { describe, it, expect, vi } from 'vitest'
import { GPUTimer, beginTimedPass } from './gpu-timer'
import { rhiRenderPassToGpu, wrapWebGpuPass, wrapWebGpuTextureView } from './rhi-webgpu'
import type { RhiCommandEncoder, RhiRenderPass, RhiRenderPassDesc } from '@xgis/rhi'

const view = wrapWebGpuTextureView({} as GPUTextureView)
const DESC: RhiRenderPassDesc = {
  label: 'seam-test',
  colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0.5, 0, 1] }],
}

describe('beginTimedPass — the gpuTimer seam (#1046 F3b)', () => {
  it('no timer ⇒ begins through the RHI encoder with the SAME descriptor object', () => {
    const rhiPass = { rhi: true } as unknown as RhiRenderPass
    const begin = vi.fn((_d: RhiRenderPassDesc) => rhiPass)
    const enc = { beginRenderPass: begin } as unknown as RhiCommandEncoder
    const got = beginTimedPass(null, enc, DESC)
    expect(begin).toHaveBeenCalledTimes(1)
    // Reference identity, not deep equality — the neutral arm must forward the
    // caller's descriptor untouched (a re-mapped clone would deep-equal).
    expect(begin.mock.calls[0]![0]).toBe(DESC)
    expect(got).toBe(rhiPass)
  })

  it('timer whose passWrites() is null (disabled / budget spent) ⇒ same neutral path', () => {
    const rhiPass = { rhi: true } as unknown as RhiRenderPass
    const enc = { beginRenderPass: vi.fn(() => rhiPass) } as unknown as RhiCommandEncoder
    const got = beginTimedPass({ passWrites: () => null }, enc, DESC)
    expect(enc.beginRenderPass).toHaveBeenCalledWith(DESC)
    expect(got).toBe(rhiPass)
  })

  it('live writes ⇒ native descriptor is rhiRenderPassToGpu(desc) + timestampWrites', () => {
    const writes = { querySet: {} } as unknown as GPURenderPassTimestampWrites
    const nativePass = {} as GPURenderPassEncoder
    const nativeBegin = vi.fn(
      (_d: GPURenderPassDescriptor & { timestampWrites?: unknown }) => nativePass,
    )
    // unwrapWebGpuCommandEncoder reads `.nativeEncoder` (the WebGpuCommandEncoder
    // getter) — the stub carries the same shape.
    const enc = {
      nativeEncoder: { beginRenderPass: nativeBegin },
    } as unknown as RhiCommandEncoder
    beginTimedPass({ passWrites: () => writes }, enc, DESC)
    expect(nativeBegin).toHaveBeenCalledTimes(1)
    const gotDesc = nativeBegin.mock.calls[0]![0]
    expect(gotDesc.timestampWrites).toBe(writes)
    const { timestampWrites: _tw, ...topology } = gotDesc
    // The mapped topology must be EXACTLY what the RHI encoder itself would
    // build — the seam adds the one field and changes nothing else.
    expect(topology).toEqual(rhiRenderPassToGpu(DESC))
  })
})

describe('markRhi — sprinkle-unconditionally safety', () => {
  it('no-ops BEFORE unwrapping when inside-passes marking is off', () => {
    // A bare prototype instance: insidePasses/querySet are undefined ⇒ every
    // precondition fails. The foreign pass BOOBY-TRAPS the unwrap surface: its
    // nativePass getter throws on ACCESS. A mutant that unwraps first and
    // guards later would trip the trap (a passive stub cannot catch that —
    // unwrap yields silent undefined and mark()'s own guards absorb it), so
    // the not-throwing run proves the guards short-circuit before any unwrap.
    const timer = Object.create(GPUTimer.prototype) as GPUTimer
    const foreignPass = {
      get nativePass(): never {
        throw new Error('markRhi unwrapped before its guards ran')
      },
    } as unknown as RhiRenderPass
    expect(() => timer.markRhi(foreignPass, 'after_bg')).not.toThrow()
  })

  it('delegates to mark() with the UNWRAPPED native pass when marking is on', () => {
    const timer = Object.create(GPUTimer.prototype) as GPUTimer
    Object.assign(timer as unknown as Record<string, unknown>, {
      insidePasses: true,
      querySet: {},
    })
    const markSpy = vi.spyOn(timer, 'mark').mockImplementation(() => {})
    const native = { sentinel: 'native-pass' } as unknown as GPURenderPassEncoder
    timer.markRhi(wrapWebGpuPass(native), 'after_raster')
    expect(markSpy).toHaveBeenCalledTimes(1)
    // Identity on the unwrapped handle — the delegation must hand mark() the
    // very native encoder the wrapper holds, not a lookalike.
    expect(markSpy.mock.calls[0]![0]).toBe(native)
    expect(markSpy.mock.calls[0]![1]).toBe('after_raster')
  })
})
