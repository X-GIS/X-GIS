// FIX 3 — captureFnCallAsString rejoined inner tokens with no
// separator (`raw += t.value`), and the lexer discards whitespace, so
// space-separated CSS colour functions like `oklab(0.5 -0.05 0.1)`
// captured as `oklab(0.5-0.050.1)`. parseCssColorFn splits on /[,\s]+/,
// got < 3 parts, returned null, and the colour silently dropped. The
// comma form `rgb(255, 0, 0)` survived because commas are preserved.
// This pins that the captured StyleProperty value round-trips through
// resolveColor for both the space form and the comma form.

import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { resolveColor } from '../tokens/colors'
import { lower } from '../ir/lower'
import { withPragma } from './_pragma'

// Parse a single layer with a `fill:` style property and return the
// captured value string (the function-call source stand-in).
function captureFillValue(value: string): string {
  const src = `
    source s { type: geojson, url: "x.geojson" }
    layer l {
      source: s
      fill: ${value}
    }
  `
  const ast = new Parser(new Lexer(withPragma(src)).tokenize()).parse()
  // Walk the AST to find the StyleProperty named "fill".
  let found: string | undefined
  const visit = (n: any): void => {
    if (!n || typeof n !== 'object') return
    if (n.kind === 'StyleProperty' && n.name === 'fill') {
      found = n.value
      return
    }
    for (const k of Object.keys(n)) {
      const v = (n as any)[k]
      if (Array.isArray(v)) v.forEach(visit)
      else if (v && typeof v === 'object') visit(v)
    }
  }
  visit(ast)
  if (found === undefined) throw new Error('fill StyleProperty not found')
  return found
}

describe('FIX 3 — captureFnCallAsString preserves token separation', () => {
  it('space-separated oklab() round-trips through resolveColor', () => {
    const captured = captureFillValue('oklab(0.5 -0.05 0.1)')
    // Captured string must have >= 3 separable parts.
    const inner = captured
      .replace(/^oklab\(/, '')
      .replace(/\)$/, '')
      .replace(/\//g, ',')
    expect(inner.split(/[,\s]+/).filter(Boolean).length).toBe(3)
    expect(resolveColor(captured)).toMatch(/^#[0-9a-f]{6,8}$/)
  })

  it('space-separated lab() round-trips through resolveColor', () => {
    const captured = captureFillValue('lab(50 20 -30)')
    expect(resolveColor(captured)).toMatch(/^#[0-9a-f]{6,8}$/)
  })

  it('comma-separated rgb() still round-trips (no regression)', () => {
    const captured = captureFillValue('rgb(255, 0, 0)')
    expect(resolveColor(captured)).toBe('#ff0000')
  })

  it('comma-separated rgba() with alpha still round-trips', () => {
    const captured = captureFillValue('rgba(0, 0, 0, 0.5)')
    expect(resolveColor(captured)).toBe('#00000080')
  })

  it('negative channel in a space form is not mashed into its neighbour', () => {
    // oklch(0.7 0.15 30) and oklab with a negative b — both must keep
    // the minus glued to ITS number and separated from the prior part.
    const captured = captureFillValue('oklch(0.7 0.15 30)')
    expect(resolveColor(captured)).toMatch(/^#[0-9a-f]{6,8}$/)
  })
})

// #2544 — the separator rule above is a HEURISTIC, and CSS has shapes it
// gets wrong: `%`, a unit identifier after a number, and a bare leading
// `.` are all their own tokens, so the rebuild glued a space where CSS
// allows none (`hsl(120, 50 %, 50 %)` → resolveColor → null → the fill
// was dropped with no diagnostic). The capture must now reproduce the
// SOURCE TEXT byte for byte, reconstructed from the line/col the tokens
// already carry, so no separator heuristic can be wrong again.
describe('#2544 — captureFnCallAsString reproduces the source text byte for byte', () => {
  const ROWS: Array<[written: string, hex: string]> = [
    ['hsl(120, 50%, 50%)', '#40bf40'],
    ['rgba(0, 0, 0, .6)', '#00000099'],
    ['hsl(120deg 50% 50%)', '#40bf40'],
    ['rgb(255, 0, 0)', '#ff0000'],
    ['oklab(0.5 -0.05 0.1)', '#606b08'],
  ]

  for (const [written, hex] of ROWS) {
    it(`\`${written}\` round-trips verbatim and resolves to ${hex}`, () => {
      const captured = captureFillValue(written)
      expect(captured).toBe(written)
      expect(resolveColor(captured)).toBe(hex)
    })
  }

  it('a comma form written WITHOUT spaces stays without spaces', () => {
    // The old rebuild normalised `rgb(255,0,0)` to `rgb(255, 0, 0)`; the
    // source is now the single authority, so what the author wrote is what
    // the capture carries — and both still resolve.
    const captured = captureFillValue('rgb(255,0,0)')
    expect(captured).toBe('rgb(255,0,0)')
    expect(resolveColor(captured)).toBe('#ff0000')
  })

  it('a nested call keeps its inner spacing', () => {
    const captured = captureFillValue('rgb(calc(100 + 155), 0, 0)')
    expect(captured).toBe('rgb(calc(100 + 155), 0, 0)')
  })
})

// The end-to-end half of #2544: what the parse bug actually cost was the
// LOWERED colour. Drives the production pipeline (Lexer → Parser → lower) on
// a layer written the way a style file writes one, and pins that the CSS
// function form lands on the same constant as the hex literal it denotes.
describe('#2544 — a percentage CSS colour lowers to the constant it names', () => {
  const lowerFill = (value: string) => {
    const src = `
    source s { type: geojson, url: "x.geojson" }
    layer l {
      source: s
      fill: ${value}
    }
  `
    const scene = lower(new Parser(new Lexer(withPragma(src)).tokenize()).parse())
    return scene
  }

  it('`fill: hsl(120, 50%, 50%)` lowers to the same constant as `fill: #40bf40`', () => {
    const viaFn = lowerFill('hsl(120, 50%, 50%)').renderNodes[0]!.fill
    const viaHex = lowerFill('#40bf40').renderNodes[0]!.fill
    expect(viaFn.kind).toBe('constant')
    expect(viaFn).toEqual(viaHex)
  })

  it('`fill: rgba(0, 0, 0, .6)` lowers to the same constant as `fill: #00000099`', () => {
    const viaFn = lowerFill('rgba(0, 0, 0, .6)').renderNodes[0]!.fill
    const viaHex = lowerFill('#00000099').renderNodes[0]!.fill
    expect(viaFn.kind).toBe('constant')
    expect(viaFn).toEqual(viaHex)
  })

  it('a resolvable colour emits NO unresolved-colour diagnostic', () => {
    const d = (lowerFill('hsl(120, 50%, 50%)').diagnostics ?? []).filter(
      (x) => x.code === 'X-GIS0029',
    )
    expect(d.length).toBe(0)
  })
})
