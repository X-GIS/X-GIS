import { describe, it, expect } from 'vitest'
import {
  fn,
  module,
  f32,
  vec4,
  vec2,
  f32T,
  vec4fT,
  u32T,
  u32,
  toF32,
  Var,
  Loop,
  matchExpr,
  structT,
  arrayT,
} from './ir'
import type { FuncDecl, ModuleDecl, Stmt } from './ir'
import { ioStruct, structDecl, uniformStruct, builtin, location } from './sot'
import { constFold } from './passes/opt/const-fold'
import { algebraicSimplify } from './passes/opt/algebraic'
import { licm } from './passes/opt/licm'
import { emitModule } from './backends/wgsl'
import { emitGlslModule } from './backends/glsl'
import { wgslLayout } from './reflect'

// ═══ #763 Phase P — optimizer/emit invariants ═══

/** fn with a raw WGSL Stmt in the body (the composer's precision-critical class). */
const rawFn = (name: string): FuncDecl => ({
  name,
  params: [{ name: 'x', type: f32T }],
  ret: f32T,
  body: [
    { s: 'raw', text: '// verbatim splice' },
    {
      s: 'return',
      expr: {
        op: 'binop',
        bop: '*',
        type: f32T,
        a: { op: 'lit', type: f32T, value: 2 },
        b: { op: 'lit', type: f32T, value: 3 },
      },
    },
  ] as unknown as Stmt[],
})

describe('#763 P — optimizer/emit invariants', () => {
  it('P1: constFold + algebraicSimplify skip raw-Stmt fns (verbatim charter)', () => {
    const m: ModuleDecl = module({ funcs: [rawFn('p1')] })
    for (const pass of [constFold, algebraicSimplify]) {
      const out = pass(m)
      const ret = out.funcs[0]!.body.find((s) => s.s === 'return') as { expr: { op: string } }
      expect(ret.expr.op).toBe('binop') // fail-before: constFold folded it to a lit
    }
    // The raw-free twin still folds — the skip is per-fn, not a pass lobotomy.
    const twin = module({ funcs: [{ ...rawFn('p1t'), body: rawFn('p1t').body.slice(1) }] })
    const folded = constFold(twin).funcs[0]!.body.find((s) => s.s === 'return') as {
      expr: { op: string }
    }
    expect(folded.expr.op).toBe('lit')
  })

  it('P2: licm seeds its temp counter past existing _licmN', () => {
    // A fn that ALREADY carries a `_licm0` binding (a prior fixpoint round) plus a
    // fresh loop-invariant compound — a reset counter would redeclare `_licm0`.
    const decl = fn('p2', { a: f32T }, ({ a }) => {
      const acc = Var(f32(0))
      Loop(
        u32(0),
        (i) => i.lt(u32(4)),
        () => {
          acc.assign(acc.add(a.mul(3).add(a.mul(3)))) // invariant compound, repeated
        },
      )
      return acc
    })
    // Simulate the prior round by injecting a `_licm0` let at the top.
    const primed: FuncDecl = {
      ...decl.decl,
      body: [
        { s: 'let', name: '_licm0', expr: { op: 'lit', type: f32T, value: 1 } } as unknown as Stmt,
        ...decl.decl.body,
      ],
    }
    const out = licm(module({ funcs: [primed] }))
    const names = out.funcs[0]!.body.filter(
      (s): s is Stmt & { s: 'let'; name: string } => s.s === 'let',
    ).map((s) => s.name)
    const licmNames = names.filter((n) => /^_licm\d+$/.test(n))
    expect(new Set(licmNames).size).toBe(licmNames.length) // fail-before: duplicate _licm0
  })

  it('P3: matchExpr in a for header throws at lower time (the promised guard)', () => {
    const decl = fn(
      'p3',
      { k: u32T },
      ({ k }) => {
        const acc = Var(f32(0))
        Loop(
          u32(0),
          (i) => toF32(i).lt(matchExpr(k, [[0, f32(4)]], f32(8))),
          () => {
            acc.assign(acc.add(1))
          },
        )
        return acc
      },
      { stage: 'fragment', retAttr: '@location(0)' },
    )
    expect(() => emitModule(module({ funcs: [decl] }))).toThrow(/for-loop header/)
  })

  it('P4: @interpolate(flat) float varyings emit GLSL `flat` on BOTH sides', () => {
    const VsOut = ioStruct('P4Out', {
      pos: builtin('position', vec4fT),
      w: location(0, f32T, 'flat'), // float + flat — the point.ts radius_px shape
    })
    const vs = fn(
      'vs',
      { vi: builtin('vertex_index', u32T) },
      () => VsOut.construct({ pos: vec4(0, 0, 0, 1), w: f32(1) }),
      { stage: 'vertex' },
    )
    const fs = fn('fs', { in: VsOut }, (p) => vec4(p.in.w, 0, 0, 1), {
      stage: 'fragment',
      retAttr: '@location(0)',
    })
    const m = module({ structs: [VsOut.decl], funcs: [vs, fs] })
    expect(emitGlslModule(m, 'vertex')).toMatch(/flat out float w;/) // fail-before: `out float w;`
    expect(emitGlslModule(m, 'fragment')).toMatch(/flat in float w;/) // fail-before: `in float w;`
  })

  it('P5: GLSL plain structs emit in define-before-use order', () => {
    const Inner = structDecl('P5Inner', { a: f32T })
    const Outer = structDecl('P5Outer', { inner: Inner.type, more: arrayT(Inner.type, 2) })
    // Module lists Outer FIRST — WGSL accepts it; GLSL must reorder.
    const use = fn('p5', { o: Outer }, ({ o }) => o.inner, {})
    const m = module({ structs: [Outer.decl, Inner.decl], funcs: [use] })
    const glsl = emitGlslModule(m, 'vertex').replace(/\s+/g, ' ')
    expect(glsl.indexOf('struct P5Inner')).toBeGreaterThanOrEqual(0)
    expect(glsl.indexOf('struct P5Inner')).toBeLessThan(glsl.indexOf('struct P5Outer')) // fail-before: module order
  })

  it('P6: a reserved-word fn name is renamed at decl + call site; a reserved binding name fails loud', () => {
    const texture = fn('texture', { x: f32T }, ({ x }) => x.mul(2))
    const entry = fn(
      'p6',
      { vi: builtin('vertex_index', u32T) },
      ({ vi }) => {
        const VsOut = ioStruct('P6Out', { pos: builtin('position', vec4fT) })
        return VsOut.construct({ pos: vec4(texture({ x: toF32(vi) }), 0, 0, 1) })
      },
      { stage: 'vertex' },
    )
    const m = module({ structs: [structT('P6Out') as never].slice(0, 0), funcs: [entry, texture] })
    const glsl = emitGlslModule(
      {
        ...m,
        structs: [
          {
            name: 'P6Out',
            fields: [
              { name: 'pos', type: vec4fT, attr: '@builtin(position)', builtin: 'position' },
            ],
          },
        ],
      },
      'vertex',
    )
    expect(glsl).not.toMatch(/float texture\(/) // fail-before: reserved decl emitted verbatim
    expect(glsl).toMatch(/texture_\(/) // renamed decl + call
    const U = uniformStruct('sampler', { group: 0, binding: 0, as: 'sampler' }, { t: f32T })
    const bad = module({ structs: [U.struct], bindings: [U.binding], funcs: [entry, texture] })
    expect(() => emitGlslModule(bad, 'vertex')).toThrow(/reserved word/)
  })

  it('P7: mat2 in a std140 layout is rejected (WGSL/GLSL rules disagree)', () => {
    const mat2T = { kind: 'mat', n: 2 } as never
    expect(() =>
      wgslLayout({ name: 'M2', fields: [{ name: 'm', type: mat2T }] }, 'std140'),
    ).toThrow(/mat2/)
    // std430 (storage) keeps working — the divergence is uniform-only.
    expect(() =>
      wgslLayout({ name: 'M2s', fields: [{ name: 'm', type: mat2T }] }, 'std430'),
    ).not.toThrow()
  })

  it('P8: a bare non-struct VERTEX output fails closed on GLSL (name-linked varyings)', () => {
    const vs = fn('p8', { vi: builtin('vertex_index', u32T) }, ({ vi }) => vec2(toF32(vi), 0), {
      stage: 'vertex',
      retAttr: '@location(0)',
    })
    const m = module({ funcs: [vs] })
    expect(() => emitGlslModule(m, 'vertex')).toThrow(/bare non-struct vertex output/)
    // Fragment bare output (a draw buffer) stays legal — it links by location, not name.
    const fs = fn('p8f', {}, () => vec4(1, 0, 0, 1), { stage: 'fragment', retAttr: '@location(0)' })
    expect(() => emitGlslModule(module({ funcs: [fs] }), 'fragment')).not.toThrow()
  })
})
