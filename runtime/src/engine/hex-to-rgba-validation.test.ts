// Pin hexToRgba's "did this parse?" contract. Pre-fix the function
// returned [0,0,0,1] for invalid hex (because parseHexColor's
// internal regex-gate fell to that default) — making the documented
// nullable contract a lie. Callers expecting hexToRgba(invalidHex)
// === null got the black tuple instead, silently rendering invalid
// colours as opaque black.

import { describe, it, expect } from 'vitest'
import { hexToRgba, parseHexColor } from './feature-helpers'

describe('hexToRgba validity contract', () => {
  it('returns null for null / undefined / empty input', () => {
    expect(hexToRgba(null)).toBeNull()
    expect(hexToRgba(undefined)).toBeNull()
    expect(hexToRgba('')).toBeNull()
  })

  it('returns null for malformed hex shape', () => {
    expect(hexToRgba('red')).toBeNull()
    expect(hexToRgba('#zz')).toBeNull()
    expect(hexToRgba('#12345')).toBeNull()    // 5-char (not 3/4/6/8)
    expect(hexToRgba('#abc def')).toBeNull()
    expect(hexToRgba('not-a-hex')).toBeNull()
  })

  it('returns tuple for valid hex shapes', () => {
    expect(hexToRgba('#abc')).toEqual([
      0xaa / 255, 0xbb / 255, 0xcc / 255, 1,
    ])
    expect(hexToRgba('#abcd')).not.toBeNull()
    expect(hexToRgba('#abcdef')).not.toBeNull()
    expect(hexToRgba('#abcdef80')).not.toBeNull()
  })

  it('parseHexColor always returns tuple (never-null contract)', () => {
    // parseHexColor is the always-returns-tuple variant. Verify the
    // legacy contract is still intact.
    expect(parseHexColor('red')).toEqual([0, 0, 0, 1])
    expect(parseHexColor('#abc')).not.toBeNull()
  })
})
