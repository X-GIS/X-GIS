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
import { fn, module, sin, vec2, vec4, f32T, vec2fT, vec4fT } from './ir'
import { builtin, ioStruct, location, uniformStruct } from './sot'
import { mangleModule } from './passes/mangle'
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

describe('semanticDiff — declOrder', () => {
  it('argument order within an expression is a real difference, not a reordering', () => {
    // Guards against `declOrder` being read as "sort everything, everywhere": swapping
    // operands changes the program, and the sort must not cancel it out.
    const swapped = fn('shade', { x: f32T }, (p) => sin(p.x).mul(0.5).add(0.5))
    const d = semanticDiff(build(swapped), build(shadeShape))
    expect(isSemanticallyEqual(d)).toBe(false)
  })
})
