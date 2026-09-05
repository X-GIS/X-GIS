import { describe, it, expect } from 'vitest'
import {
  fn,
  module,
  arrayLit,
  construct,
  f32T,
  i32T,
  vec2fT,
  vec4fT,
  voidT,
  structT,
  arrayT,
  typeKey,
  type KeyOf,
  type Node,
} from './index.js'
import { structDecl, ioStruct, builtin, location } from '../sot.js'
import { emitModule } from '../backends/wgsl.js'

// ═══ #2456 — KeyOf's struct / array / void arms ═══
//
// `KeyOf` is documented as having to stay byte-identical to `typeKey`'s switch. It had no
// arm for `struct`, `array` or `void`, so all three fell to the `: string` fallback — and
// `Node<string>` is the ONE key neither assignable to nor from a specific key, i.e. the value
// is outside the checker rather than loosely inside it. Two unrelated IO structs interchanged
// silently.
//
// EVERY type assertion below uses `Exact`, never assignability. `'struct:VsOut'` IS assignable
// to `string`, so an assignability check would have passed against the very fallback it exists
// to reject (§12's vacuous-assertion lesson, paid for on #2408's first `-0` test).

type Exact<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

// The instrument check: `Exact` must SEPARATE the fallback from the precise key. Without
// these two lines a broken `Exact` (one that returns `true` for everything) would green the
// whole file.
const _exactRejectsFallback: Exact<string, 'struct:VsOut'> = false
const _exactAcceptsMatch: Exact<'struct:VsOut', 'struct:VsOut'> = true

const VsOut = ioStruct('VsOut', { pos: builtin('position', vec4fT), uv: location(0, vec2fT) })
const FsIn = ioStruct('FsIn', { uv: location(0, vec2fT) })
const Seg = structDecl('SegK', { k: f32T, v: vec2fT })

describe('#2456 — KeyOf agrees with typeKey on struct / array / void', () => {
  it('spells each key the way typeKey spells it, at the TYPE level and at runtime', () => {
    // Written twice on purpose: the `Exact` line pins the compile-time key, the `toBe` pins
    // the runtime one. An arm that drifts from typeKey fails one of the two, whichever way
    // it drifted.
    const st = structT('VsOut')
    const _st: Exact<KeyOf<typeof st>, 'struct:VsOut'> = true
    expect(typeKey(st)).toBe('struct:VsOut')

    const fixed = arrayT(f32T, 3)
    const _fixed: Exact<KeyOf<typeof fixed>, 'array<f32,3>'> = true
    expect(typeKey(fixed)).toBe('array<f32,3>')

    const runtimeSized = arrayT(i32T)
    const _runtimeSized: Exact<KeyOf<typeof runtimeSized>, 'array<i32>'> = true
    expect(typeKey(runtimeSized)).toBe('array<i32>')

    const nested = arrayT(structT('SegK'), 2)
    const _nested: Exact<KeyOf<typeof nested>, 'array<struct:SegK,2>'> = true
    expect(typeKey(nested)).toBe('array<struct:SegK,2>')

    const _void: Exact<KeyOf<typeof voidT>, 'void'> = true
    expect(typeKey(voidT)).toBe('void')

    expect([_st, _fixed, _runtimeSized, _nested, _void, _exactAcceptsMatch]).not.toContain(false)
    expect(_exactRejectsFallback).toBe(false)
  })

  it('carries the struct name through construct() and both declarators', () => {
    const raw = construct(structT('SegK'), [construct(f32T, [1]), construct(vec2fT, [0, 0])])
    const _raw: Exact<KeyOf<{ kind: 'struct'; name: 'SegK' }>, 'struct:SegK'> = true
    expect(raw.type).toEqual({ kind: 'struct', name: 'SegK' })

    const io = VsOut.construct({
      pos: construct(vec4fT, [0, 0, 0, 1]),
      uv: construct(vec2fT, [0, 0]),
    })
    const _io: Exact<typeof io, Node<'struct:VsOut'>> = true
    expect(typeKey(io.type)).toBe('struct:VsOut')

    const plain = Seg.construct({ k: construct(f32T, [1]), v: construct(vec2fT, [0, 0]) })
    const _plain: Exact<typeof plain, Node<'struct:SegK'>> = true
    expect(typeKey(plain.type)).toBe('struct:SegK')

    expect([_raw, _io, _plain]).not.toContain(false)
  })

  it('carries the element key AND the literal item count through arrayLit()', () => {
    const three = arrayLit(f32T, construct(f32T, [1]), construct(f32T, [2]), construct(f32T, [3]))
    const _three: Exact<typeof three, Node<'array<f32,3>'>> = true
    expect(typeKey(three.type)).toBe('array<f32,3>')
    expect(_three).toBe(true)
  })

  it('REJECTS handing one IO struct where the other is wanted (the bug this closes)', () => {
    const takesFsIn = fn('takes_fs_in', { i: FsIn }, ({ i }) => i.uv.x)
    const wrong = VsOut.construct({
      pos: construct(vec4fT, [0, 0, 0, 1]),
      uv: construct(vec2fT, [0, 0]),
    })
    // @ts-expect-error — #2456: a `struct:VsOut` value where `struct:FsIn` is wanted. This was
    // tsc-GREEN before the KeyOf arms, because both sides were `Node<string>`.
    takesFsIn({ i: wrong })
    // The RUNTIME gate is independent and was always there — asserted so the @ts-expect-error
    // above cannot be "satisfied" by the call simply being impossible to make.
    expect(() => takesFsIn({ i: FsIn.construct({ uv: construct(vec2fT, [0, 0]) }) })).not.toThrow()
  })

  it('infers a fn return key from a body that returns a struct field PROXY', () => {
    // `return o` (the #763 X14 duck-typed proxy return) used to collapse the handle to
    // `FnHandle<P, string>`; the keyed StructArg makes it infer the struct.
    const g = fn('proxy_ret', { u: vec2fT }, ({ u }) => {
      const o = VsOut.var('o')
      o.pos.assign(construct(vec4fT, [u.x, u.y, 0, 1]))
      o.uv.assign(u)
      return o
    })
    const called = g({ u: construct(vec2fT, [0, 0]) })
    const _called: Exact<typeof called, Node<'struct:VsOut'>> = true
    expect(_called).toBe(true)
    expect(typeKey(called.type)).toBe('struct:VsOut')
    expect(emitModule(module({ structs: [VsOut.decl], funcs: [g] }))).toContain(
      'fn proxy_ret(u: vec2<f32>) -> VsOut',
    )
  })

  it('moves no emitted bytes — the keys are phantom', () => {
    const f = fn('build_seg', { k: f32T }, ({ k }) =>
      Seg.construct({ k, v: construct(vec2fT, [k, k]) }),
    )
    const wgsl = emitModule(module({ structs: [Seg.decl], funcs: [f] }))
    expect(wgsl).toContain('fn build_seg(k: f32) -> SegK')
    expect(wgsl).toContain('SegK(k, vec2<f32>(k, k))')
  })
})
