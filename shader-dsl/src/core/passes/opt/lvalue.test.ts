import { describe, it, expect } from 'vitest'
import { cse, licm } from './index'
import { module, fn, f32, f32T, i32, bindingRef, structT, type ModuleDecl } from '../../ir'
import { emitModule } from '../../backends/wgsl'

// Regression (architect-found): CSE/LICM must NOT hoist a read of a WRITTEN binding.
// A read_write storage member read 2x AND stored is NOT invariant; hoisting it
// rewrites the store target into the immutable temp -> invalid WGSL (let-mutation)
// + a dropped store. The oracle (f64, single-fn, let-mutation-permissive) cannot
// catch this, so the assertion is on emitted-WGSL structure: no temp is introduced
// for a written binding.
const buf = bindingRef('buf', structT('Buf'))

const cseWitness = (): ModuleDecl => module({
  structs: [{ name: 'Buf', fields: [{ name: 'v', type: f32T }] }],
  bindings: [{ group: 0, binding: 0, name: 'buf', space: 'storage' as const, access: 'read_write' as const, type: structT('Buf') }],
  funcs: [fn('k', {}, f32T, (b) => {
    const a = b.let('a', buf.field('v', f32T).add(buf.field('v', f32T))) // buf.v read 2x
    b.assign(buf.field('v', f32T), f32(7)) // store to buf.v
    b.ret(a)
  })],
})

const licmWitness = (): ModuleDecl => module({
  structs: [{ name: 'Buf', fields: [{ name: 'v', type: f32T }] }],
  bindings: [{ group: 0, binding: 0, name: 'buf', space: 'storage' as const, access: 'read_write' as const, type: structT('Buf') }],
  funcs: [fn('k', {}, f32T, (b) => {
    const acc = b.var('acc', f32T, f32(0))
    b.forRange('i', i32(0), (i) => i.lt(i32(4)), (cb) => {
      cb.addAssign(acc, buf.field('v', f32T)) // read buf.v in the loop
      cb.assign(buf.field('v', f32T), buf.field('v', f32T).add(1)) // ...and mutate it
    })
    b.ret(acc)
  })],
})

describe('optimizer — written bindings are not invariant (lvalue regression)', () => {
  it('CSE does not hoist a read of a written read_write binding', () => {
    expect(emitModule(cse(cseWitness()))).not.toContain('_cse')
  })

  it('LICM does not hoist a binding read that is mutated inside the loop', () => {
    expect(emitModule(licm(licmWitness()))).not.toContain('_licm')
  })
})
