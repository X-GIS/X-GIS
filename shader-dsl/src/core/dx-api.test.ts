import { describe, it, expect } from 'vitest'
import { fn, module, vec2, vec4, f32T, u32T, vec2fT, vec4fT, texture2dfT } from './ir'
import { ioStruct, structDecl, uniformStruct, storageBuffer, resource, constDecl, builtin, location } from './sot'
import { emitModule } from './backends/wgsl'
import { compileModule } from './oracle'

// ═══ #763 Phase X part 2 — the API additions, pinned ═══

describe('#763 X — API additions', () => {
  it('X2: constDecl declares once — decl into the module, typed node at use sites', () => {
    const TAU = constDecl('X_TAU', f32T, { wgsl: 6.2831853, cpu: Math.PI * 2 })
    const g = fn('x2', { t: f32T }, ({ t }) => t.mul(TAU.node))
    const m = module({ consts: [TAU.decl], funcs: [g] }) // array form — record keys RENAME (R1)
    const w = emitModule(m)
    expect(w).toContain('X_TAU') // declared…
    expect(w).toContain('6.2831853') // …with the WGSL-side value
    const cpu = compileModule(m)
    expect(cpu.fns['x2']!(0.5)).toBeCloseTo(Math.PI, 12) // full-precision cpu twin
  })

  it('X3: retAttr accepts location(); a bare fragment return defaults to @location(0)', () => {
    const typed = fn('x3a', {}, () => vec4(1, 0, 0, 1), { stage: 'fragment', retAttr: location(0, vec4fT) })
    expect(emitModule(module({ funcs: [typed] }))).toContain('-> @location(0) vec4<f32>')
    const defaulted = fn('x3b', {}, () => vec4(0, 1, 0, 1), { stage: 'fragment' }) // no retAttr at all
    expect(emitModule(module({ funcs: [defaulted] }))).toContain('-> @location(0) vec4<f32>')
  })

  it('X14: `return o` works — the proxy duck-types as the raw node in value positions', () => {
    const VsOut = ioStruct('X14Out', { pos: builtin('position', vec4fT), uv: location(0, vec2fT) })
    const vs = fn('x14', { vi: builtin('vertex_index', u32T) }, () => {
      const o = VsOut.var('out')
      o.pos.assign(vec4(0, 0, 0, 1))
      o.uv.assign(vec2(0, 0))
      return o // ← the naive first attempt; used to die at LOAD with "no field 'expr'"
    }, { stage: 'vertex' })
    const w = emitModule(module({ structs: [VsOut.decl], funcs: [vs] }))
    expect(w).toContain('return out;')
  })

  it('X1: module({ uses }) derives structs/bindings/consts from the handles', () => {
    const U = uniformStruct('X1U', { group: 0, binding: 0, as: 'x1u' }, { t: f32T })
    const VsOut = ioStruct('X1Out', { pos: builtin('position', vec4fT) })
    const Seg = structDecl('X1Seg', { a: f32T })
    const segs = storageBuffer('x1_segs', Seg, { group: 1, binding: 0, access: 'read' })
    const tex = resource('x1_tex', texture2dfT, { group: 0, binding: 1 })
    const TAU = constDecl('X1_TAU', f32T, { wgsl: 6.28, cpu: Math.PI * 2 })
    const vs = fn('x1_vs', {}, () => {
      const o = VsOut.var('out')
      o.pos.assign(vec4(U.field.t, segs.at(0).a, TAU.node, 1))
      return o
    }, { stage: 'vertex' })
    const m = module({
      uses: [U, VsOut, segs, tex, TAU],
      funcs: [vs],
    })
    // Derived: uniform struct + IO struct + storage ELEMENT struct…
    expect(m.structs.map((s) => s.name).sort()).toEqual(['X1Out', 'X1Seg', 'X1U'])
    // …uniform + storage + texture bindings…
    expect(m.bindings.map((b) => b.name).sort()).toEqual(['x1ptr'.replace('ptr', 'u'), 'x1_segs', 'x1_tex'].sort())
    // …and the const.
    expect(m.consts.map((c) => c.name)).toEqual(['X1_TAU'])
    // The whole thing emits without any hand-restated arrays.
    const w = emitModule(m)
    expect(w).toContain('struct X1U')
    expect(w).toContain('var<storage, read> x1_segs')
    // Explicit arrays still merge without duplicating (name-deduped).
    const m2 = module({ structs: [U.struct], uses: [U], funcs: [vs] })
    expect(m2.structs.filter((s) => s.name === 'X1U')).toHaveLength(1)
  })
})
