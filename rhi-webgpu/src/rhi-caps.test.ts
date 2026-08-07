import { describe, it, expect } from 'vitest'
import { WebGpuDevice } from './rhi-webgpu'
import { WebGl2Device } from '@xgis/rhi-webgl2'
import type { RhiCaps } from '@xgis/rhi'

// ═══ RhiCaps device-truth gate (#1046 F1) ═══
//
// Both backends populate the RhiCaps capability record (rhi.ts, doc §2.2)
// once at construction, frozen. This pins:
//   • the exact CAPS_FIELDS shape on BOTH devices (no more, no fewer),
//   • the fixed native truths (WebGPU: 4×MSAA / MRT / async / float / native /
//     deferred; WebGL2: 1× / no-MRT / sync / fragment-emulated / immediate),
//   • the two HARDWARE-DETECTED values against real probes: WebGPU `timestampQuery`
//     = the adapter feature the device was created with; WebGL2 `floatBlendTargets`
//     = EXT_color_buffer_float && EXT_float_blend (faked-GL, both arms).
// A fake device/GL is enough — caps read no GPU state beyond features/extensions.

// The fields the record must expose (append-only by policy, doc §2.2). Locking the
// exact key set catches an accidental extra/missing field on either backend; the
// COUNT lives only here — titles derive it, so it cannot drift (it did, twice).
const CAPS_FIELDS = [
  'maxSampleCount',
  'presentablePassMrt',
  'pickReadback',
  'floatBlendTargets',
  'chainFrame',
  'compute',
  'timestampQuery',
  'executionModel',
  'shaderLanguage',
] as const

function fakeGpuDevice(features: string[] | null): GPUDevice {
  return {
    features: features === null ? undefined : { has: (f: string) => features.includes(f) },
  } as unknown as GPUDevice
}

function fakeGl(supportedExtensions: string[] | null): WebGL2RenderingContext {
  return {
    // sampler enum constants the device ctor collects once (distinct non-zero)
    SAMPLER_2D: 0x8b5e,
    SAMPLER_CUBE: 0x8b60,
    SAMPLER_3D: 0x8b5f,
    SAMPLER_2D_ARRAY: 0x8dc1,
    getSupportedExtensions: () => supportedExtensions,
    // #1060 — the device ctor now ENABLES the float-blend extensions when both
    // are supported (getExtension is WebGL2's activation call, not just a probe);
    // the stub mirrors a real context by answering for names it "supports".
    getExtension: (name: string) => (supportedExtensions?.includes(name) ? {} : null),
  } as unknown as WebGL2RenderingContext
}

describe('RhiCaps — WebGpuDevice native truths (#1046 F1)', () => {
  it(`exposes exactly the ${CAPS_FIELDS.length} caps fields, frozen`, () => {
    const caps = new WebGpuDevice(fakeGpuDevice([])).caps
    expect(Object.keys(caps).sort()).toEqual([...CAPS_FIELDS].sort())
    expect(Object.isFrozen(caps)).toBe(true)
  })

  it('reports the fixed WebGPU capability truths', () => {
    const caps = new WebGpuDevice(fakeGpuDevice([])).caps
    expect(caps.maxSampleCount).toBe(4)
    expect(caps.presentablePassMrt).toBe(true)
    expect(caps.pickReadback).toBe('async')
    expect(caps.floatBlendTargets).toBe(true)
    expect(caps.compute).toBe('native')
    expect(caps.executionModel).toBe('deferred')
    // WebGPU hosts the unified chain's whole frame (#1046 Inc-4) — the instance
    // value, beside the source-literal pin in map's chain-routing-cap.test.ts.
    expect(caps.chainFrame).toBe(true)
    // Reads RhiPipelineDesc.code; the GLSL halves are ignored. The map's source seam
    // (wgslFor/glslStagesFor) emits from THIS, so an inverted value would build the
    // wrong language for every pipeline — pinned per backend beside its behaviour too.
    expect(caps.shaderLanguage).toBe('wgsl')
  })

  it('timestampQuery tracks the adapter feature the device was created with', () => {
    expect(new WebGpuDevice(fakeGpuDevice(['timestamp-query'])).caps.timestampQuery).toBe(true)
    expect(new WebGpuDevice(fakeGpuDevice([])).caps.timestampQuery).toBe(false)
    // A device stub without a `features` set (older fakes) degrades to false, never throws.
    expect(new WebGpuDevice(fakeGpuDevice(null)).caps.timestampQuery).toBe(false)
  })
})

describe('RhiCaps — WebGl2Device truths + float-blend detection (#1046 F1)', () => {
  it(`exposes exactly the ${CAPS_FIELDS.length} caps fields, frozen`, () => {
    const caps = new WebGl2Device(fakeGl([])).caps
    expect(Object.keys(caps).sort()).toEqual([...CAPS_FIELDS].sort())
    expect(Object.isFrozen(caps)).toBe(true)
  })

  it('reports the fixed WebGL2 capability truths (compute is fragment-emulated)', () => {
    const caps = new WebGl2Device(fakeGl([])).caps
    expect(caps.maxSampleCount).toBe(1)
    expect(caps.presentablePassMrt).toBe(false)
    expect(caps.pickReadback).toBe('sync')
    expect(caps.compute).toBe('fragment-emulated')
    expect(caps.timestampQuery).toBe(false)
    expect(caps.executionModel).toBe('immediate')
    // TRUE since the Inc-E2 flip (#1046 F4): the loop tail landed on the RHI
    // (Inc-A..D + E1), so this device hosts the whole chain frame — the only
    // frame shape on WebGL2 since the twin's deletion (Inc-F3a).
    expect(caps.chainFrame).toBe(true)
    // Requires the split GLSL sources and never reads `code` — createPipeline fail-louds
    // on a WGSL-only desc (createpipeline-dual-source-guard.test.ts asserts both halves).
    expect(caps.shaderLanguage).toBe('glsl-es300')
  })

  it('floatBlendTargets = EXT_color_buffer_float && EXT_float_blend (both required)', () => {
    const of = (exts: string[] | null): boolean =>
      new WebGl2Device(fakeGl(exts)).caps.floatBlendTargets
    expect(of(['EXT_color_buffer_float', 'EXT_float_blend'])).toBe(true)
    expect(of(['EXT_color_buffer_float'])).toBe(false) // blend-into-float missing
    expect(of(['EXT_float_blend'])).toBe(false) // float attachment missing
    expect(of([])).toBe(false)
    expect(of(null)).toBe(false) // getSupportedExtensions() → null (context-loss edge)
  })
})

describe('RhiCaps — cross-backend shape (#1046 F1)', () => {
  it('compute answers native (WebGPU) vs fragment-emulated (WebGL2) — the seam is a capability, not identity', () => {
    const webgpu: RhiCaps = new WebGpuDevice(fakeGpuDevice([])).caps
    const webgl2: RhiCaps = new WebGl2Device(fakeGl([])).caps
    expect(webgpu.compute).toBe('native')
    expect(webgl2.compute).toBe('fragment-emulated')
  })

  it('the pick pair is COHERENT: no continuous pick MRT ⇒ synchronous on-demand readback', () => {
    // The two caps are one decision seen from both ends (#1046 Inc-F, rhi.ts):
    // `presentablePassMrt` tells the frame wiring whether to allocate/attach a
    // continuous pick target, `pickReadback` tells the interaction controller how a
    // texel comes back. A device answering false/'async' would ask the controller to
    // read a texture the wiring never allocated — a null pick with no error, which is
    // exactly the silent-death class this increment closed on the chain arm.
    for (const caps of [
      new WebGpuDevice(fakeGpuDevice([])).caps,
      new WebGl2Device(fakeGl([])).caps,
    ] as RhiCaps[]) {
      if (!caps.presentablePassMrt) expect(caps.pickReadback).toBe('sync')
    }
  })
})
