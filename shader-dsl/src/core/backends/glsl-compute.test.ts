// ═══ GLSL ES 3.00 — compute → fragment-GPGPU lowering (M2a) ═══
//
// A gather-only @compute kernel (the per-feature paint shape: read feat_data, write
// out_color[gid.x], one uniform u_count) lowers to a @fragment GPGPU pass under the
// `emulateCompute` opt-in, instead of fail-closing. WGSL is untouched; the default
// (no opt-in) still throws. See render-graph-pass-scheduler.md §6.5 + the M2 design.

import { describe, it, expect } from 'vitest'
import { emitGlslModule, UnsupportedFeatureError } from '@xgis/shader-dsl'
import { requiredCaps } from '@xgis/shader-dsl/dev'
import {
  f32T,
  u32T,
  vec3uT,
  vec4uT,
  vec4fT,
  voidT,
  type ShaderType,
  type Expr,
  type ModuleDecl,
} from '@xgis/shader-dsl'

const boolT = { kind: 'scalar', scalar: 'bool' } as ShaderType
const arrF32 = { kind: 'array', elem: f32T } as ShaderType // runtime-sized storage array<f32>
const arrU32 = { kind: 'array', elem: u32T } as ShaderType // runtime-sized storage array<u32>

// raw-IR node builders (no authoring layer — matches glsl.test.ts fixture style)
const lit = (value: number, type: ShaderType): Expr => ({ op: 'lit', type, value })
const varref = (name: string, type: ShaderType): Expr => ({ op: 'varref', type, name })
const member = (base: Expr, field: string, type: ShaderType): Expr => ({
  op: 'member',
  type,
  base,
  field,
})
const index = (base: Expr, idx: Expr, type: ShaderType): Expr => ({ op: 'index', type, base, idx })

// gid.x — the linear invocation index (the param node is reused at every use site, exactly
// like compute-gen.ts: `const fid = gid.x` is a JS const holding ONE Node).
const gidParam = { op: 'param', type: vec3uT, name: 'gid' } as Expr
const fid = member(gidParam, 'x', u32T)
const count = member(varref('u_count', vec4uT), 'x', u32T) // u_count.x = feature count
const featAtFid = index(varref('feat_data', arrF32), fid, f32T) // feat_data[fid]
const color: Expr = {
  op: 'construct',
  type: vec4fT,
  args: [featAtFid, lit(0, f32T), lit(0, f32T), lit(1, f32T)],
}
const packed: Expr = { op: 'call', type: u32T, fn: 'pack4x8unorm', args: [color] }

// The fixed per-feature paint kernel shell (compute-gen.ts:408-417), as raw IR.
const computeMod: ModuleDecl = {
  consts: [],
  structs: [],
  bindings: [
    { group: 0, binding: 0, name: 'feat_data', space: 'storage', access: 'read', type: arrF32 },
    {
      group: 0,
      binding: 1,
      name: 'out_color',
      space: 'storage',
      access: 'read_write',
      type: arrU32,
    },
    { group: 0, binding: 2, name: 'u_count', space: 'uniform', type: vec4uT },
  ],
  funcs: [
    {
      name: 'paint',
      attrs: ['@compute', '@workgroup_size(64)'],
      params: [{ name: 'gid', type: vec3uT, builtin: 'global_invocation_id' }],
      ret: voidT,
      body: [
        // per-fid bounds guard: if (fid >= count) return;   → becomes `discard;`
        {
          s: 'if',
          arms: [
            {
              cond: { op: 'compare', type: boolT, cop: '>=', a: fid, b: count },
              body: [{ s: 'return' }],
            },
          ],
        },
        // the SOLE output write: out_color[fid] = pack4x8unorm(color);   → becomes `return <packed>;`
        { s: 'assign', target: index(varref('out_color', arrU32), fid, u32T), expr: packed },
      ],
    },
  ],
}

describe('glsl-es300 — compute → fragment-GPGPU lowering (emulateCompute)', () => {
  it('lowers the per-feature @compute kernel to a @fragment GPGPU pass (no UnsupportedFeatureError)', () => {
    const fs = emitGlslModule(computeMod, 'fragment', { emulateCompute: true })
    // a real GLSL ES 3.00 fragment shader
    expect(fs).toContain('#version 300 es')
    expect(fs).toContain('void main()')
    // the output storage write → an R32UI draw buffer (out uint @location 0)
    expect(fs).toMatch(/layout\(location = 0\) out uint \w+;/)
    // the read storage array → a data texture sampled with texelFetch (storage-emul reuse)
    expect(fs).toContain('uniform sampler2D feat_data;')
    expect(fs).toContain('texelFetch(feat_data,')
    // u_count survives as a bare default-block uniform (gated behind emulateCompute)
    expect(fs).toContain('uniform uvec4 u_count;')
    // global_invocation_id.x synthesised from gl_FragCoord + the output-row width u_count.y
    expect(fs).toMatch(/gl_FragCoord/)
    expect(fs).toMatch(/floor/)
    expect(fs).toContain('u_count.y')
    // the packed colour is written bit-exact. GLSL ES 3.00 has NO packUnorm4x8 (4.00/3.10
    // only), so pack4x8unorm lowers to the hand-inlined round(clamp(v,0,1)*255) byte pack
    // (verified byte-equal vs the oracle on real WebGL2 — the _compute-parity gate).
    expect(fs).not.toContain('packUnorm4x8(') // not a GLSL ES 3.00 builtin
    expect(fs).toContain('round(clamp(') // the hand-inlined byte pack
    expect(fs).toContain('255.0')
    expect(fs).toContain('<< 24') // the alpha byte shifted to the high bits
    // the per-fid guard early-out lowers to discard
    expect(fs).toContain('discard;')
    // nothing compute / storage / scatter survives
    expect(fs).not.toContain('@compute')
    expect(fs).not.toContain('@workgroup_size')
    expect(fs).not.toContain('out_color')
    expect(fs).not.toMatch(/\bstorage\b/)
  })

  it('STILL fails closed without the opt-in (default GLSL contract preserved)', () => {
    expect(() => emitGlslModule(computeMod, 'fragment')).toThrow(UnsupportedFeatureError)
  })

  it('leaves the WGSL caps contract intact (requiredCaps still demands compute + storage)', () => {
    // the source module is unchanged — the WGSL path still needs the real caps.
    const caps = requiredCaps(computeMod)
    expect(caps).toContain('compute')
    expect(caps).toContain('storageBuffer')
    // …yet emulateCompute emits without throwing, because the REWRITE cleared those caps
    // before assertCaps ran (no caps loosening on the backend).
    expect(() => emitGlslModule(computeMod, 'fragment', { emulateCompute: true })).not.toThrow()
  })

  it('fail-closes a non-gather (scatter) kernel — output write not at the invocation index', () => {
    const scatter: ModuleDecl = {
      ...computeMod,
      funcs: [
        {
          ...computeMod.funcs[0],
          body: [
            // out_color[0] = … — a constant index, NOT the gid-derived fid → scatter
            {
              s: 'assign',
              target: index(varref('out_color', arrU32), lit(0, u32T), u32T),
              expr: packed,
            },
          ],
        },
      ],
    }
    expect(() => emitGlslModule(scatter, 'fragment', { emulateCompute: true })).toThrow(
      UnsupportedFeatureError,
    )
  })
})
