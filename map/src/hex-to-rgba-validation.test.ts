// Pin hexToRgba's "did this parse?" contract. Pre-fix the function
// returned [0,0,0,1] for invalid hex (because the `parseHexColor` it
// delegated to fell to that default) — making the documented nullable
// contract a lie. Callers expecting hexToRgba(invalidHex) === null got
// the black tuple instead, silently rendering invalid colours as
// opaque black.
//
// #1666 finished it: `parseHexColor` is GONE and hexToRgba is the one
// colour-string parser in the package. The nullable answer is no longer
// one variant of two that a caller could pick the wrong half of — it is
// the only answer there is, which is what makes the last test below the
// load-bearing one.

import { describe, it, expect } from 'vitest'
import { hexToRgba } from '@xgis/map'
import * as mapApi from '@xgis/map'

describe('hexToRgba validity contract', () => {
  it('returns null for null / undefined / empty input', () => {
    expect(hexToRgba(null)).toBeNull()
    expect(hexToRgba(undefined)).toBeNull()
    expect(hexToRgba('')).toBeNull()
  })

  it('returns null for malformed hex shape', () => {
    expect(hexToRgba('red')).toBeNull()
    expect(hexToRgba('#zz')).toBeNull()
    expect(hexToRgba('#12345')).toBeNull() // 5-char (not 3/4/6/8)
    expect(hexToRgba('#abc def')).toBeNull()
    expect(hexToRgba('not-a-hex')).toBeNull()
  })

  it('returns tuple for valid hex shapes', () => {
    expect(hexToRgba('#abc')).toEqual([0xaa / 255, 0xbb / 255, 0xcc / 255, 1])
    expect(hexToRgba('#abcd')).not.toBeNull()
    expect(hexToRgba('#abcdef')).not.toBeNull()
    expect(hexToRgba('#abcdef80')).not.toBeNull()
  })

  it('no total variant survives — hexToRgba is the ONLY hex parser exported (#1666)', () => {
    // This replaces `parseHexColor always returns tuple (never-null contract)`, which
    // pinned exactly the behaviour #1666 removed: `parseHexColor('red')` → [0, 0, 0, 1].
    // That expectation is not "still correct but relocated" — it was the bug. Opaque
    // black is indistinguishable at the colour buffer from an authored black, so no
    // downstream gate could ever tell a typo'd colour from a deliberate one, and every
    // caller that wrote `parsed ? … : dflt` had a DEAD fallback (the five retained
    // packers). The pin that matters now is that the total variant cannot come back:
    // re-exporting one would silently re-arm every one of those call sites.
    expect(mapApi).not.toHaveProperty('parseHexColor')
    // …and the LAST surviving total parser (parseColor, renderer-helpers.ts) must
    // stay un-exported too — index.ts re-exports renderer-helpers selectively today,
    // and a future `export *` would put a total parser back on the public surface
    // while this title still claims hexToRgba is the only one (#1666 review F1).
    expect(mapApi).not.toHaveProperty('parseColor')
    expect(hexToRgba('red')).toBeNull()
    expect(hexToRgba('#abc')).not.toBeNull()
  })
})
