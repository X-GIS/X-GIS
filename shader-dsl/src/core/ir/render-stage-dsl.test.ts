import { describe, it, expect } from 'vitest'
import {
  entryFn, bindingRef, member, arrayLit, transformMat4, vec2, vec4, f32, module,
  structT, mat4x4fT, vec2fT, vec4fT, u32T,
  type StructDecl,
} from './index'
import { emitModule } from '../backends/wgsl'
import { compileModule } from '../oracle'

// Phase-2 render-stage IR proof: author a minimal render shader exercising the
// new surface (uniform struct, @vertex/@fragment entries, @builtin params +
// struct fields, mat4x4 × vec4, sized array<vec2,N> + index, struct var /
// member-assign / return). Emit valid WGSL + run the vertex fn on the CPU
// interpreter. This is the foundation the standalone render shaders
// (background/icon/text/raster/point) migrate onto.

const U: StructDecl = {
  name: 'U',
  fields: [
    { name: 'mvp', type: mat4x4fT },
    { name: 'cam', type: vec2fT },
    { name: 'color', type: vec4fT },
  ],
}
const VOut: StructDecl = {
  name: 'VOut',
  fields: [{ name: 'pos', type: vec4fT, attr: '@builtin(position)' }],
}
const FOut: StructDecl = {
  name: 'FOut',
  fields: [{ name: 'color', type: vec4fT, attr: '@location(0)' }],
}

const u = bindingRef('u', structT('U'))

const vs = entryFn('vs', 'vertex', [{ name: 'idx', type: u32T, builtin: 'vertex_index' }], structT('VOut'), ({ idx }, b) => {
  const p = b.let('p', arrayLit(vec2fT,
    vec2(f32(-1), f32(-1)), vec2(f32(1), f32(-1)), vec2(f32(0), f32(1))))
  const local = b.let('local', p.at(idx, vec2fT).sub(member(u, 'cam', vec2fT)))
  const out = b.var('out', structT('VOut'))
  b.assign(member(out, 'pos', vec4fT), transformMat4(member(u, 'mvp', mat4x4fT), vec4(local, f32(0), f32(1))))
  b.ret(out)
})

const fs = entryFn('fs', 'fragment', [{ name: 'in', type: structT('VOut') }], structT('FOut'), (_p, b) => {
  const out = b.var('out', structT('FOut'))
  b.assign(member(out, 'color', vec4fT), member(u, 'color', vec4fT))
  b.ret(out)
})

const MOD = module({
  structs: [U, VOut, FOut],
  bindings: [{ group: 0, binding: 0, name: 'u', space: 'uniform', type: structT('U') }],
  funcs: [vs, fs],
})

describe('Phase-2 render-stage IR — WGSL emission', () => {
  const wgsl = emitModule(MOD)
  it('emits uniform struct + binding + both entry points with attrs', () => {
    expect(wgsl).toContain('@group(0) @binding(0) var<uniform> u: U;')
    expect(wgsl).toContain('@builtin(position) pos: vec4<f32>,')
    expect(wgsl).toContain('@location(0) color: vec4<f32>,')
    expect(wgsl).toContain('mvp: mat4x4<f32>,')
    expect(wgsl).toContain('@vertex\nfn vs(@builtin(vertex_index) idx: u32) -> VOut')
    expect(wgsl).toContain('@fragment\nfn fs(in: VOut) -> FOut')
    expect(wgsl).toContain('array<vec2<f32>, 3>(')
    expect(wgsl).toContain('(u.mvp * vec4<f32>(local, 0.0, 1.0))')
  })
  it('is structurally balanced', () => {
    expect((wgsl.match(/{/g) ?? []).length).toBe((wgsl.match(/}/g) ?? []).length)
    expect((wgsl.match(/\(/g) ?? []).length).toBe((wgsl.match(/\)/g) ?? []).length)
  })
})

describe('Phase-2 render-stage IR — cpu interpreter runs the vertex stage', () => {
  it('vs applies mat4 × vec4 over the indexed quad vertex', () => {
    const M = compileModule(MOD)
    // mvp: scale x/y by 2 (column-major diag), cam = (10, 20), color unused here.
    const mvp = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    M.setBinding('u', { mvp, cam: [10, 20], color: [1, 0, 0, 1] } as unknown as never)
    const verts: Array<[number, number]> = [[-1, -1], [1, -1], [0, 1]]
    for (let idx = 0; idx < 3; idx++) {
      const out = M.fns.vs(idx) as { pos: number[] }
      const [px, py] = verts[idx]!
      // local = p[idx] - cam; pos = mvp * vec4(local, 0, 1) → scale*2 on x/y.
      const lx = px - 10, ly = py - 20
      expect(out.pos[0]).toBeCloseTo(lx * 2, 6)
      expect(out.pos[1]).toBeCloseTo(ly * 2, 6)
      expect(out.pos[3]).toBeCloseTo(1, 6)
    }
  })
})
