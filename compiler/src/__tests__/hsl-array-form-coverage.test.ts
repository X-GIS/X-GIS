// Pin `["hsl", h, s, l]` / `["hsla", h, s, l, a]` array-form colour
// tuples. Mapbox spec accepts them but the converter only handled
// rgb/rgba arrays before — hsl tuples fell to "Color expression
// not converted" → null and the layer dropped its declared colour.

import { describe, it, expect } from 'vitest'
import { colorToXgis } from '../convert/colors'

describe('hsl / hsla array-form colour tuples', () => {
  it('["hsl", 0, 100, 50] resolves to red', () => {
    const w: string[] = []
    expect(colorToXgis(['hsl', 0, 100, 50], w)).toBe('#ff0000')
  })

  it('["hsl", 120, 100, 50] resolves to pure green', () => {
    const w: string[] = []
    expect(colorToXgis(['hsl', 120, 100, 50], w)).toBe('#00ff00')
  })

  it('["hsla", 0, 100, 50, 0.5] resolves to red with mid alpha', () => {
    const w: string[] = []
    const out = colorToXgis(['hsla', 0, 100, 50, 0.5], w)
    expect(out).toMatch(/^#ff0000[78]0$/i)
  })

  it('v8 wrapped channels in hsl still resolve', () => {
    // Mirror of the rgb per-channel unwrap.
    const w: string[] = []
    expect(colorToXgis(
      ['hsl', ['literal', 0], ['literal', 100], ['literal', 50]],
      w,
    )).toBe('#ff0000')
  })

  it('v8 wrapped channels in hsla still resolve', () => {
    const w: string[] = []
    const out = colorToXgis(
      ['hsla', ['literal', 0], ['literal', 100], ['literal', 50], ['literal', 1]],
      w,
    )
    expect(out).toBe('#ff0000')
  })
})
