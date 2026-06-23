import { describe, it, expect } from 'vitest'
import { emitModule, wgslBackend } from './backends/wgsl'
import { emitModuleWithReflection } from './emit'
import { reflect } from './reflect'
import {
  mat4x4fT, vec4fT, vec2fT, f32T, i32T, type ModuleDecl, type StructDecl,
} from './ir'

const struct = (name: string, fields: [string, StructDecl['fields'][number]['type']][]): StructDecl =>
  ({ name, fields: fields.map(([n, t]) => ({ name: n, type: t })) })

// ── Module A — the shipping point Uniforms layout, a uniform-struct binding + a
//    @vertex entry. No matchExpr: the lowered module's funcs equal the authored funcs.
const Uniforms = struct('Uniforms', [
  ['mvp', mat4x4fT], ['proj_params', vec4fT], ['viewport', vec4fT],
  ['cam_ecef_h', vec4fT], ['cam_ecef_l', vec4fT], ['circle_params', vec4fT],
])
const moduleA: ModuleDecl = {
  consts: [],
  structs: [Uniforms],
  bindings: [{ group: 0, binding: 0, name: 'u', space: 'uniform', type: { kind: 'struct', name: 'Uniforms' } }],
  funcs: [
    {
      name: 'vs_main',
      params: [{ name: 'pos', type: vec2fT, location: 0 }],
      ret: vec4fT,
      retAttr: '@builtin(position)',
      attrs: ['@vertex'],
      body: [{ s: 'return', expr: { op: 'construct', type: vec4fT, args: [
        { op: 'param', type: vec2fT, name: 'pos' },
        { op: 'lit', type: f32T, value: 0 },
        { op: 'lit', type: f32T, value: 1 },
      ] } }],
    },
  ],
}

// ── Module B — exercises the lowering path: the helper body returns a `matchExpr`,
//    which lowerForBackend rewrites into a hoisted { var slot, switch } pair. If the
//    string and the reflection were NOT derived from the SAME lowered module they would
//    desync here; this module is the teeth of that guarantee.
const moduleB: ModuleDecl = {
  consts: [],
  structs: [],
  bindings: [],
  funcs: [
    {
      name: 'pick',
      params: [{ name: 'i', type: i32T }],
      ret: f32T,
      body: [{ s: 'return', expr: {
        op: 'matchExpr', type: f32T,
        scrutinee: { op: 'param', type: i32T, name: 'i' },
        cases: [
          [0, { op: 'lit', type: f32T, value: 1 }],
          [1, { op: 'lit', type: f32T, value: 2 }],
        ],
        default: { op: 'lit', type: f32T, value: 0 },
      } }],
    },
  ],
}

describe('emitModuleWithReflection — code byte-identity + reflection consistency', () => {
  for (const [label, m] of [['module A (uniform struct + vertex entry)', moduleA], ['module B (matchExpr → lowered)', moduleB]] as const) {
    describe(label, () => {
      it('`.code` is byte-identical to emitModule(m)', () => {
        const { code } = emitModuleWithReflection(m, wgslBackend)
        expect(code).toBe(emitModule(m))
      })

      it('`.reflection` deep-equals reflect(m)', () => {
        const { reflection } = emitModuleWithReflection(m, wgslBackend)
        expect(reflection).toEqual(reflect(m))
      })
    })
  }

  it('surfaces the shipping point-Uniforms std140 offsets (non-empty + correct)', () => {
    const { reflection } = emitModuleWithReflection(moduleA, wgslBackend)
    expect(reflection.uniforms).toHaveLength(1)
    const u = reflection.uniforms[0]!
    expect(u.fields.length).toBeGreaterThan(0)
    expect(Object.fromEntries(u.fields.map((f) => [f.name, f.offset]))).toEqual({
      mvp: 0, proj_params: 64, viewport: 80, cam_ecef_h: 96, cam_ecef_l: 112, circle_params: 128,
    })
    expect(u.size).toBe(144)
    expect(u.align).toBe(16)
  })
})
