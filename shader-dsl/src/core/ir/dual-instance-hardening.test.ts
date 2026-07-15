import { describe, it, expect } from 'vitest'
import { fn, module, f32, f32T, NODE_BRAND, isNodeValue, type ReadonlyNode } from './index'
import { emitModule } from '../backends/wgsl'

// ═══ #763 Phase D — dual-instance hardening ═══
//
// A bundler can load TWO copies of this package (the R1 dup-func incident).
// `instanceof Node` splits per copy; the ambient scope stack used to split
// per copy; a record-form rename mutates a SHARED decl. These pin the
// cross-instance behaviors WITHOUT actually double-loading the package: a
// "foreign copy's node" is simulated as a brand-carrying non-Node object —
// exactly what copy B's instances look like to copy A.

/** A node as another package copy would present it: right shape, right brand,
 *  WRONG prototype (not our Node class). */
const foreignNode = (n: ReadonlyNode): ReadonlyNode => {
  const alien = Object.create(null) as Record<string | symbol, unknown>
  alien.expr = n.expr
  alien.type = n.type
  alien[NODE_BRAND] = true
  return alien as unknown as ReadonlyNode
}

describe('#763 D — dual-instance hardening', () => {
  it('D1: isNodeValue accepts a cross-instance node; instanceof would not', () => {
    const probe = fn('d1_probe', { x: f32T }, ({ x }) => x.mul(2))
    const local = f32(3)
    const alien = foreignNode(local)
    expect(isNodeValue(alien)).toBe(true)
    expect(alien instanceof Object.getPrototypeOf(local).constructor).toBe(false)
    // The call factory's single-arg dispatch: a foreign node must be treated as
    // a POSITIONAL value — the pre-D1 instanceof check misparsed it as a
    // named-args bag ("undefined is not an object" / silent mis-swizzle class).
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- the test verifies the POSITIONAL single-arg dispatch of a foreign-brand node; it must use the positional call form
    const call = probe(alien)
    expect(call.expr.op).toBe('call')
    const emitted = emitModule(
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- the test verifies the POSITIONAL single-arg dispatch of a foreign-brand node; it must use the positional call form
      module({ funcs: { d1: fn('d1', {}, () => probe(foreignNode(f32(1)))) } }),
    )
    expect(emitted).toContain('d1_probe(1')
  })

  it('D4: renaming a decl already assembled under another key throws; same-key reuse is fine', () => {
    const shared = fn('d4_shared', { x: f32T }, ({ x }) => x.add(1))
    // First assembly under its own name — pins ASSEMBLED_AS.
    emitModule(module({ funcs: [shared] }))
    // Same-name record assembly: harmless, allowed.
    expect(() => module({ funcs: { d4_shared: shared } })).not.toThrow()
    // A DIFFERENT key would mutate the shared decl and corrupt the first
    // module's re-emit — fail loud at assembly time.
    expect(() => module({ funcs: { d4_other: shared } })).toThrow(
      /already assembled as 'd4_shared'/,
    )
  })
})
