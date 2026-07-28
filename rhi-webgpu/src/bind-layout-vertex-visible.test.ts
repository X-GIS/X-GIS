// ═══ Vertex-visible texture bindings (#1409) ═══
//
// GPU particle advection fetches each particle's position from a state texture IN THE VERTEX
// STAGE (`textureLoad` → `texelFetch`). WebGPU validates shader-stage visibility, and this
// backend made every texture and sampler FRAGMENT-only, so that draw was a validation error —
// while WebGL2, which binds sampler uniforms by name and does not care which stage reads them,
// was perfectly happy. That split is the worst kind: the environment that can run headlessly
// here is the one that would NOT have caught it.
//
// The flag is OPT-IN, and the default half of this gate is the load-bearing half: WebGPU counts
// sampled textures PER STAGE (`maxSampledTexturesPerShaderStage`), so widening every texture
// would charge each one against the vertex budget too and could push an unrelated fat material
// over the limit for a capability it never asked for.

import { describe, it, expect } from 'vitest'
import { WebGpuDevice } from './rhi-webgpu'

// The spec's own bit values. `GPUShaderStage` is a browser global that node does not define,
// and the code under test reads it directly, so it is supplied here rather than mocked away —
// asserting against the REAL numbers keeps this gate honest about what WebGPU will see.
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

describe('createBindGroupLayout — vertex-visible textures (#1409)', () => {
  it('textures and samplers are FRAGMENT-only by DEFAULT — unchanged for every existing layout', () => {
    const got = layoutFor([
      { binding: 0, kind: 'texture', name: 'atlas' },
      { binding: 1, kind: 'sampler', name: 'smp' },
    ])
    expect(got.map((e) => e.visibility)).toEqual([FRAGMENT, FRAGMENT])
  })

  it('...and uniforms/storage stay VERTEX|FRAGMENT, which they always were', () => {
    // Not incidental: a vertex shader reading its own transform uniform is the common case, and
    // narrowing THOSE while widening textures would be the same bug pointed the other way.
    const got = layoutFor([
      { binding: 0, kind: 'uniform', name: 'Camera' },
      { binding: 1, kind: 'storage', name: 'feat' },
    ])
    expect(got.map((e) => e.visibility)).toEqual([VERTEX | FRAGMENT, VERTEX | FRAGMENT])
  })

  it('vertexVisible widens a texture to VERTEX|FRAGMENT', () => {
    const got = layoutFor([{ binding: 0, kind: 'texture', name: 'state_tex', vertexVisible: true }])
    expect(got[0]!.visibility).toBe(VERTEX | FRAGMENT)
    // Still a texture binding, not silently reshaped into something else.
    expect(got[0]!.texture).toBeDefined()
  })

  it('the flag is PER ENTRY — one vertex-visible texture does not widen its neighbours', () => {
    // The whole point of opting in is that the per-stage sampled-texture budget is not spent
    // wholesale. A group-level flag would defeat that, so this pins entry granularity.
    const got = layoutFor([
      { binding: 0, kind: 'texture', name: 'state_tex', vertexVisible: true },
      { binding: 1, kind: 'texture', name: 'lut' },
      { binding: 2, kind: 'sampler', name: 'smp' },
    ])
    expect(got.map((e) => e.visibility)).toEqual([VERTEX | FRAGMENT, FRAGMENT, FRAGMENT])
  })
})
