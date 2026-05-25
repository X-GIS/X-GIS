import { describe, it, expect } from 'vitest'
import { f32, vec2, vec3, param } from './ir'
import { ShapeDesc } from './sdf'

// AC4 — "a WGSL type/layout error surfaces as a TS compile error". The
// generic Node<K> phantom + the schema builder's keyed field access turn
// shape/key mismatches into `bun`/tsc errors. Each probe is a runtime no-op
// (or a documented throw); its VALUE is the @ts-expect-error directive, which
// FAILS typecheck if the compile-time guarantee ever regresses (an unused
// directive is itself an error). Validated by `tsc -p runtime/tsconfig.json`.
describe('AC4 type-safety: WGSL type errors are TS compile errors', () => {
  it('vector key mismatches are rejected at compile time', () => {
    const a = vec2(f32(1), f32(2))
    // valid: vec + scalar, and vec + same-shape vec, both type-check + run.
    expect(a.add(f32(3)).type.kind).toBe('vec')
    expect(a.add(vec2(f32(1), f32(2))).type.kind).toBe('vec')
    // @ts-expect-error vec2 + vec3 — different vector keys
    expect(() => a.add(vec3(f32(1), f32(2), f32(3)))).toThrow()
  })

  it('struct field access is checked against the declared schema', () => {
    const s = param('s', ShapeDesc.type)
    expect(ShapeDesc.get(s, 'bbox_min_x').type.kind).toBe('scalar') // declared field
    // @ts-expect-error 'nope' is not a ShapeDesc field
    ShapeDesc.get(s, 'nope')
  })

  it('.select is only valid on a bool node', () => {
    const cond = f32(1).lt(f32(2)) // Node<'bool'>
    expect(cond.select(f32(1), f32(0)).type.kind).toBe('scalar')
    // @ts-expect-error .select on a non-bool (f32) node
    expect(() => f32(1).select(f32(1), f32(0))).toThrow()
  })

  it('comparison/logical results carry the bool key', () => {
    const cond = f32(1).lt(2)
    expect(cond.and(f32(0).gt(1)).type).toEqual({ kind: 'scalar', scalar: 'bool' })
  })
})
