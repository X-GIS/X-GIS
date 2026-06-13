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
  const ast = new Parser(new Lexer(src).tokenize()).parse()
  // Walk the AST to find the StyleProperty named "fill".
  let found: string | undefined
  const visit = (n: any): void => {
    if (!n || typeof n !== 'object') return
    if (n.kind === 'StyleProperty' && n.name === 'fill') { found = n.value; return }
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
    const inner = captured.replace(/^oklab\(/, '').replace(/\)$/, '').replace(/\//g, ',')
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
