// ═══ Unfilterable-float texture bindings (#1384) ═══
//
// WebGPU validation rejects binding a texture whose format cannot be linearly filtered — e.g.
// r32float / rg32float — to a bind-group layout entry whose sampleType defaults to 'float'
// (that default is only legal when the adapter advertises `float32-filterable`, which is not
// universal — notably absent on iPhone Safari / iPhone Chrome as of 2026, `gpu.ts`). Before this
// flag, `RhiBindLayoutEntry` had no way to express `sampleType: 'unfilterable-float'` at all, so
// any RHI-path draw that reads such a texture (`textureLoad`, not `textureSample`) would fail
// bind-group-layout validation on exactly the devices missing the filterable feature.
//
// The flag is OPT-IN, mirroring `vertexVisible` (#1409): the default half is the load-bearing
// half — every existing layout that binds a filterable-format texture must stay on
// sampleType 'float' byte-for-byte.

import { describe, it, expect } from 'vitest'
import { WebGpuDevice } from './rhi-webgpu'

const VERTEX = 1
const FRAGMENT = 2
const COMPUTE = 4
;(globalThis as { GPUShaderStage?: unknown }).GPUShaderStage ??= { VERTEX, FRAGMENT, COMPUTE }

/** Minimal GPUDevice stub: records the descriptor `createBindGroupLayout` is handed. */
function stubDevice() {
  const seen: GPUBindGroupLayoutDescriptor[] = []
  const device = {
    createBindGroupLayout: (d: GPUBindGroupLayoutDescriptor) => {
      seen.push(d)
      return { __layout: true } as unknown as GPUBindGroupLayout
    },
  }
  return { seen, device: device as unknown as GPUDevice }
}

function layoutFor(entries: Parameters<WebGpuDevice['createBindGroupLayout']>[0]) {
  const { seen, device } = stubDevice()
  const dev = Object.create(WebGpuDevice.prototype) as WebGpuDevice
  ;(dev as unknown as { device: GPUDevice }).device = device
  dev.createBindGroupLayout(entries)
  return [...(seen[0]!.entries as GPUBindGroupLayoutEntry[])]
}

describe('createBindGroupLayout — unfilterable-float textures (#1384)', () => {
  it('a texture entry defaults to sampleType float (`{}`) — unchanged for every layout', () => {
    const got = layoutFor([{ binding: 0, kind: 'texture', name: 'atlas' }])
    expect(got[0]!.texture).toEqual({})
  })

  it('unfilterableFloat sets sampleType to unfilterable-float', () => {
    const got = layoutFor([
      { binding: 0, kind: 'texture', name: 'density_tex', unfilterableFloat: true },
    ])
    expect(got[0]!.texture).toEqual({ sampleType: 'unfilterable-float' })
    // Still FRAGMENT-only by default — orthogonal to vertexVisible.
    expect(got[0]!.visibility).toBe(FRAGMENT)
  })

  it('the flag is PER ENTRY — one unfilterable texture does not affect its neighbours', () => {
    const got = layoutFor([
      { binding: 0, kind: 'texture', name: 'density_tex', unfilterableFloat: true },
      { binding: 1, kind: 'texture', name: 'lut' },
    ])
    expect(got[0]!.texture).toEqual({ sampleType: 'unfilterable-float' })
    expect(got[1]!.texture).toEqual({})
  })

  it('composes with vertexVisible — both flags apply independently on the same entry', () => {
    const got = layoutFor([
      {
        binding: 0,
        kind: 'texture',
        name: 'state_tex',
        vertexVisible: true,
        unfilterableFloat: true,
      },
    ])
    expect(got[0]!.visibility).toBe(VERTEX | FRAGMENT)
    expect(got[0]!.texture).toEqual({ sampleType: 'unfilterable-float' })
  })
})
