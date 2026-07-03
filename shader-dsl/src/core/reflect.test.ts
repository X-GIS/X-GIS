import { describe, it, expect } from 'vitest'
import { wgslLayout, reflect } from './reflect'
import { mat4x4fT, vec4fT, vec3fT, f32T, type StructDecl, type ModuleDecl } from './ir'

const struct = (
  name: string,
  fields: [string, StructDecl['fields'][number]['type']][],
): StructDecl => ({ name, fields: fields.map(([n, t]) => ({ name: n, type: t })) })

describe('wgslLayout — std140 / std430 offset engine', () => {
  it('anchors to the shipping point Uniforms offsets (mat4x4 + 5×vec4 = 144 bytes)', () => {
    // These offsets are the contract runtime/.../point-uniform-layout.test.ts asserts
    // against the shipping CPU packer (slot×4 = byte): mvp@0 proj@16 viewport@20 … size 36 slots.
    const U = struct('Uniforms', [
      ['mvp', mat4x4fT],
      ['proj_params', vec4fT],
      ['viewport', vec4fT],
      ['cam_ecef_h', vec4fT],
      ['cam_ecef_l', vec4fT],
      ['circle_params', vec4fT],
    ])
    const L = wgslLayout(U, 'std140')
    expect(Object.fromEntries(L.fields.map((f) => [f.name, f.offset]))).toEqual({
      mvp: 0,
      proj_params: 64,
      viewport: 80,
      cam_ecef_h: 96,
      cam_ecef_l: 112,
      circle_params: 128,
    })
    expect(L.size).toBe(144)
    expect(L.align).toBe(16)
  })

  it('vec3 has align 16 / size 12 (the classic std140 trap)', () => {
    const S = struct('S', [
      ['a', f32T],
      ['b', vec3fT],
      ['c', f32T],
    ])
    const L = wgslLayout(S, 'std140')
    expect(L.fields.map((f) => f.offset)).toEqual([0, 16, 28]) // a@0, b aligns to 16, c@28
    expect(L.size).toBe(32)
  })

  it('std140 rounds struct base alignment up to 16; std430 uses natural alignment', () => {
    const Inner = struct('Inner', [
      ['x', f32T],
      ['y', f32T],
    ])
    expect(wgslLayout(Inner, 'std140')).toMatchObject({ align: 16, size: 16 })
    expect(wgslLayout(Inner, 'std430')).toMatchObject({ align: 4, size: 8 })
  })
})

describe('reflect — module metadata walker', () => {
  it('recovers bind groups, std140 uniform layout, and entry signatures', () => {
    const U = struct('Uniforms', [
      ['mvp', mat4x4fT],
      ['viewport', vec4fT],
    ])
    const m: ModuleDecl = {
      consts: [],
      structs: [U],
      bindings: [
        {
          group: 0,
          binding: 0,
          name: 'u',
          space: 'uniform',
          type: { kind: 'struct', name: 'Uniforms' },
        },
      ],
      funcs: [
        { name: 'vs', params: [], ret: { kind: 'void' }, attrs: ['@vertex'], body: [] },
        {
          name: 'cs',
          params: [],
          ret: { kind: 'void' },
          attrs: ['@compute', '@workgroup_size(64)'],
          body: [],
        },
      ],
    }
    const r = reflect(m)
    expect(r.bindGroups).toEqual([
      {
        group: 0,
        entries: [
          {
            group: 0,
            binding: 0,
            name: 'u',
            space: 'uniform',
            resourceKind: 'uniform-buffer',
            structName: 'Uniforms',
          },
        ],
      },
    ])
    expect(r.uniforms[0]?.size).toBe(80) // mat4x4(64) + vec4(16)
    expect(r.entries.map((e) => e.stage)).toEqual(['vertex', 'compute'])
    expect(r.entries.find((e) => e.stage === 'compute')?.workgroupSize).toBe(64)
  })
})
