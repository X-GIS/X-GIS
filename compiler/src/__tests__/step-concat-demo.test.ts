// Sanity-check the playground step-and-concat demo source compiles.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { evaluate } from '../eval/evaluator'
import { withPragma } from './_pragma'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const DEMO = `
source places { type: geojson, url: "data/x.geojson" }

layer city_dots {
  source: places
  | size-[step(.pop_max, 3, 100000, 5, 1000000, 7, 5000000, 10)]
  | fill-[step(.pop_max, "#4ade80", 1000000, "#facc15", 5000000, "#f97316", 10000000, "#ef4444")]
    fill-opacity-90
}

layer city_labels {
  source: places
  | label-[concat(.name, ", ", .adm0name, "  (", round(.pop_max / 1000), "k)")]
    label-size-11 label-color-#fff
}
`

describe('step + concat playground demo source', () => {
  it('lexes + parses + lowers without throwing', () => {
    const tokens = new Lexer(withPragma(DEMO)).tokenize()
    const ast = new Parser(tokens).parse()
    const scene = lower(ast)
    expect(scene.renderNodes.length).toBe(2)
  })

  it('runtime evaluator handles N-stop step + concat with sample feature', () => {
    const props = {
      pop_max: 7_500_000,
      name: 'Tokyo',
      adm0name: 'Japan',
    }
    // Inline parse the bindings the same way the runtime would.
    const tokens = new Lexer(
      withPragma(
        `source x { type: geojson } layer y { source: x | size-[step(.pop_max, 3, 100000, 5, 1000000, 7, 5000000, 10)] }`,
      ),
    ).tokenize()
    const ast = new Parser(tokens).parse()
    // Find the size binding's AST node and evaluate it directly.
    const layer = ast.body.find((s) => s.kind === 'LayerStatement') as never

    const sizeBinding = (layer as any).utilities[0].items[0].binding
    const result = evaluate(sizeBinding, props)
    // pop_max=7.5M ≥ 5M → step yields 10.
    expect(result).toBe(10)
  })

  it('concat coerces numerics + drops nulls', () => {
    const tokens = new Lexer(
      withPragma(
        `source x { type: geojson } layer y { source: x | label-[concat(.name, " (", round(.pop_max / 1000), "k)")] }`,
      ),
    ).tokenize()
    const ast = new Parser(tokens).parse()
    const layer = ast.body.find((s) => s.kind === 'LayerStatement') as never

    const labelBinding = (layer as any).utilities[0].items[0].binding
    const result = evaluate(labelBinding, { name: 'Tokyo', pop_max: 13_500_000 })
    expect(result).toBe('Tokyo (13500k)')
  })
})

// ═══ The SHIPPED demo against the SHIPPED fixture (#1838) ═══════════
//
// Everything above runs an INLINE COPY of the demo over SYNTHETIC props, so
// the pairing that actually ships is unpinned on both sides: rename a field
// in `step-and-concat.xgis`, or lose one from the populated-places fixture,
// and every case above stays green while every label on the gallery page
// resolves to a blank string. #1838 was filed as "the demo renders zero
// label text", and ruling that out is exactly this read of the two real
// files — the concat is over `.name` / `.adm0name` / `.pop_max`, which only
// the fixture can confirm.
describe('shipped step-and-concat.xgis over the shipped populated-places fixture', () => {
  const DEMO_XGIS = join(REPO_ROOT, 'playground/src/examples/step-and-concat.xgis')
  const PLACES = join(REPO_ROOT, 'playground/public/data/ne_110m_populated_places.geojson')

  it('composes a non-empty "City, Country  (NNNk pop)" label for EVERY feature', () => {
    const scene = lower(new Parser(new Lexer(readFileSync(DEMO_XGIS, 'utf8')).tokenize()).parse())
    const labelled = scene.renderNodes.filter((n) => n.label !== undefined)
    expect(labelled.length, 'exactly one label layer in the demo').toBe(1)
    const text = labelled[0]!.label!.text
    expect(text.kind).toBe('expr')
    if (text.kind !== 'expr') return

    const fc = JSON.parse(readFileSync(PLACES, 'utf8')) as {
      features: { properties: Record<string, unknown> }[]
    }
    expect(fc.features.length, 'Natural Earth 110m populated places').toBeGreaterThan(200)

    // The runtime path for `kind: 'expr'` with no zoom/id/geometry-type in the
    // bag is exactly `String(evaluate(ast, props))` — map/src/text/
    // text-resolver.ts resolveTextUncached.
    const resolved = fc.features.map((f) => {
      const v = evaluate(text.expr.ast, f.properties ?? {})
      return v === null || v === undefined ? '' : String(v)
    })
    const blank = resolved.filter((s) => s.trim().length === 0)
    expect(blank.length, `features resolving to a blank label: ${blank.length}`).toBe(0)

    // Shape, not just non-emptiness: a missing `.adm0name` would still leave a
    // non-blank "Name,   (Nk pop)", so assert every part of the composition.
    const SHAPE = /^[^,]+, .+ {2}\(\d+k pop\)$/
    const unshaped = resolved.filter((s) => !SHAPE.test(s))
    expect(unshaped.length, `unshaped labels (first 3: ${unshaped.slice(0, 3).join(' | ')})`).toBe(
      0,
    )

    // One exact value pins concat's separators AND round()'s thousands roll-up
    // (pop_max 832 → "1k"), which a shape regex alone would not.
    expect(resolved[0]).toBe('Vatican City, Vatican (Holy See)  (1k pop)')
  })
})
