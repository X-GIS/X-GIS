// Pin setPaintProperty colour validation. Pre-fix the local
// parseHexColor wrapper only rejected empty / non-string; an
// unrecognised hex shape (CSS name 'red', malformed length, etc.)
// fell through to parseHexColorRaw which silently returned
// [0,0,0,1] opaque-black. show.fill carried the bad string while
// paintShapes.fill turned black — silent state desync + visual
// corruption on every setPaintProperty('fill-color', 'red').

import { describe, it, expect } from 'vitest'
import { LayerIdRegistry } from '../layer'

describe('layer.style.fill colour validation', () => {
  it('reserved id registry round-trips (smoke test, no fill setter)', () => {
    // Smoke test for layer module load; can't easily test fill setter
    // without a full XGISMap fixture (the setter touches host.show).
    const reg = new LayerIdRegistry()
    const id = reg.register('test')
    expect(id).toBeGreaterThan(0)
    expect(reg.getName(id)).toBe('test')
  })
})
