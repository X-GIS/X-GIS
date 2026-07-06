// Unit cover for the reflect()→WebGPU descriptor adapter (pure, GPUDevice-free).
// Sibling of compute-bind-layout.test.ts. Drives the adapter off the REAL point
// reflection so the test moves with the shader, plus a synthetic case for the
// read_write / texture / missing-visibility branches.

import { describe, it, expect } from 'vitest'
import { reflect, type Reflection } from '@xgis/shader-dsl'
import { buildPointModule } from '@xgis/map'
import { reflectionToBindGroupLayoutEntries, uniformFieldSlots, type VisibilityMap } from '@xgis/rhi-webgpu'

const V = 1 // GPUShaderStage.VERTEX
const F = 2 // GPUShaderStage.FRAGMENT
const POINT_VIS: VisibilityMap = new Map([
  [0, V | F],
  [1, V | F],
  [2, F],
  [3, F],
])

describe('reflectionToBindGroupLayoutEntries', () => {
  const r = reflect(buildPointModule())

  it('maps the point reflection to the renderer bind-group-layout entries', () => {
    expect(reflectionToBindGroupLayoutEntries(r, POINT_VIS)).toEqual([
      { binding: 0, visibility: V | F, buffer: { type: 'uniform' } },
      { binding: 1, visibility: V | F, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: F, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: F, buffer: { type: 'read-only-storage' } },
    ])
  })

  it('throws when a binding has no visibility entry', () => {
    expect(() => reflectionToBindGroupLayoutEntries(r, new Map([[0, V]]))).toThrow(
      /no visibility for binding 1/,
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
            },
          ],
        },
      ],
      uniforms: [],
      storage: [],
      entries: [],
    }
    expect(reflectionToBindGroupLayoutEntries(synthetic, new Map([[0, F]]))).toEqual([
      { binding: 0, visibility: F, buffer: { type: 'storage' } },
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
    })
    expect(u.slots).toBe(40) // #600 — grew 36→40 (globe_eye vec4)
  })

  it('throws for an unknown struct name', () => {
    expect(() => uniformFieldSlots(reflect(buildPointModule()), 'Nope')).toThrow(
      /no uniform struct 'Nope'/,
    )
  })
})
