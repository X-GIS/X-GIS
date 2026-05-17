// Pin v8 strict `["literal", N]` per-channel unwrap in
// `["rgb", r, g, b]` / `["rgba", r, g, b, a]` colour tuples.
// Pre-fix any wrapped channel value (`["literal", 255]`) stringified
// to "[object]" inside the CSS-function template — resolveColor
// failed and the colour fell to the data-driven bracket path or
// null.

import { describe, it, expect } from 'vitest'
import { colorToXgis } from '../convert/colors'
import { exprToXgis } from '../convert/expressions'

describe('rgb/rgba per-channel literal-wrap unwrap', () => {
  it('bare ["rgb", 255, 0, 0] resolves to #ff0000', () => {
    const w: string[] = []
    expect(colorToXgis(['rgb', 255, 0, 0], w)).toBe('#ff0000')
  })

  it('wrapped ["rgb", ["literal", 255], ["literal", 0], ["literal", 0]] also resolves', () => {
    const w: string[] = []
    expect(colorToXgis(
      ['rgb', ['literal', 255], ['literal', 0], ['literal', 0]],
      w,
    )).toBe('#ff0000')
  })

  it('mixed bare + wrapped channels resolve', () => {
    const w: string[] = []
    expect(colorToXgis(
      ['rgb', 255, ['literal', 128], 0],
      w,
    )).toBe('#ff8000')
  })

  it('bare ["rgba", 255, 0, 0, 0.5] resolves', () => {
    const w: string[] = []
    const out = colorToXgis(['rgba', 255, 0, 0, 0.5], w)
    expect(out).toMatch(/^#ff0000[78]0$/i)  // alpha 0.5 → 0x80 or 0x7f depending on rounding
  })

  it('exprToXgis path: nested ["rgb", ["literal", 255], …] inside case also hex-encodes', () => {
    // Mirror of the colorToXgis unwrap, applied at exprToXgis case
    // 'rgb' / 'rgba' for expressions that don't reach the color-only
    // path (e.g. an `["rgb", ...]` constant deep inside a
    // `["case", cond, ["rgb", ...], default]`).
    const w: string[] = []
    const out = exprToXgis(['rgb', ['literal', 0], ['literal', 255], ['literal', 0]], w)
    expect(out).toBe('#00ff00')
  })

  it('fully wrapped ["rgba", ["literal", 255], …, ["literal", 0.5]] also resolves', () => {
    const w: string[] = []
    const out = colorToXgis(
      ['rgba', ['literal', 255], ['literal', 0], ['literal', 0], ['literal', 0.5]],
      w,
    )
    expect(out).toMatch(/^#ff0000[78]0$/i)
  })
})
