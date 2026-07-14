// Audit iter 515: verify Mapbox `["match", ...]` evaluator semantics
// match X-GIS' compiler + runtime for the OFM POI icon-image
// expression shape. User reported (2026-05-18) extra icons in
// X-GIS at Seoul school view that aren't in MapLibre. Hypothesis
// was an evaluator divergence — this audit RULES IT OUT.
//
// OFM POI iconImage expression:
//   ["match", ["get", "subclass"],
//             ["florist", "furniture"],  // labels
//             ["get", "subclass"],       // → subclass when matched
//             ["get", "class"]]          // → class when default
//
// Verified semantics:
//   school feature (subclass=school, class=education) → "education"
//   florist (subclass=florist, class=shop) → "florist"
//   sports_centre (subclass=sports_centre, class=leisure) → "leisure"
//
// The "extra runner figure" Seoul divergence is NOT an evaluator
// bug. Root cause is Phase C.9: X-GIS doesn't have an icon
// collision queue, so colliding icons that MapLibre drops via
// icon-allow-overlap=false (default) survive in X-GIS' render.

import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { evaluate } from '../eval/evaluator'
import { exprToXgis } from '../convert/expressions'
import type { Expr } from '../parser/ast'
import { withPragma } from './_pragma'

function parseExpr(src: string): Expr {
  const tokens = new Lexer(withPragma('let __x = ' + src)).tokenize()
  const ast = new Parser(tokens).parse()
  const stmt = ast.body[0]
  if (stmt.kind !== 'LetStatement') throw new Error('expected LetStatement')
  return stmt.value
}

describe('Mapbox match — array-label semantics (OFM POI icon-image shape)', () => {
  it('exprToXgis converts the OFM POI match shape to a match block with two labels', () => {
    const mapbox = [
      'match',
      ['get', 'subclass'],
      ['florist', 'furniture'],
      ['get', 'subclass'],
      ['get', 'class'],
    ]
    const warnings: string[] = []
    const xgis = exprToXgis(mapbox, warnings)
    expect(xgis).toBeTruthy()
    expect(xgis).toContain('match(.subclass)')
    expect(xgis).toContain('"florist" -> .subclass')
    expect(xgis).toContain('"furniture" -> .subclass')
    expect(xgis).toContain('_ -> .class')
    expect(warnings).toEqual([])
  })

  it('evaluator: subclass=school + class=education → "education" (default arm)', () => {
    const expr = parseExpr(
      'match(.subclass) { "florist" -> .subclass, "furniture" -> .subclass, _ -> .class }',
    )
    const result = evaluate(expr as never, { subclass: 'school', class: 'education' })
    expect(result).toBe('education')
  })

  it('evaluator: subclass=florist + class=shop → "florist" (match arm 1)', () => {
    const expr = parseExpr(
      'match(.subclass) { "florist" -> .subclass, "furniture" -> .subclass, _ -> .class }',
    )
    const result = evaluate(expr as never, { subclass: 'florist', class: 'shop' })
    expect(result).toBe('florist')
  })

  it('evaluator: subclass=furniture + class=shop → "furniture" (match arm 2)', () => {
    const expr = parseExpr(
      'match(.subclass) { "florist" -> .subclass, "furniture" -> .subclass, _ -> .class }',
    )
    const result = evaluate(expr as never, { subclass: 'furniture', class: 'shop' })
    expect(result).toBe('furniture')
  })

  it('evaluator: subclass=sports_centre + class=leisure → "leisure" (default — matches OFM POI runner-icon case)', () => {
    // This is the Seoul "extra runner icon" feature. iconImage resolves to "leisure"
    // → sprite atlas's leisure entry (a runner/sports figure). MapLibre would
    // resolve to the SAME icon — the divergence is icon collision, not eval.
    const expr = parseExpr(
      'match(.subclass) { "florist" -> .subclass, "furniture" -> .subclass, _ -> .class }',
    )
    const result = evaluate(expr as never, { subclass: 'sports_centre', class: 'leisure' })
    expect(result).toBe('leisure')
  })

  it('evaluator: missing subclass — default arm fires using class', () => {
    const expr = parseExpr(
      'match(.subclass) { "florist" -> .subclass, "furniture" -> .subclass, _ -> .class }',
    )
    const result = evaluate(expr as never, { class: 'amenity' })
    expect(result).toBe('amenity')
  })
})
