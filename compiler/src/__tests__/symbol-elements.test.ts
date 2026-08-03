// ═══ Every `symbol` element the grammar documents produces geometry (#1550) ═══
//
// The grammar has listed four symbol elements since Major 1 (`docs/spec/xgis-language.md` §2.8) and
// the parser has built AST nodes for all four; only `path` reached the renderer. The other three
// were dropped in lowering with no diagnostic anywhere.
//
// THAT SILENCE IS THE BUG, more than the missing feature. A symbol with no `path` registered NO
// shape, and the reference then fell through `ShapeRegistry.getShapeId`'s `?? 0` to shape id 0 —
// the built-in CIRCLE. So `symbol dot { circle r: 5 }`, which the grammar explicitly permits, drew
// a plain circle and every layer reported success. The author cannot tell a working round symbol
// from a silently substituted one, which is the failure mode this repo keeps paying for.
//
// The spec's OWN EXAMPLE was affected: `symbol arrow { path "…" anchor: center }`.

import { describe, it, expect } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { rectPath, circlePath, SYMBOL_ANCHORS } from '../ir/symbol-elements'

const sceneOf = (src: string) => lower(new Parser(new Lexer(`xgis 1\n${src}`).tokenize()).parse())
const symbolOf = (src: string) => sceneOf(src).symbols[0]
const codes = (src: string): string[] => (sceneOf(src).diagnostics ?? []).map((d) => d.code)

describe('`rect` and `circle` reach the renderer as geometry (#1550)', () => {
  it('a rect-only symbol registers a closed 4-corner path — it used to register NOTHING', () => {
    const s = symbolOf('symbol box { rect w: 2 h: 1 }')
    expect(s, 'the symbol exists at all').toBeDefined()
    expect(s!.name).toBe('box')
    expect(s!.paths).toHaveLength(1)
    // Centred on its own origin by default, so it behaves like every hand-written path symbol.
    expect(s!.paths[0]).toBe('M -1 -0.5 L 1 -0.5 L 1 0.5 L -1 0.5 Z')
  })

  it('a circle-only symbol registers FOUR CUBICS, not a polygon approximation', () => {
    // The SDF pipeline keeps beziers as true curves (`sdf-shape.ts` segment `kind: 2 = cubic`)
    // rather than flattening them, so a circle expressed as cubics is round at every zoom. A
    // flattened polygon would be round at whatever tolerance someone picked and faceted past it.
    const s = symbolOf('symbol dot { circle r: 5 }')
    expect(s, 'the symbol exists at all').toBeDefined()
    expect((s!.paths[0]!.match(/C /g) ?? []).length, 'four cubic arcs').toBe(4)
    expect(s!.paths[0]).not.toMatch(/L /)
  })

  it('the circle is a CIRCLE — the bezier constant is right, not merely present', () => {
    // `k = 4/3·(√2 − 1)` is the exact quarter-arc control offset. Asserted by sampling the curve
    // rather than by matching the literal: a wrong constant still emits four `C`s.
    const k = (4 / 3) * (Math.SQRT2 - 1)
    const r = 1
    // The first arc runs (r,0) → (0,r) with controls (r,k·r) and (k·r,r). Its midpoint (t = 0.5)
    // must sit on the circle to within the standard ~0.027 % radial error.
    const at = (t: number, a: number, b: number, c: number, d: number): number =>
      (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t ** 2 * c + t ** 3 * d
    const mx = at(0.5, r, r, k * r, 0)
    const my = at(0.5, 0, k * r, r, r)
    expect(Math.hypot(mx, my), 'the arc midpoint is on the unit circle').toBeCloseTo(1, 3)
    // …and the emitted path uses that same constant.
    expect(circlePath({ r: 1 })).toContain(k.toFixed(4).replace(/\.?0+$/, ''))
  })

  it('mixed elements accumulate, in source order', () => {
    const s = symbolOf('symbol mix { path "M 0 0 L 1 1 Z" rect w: 1 h: 1 circle r: 1 }')
    expect(s!.paths).toHaveLength(3)
    expect(s!.paths[0]).toBe('M 0 0 L 1 1 Z')
    expect(s!.paths[1]).toBe(rectPath({ w: 1, h: 1 }))
    expect(s!.paths[2]).toBe(circlePath({ r: 1 }))
  })

  it('the props are optional and the defaults are usable', () => {
    // `numeric-props` is `( IDENT ":" NUMBER )*` — zero pairs is legal grammar, so a bare
    // `rect` must not produce a degenerate zero-area path the SDF cannot evaluate.
    const s = symbolOf('symbol bare { rect circle }')
    expect(s!.paths).toHaveLength(2)
    for (const p of s!.paths) expect(p).not.toMatch(/\bNaN\b/)
    expect(rectPath({})).toBe('M -0.5 -0.5 L 0.5 -0.5 L 0.5 0.5 L -0.5 0.5 Z')
  })
})

describe('`anchor` survives lowering (#1550)', () => {
  it('the SPEC’S OWN EXAMPLE carries its anchor through', () => {
    // §2.8 verbatim. It parsed, validated, and was discarded.
    const s = symbolOf('symbol arrow { path "M 0 -1 L -0.4 0.3 Z" anchor: center }')
    expect(s!.anchor).toBe('center')
  })

  for (const a of SYMBOL_ANCHORS) {
    it(`anchor: ${a} is carried`, () => {
      expect(symbolOf(`symbol s { rect w: 1 h: 1 anchor: ${a} }`)!.anchor).toBe(a)
    })
  }

  it('an UNKNOWN anchor is reported, not silently centred', () => {
    const src = 'symbol s { rect w: 1 h: 1 anchor: middleish }'
    expect(codes(src)).toContain('X-GIS0015')
    // …and the symbol still draws, centred — a typo in a hint must not delete the geometry.
    expect(symbolOf(src)!.anchor).toBeUndefined()
    expect(symbolOf(src)!.paths).toHaveLength(1)
  })

  it('an absent anchor adds no field at all — every existing symbol is untouched', () => {
    expect(symbolOf('symbol s { path "M 0 0 L 1 1 Z" }')).not.toHaveProperty('anchor')
  })
})

describe('the silence itself — a symbol with no geometry (#1550)', () => {
  it('is REPORTED, where it used to resolve to a circle with nothing said', () => {
    // THE FAIL-BEFORE, as behaviour rather than as a story: `symbol dot { anchor: center }` has no
    // geometry. It registered no shape; `getShapeId` returned 0 for the unknown name; 0 is the
    // built-in circle. The author saw a circle and no layer, pass, or console said why.
    const src = 'symbol ghost { anchor: center }'
    expect(codes(src), 'the empty symbol is diagnosed').toContain('X-GIS0016')
    const d = sceneOf(src).diagnostics!.find((x) => x.code === 'X-GIS0016')!
    expect(d.message, 'the message names the symbol and the way out').toContain('ghost')
    expect(d.message).toContain('path')
    // A warning, not an error: the program still compiles and still draws something.
    expect(d.severity).toBe('warn')
  })

  it('…and `rect` / `circle` are now enough to avoid it entirely', () => {
    // The same block that used to be empty-by-lowering is now a real symbol, which is the point:
    // the diagnostic above should fire on genuinely empty blocks and nothing else.
    expect(codes('symbol dot { circle r: 5 }')).not.toContain('X-GIS0016')
    expect(codes('symbol box { rect w: 1 h: 1 }')).not.toContain('X-GIS0016')
  })
})
