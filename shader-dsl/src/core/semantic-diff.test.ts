// ═══ semanticDiff — bucket separation, the mangle invariant, and non-vacuity (#1714) ═══
//
// Every "it detects X" arm here CUTS THE SPECIFIC MECHANISM rather than only checking
// that a fail-before goes red: each variant module changes exactly one axis, and the
// arm asserts both that the owning bucket names it AND that the other buckets stay
// empty. A comparator that reported everything under one bucket, or that reported a
// literal change as a control-flow change, would pass a plain "is it non-empty?" test
// and fail these (CLAUDE.md §12).
//
// The load-bearing arm is mangle invariance. It is what lets #1715's "prod is dev,
// optimized" claim be asserted rather than trusted, and it is why 'names'
// canonicalizes exactly the partition mangleModule is free to rewrite. It carries its
// own sanity check — mangleModule returns the module UNCHANGED when there is nothing
// to rename (and bails to identity on a `raw` body), so without asserting that renames
// actually happened the invariant would hold vacuously.

import { describe, it, expect } from 'vitest'
import { f32, floor, fn, fract, module, sin, vec2, vec4, f32T, vec2fT, vec4fT } from './ir'
import { builtin, ioStruct, location, uniformStruct } from './sot'
import { mangleModule } from './passes/mangle'
import { inlineLinearAll } from './passes/inline-linear'
import { inline, mangle, minify } from '../emit-prod'
import { isSemanticallyEqual, semanticDiff } from './semantic-diff'
import type { ModuleDecl } from './ir'

const U = uniformStruct(
  'SdParams',
  { group: 0, binding: 0, as: 'params' },
  { scale: f32T, tint: vec4fT },
)
const U2 = uniformStruct('SdExtra', { group: 0, binding: 1, as: 'extra' }, { bias: f32T })
const VsOut = ioStruct('SdVsOut', {
  pos: builtin('position', vec4fT),
  uv: location(0, vec2fT),
})

// The three helper bodies the arms below vary. Declared before `build` so its
// parameter can take the CONCRETE handle type: `ReturnType<typeof fn>` erases the
// param spec to `FnHandle<FnParamSpec, string>`, which the specific
// `FnHandle<{ x: f32 }, 'f32'>` is not assignable to (the call signature's args are
// contravariant). vitest does not typecheck, so only `bun run build` sees that.
//
// `mul` then `add`, both by 0.5.
const shadeBase = fn('shade', { x: f32T }, (p) => sin(p.x).mul(0.5).add(0.5))
// SAME tree shape, different literal values → `constants` only.
const shadeLit = fn('shade', { x: f32T }, (p) => sin(p.x).mul(0.25).add(0.25))
// SAME literal multiset {0.5, 0.5}, operators swapped → `controlFlow` only.
const shadeShape = fn('shade', { x: f32T }, (p) => sin(p.x).add(0.5).mul(0.5))

/** `shade` differs between variants only in the axis each arm is probing. */
const build = (
  shade: typeof shadeBase,
  opts: { readonly fsName?: string; readonly extraBinding?: boolean } = {},
): ModuleDecl => {
  const vs = fn(
    'vs_main',
    {},
    () => VsOut.construct({ pos: vec4(0.0, 0.0, 0.0, 1.0), uv: vec2(shade({ x: 1.0 }), 0.0) }),
    { stage: 'vertex' },
  )
  const fs = fn(
    opts.fsName ?? 'fs_main',
    { vo: VsOut },
    (p) => {
      const s = shade({ x: p.vo.uv.x.mul(U.field.scale) })
      return vec4(s, s, s, U.field.tint.w)
    },
    { stage: 'fragment', retAttr: '@location(0)' },
  )
  return module({ funcs: [vs, fs], uses: opts.extraBinding ? [U, U2, VsOut] : [U, VsOut] })
}

const base = build(shadeBase)

describe('semanticDiff — reflexivity', () => {
  it('a module does not differ from itself, under the default ignore set', () => {
    expect(semanticDiff(base, base)).toEqual({
      interface: [],
      resources: [],
      constants: [],
      controlFlow: [],
      semanticsPreservingTransform: [],
    })
  })

  it('…nor with nothing ignored at all', () => {
    expect(isSemanticallyEqual(semanticDiff(base, base, { ignore: [] }))).toBe(true)
  })
})

describe('semanticDiff — the mangle invariant (#1715B seed)', () => {
  const mangled = mangleModule(base)

  it('mangleModule actually renamed something (the invariant below is not vacuous)', () => {
    // Identity is a REAL mangleModule outcome (nothing renameable / a `raw` body), and
    // it would satisfy the invariant while proving nothing.
    expect(mangled.renames.size).toBeGreaterThan(0)
    expect(mangled.module).not.toBe(base)
  })

  it('renaming internal identifiers changes nothing semanticDiff reports', () => {
    expect(semanticDiff(base, mangled.module)).toEqual({
      interface: [],
      resources: [],
      constants: [],
      controlFlow: [],
      semanticsPreservingTransform: [],
    })
  })

  it("…and `ignore: []` DOES see the rename — so 'names' distinguishes the two states", () => {
    const d = semanticDiff(base, mangled.module, { ignore: ['declOrder'] })
    expect(isSemanticallyEqual(d)).toBe(false)
    expect(d.controlFlow.join('\n')).toContain('shade')
  })
})

describe('semanticDiff — one axis per bucket', () => {
  it('a changed literal lands in `constants`, and NOT in `controlFlow`', () => {
    const d = semanticDiff(base, build(shadeLit))
    expect(d.constants.join('\n')).toContain('lit f32=0.5')
    expect(d.constants.join('\n')).toContain('lit f32=0.25')
    expect(d.controlFlow).toEqual([])
    expect(d.interface).toEqual([])
    expect(d.resources).toEqual([])
  })

  it('a changed expression shape lands in `controlFlow`, and NOT in `constants`', () => {
    // Same literals, `mul`/`add` swapped: the buckets must not blur into each other.
    const d = semanticDiff(base, build(shadeShape))
    expect(isSemanticallyEqual(d)).toBe(false)
    expect(d.controlFlow.length).toBeGreaterThan(0)
    expect(d.constants).toEqual([])
    expect(d.interface).toEqual([])
    expect(d.resources).toEqual([])
  })

  it('an added binding lands in `resources`, naming the group/binding', () => {
    const d = semanticDiff(base, build(shadeBase, { extraBinding: true }))
    expect(d.resources.join('\n')).toContain('bind 0:1 extra')
    expect(d.resources.join('\n')).toContain('layout std140 struct:SdExtra')
    expect(d.controlFlow).toEqual([])
    expect(d.constants).toEqual([])
    expect(d.interface).toEqual([])
  })

  it('a renamed ENTRY POINT lands in `interface` — an entry name is ABI, never ignorable', () => {
    const d = semanticDiff(base, build(shadeBase, { fsName: 'fs_alt' }))
    expect(d.interface.join('\n')).toContain('fs_main')
    expect(d.interface.join('\n')).toContain('fs_alt')
    expect(d.resources).toEqual([])
  })
})

describe('semanticDiff — declOrder', () => {
  it('argument order within an expression is a real difference, not a reordering', () => {
    // Guards against `declOrder` being read as "sort everything, everywhere": swapping
    // operands changes the program, and the sort must not cancel it out.
    const swapped = fn('shade', { x: f32T }, (p) => sin(p.x).mul(0.5).add(0.5))
    const d = semanticDiff(build(swapped), build(shadeShape))
    expect(isSemanticallyEqual(d)).toBe(false)
  })
})

// ═══ #1806 — semantics-preserving transform classification ═══════════════════════════
//
// A consumer's cross-backend parity gate compares the DEV module against the PRODUCTION
// one, and the production emit runs `inline()` — so the optimizer's own rewrite lands in
// `controlFlow`/`constants` and spends the same mismatch budget a backend or interface
// regression does. `transforms` re-runs the declared plugins on BOTH sides and reports
// what they account for separately.
//
// The two arms that carry the information are the NEGATIVE ones, and both are cuts of a
// specific mechanism (§12) rather than "does it go green":
//
//   • declaring minify() — a text-stage plugin that moves no IR — must leave the
//     mismatch fail-able. An implementation that emptied the buckets whenever
//     `transforms` was non-empty would be indistinguishable from this one otherwise.
//   • a REAL control-flow change (mul/add swapped) must stay fail-able even with
//     inline() declared, because inlining both sides does not make the two agree. That
//     is the whole reason this re-runs the pass instead of pattern-matching the diff:
//     a genuine regression and an inline produce the same SHAPE of diff line.

// A LINEAR multi-statement helper — the shape inline() rewrites by LIFTING its statements
// into the caller and binding the call's value to a temporary. `shade` above is
// single-return and inlines by plain expression substitution, so the temporary-variable
// rewrite the report names is only reachable through this shape.
const sdNoise = fn('sdNoise', { p: f32T }, f32T, ({ p }, b) => {
  const lo = b.let('lo', floor(p))
  const hi = b.let('hi', fract(p))
  b.ret(lo.add(hi).mul(2))
})
const sdLinearFs = fn(
  'sdLinearFs',
  {},
  vec4fT,
  (_p, b) => b.ret(vec4(sdNoise({ p: f32(0.5) }), 0.0, 0.0, 1.0)),
  { stage: 'fragment', retAttr: '@location(0)' },
)
const linearDev = module({ funcs: [sdNoise, sdLinearFs] })

describe('semanticDiff — semantics-preserving transform classification (#1806)', () => {
  // The chain a consumer passes to the emit call, verbatim: two IR-stage plugins and one
  // text-stage plugin. `prod` is `dev` with inline() applied — the pair a parity gate
  // actually compares.
  const PROD_PLUGINS = [inline(), mangle(), minify()]
  const dev = base
  const prod = inlineLinearAll(dev)

  it('inline() actually rewrote the module (every arm below is vacuous otherwise)', () => {
    // Identity is a real inlineLinearAll outcome — nothing inlinable, or a `raw` body —
    // and it would satisfy the classification arm while proving nothing.
    expect(dev.funcs.map((f) => f.name)).toContain('shade')
    expect(prod.funcs.map((f) => f.name)).not.toContain('shade')
  })

  it('WITHOUT the declaration the rewrite is still an ordinary, fail-able mismatch', () => {
    // Nothing about the default behaviour moved: this is a classification, not an ignore.
    const d = semanticDiff(dev, prod)
    expect(isSemanticallyEqual(d)).toBe(false)
    expect(d.controlFlow.length).toBeGreaterThan(0)
    expect(d.constants.length).toBeGreaterThan(0)
    expect(d.semanticsPreservingTransform).toEqual([])
  })

  it('DECLARED, it is classified instead — and the fail-able buckets go empty', () => {
    const d = semanticDiff(dev, prod, { transforms: PROD_PLUGINS })
    expect(d.controlFlow).toEqual([])
    expect(d.constants).toEqual([])
    expect(d.interface).toEqual([])
    expect(d.resources).toEqual([])
    expect(isSemanticallyEqual(d)).toBe(true)
  })

  it('…with the provenance a review needs: which plugin, which bucket, which facts', () => {
    const d = semanticDiff(dev, prod, { transforms: PROD_PLUGINS })
    // Attribution is PER PLUGIN, not per chain. `mangle` is credited with nothing because
    // 'names' already canonicalizes exactly what it rewrites, and `minify` has no
    // transformIR at all — a report that blamed "the chain" would name all three.
    expect([...new Set(d.semanticsPreservingTransform.map((f) => f.transform))]).toEqual(['inline'])
    expect(d.semanticsPreservingTransform.map((f) => f.bucket).sort()).toEqual([
      'constants',
      'controlFlow',
    ])
    for (const f of d.semanticsPreservingTransform) expect(f.facts.length).toBeGreaterThan(0)
    // The facts are the ORIGINAL diff lines, so a reviewer reads exactly the text the
    // fail-able bucket would have carried.
    const raw = semanticDiff(dev, prod)
    expect(d.semanticsPreservingTransform.flatMap((f) => f.facts).sort()).toEqual(
      [...raw.constants, ...raw.controlFlow].sort(),
    )
  })

  it('declaring a transform that moves no IR leaves the mismatch fail-able', () => {
    // minify() is text-stage only, so it accounts for nothing. Cutting exactly this wire
    // is what distinguishes "the declared pass reproduced the difference" from "the
    // buckets are emptied whenever `transforms` is non-empty".
    const d = semanticDiff(dev, prod, { transforms: [minify()] })
    expect(isSemanticallyEqual(d)).toBe(false)
    expect(d.controlFlow.length).toBeGreaterThan(0)
    expect(d.semanticsPreservingTransform).toEqual([])
  })

  it('a REAL control-flow regression is NOT laundered by declaring inline()', () => {
    // `shadeShape` swaps mul/add, so inlining BOTH sides still leaves them different —
    // the declared transform does not reproduce this difference, so it stays fail-able.
    const d = semanticDiff(dev, inlineLinearAll(build(shadeShape)), { transforms: PROD_PLUGINS })
    expect(isSemanticallyEqual(d)).toBe(false)
    expect(d.controlFlow.length).toBeGreaterThan(0)
  })

  it('a constant regression stays in `constants`, with control flow still clean', () => {
    const d = semanticDiff(dev, inlineLinearAll(build(shadeLit)), { transforms: PROD_PLUGINS })
    expect(d.constants.join('\n')).toContain('lit f32=0.25')
    expect(d.controlFlow).toEqual([])
    expect(isSemanticallyEqual(d)).toBe(false)
  })

  it('an interface regression stays in `interface`', () => {
    const d = semanticDiff(dev, inlineLinearAll(build(shadeBase, { fsName: 'fs_alt' })), {
      transforms: PROD_PLUGINS,
    })
    expect(d.interface.join('\n')).toContain('fs_alt')
    expect(isSemanticallyEqual(d)).toBe(false)
  })

  it('a resource regression stays in `resources`', () => {
    const d = semanticDiff(dev, inlineLinearAll(build(shadeBase, { extraBinding: true })), {
      transforms: PROD_PLUGINS,
    })
    expect(d.resources.join('\n')).toContain('bind 0:1 extra')
    expect(isSemanticallyEqual(d)).toBe(false)
  })

  it('a LIFTED TEMPORARY classifies too — not just expression substitution', () => {
    const linearProd = inlineLinearAll(linearDev)
    const entryStmts = (m: ModuleDecl): number =>
      m.funcs.find((f) => f.name === 'sdLinearFs')!.body.length
    // Non-vacuity AND the mechanism: the helper is gone and its statements now sit in the
    // caller's block bound to temps. That statement-count growth IS the temporary-variable
    // rewrite the report names, and it is invisible to `ignore: ['names']`.
    expect(linearProd.funcs.length).toBeLessThan(linearDev.funcs.length)
    expect(entryStmts(linearProd)).toBeGreaterThan(entryStmts(linearDev))
    expect(semanticDiff(linearDev, linearProd).controlFlow.length).toBeGreaterThan(0)

    const d = semanticDiff(linearDev, linearProd, { transforms: PROD_PLUGINS })
    expect(isSemanticallyEqual(d)).toBe(true)
    expect(
      d.semanticsPreservingTransform.some(
        (f) => f.transform === 'inline' && f.bucket === 'controlFlow',
      ),
    ).toBe(true)
  })
})
