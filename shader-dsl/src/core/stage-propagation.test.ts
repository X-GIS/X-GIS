import { describe, it, expect } from 'vitest'
import { fn, module, vec4, f32, vec4fT, f32T, stageOf, workgroupSizeOf, type FuncDecl } from './ir'
import { location, builtin } from './sot'
import { requiredCaps, assertCaps } from './passes/required-caps'
import { glslEs300Backend } from './backends/glsl'
import { emitGlslModule } from './backends/glsl'
import { reflect } from './reflect'
import { deadFnElim } from './passes/opt/dce-fns'

// ═══ #763 Phase S — structured `stage` is the semantic source EVERYWHERE ═══
//
// #740 R3 made `stage` structured-first but only reflect() was updated; four
// other stage/entry predicates stayed attrs-only. These fixtures use
// STRUCTURED-ONLY decls (attrs stripped — the hand-built-literal shape the IR
// contract explicitly allows) and pin each predicate to the shared stageOf().

/** A decl carrying ONLY the structured stage — the shape that slipped every gate. */
const structuredOnly = (f: FuncDecl): FuncDecl => {
  const { attrs: _drop, ...rest } = f as FuncDecl & { attrs?: readonly string[] }
  return rest as FuncDecl
}

describe('#763 S — stageOf propagation', () => {
  it('S1: stageOf reads structured first, attr fallback second', () => {
    const frag = fn('s1_fs', {}, () => vec4(1, 0, 0, 1), { stage: 'fragment', retAttr: '@location(0)' })
    expect(stageOf(frag)).toBe('fragment')
    expect(stageOf(structuredOnly(frag.decl))).toBe('fragment')
    expect(stageOf({ attrs: ['@vertex'] })).toBe('vertex')
    expect(stageOf({})).toBeUndefined()
    const k = fn('s1_k', {}, () => f32(0), { stage: 'compute', workgroupSize: 32 })
    expect(workgroupSizeOf(structuredOnly(k.decl))).toBe(32)
  })

  it('S2: a structured-only compute kernel does NOT slip the capability gate', () => {
    const kernel = fn('s2_kernel', {}, () => f32(0), { stage: 'compute' })
    const m = module({ funcs: [structuredOnly(kernel.decl)] })
    expect(requiredCaps(m)).toContain('compute') // fail-before: attrs-only check returned []
    expect(() => assertCaps(glslEs300Backend, m)).toThrow(/compute/)
  })

  it('S3: a structured-only fragment entry is classified fragment and NOT dropped', () => {
    const frag = fn('s3_fs', {}, () => vec4(0, 1, 0, 1), { stage: 'fragment', retAttr: '@location(0)' })
    const m = module({ funcs: [structuredOnly(frag.decl)] })
    const glsl = emitGlslModule(m, 'fragment')
    // fail-before: the staged filter matched attr strings only → entry dropped
    // (and the entry classifier defaulted it to VERTEX).
    expect(glsl).toContain('void main()')
    expect(glsl).toContain('out ') // fragment draw-buffer output present
  })

  it('S4: fn-DCE roots come from the stage predicate, not attrs.length', () => {
    const helper = fn('s4_helper', { x: f32T }, ({ x }) => x.mul(2))
    const entry = fn('s4_fs', {}, () => vec4(1, 1, 1, 1), { stage: 'fragment', retAttr: '@location(0)' })
    // Structured-only entry + an UNCALLED helper: the old `attrs.length > 0`
    // saw zero roots → no-op'd → the dead helper survived.
    const m = module({ funcs: [structuredOnly(entry.decl), helper] })
    const out = deadFnElim(m)
    expect(out.funcs.map((f) => f.name)).toEqual(['s4_fs'])
  })

  it('S5: location()/builtin() entry params reach reflect() as vertex attributes', () => {
    const vs = fn('s5_vs', {
      pos: location(0, vec4fT),
      w: location(1, f32T),
      vi: builtin('vertex_index', { kind: 'scalar', scalar: 'u32' }),
    }, ({ pos }) => pos, { stage: 'vertex' })
    const m = module({ funcs: [vs] })
    const r = reflect(m)
    // fail-before: fn() dropped the structured location → reflect saw ZERO attributes.
    expect(r.vertex).toBeDefined()
    expect(r.vertex!.attributes.map((a) => ({ name: a.name, location: a.location }))).toEqual([
      { name: 'pos', location: 0 },
      { name: 'w', location: 1 },
    ])
  })
})
