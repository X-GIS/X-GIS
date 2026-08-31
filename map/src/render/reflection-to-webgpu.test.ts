// Unit cover for the reflect()→WebGPU descriptor adapter (pure, GPUDevice-free).
// Sibling of compute-bind-layout.test.ts. Drives the adapter off the REAL point
// reflection so the test moves with the shader, plus a synthetic case for the
// read_write / texture / missing-visibility branches.

import { describe, it, expect } from 'vitest'
import { reflect, type Reflection } from '@xgis/shader-dsl'
import { buildPointModule } from '@xgis/map'
import {
  reflectionToBindGroupLayoutEntries,
  uniformFieldSlots,
  type ShaderStageBits,
} from '@xgis/rhi-webgpu'

// The spec's own GPUShaderStage values, stubbed because Node has no WebGPU globals —
// which is exactly why the adapter takes them as a parameter.
const V = 1 // GPUShaderStage.VERTEX
const F = 2 // GPUShaderStage.FRAGMENT
const C = 4 // GPUShaderStage.COMPUTE
const BITS: ShaderStageBits = { VERTEX: V, FRAGMENT: F, COMPUTE: C }

describe('reflectionToBindGroupLayoutEntries', () => {
  const r = reflect(buildPointModule())

  it('maps the point reflection to the renderer bind-group-layout entries', () => {
    // #1913 — these four visibility masks are DERIVED from `BindEntry.stages` now.
    // They are byte-for-byte the map point-renderer.ts used to hand-author, which is
    // the whole claim: `u`/`feat_data` reach both stages, the SDF shape/segment
    // storage buffers are FRAGMENT-only, and nobody had to say so twice.
    expect(reflectionToBindGroupLayoutEntries(r, BITS)).toEqual([
      { binding: 0, visibility: V | F, buffer: { type: 'uniform' } },
      { binding: 1, visibility: V | F, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: F, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: F, buffer: { type: 'read-only-storage' } },
    ])
  })

  it('the derived masks are not all-stages — the reflection actually discriminates', () => {
    // Without this, the assertion above passes just as well against an adapter that
    // ORs every bit for every binding (§12: the assertion that succeeds either way).
    // Bindings 2 and 3 must NOT carry the vertex bit.
    const vis = reflectionToBindGroupLayoutEntries(r, BITS).map((e) => e.visibility)
    expect(vis.filter((v) => (v & V) !== 0)).toHaveLength(2)
    expect(vis.every((v) => (v & C) === 0)).toBe(true) // no compute entry in this module
  })

  it('throws when no stage reaches a binding', () => {
    // `stages: []` is a real reflection outcome — a binding declared and never read —
    // and `visibility: 0` is invalid in WebGPU, so it must fail here naming the
    // binding rather than at createBindGroupLayout, which names nothing.
    const unreached: Reflection = {
      ...r,
      bindGroups: [
        {
          group: 0,
          entries: [{ ...r.bindGroups[0]!.entries[1]!, stages: [] }],
        },
      ],
    }
    expect(() => reflectionToBindGroupLayoutEntries(unreached, BITS)).toThrow(
      /no stage reaches binding 1 \('feat_data'\)/,
    )
  })

  it('maps a read_write storage binding to a read-write storage buffer', () => {
    const synthetic: Reflection = {
      bindGroups: [
        {
          group: 0,
          entries: [
            {
              group: 0,
              binding: 0,
              name: 'rw',
              space: 'storage',
              access: 'read_write',
              resourceKind: 'storage-buffer',
              owner: 'module',
              // #1906/#1913 — the adapter reads THIS to build the mask now, so the
              // compute-only stage list below is what makes the expectation `C`.
              stages: ['compute'],
            },
          ],
        },
      ],
      uniforms: [],
      storage: [],
      entries: [],
      overrides: [],
      // #1670 — always-present, like `overrides`; this synthetic fixture needs none.
      requiredFeatures: [],
      // #1713 — same contract: always present, empty when the module expects nothing
      // from its host.
      requires: [],
    }
    expect(reflectionToBindGroupLayoutEntries(synthetic, BITS)).toEqual([
      { binding: 0, visibility: C, buffer: { type: 'storage' } },
    ])
  })
})

describe('uniformFieldSlots', () => {
  it('returns the point Uniforms field f32 slots + total slot count', () => {
    const u = uniformFieldSlots(reflect(buildPointModule()), 'Uniforms')
    expect(u.slot).toEqual({
      mvp: 0,
      proj_params: 16,
      viewport: 20,
      cam_ecef_h: 24,
      cam_ecef_l: 28,
      circle_params: 32,
      globe_eye: 36, // #600 — globe(7) eye-horizon cull dir
      zoom: 40, // #1635 — camera zoom, read by a `@color`/`@stroke` stage block
      mvp_pitch0: 44, // #2118 — the pitch-0 MVP the circle ground basis divides by
    })
    // #1635 — grew 40→44 (zoom f32 + std140 tail pad). #2118 — grew 44→60: the
    // mat4 consumed those 3 pad slots as its own 16 B alignment and added 64 B.
    expect(u.slots).toBe(60)
  })

  it('throws for an unknown struct name', () => {
    expect(() => uniformFieldSlots(reflect(buildPointModule()), 'Nope')).toThrow(
      /no uniform struct 'Nope'/,
    )
  })
})
