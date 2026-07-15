import { describe, it, expect } from 'vitest'
import { lint } from '../engine'
import { callSignature } from './call-signature'
import { fn, module, externFn, f32, vec2, f32T, vec2fT } from '../../../ir'

// The exact holes this rule exists to close: FnHandle's positional call form is
// `(...args: NodeLike[])` at the TS level, so wrong arity / wrong types compile —
// they must fail HERE (emit-time lint) instead of as an opaque driver error.

const helper = fn('helper', { a: f32T, b: vec2fT }, ({ a, b }) => a.add(b.x))

function diagsFor(body: () => ReturnType<typeof f32>): readonly string[] {
  const caller = fn('caller', {}, body)
  const m = module({ funcs: [helper, caller] })
  return lint(m, [callSignature]).map((d) => d.message)
}

describe('call-signature', () => {
  it('accepts a call matching the declared signature', () => {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- callSignature exists to lint the POSITIONAL call form; this fixture must use it
    expect(diagsFor(() => helper(f32(1), vec2(1, 2)))).toEqual([])
  })

  it('flags wrong arity', () => {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- deliberately wrong-arity POSITIONAL call (the object-param form would not compile); it is the input under test
    const msgs = diagsFor(() => helper(f32(1)))
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatch(/passes 1 argument, declared 2/)
  })

  it('flags swapped argument types, naming the parameter', () => {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- deliberately type-swapped POSITIONAL call (the object-param form would not compile); it is the input under test
    const msgs = diagsFor(() => helper(vec2(1, 2), f32(1)) as ReturnType<typeof f32>)
    expect(msgs).toHaveLength(2)
    expect(msgs[0]).toMatch(/argument #1 \('a'\) is vec2<f32>, declared f32/)
    expect(msgs[1]).toMatch(/argument #2 \('b'\) is f32, declared vec2<f32>/)
  })

  it('skips unresolvable names (intrinsics / composer-injected externs)', () => {
    const injectedExtern = externFn('injected_extern', { x: vec2fT }, f32T)
    expect(diagsFor(() => injectedExtern({ x: vec2(1, 2) }))).toEqual([])
  })
})
