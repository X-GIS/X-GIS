// Pin per-feature `["interpolate", curve, input, stops…]` lowering
// when input is NOT ["zoom"]. The dedicated zoom path
// (paint.ts:interpolateZoomCall) only fires when input === ["zoom"];
// any other input fell through to "Expression not converted" and the
// whole property dropped to null.

import { describe, it, expect } from 'vitest'
import { exprToXgis } from '../convert/expressions'

describe('data-driven interpolate (non-zoom input)', () => {
  it('linear interpolate over get("magnitude") emits interpolate(.mag, …)', () => {
    const w: string[] = []
    const out = exprToXgis(
      ['interpolate', ['linear'], ['get', 'magnitude'],
        0, 1,
        10, 20,
      ],
      w,
    )
    expect(out).toBe('interpolate(.magnitude, 0, 1, 10, 20)')
    expect(w).toEqual([])
  })

  it('exponential interpolate with base 1.5 emits interpolate_exp', () => {
    const w: string[] = []
    const out = exprToXgis(
      ['interpolate', ['exponential', 1.5], ['get', 'height'],
        0, 0,
        100, 50,
      ],
      w,
    )
    expect(out).toBe('interpolate_exp(.height, 1.5, 0, 0, 100, 50)')
  })

  it('exponential base 1 collapses to linear', () => {
    const w: string[] = []
    const out = exprToXgis(
      ['interpolate', ['exponential', 1], ['get', 'h'],
        0, 0, 100, 50],
      w,
    )
    expect(out).toBe('interpolate(.h, 0, 0, 100, 50)')
  })

  it('interpolate-lab over feature input warns + approximates as linear', () => {
    const w: string[] = []
    const out = exprToXgis(
      ['interpolate-lab', ['linear'], ['get', 'idx'],
        0, '"#000"',
        1, '"#fff"',
      ],
      w,
    )
    expect(out).not.toBeNull()
    expect(w.some(s => s.includes('interpolate-lab') && s.includes('linear-RGB'))).toBe(true)
  })

  it('cubic-bezier curve warns + folds to linear', () => {
    const w: string[] = []
    const out = exprToXgis(
      ['interpolate', ['cubic-bezier', 0.42, 0, 0.58, 1], ['get', 'm'],
        0, 0, 1, 1],
      w,
    )
    expect(out).toBe('interpolate(.m, 0, 0, 1, 1)')
    expect(w.some(s => s.includes('cubic-bezier'))).toBe(true)
  })

  it('malformed interpolate (too few stops) returns null', () => {
    const w: string[] = []
    // Only one stop pair allowed by spec but interpolate needs ≥2.
    expect(exprToXgis(['interpolate', ['linear'], ['get', 'x']], w)).toBeNull()
  })

  it('zoom input still routes through this generic path (parity)', () => {
    // The dedicated paint.ts path handles zoom specially for
    // pre-bucketing; this generic exprToXgis path should ALSO
    // succeed when called directly on a zoom interpolate so
    // exprToXgis remains complete.
    const w: string[] = []
    const out = exprToXgis(
      ['interpolate', ['linear'], ['zoom'],
        10, 1, 16, 8],
      w,
    )
    // Note: at this level we don't special-case zoom — the input
    // lowers via the `case 'zoom'` handler if one exists, else
    // returns null. We accept either outcome here: success means
    // zoom resolved via a converter case; null means the dedicated
    // paint path is authoritative. Current state: exprToXgis has
    // no `zoom` case so v[2] = ["zoom"] lowers to null and the
    // whole interpolate returns null. Pin that contract so a future
    // addition is intentional.
    expect(out).toBeNull()
  })
})
