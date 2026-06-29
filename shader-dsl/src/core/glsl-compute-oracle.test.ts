// ═══ M2b — compute→fragment lowering is VALUE-FAITHFUL (CPU-f64 oracle differential) ═══
//
// Proves the compute→fragment-GPGPU rewrite preserves the kernel's semantics: the original
// @compute kernel (void, writes out_color[gid.x]) and the lowered @fragment form (returns the
// packed u32 per __frag_pos texel) produce byte-IDENTICAL out_color over [0,count) — for
// several feat_data inputs AND a multi-row output grid (H_out>1, exercising u_count.y).
//
// Per the M2 design critique: apply ONLY lowerComputeToFragment here (NOT the storage→
// data-texture pass) — the CPU oracle reads `feat_data` as a plain storage array via
// setBinding and has no storageFetchF32/texelFetch builtin. Storage→data-texture is covered
// by the M2a emit-shape test and the M2c real-GPU gate.

import { describe, it, expect } from 'vitest'
import { compileModule, lowerComputeToFragment } from '@xgis/shader-dsl'
import {
  f32T, u32T, vec3uT, vec4uT, vec4fT, voidT,
  type ShaderType, type Expr, type ModuleDecl,
} from '@xgis/shader-dsl'

const boolT = { kind: 'scalar', scalar: 'bool' } as ShaderType
const arrF32 = { kind: 'array', elem: f32T } as ShaderType
const arrU32 = { kind: 'array', elem: u32T } as ShaderType
const lit = (value: number, type: ShaderType): Expr => ({ op: 'lit', type, value })
const varref = (name: string, type: ShaderType): Expr => ({ op: 'varref', type, name })
const member = (base: Expr, field: string, type: ShaderType): Expr => ({ op: 'member', type, base, field })
const index = (base: Expr, idx: Expr, type: ShaderType): Expr => ({ op: 'index', type, base, idx })

// The per-feature paint kernel shell (compute-gen.ts shape): out_color[fid] = pack4x8unorm(
// vec4(feat_data[fid], 0, 0, 1)), guarded by fid < u_count.x.
const gid = { op: 'param', type: vec3uT, name: 'gid' } as Expr
const fid = member(gid, 'x', u32T)
const count = member(varref('u_count', vec4uT), 'x', u32T)
const feat = index(varref('feat_data', arrF32), fid, f32T)
const color: Expr = { op: 'construct', type: vec4fT, args: [feat, lit(0, f32T), lit(0, f32T), lit(1, f32T)] }
const packed: Expr = { op: 'call', type: u32T, fn: 'pack4x8unorm', args: [color] }
const computeMod: ModuleDecl = {
  consts: [], structs: [],
  bindings: [
    { group: 0, binding: 0, name: 'feat_data', space: 'storage', access: 'read', type: arrF32 },
    { group: 0, binding: 1, name: 'out_color', space: 'storage', access: 'read_write', type: arrU32 },
    { group: 0, binding: 2, name: 'u_count', space: 'uniform', type: vec4uT },
  ],
  funcs: [{
    name: 'paint', attrs: ['@compute', '@workgroup_size(64)'],
    params: [{ name: 'gid', type: vec3uT, builtin: 'global_invocation_id' }], ret: voidT,
    body: [
      { s: 'if', arms: [{ cond: { op: 'compare', type: boolT, cop: '>=', a: fid, b: count }, body: [{ s: 'return' }] }] },
      { s: 'assign', target: index(varref('out_color', arrU32), fid, u32T), expr: packed },
    ],
  }],
}

// Run the original VOID @compute kernel: gid=[fid,0,0], in-place writes into out_color[].
function runCompute(featData: number[], n: number): number[] {
  const cm = compileModule(computeMod)
  cm.setBinding('feat_data', featData)
  cm.setBinding('u_count', [n, 0, 0, 0])
  const out = new Array(n).fill(0)
  cm.setBinding('out_color', out)
  for (let f = 0; f < n; f++) cm.fns.paint([f, 0, 0])
  return out
}

// Run the LOWERED @fragment form per-texel over a W×H grid; collect the returned u32 at
// fid = x + y*W for fid < n. u_count.y carries the row width W (the GLSL-only contract).
function runFragment(featData: number[], n: number, w: number): number[] {
  const fm = compileModule(lowerComputeToFragment(computeMod))
  fm.setBinding('feat_data', featData)
  const h = Math.ceil(n / w)
  fm.setBinding('u_count', [n, w, 0, 0])
  const out = new Array(n).fill(0)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const f = x + y * w
      if (f >= n) continue                    // over-grid padding texel → discard path
      out[f] = fm.fns.paint([x + 0.5, y + 0.5, 0, 1]) as number
    }
  }
  return out
}

describe('M2b — compute→fragment lowering preserves out_color byte-for-byte (oracle)', () => {
  const inputs: Array<{ name: string; data: number[] }> = [
    { name: 'ramp', data: Array.from({ length: 10 }, (_, i) => i / 10) },
    { name: 'edges', data: [0, 1, 0.5, 0.25, 0.999, 0.001, 0.5, 0.5] },
  ]
  for (const { name, data } of inputs) {
    it(`single-row grid (W=count) — ${name}`, () => {
      const n = data.length
      expect(runFragment(data, n, n)).toEqual(runCompute(data, n))
    })
  }

  it('multi-row grid (H_out>1) — exercises the u_count.y width contract (critique #4)', () => {
    const n = 10, w = 4                        // H = ceil(10/4) = 3 rows; last row partial
    const data = Array.from({ length: n }, (_, i) => (i * 7 % 11) / 11)
    expect(runFragment(data, n, w)).toEqual(runCompute(data, n))
  })

  it('boundary fid==count-1 is written; an over-grid texel (fid>=count) writes nothing', () => {
    const n = 5, w = 4                         // grid 4×2=8 texels; texels 5,6,7 are over-grid
    const data = Array.from({ length: n }, (_, i) => (i + 1) / 6)
    const out = runFragment(data, n, w)
    expect(out.length).toBe(n)
    expect(out[n - 1]).toBe(runCompute(data, n)[n - 1])   // last in-range fid written
  })
})
