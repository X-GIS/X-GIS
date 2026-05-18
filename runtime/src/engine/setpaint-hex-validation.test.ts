// Pin setPaintProperty contract: invalid hex string returns false
// instead of silently succeeding while the underlying setter
// no-ops. Pre-fix setPaintProperty(layerId, "fill-color", "red")
// returned true (= caller thinks the colour changed) but the
// layer.style.fill setter silently rejected and the layer kept
// its previous colour.
//
// We exercise the gate contract via the runtime hexToRgba (which
// is what setPaintProperty now calls); the map-level integration
// covers it but requires a GPU mock to test directly.

import { describe, it, expect } from 'vitest'
import { hexToRgba } from './feature-helpers'

describe('setPaintProperty hex validation contract', () => {
  it('hexToRgba("red") returns null (so setPaintProperty rejects)', () => {
    expect(hexToRgba('red')).toBeNull()
  })

  it('hexToRgba("#zzz") returns null (so setPaintProperty rejects)', () => {
    expect(hexToRgba('#zzz')).toBeNull()
  })

  it('hexToRgba("#abc") returns tuple (so setPaintProperty accepts)', () => {
    expect(hexToRgba('#abc')).not.toBeNull()
  })

  it('hexToRgba(null) returns null (caller passes null = "clear colour")', () => {
    // setPaintProperty allows null to clear; the hexToRgba(value) ===
    // null check is GUARDED by `typeof value === 'string'` to let
    // the explicit-null clear path through.
    expect(hexToRgba(null)).toBeNull()
  })
})
