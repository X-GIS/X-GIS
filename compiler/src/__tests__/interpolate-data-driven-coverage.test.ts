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

  it('zoom input also routes through this generic path', () => {
    // The dedicated paint.ts path handles zoom for pre-bucketing
    // BUT this generic exprToXgis route also succeeds for direct
    // calls — important because `["interpolate", ["linear"], ["zoom"],
    // …]` can appear nested inside a `case`/`match`/`coalesce` arm
    // that paint.ts doesn't recursively descend into.
    const w: string[] = []
    const out = exprToXgis(
      ['interpolate', ['linear'], ['zoom'],
        10, 1, 16, 8],
      w,
    )
    expect(out).toBe('interpolate(zoom, 10, 1, 16, 8)')
    expect(w).toEqual([])
  })
})
