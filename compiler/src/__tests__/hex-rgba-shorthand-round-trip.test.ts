// #2543 — cross-component contract: the CSS Color Module 4 four-digit
// shorthand `#rgba`.
//
// `convert/colors.ts:69` validates hex against `{3,4}|6|8` digits and
// passes `#f00a` through verbatim with NO warning; `tokens/colors.ts`
// (`resolveColorToRgba`), `eval/evaluator-helpers.ts` and the runtime's
// `map/src/feature-helpers.ts` all carry an explicit length-5 branch.
// The lexer was the single outlier — `lexer.ts:214` accepted only
// lengths 4 / 7 / 9 — so a converted style using the shorthand lexed
// with `Invalid color literal: #f00a` and the WHOLE import died.
//
// No per-component test can see that: each half is internally
// consistent. This drives the real seam — convertMapboxStyle → Lexer →
// Parser → lower → optimize → emitCommands — on the converter's own
// output string, so the lexer input is the shape a real caller
// produces rather than a hand-written literal.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle, type StyleCoverage } from '../convert/mapbox-to-xgis'
import { Lexer } from '../lexer/lexer'
import { TokenType } from '../lexer/tokens'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { optimize } from '../ir/optimize'
import { emitCommands } from '../ir/emit-commands'

function fillStyle(color: string): unknown {
  return {
    version: 8,
    sources: { s: { type: 'vector', tiles: ['http://x.test/{z}/{x}/{y}.pbf'] } },
    layers: [
      {
        id: 'L',
        type: 'fill',
        source: 's',
        'source-layer': 'water',
        paint: { 'fill-color': color },
      },
    ],
  }
}

function convert(color: string): { source: string; warnings: string[] } {
  const coverage: StyleCoverage = { sources: [], layers: [], warnings: [] }
  const source = convertMapboxStyle(fillStyle(color) as Parameters<typeof convertMapboxStyle>[0], {
    coverage,
  })
  return { source, warnings: coverage.warnings }
}

/** The four f32 literals of the emitted FILL_COLOR vec4 const. */
function fillRgba(xgisSource: string): number[] {
  const shows = emitCommands(
    optimize(lower(new Parser(new Lexer(xgisSource).tokenize()).parse())),
  ).shows
  expect(shows.length).toBe(1)
  const consts = shows[0]!.shaderVariant?.preamble.consts ?? []
  const fill = consts.find((c) => c.name === 'FILL_COLOR')
  expect(fill).toBeDefined()
  const expr = fill!.valueExpr as unknown as { args: { value: number }[] }
  return expr.args.map((a) => a.value)
}

describe('#rgba four-digit shorthand — converter → lexer round-trip (#2543)', () => {
  it('a converted style whose fill-color is #f00a lexes (the contract the lexer broke)', () => {
    const { source, warnings } = convert('#f00a')
    // The converter emits the shorthand verbatim and says nothing is wrong…
    expect(source).toContain('fill-#f00a')
    expect(warnings).toEqual([])
    // …so the lexer must accept it, or the entire import throws.
    const colors = new Lexer(source).tokenize().filter((t) => t.type === TokenType.Color)
    expect(colors.map((t) => t.value)).toEqual(['#f00a'])
  })

  it('the alpha survives lowering: #f00a → rgba(1, 0, 0, 0.667), not opaque red', () => {
    const { source } = convert('#f00a')
    const rgba = fillRgba(source)
    expect(rgba.slice(0, 3)).toEqual([1, 0, 0])
    expect(rgba[3]).toBeCloseTo(0xaa / 255, 6)
  })

  it('#f00a and its #ff0000aa long form compile to the same fill colour', () => {
    expect(fillRgba(convert('#f00a').source)).toEqual(fillRgba(convert('#ff0000aa').source))
  })
})
