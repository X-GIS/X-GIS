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
//
// The #1806 block pins the OTHER half of that claim, for transforms that DO change
// what this comparator reports (inline): a declared pipeline drains exactly the
// differences it provably causes into `explained`, and the arm that matters is the
// regression one — the same declaration must NOT drain a difference the pipeline does
// not account for.

import { describe, it, expect } from 'vitest'
import { fn, module, sin, vec2, vec4, f32T, vec2fT, vec4fT } from './ir/index.js'
import { builtin, ioStruct, location, uniformStruct } from './sot.js'
import { mangleModule } from './passes/mangle.js'
import { inlineLinearAll } from './passes/inline-linear.js'
import { inline, mangle, minify } from '../emit-prod.js'
import { isSemanticallyEqual, semanticDiff } from './semantic-diff.js'
import type { ModuleDecl } from './ir/index.js'

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

describe('semanticDiff — declared transforms (#1806)', () => {
  const inlined = inlineLinearAll(base)

  it('inline() actually rewrites this module (the arms below are not vacuous)', () => {
    expect(inlined).not.toBe(base)
    const raw = semanticDiff(base, inlined)
    expect(isSemanticallyEqual(raw)).toBe(false)
    expect(raw.controlFlow.length).toBeGreaterThan(0)
  })

  it('without `transforms` the result shape is unchanged — no `explained` key', () => {
    expect('explained' in semanticDiff(base, inlined)).toBe(false)
  })

  it('declaring inline() explains the whole dev↔prod diff, with provenance', () => {
    const d = semanticDiff(base, inlined, { transforms: [inline()] })
    expect(isSemanticallyEqual(d)).toBe(true)
    expect(d.explained.length).toBeGreaterThan(0)
    for (const e of d.explained) expect(e.transform).toBe('inline')
    // Provenance names the bucket each line left. inline rewrites code, never ABI —
    // an interface/resources entry here would mean the declared pipeline touched
    // something a semantics-preserving transform must not.
    const buckets = new Set(d.explained.map((e) => e.bucket))
    expect(buckets.has('controlFlow')).toBe(true)
    expect(buckets.has('interface')).toBe(false)
    expect(buckets.has('resources')).toBe(false)
  })

  it('a real regression survives a declared transform — classification cannot swallow it', () => {
    // b went through the SAME declared pipeline but also changed a literal
    // (0.5 → 0.25): the inline-shaped half of the diff must drain into `explained`
    // while the regression stays in its bucket, still fail-able.
    const regressed = inlineLinearAll(build(shadeLit))
    const d = semanticDiff(base, regressed, { transforms: [inline()] })
    expect(isSemanticallyEqual(d)).toBe(false)
    expect(d.constants.join('\n')).toContain('lit f32=0.5')
    expect(d.constants.join('\n')).toContain('lit f32=0.25')
    expect(d.controlFlow).toEqual([])
    expect(d.explained.some((e) => e.bucket === 'controlFlow')).toBe(true)
  })

  it('a CONTROL-FLOW regression survives too — the other fail-able axis, cut separately', () => {
    // §12: one cut only ever proves one message, so the constants-axis arm above
    // gets a controlFlow twin. b went through the same declared inline() but also
    // swapped mul/add — same literal multiset, different shape. The regression must
    // land in `controlFlow` alone (a shape change that merely RESEMBLES an inline
    // rewrite is not excused), while the helper-removal half still drains.
    const regressed = inlineLinearAll(build(shadeShape))
    const d = semanticDiff(base, regressed, { transforms: [inline()] })
    expect(isSemanticallyEqual(d)).toBe(false)
    expect(d.controlFlow.length).toBeGreaterThan(0)
    expect(d.constants).toEqual([])
    expect(d.interface).toEqual([])
    expect(d.resources).toEqual([])
    expect(d.explained.some((e) => e.bucket === 'controlFlow')).toBe(true)
  })

  it('the temp-var LIFTING path is fully explained — not just expression substitution', () => {
    // `shade` is single-return, so the arms above exercise inlineFn's expression
    // substitution. A linear multi-statement helper (let-prelude + trailing return)
    // takes inline-linear's statement-LIFTING path — fresh `let`s spliced into the
    // caller — which is exactly the "temporary-variable rewrite" #1806 names.
    const noise = fn('noiseish', { x: f32T }, f32T, ({ x }, b) => {
      const a = b.let('a', sin(x))
      const t = b.let('t', a.mul(0.5))
      b.ret(t.add(a))
    })
    const vs = fn(
      'vs_main',
      {},
      () => VsOut.construct({ pos: vec4(0.0, 0.0, 0.0, 1.0), uv: vec2(noise({ x: 1.0 }), 0.0) }),
      { stage: 'vertex' },
    )
    const fs = fn(
      'fs_main',
      { vo: VsOut },
      (p) => {
        const s = noise({ x: p.vo.uv.x })
        return vec4(s, s, s, 1.0)
      },
      { stage: 'fragment', retAttr: '@location(0)' },
    )
    const m = module({ funcs: [vs, fs], uses: [VsOut] })
    const prod = inlineLinearAll(m)
    // Non-vacuity: the LIFT actually fired (spliced `_inl…` lets in an entry body),
    // not the single-return fallback — without this the arm greens on the wrong path.
    const lifted = prod.funcs.some((f) =>
      f.body.some((s) => s.s === 'let' && s.name.startsWith('_inl')),
    )
    expect(lifted).toBe(true)
    const d = semanticDiff(m, prod, { transforms: [inline()] })
    expect(isSemanticallyEqual(d)).toBe(true)
    expect(d.explained.some((e) => e.transform === 'inline' && e.bucket === 'controlFlow')).toBe(
      true,
    )
  })

  it('a multi-plugin pipeline attributes to the transform that explains, not the last one', () => {
    // b = mangle(inline(base)) — the standard prod ordering. Under the default
    // `ignore: ['names']` the canon already cancels mangle's renames, so every
    // explained line must attribute to inline; mangle explains nothing extra.
    const prod = mangleModule(inlined).module
    const d = semanticDiff(base, prod, { transforms: [inline(), mangle()] })
    expect(isSemanticallyEqual(d)).toBe(true)
    expect(d.explained.length).toBeGreaterThan(0)
    for (const e of d.explained) expect(e.transform).toBe('inline')
  })

  it('a text-stage plugin explains nothing — this comparator never sees text', () => {
    const d = semanticDiff(base, build(shadeLit), { transforms: [minify()] })
    expect(d.explained).toEqual([])
    const { explained: _, ...residue } = d
    expect(residue).toEqual(semanticDiff(base, build(shadeLit)))
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
