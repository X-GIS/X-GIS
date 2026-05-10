import { describe, it, expect } from 'vitest'
import { toU32Id, fnv1a32 } from './id-resolver'

describe('toU32Id', () => {
  it('passes through small non-negative integers unchanged', () => {
    expect(toU32Id(0)).toBe(0)
    expect(toU32Id(1)).toBe(1)
    expect(toU32Id(42)).toBe(42)
    expect(toU32Id(0x7fffffff)).toBe(0x7fffffff)
  })

  it('hashes negative numbers via their string form', () => {
    const h = toU32Id(-1)
    expect(h).toBe(fnv1a32('-1'))
    expect(h).toBeGreaterThan(0)
  })

  it('hashes non-integer numbers via their string form', () => {
    expect(toU32Id(3.14)).toBe(fnv1a32('3.14'))
  })

  it('hashes integers >= 2^31 into u32 space', () => {
    const big = 0x80000000
    const h = toU32Id(big)
    expect(h).toBe(fnv1a32(String(big)))
    expect(h).toBeLessThan(0x100000000)
  })

  it('hashes strings deterministically', () => {
    const a = toU32Id('F-16-01')
    const b = toU32Id('F-16-01')
    expect(a).toBe(b)
    expect(a).not.toBe(toU32Id('F-16-02'))
  })

  it('handles common C2 id patterns without collision', () => {
    const ids = [
      'F-16-01', 'F-16-02', 'F-35-01',
      'AWACS-1', 'AWACS-2',
      '550e8400-e29b-41d4-a716-446655440000', // UUID
      'track#1', 'track#2', 'track#1000',
    ]
    const hashes = ids.map(toU32Id)
    expect(new Set(hashes).size).toBe(ids.length)
  })

  it('null and undefined coerce to 0', () => {
    expect(toU32Id(null)).toBe(0)
    expect(toU32Id(undefined)).toBe(0)
  })

  it('FNV-1a matches a well-known vector', () => {
    // FNV-1a('') = 0x811c9dc5
    expect(fnv1a32('')).toBe(0x811c9dc5)
    // FNV-1a('a') = 0xe40c292c
    expect(fnv1a32('a')).toBe(0xe40c292c)
  })
})
