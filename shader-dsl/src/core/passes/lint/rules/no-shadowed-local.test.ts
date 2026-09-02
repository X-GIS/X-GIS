import { describe, it, expect } from 'vitest'
import { module, fn, f32, f32T } from '../../../ir/index.js'
import { lintModule } from '../../validate.js'
import { compileModule } from '../../../oracle.js'
import { optimizeAt } from '../../opt/optimize.js'
import { emitModule } from '../../../backends/wgsl.js'
import { emitGlslModule } from '../../../backends/glsl.js'

// #2341 — the IR identifies a binding by its NAME alone, and five optimizer passes key a
// function-wide flat map on it. A duplicated name merges two bindings; nothing checked it.
// These fixtures ARE the two symptoms from the issue, so the rule can never be graded
// against a shape gentler than the one that miscompiled.

const shadowed = (m: ReturnType<typeof module>): string[] =>
  lintModule(m)
    .filter((d) => d.ruleId === 'no-shadowed-local')
    .map((d) => d.message)

describe('no-shadowed-local', () => {
  // Symptom 1: sibling arms. Nothing is shadowed LEXICALLY — which is exactly why this
  // shape is the dangerous one: it reads as obviously fine and collides in the flat map.
  const siblingArms = module({
    funcs: [
      fn('k', { c: f32T }, f32T, ({ c }, b) => {
        const out = b.var('out', f32T, f32(0))
        b.if(c.gt(f32(0)), (bb) => {
          out.assign(bb.let('t', f32(10)))
        }).else((bb) => {
          out.assign(bb.let('t', f32(20)))
        })
        b.ret(out)
      }),
    ],
  })

  it('reports a name reused between two sibling blocks', () => {
    const found = shadowed(siblingArms)
    expect(found).toHaveLength(1)
    expect(found[0]).toContain("'t' is declared more than once in fn 'k'")
  })

  it('is an error, and carries SD0112', () => {
    const d = lintModule(siblingArms).find((x) => x.ruleId === 'no-shadowed-local')!
    expect(d.severity).toBe('error')
    expect(d.code).toBe('SD0112')
  })

  // Symptom 2: a local reusing a PARAM name. Wrong at O0 too — the emitted WGSL spells the
  // param reference with the local's name, so `t + shadow` becomes `(t + t)` and the
  // parameter is unreachable.
  const overParam = module({
    funcs: [
      fn('p', { t: f32T }, f32T, ({ t }, b) => {
        const shadow = b.let('t', f32(99))
        b.ret(t.add(shadow))
      }),
    ],
  })

  it('reports a local that reuses a parameter name', () => {
    expect(shadowed(overParam)).toHaveLength(1)
  })

  // What these two fixtures DID before the gate existed, measured on 6285c6a and reproduced
  // in #2341: the sibling arms returned 10 at O0 and 20 at O1 — the tier the package
  // documents as value-identical to O0 (optimize.ts:209) — and the param reuse returned 198
  // instead of the authored 100, with the CPU oracle and the emitted WGSL agreeing on the
  // wrong value, so no backend differential could have caught it. Every door onto that is
  // now shut, including the one that does not go through validate():
  it.each([
    ['the CPU oracle', (m: ReturnType<typeof module>) => compileModule(m)],
    ['the WGSL writer', (m: ReturnType<typeof module>) => emitModule(m)],
    ['the GLSL writer', (m: ReturnType<typeof module>) => emitGlslModule(m)],
    [
      'a direct optimizeAt(), which never runs validate()',
      (m: ReturnType<typeof module>) => optimizeAt(m, 'O1'),
    ],
  ])('%s fails closed on a duplicated name', (_what, run) => {
    expect(() => run(siblingArms)).toThrow(/SD0112/)
    expect(() => run(overParam)).toThrow(/SD0112/)
  })

  // The shape an author is most likely to write by accident: two loops, each with its own
  // `let t`. It reads as obviously fine — separate loop scopes, legal WGSL — and const-prop
  // propagated the SECOND loop's literal into the FIRST loop's body (#2341).
  it('reports two sibling loop bodies that bind the same name', () => {
    const m = module({
      funcs: [
        fn('k', { x: f32T }, f32T, ({ x }, b) => {
          const acc = b.var('acc', f32T, f32(0))
          b.forRange(
            'i',
            f32(0),
            (i) => i.lt(f32(2)),
            (cb, i) => {
              cb.addAssign(acc, cb.let('t', f32(10)).mul(i).add(x))
            },
          )
          b.forRange(
            'j',
            f32(0),
            (j) => j.lt(f32(2)),
            (cb, j) => {
              cb.addAssign(acc, cb.let('t', f32(20)).mul(j))
            },
          )
          b.ret(acc)
        }),
      ],
    })
    expect(shadowed(m)).toHaveLength(1)
  })

  it('reports a `for` counter that reuses an outer binding name', () => {
    const m = module({
      funcs: [
        fn('l', {}, f32T, (_p, b) => {
          const i = b.var('i', f32T, f32(7)) // outer 'i' …
          const total = b.var('total', f32T, f32(0))
          b.forRange(
            'i', // … and the loop counter takes the same name
            f32(0),
            (k) => k.lt(f32(3)),
            (bb, k) => {
              bb.addAssign(total, k)
            },
          )
          b.ret(total.add(i))
        }),
      ],
    })
    expect(shadowed(m)).toHaveLength(1)
  })

  it('does not false-flag the auto-named loop idiom every shader uses', () => {
    const m = module({
      funcs: [
        fn('sum', {}, f32T, (_p, b) => {
          const total = b.var('total', f32T, f32(0))
          b.forRange(
            f32(0),
            (k) => k.lt(f32(3)),
            (bb, k) => {
              bb.addAssign(total, k)
            },
          )
          b.ret(total)
        }),
      ],
    })
    expect(shadowed(m)).toEqual([])
  })

  it('stays silent on distinct names, including the auto-named idiom', () => {
    const m = module({
      funcs: [
        fn('ok', { x: f32T }, f32T, ({ x }, b) => {
          const a = b.let(x.mul(2)) // auto-named _v0
          const c = b.let(x.mul(3)) // auto-named _v1
          const out = b.var('out', f32T, a.add(c))
          b.if(x.gt(f32(0)), (bb) => {
            out.assign(bb.let('hi', f32(1)))
          }).else((bb) => {
            out.assign(bb.let('lo', f32(2)))
          })
          b.ret(out)
        }),
      ],
    })
    expect(shadowed(m)).toEqual([])
    expect(() => emitModule(m)).not.toThrow()
  })
})
