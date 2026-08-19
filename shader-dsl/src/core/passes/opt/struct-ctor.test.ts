import { describe, it, expect } from 'vitest'
import { structCtor } from './index.js'
import {
  module as dslModule,
  fn,
  f32T,
  vec2fT,
  vec4fT,
  vec2,
  vec4,
  If,
  Let,
  type Stmt,
} from '../../ir/index.js'
import { ioStruct, builtin, location } from '../../sot.js'
import { emitModule } from '../../backends/wgsl.js'
import { emitGlslModule } from '../../backends/glsl.js'
import { compileModule } from '../../oracle.js'

// #1867 — a write-once struct local is a VALUE being assembled, not a variable. The
// `Out.var()` + field-assign + `return o.$` shape is what ioStruct bodies author, and it
// reached BOTH writers verbatim: `var out: FragmentOutput` in the WGSL, `VsOut _v1;` plus
// a gather-shaped scatter in the GLSL. Collapsing it to the constructor is an IR fact, so
// it is fixed once here rather than twice in the backends — and on the GLSL side the
// struct DECL then disappears with it, because a constructor exit is scattered
// field-by-field and the type has no spelling left.
//
// The exclusions carry the weight, so each has its own case below: a mutated aggregate
// (the polygon fragment's `out.color.w = out.color.w * …`), a partial write, and a local
// something else reads. Every one of those is a real shape in this repo.

/** The entry's top-level statements — what the pass rewrites. */
const bodyOf = (m: ReturnType<typeof dslModule>): readonly Stmt[] =>
  m.funcs.find((f) => f.body.length > 0 && f.name.startsWith('vs'))?.body ??
  m.funcs[m.funcs.length - 1]!.body

const IoOut = ioStruct('IoOut', {
  pos: builtin('position', vec4fT),
  uv: location(0, vec2fT),
})

/** The authored shape: declare, assign each field once, return the whole. */
const buildModule = () =>
  dslModule({
    uses: [IoOut],
    funcs: [
      fn(
        'vs',
        { idx: builtin('vertex_index', f32T) },
        IoOut.type,
        ({ idx }) => {
          const o = IoOut.var()
          o.pos.assign(vec4(idx, 0, 0, 1))
          o.uv.assign(vec2(idx, idx))
          return o.$
        },
        { stage: 'vertex' },
      ),
    ],
  })

describe('optimize — write-once struct local → constructor (#1867)', () => {
  it('collapses the assemble-then-return shape', () => {
    // Asserted on the IR, because the emit path runs the whole pipeline (this pass
    // included) and could not show the before state.
    const before = bodyOf(buildModule())
    expect(before.filter((s) => s.s === 'var')).toHaveLength(1) // fail-before: a var…
    expect(before.filter((s) => s.s === 'assign')).toHaveLength(2) // …and two field writes
    const after = bodyOf(structCtor(buildModule()))
    expect(after.some((s) => s.s === 'var' || s.s === 'assign')).toBe(false)
    expect(after).toHaveLength(1)
    const exit = after[0]!
    expect(exit.s).toBe('return')
    expect(exit.s === 'return' && exit.expr?.op).toBe('construct')
  })

  it('emits the constructor on the WGSL side, end to end', () => {
    expect(emitModule(buildModule())).toContain(
      'return IoOut(vec4<f32>(idx, 0.0, 0.0, 1.0), vec2<f32>(idx, idx));',
    )
  })

  it('lets the GLSL writer drop the struct DECL entirely', () => {
    // The payoff the IR change unlocks: a constructor exit is scattered field-by-field,
    // so nothing spells the type and the decl is not emitted. This is the whole reason
    // the fix belongs in the IR rather than in either backend.
    const glsl = emitGlslModule(buildModule(), 'vertex')
    expect(glsl).not.toContain('struct IoOut')
    expect(glsl).not.toMatch(/IoOut \w+;/)
    expect(glsl).toContain('gl_Position = vec4(idx, 0.0, 0.0, 1.0);')
    expect(glsl).toContain('uv = vec2(idx, idx);')
  })

  it('KEEPS a mutated aggregate — the field is read back', () => {
    // The polygon fragment shape: `out.color.w = out.color.w * rim`. A constructor cannot
    // express a read-modify-write, and the nested member target is the tell.
    const m = dslModule({
      uses: [IoOut],
      funcs: [
        fn(
          'vs_mut',
          { idx: builtin('vertex_index', f32T) },
          IoOut.type,
          ({ idx }) => {
            const o = IoOut.var()
            o.pos.assign(vec4(idx, 0, 0, 1))
            o.uv.assign(vec2(idx, idx))
            o.uv.x.assign(o.uv.x.mul(2))
            return o.$
          },
          { stage: 'vertex' },
        ),
      ],
    })
    expect(emitModule(structCtor(m))).toMatch(/var \w+: IoOut;/)
  })

  it('KEEPS a local something else READS', () => {
    // A read makes it a real variable, not a value under construction.
    const m = dslModule({
      uses: [IoOut],
      funcs: [
        fn(
          'vs_read',
          { idx: builtin('vertex_index', f32T) },
          IoOut.type,
          ({ idx }) => {
            const o = IoOut.var()
            o.pos.assign(vec4(idx, 0, 0, 1))
            const k = Let(o.pos.x) // reads the aggregate before the return
            o.uv.assign(vec2(k, k))
            return o.$
          },
          { stage: 'vertex' },
        ),
      ],
    })
    expect(emitModule(structCtor(m))).toMatch(/var \w+: IoOut;/)
  })

  it('KEEPS a run the return is not adjacent to', () => {
    // Contiguity is what lets the pass claim value-safety with no dataflow analysis: an
    // expression separated from its constructor by arbitrary statements could read a
    // variable those statements reassign. `glsl/point/vertex` is this shape.
    const m = dslModule({
      uses: [IoOut],
      funcs: [
        fn(
          'vs_split',
          { idx: builtin('vertex_index', f32T) },
          IoOut.type,
          ({ idx }) => {
            const o = IoOut.var()
            o.pos.assign(vec4(idx, 0, 0, 1))
            If(idx.gt(0), () => {
              Let(idx.mul(2))
            })
            o.uv.assign(vec2(idx, idx))
            return o.$
          },
          { stage: 'vertex' },
        ),
      ],
    })
    expect(emitModule(structCtor(m))).toMatch(/var \w+: IoOut;/)
  })

  it('preserves oracle value-equality', () => {
    // The pass carries expressions over verbatim and in order, so a pure fn built the
    // same way must evaluate identically before and after.
    const pure = () =>
      dslModule({
        structs: [IoOut.decl],
        funcs: [
          fn('k', { x: f32T }, IoOut.type, ({ x }) => {
            const o = IoOut.var()
            o.pos.assign(vec4(x, x, x, 1))
            o.uv.assign(vec2(x.mul(2), x.add(1)))
            return o.$
          }),
        ],
      })
    const a = compileModule(pure())
    const b = compileModule(structCtor(pure()))
    for (const x of [-1, 0, 0.5, 3, 1e6]) {
      expect(b.fns.k!(x)).toEqual(a.fns.k!(x))
    }
  })
})
