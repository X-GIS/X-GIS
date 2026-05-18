// Pin contract: synthesizeConstantPaintShapes (in interpreter.ts)
// must produce `fill: null` for invalid hex input, not opaque black.
// Pre-fix the compiler's always-returns-tuple hexToRgba returned
// [0,0,0,1] for invalid hex, silently rendering "red" or "#zz" as
// opaque black. Switching to runtime hexToRgba (nullable variant)
// surfaces invalid hex as no-fill (null).
//
// We can't import synthesizeConstantPaintShapes directly (it's not
// exported); pin the BEHAVIOR through the runtime hexToRgba directly.

import { describe, it, expect } from 'vitest'
import { hexToRgba } from './feature-helpers'

describe('interpreter hex-null behaviour (via runtime hexToRgba)', () => {
  it('invalid hex string returns null (not [0,0,0,1])', () => {
    expect(hexToRgba('red')).toBeNull()
    expect(hexToRgba('#zz')).toBeNull()
    expect(hexToRgba('not-a-color')).toBeNull()
  })

  it('null/undefined returns null', () => {
    expect(hexToRgba(null)).toBeNull()
    expect(hexToRgba(undefined)).toBeNull()
  })

  it('valid hex returns RGBA tuple', () => {
    expect(hexToRgba('#abc')).not.toBeNull()
    expect(hexToRgba('#abcdef')).not.toBeNull()
    expect(hexToRgba('#abcdef80')).not.toBeNull()
  })
})
