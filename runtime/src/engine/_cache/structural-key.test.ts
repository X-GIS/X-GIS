// iter-281 — structuralHash unit tests
import { describe, it, expect } from 'vitest'
import { structuralHash, structuralHashKey } from './structural-key'

describe('structuralHash', () => {
  it('same object literal → same hash', () => {
    const a = { x: 1, y: 2 }
    const b = { x: 1, y: 2 }
    expect(structuralHash(a)).toBe(structuralHash(b))
  })

  it('key order independent', () => {
    const a = { x: 1, y: 2 }
    const b = { y: 2, x: 1 }
    expect(structuralHash(a)).toBe(structuralHash(b))
  })

  it('different value → different hash', () => {
    expect(structuralHash({ x: 1 })).not.toBe(structuralHash({ x: 2 }))
  })

  it('different key → different hash', () => {
    expect(structuralHash({ a: 1 })).not.toBe(structuralHash({ b: 1 }))
  })

  it('added field changes hash', () => {
    const before = structuralHash({ tiles: [1, 2, 3], epoch: 5 })
    const after = structuralHash({ tiles: [1, 2, 3], epoch: 5, newDep: 'x' })
    expect(before).not.toBe(after)
  })

  it('array order significant', () => {
    expect(structuralHash({ a: [1, 2, 3] }))
      .not.toBe(structuralHash({ a: [3, 2, 1] }))
  })

  it('nested objects recursive', () => {
    const a = { x: { a: 1, b: 2 }, y: [1, 2] }
    const b = { x: { b: 2, a: 1 }, y: [1, 2] }
    expect(structuralHash(a)).toBe(structuralHash(b))
  })

  it('null / undefined hash the same as missing', () => {
    expect(structuralHash({ x: null })).toBe(structuralHash({ x: undefined }))
  })

  it('booleans differentiated', () => {
    expect(structuralHash({ x: true })).not.toBe(structuralHash({ x: false }))
  })

  it('string vs number distinguished', () => {
    expect(structuralHash({ x: '1' })).not.toBe(structuralHash({ x: 1 }))
  })

  it('structuralHashKey returns base36 string', () => {
    const k = structuralHashKey({ x: 42 })
    expect(typeof k).toBe('string')
    expect(/^[0-9a-z]+$/.test(k)).toBe(true)
  })

  it('large key set has no immediate collisions', () => {
    const seen = new Set<number>()
    let collisions = 0
    for (let i = 0; i < 10_000; i++) {
      const h = structuralHash({ tile: i, epoch: i * 7, world: i % 5 })
      if (seen.has(h)) collisions++
      seen.add(h)
    }
    // Birthday paradox at 32-bit, 10k samples: expected ~12 collisions.
    // Allow margin; sanity gate, not pinpoint.
    expect(collisions).toBeLessThan(50)
  })

  it('canonical cache-key shape — bundle example', () => {
    const a = {
      sliceLayer: 'fill',
      phase: 'opaque',
      tiles: [1, 2, 3],
      epochs: [10, 20, 30],
      worldOffsets: [-360, 0, 360],
      bindGroupEpoch: 5,
      pickOn: false,
      samples: 1,
      mainLabel: 'fill-pipeline',
      lineLabel: 'line-pipeline',
    } as const
    const b = { ...a, tiles: [1, 2, 4] }
    expect(structuralHash(a)).not.toBe(structuralHash(b))
    // Adding a new field changes the hash — the whole point of the
    // pattern.
    const c = { ...a, newDimension: 'experimental' }
    expect(structuralHash(a)).not.toBe(structuralHash(c))
  })

  // iter-300 — iterative walk pin. Prior recursive version blew the
  // stack at ~5 K depth.
  describe('iter-300 iterative walk — depth + cycle resilience', () => {
    it('5000-deep nested object handled without stack overflow', () => {
      let inner: Record<string, unknown> = { x: 1 }
      for (let i = 0; i < 5000; i++) inner = { next: inner }
      expect(() => structuralHash({ root: inner })).not.toThrow()
    })

    it('10000-element flat array handled', () => {
      const big = Array.from({ length: 10000 }, (_, i) => i)
      expect(() => structuralHash({ keys: big })).not.toThrow()
    })

    it('cyclic reference does not infinite-loop (WeakSet guard)', () => {
      const a: Record<string, unknown> = { kind: 'cyclic' }
      a.self = a
      expect(() => structuralHash(a)).not.toThrow()
    })

    it('two structurally-distinct deep objects produce distinct hashes', () => {
      let a: Record<string, unknown> = { x: 1 }
      let b: Record<string, unknown> = { x: 2 }
      for (let i = 0; i < 1000; i++) {
        a = { next: a }
        b = { next: b }
      }
      expect(structuralHash(a)).not.toBe(structuralHash(b))
    })
  })
})
