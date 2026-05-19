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

  it('interpolate-lab over feature input routes to runtime interpolate_lab (iter 164)', () => {
    // Stop values that can't be densified at compile time (here
    // they're quoted strings, not bare hex literals the densifier
    // accepts) now route to the runtime evaluator's interpolate_lab
    // case — pre-iter-164 the same input silently downgraded to
    // plain linear-sRGB, losing the Lab intent. Pins the new
    // routing.
    const w: string[] = []
    const out = exprToXgis(
      ['interpolate-lab', ['linear'], ['get', 'idx'],
        0, '"#000"',
        1, '"#fff"',
      ],
      w,
    )
    expect(out).not.toBeNull()
    expect(out!).toContain('interpolate_lab(')
    expect(w.some(s => s.includes('interpolate-lab') && /routed to runtime/.test(s))).toBe(true)
    // The old downgrade warning must NOT fire.
    expect(w.some(s => s.includes('linear-sRGB'))).toBe(false)
  })

  it('interpolate-lab over feature input with bare-hex stops densifies in Lab (iter 62)', () => {
    const w: string[] = []
    const out = exprToXgis(
      ['interpolate-lab', ['linear'], ['get', 'idx'],
        0, '#000000',
        1, '#ffffff',
      ],
      w,
    )
    expect(out).not.toBeNull()
    expect(out).toContain('#000000') // start endpoint preserved
    expect(out).toContain('#ffffff') // end endpoint preserved
    expect(w.some(s =>
      s.includes('interpolate-lab')
      && s.includes('dense piecewise-linear')
      && s.includes('Lab space'),
    )).toBe(true)
  })

  it('cubic-bezier curve over feature input with numeric stops densifies (iter 62)', () => {
    const w: string[] = []
    const out = exprToXgis(
      ['interpolate', ['cubic-bezier', 0.42, 0, 0.58, 1], ['get', 'm'],
        0, 0, 1, 1],
      w,
    )
    // Densified output preserves endpoints + extends the interpolate
    // call with intermediate (zoom, eased-y) pairs.
    expect(out).toMatch(/^interpolate\(\.m, 0, 0/) // starts at z=0, v=0
    expect(out).toMatch(/, 1, 1\)$/) // ends at z=1, v=1
    expect(w.some(s => s.includes('cubic-bezier') && s.includes('dense piecewise-linear'))).toBe(true)
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
