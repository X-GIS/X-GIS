// Mapbox `["distance-from-center"]` expression accessor (#2119) →
// `get("$distanceFromCenter")`, resolved at eval time via the reserved
// $distanceFromCenter key (DISTANCE_FROM_CENTER_KEY). Routing mirror of
// `["geometry-type"]` / `["id"]` (get("$key")), reserved-key mirror of
// `["zoom"]` / `["pitch"]` / `["accumulated"]` — see reserved-keys.ts for
// why this one accessor rides the get() channel instead of a bare
// identifier.

import { describe, it, expect } from 'vitest'
import type * as AST from '../parser/ast'
import { parseExpressionString } from '../parser/parser'
import { exprToXgis } from '../convert/expressions'
import { evaluate } from '../eval/evaluator'
import { makeEvalProps, DISTANCE_FROM_CENTER_KEY } from '../eval/reserved-keys'
import { distanceFromCenterRatio } from '../eval/distance-from-center'

function convert(mapbox: unknown): { result: string | null; warnings: string[] } {
  const warnings: string[] = []
  const result = exprToXgis(mapbox as never, warnings)
  return { result, warnings }
}

/** Build the `get("$distanceFromCenter")` AST node directly — the shape
 *  `["distance-from-center"]` lowers to. Mirror of expressions-pitch's
 *  `id()` helper, adapted for the get()-route form. */
const getDfc = (): AST.Expr =>
  ({
    kind: 'FnCall',
    callee: { kind: 'Identifier', name: 'get' },
    args: [{ kind: 'StringLiteral', value: '$distanceFromCenter' }],
  }) as AST.Expr

describe('Mapbox ["distance-from-center"] expression accessor (#2119)', () => {
  it('["distance-from-center"] → get("$distanceFromCenter") (no warning)', () => {
    const { result, warnings } = convert(['distance-from-center'])
    expect(result).toBe('get("$distanceFromCenter")')
    expect(warnings.some((w) => w.includes('Distance-from-center accessor'))).toBe(false)
    expect(warnings.some((w) => w.startsWith('Expression not converted'))).toBe(false)
  })

  it('malformed ["distance-from-center", 1] warns about extra args but still converts', () => {
    const { result, warnings } = convert(['distance-from-center', 1])
    expect(result).toBe('get("$distanceFromCenter")')
    expect(warnings.some((w) => w.includes('Malformed ["distance-from-center"]'))).toBe(true)
  })

  it('fail-before repro (#2119): ["step", ["distance-from-center"], …] converts cleanly', () => {
    // The issue's own reproduction — an opacity fade keyed off distance
    // from centre: opaque(1) inside 0.5, half beyond it, gone beyond 1
    // (off-screen). Pre-fix this warned + dropped (result === null).
    const { result, warnings } = convert(['step', ['distance-from-center'], 1, 0.5, 0.5, 1, 0])
    expect(result).not.toBeNull()
    expect(result).toContain('get("$distanceFromCenter")')
    expect(warnings.some((w) => w.includes('["distance-from-center"]'))).toBe(false)
  })

  it('evaluator resolves get("$distanceFromCenter") via injected per-feature value', () => {
    const ast = getDfc()
    expect(evaluate(ast, makeEvalProps({ distanceFromCenter: 0.42 }))).toBe(0.42)
    // Direct reserved-key form (the runtime injection contract).
    expect(evaluate(ast, { [DISTANCE_FROM_CENTER_KEY]: 0.75 })).toBe(0.75)
    // Without injection (no camera / anchor not well-defined) → null.
    expect(evaluate(ast, makeEvalProps({}))).toBeNull()
  })

  it('makeEvalProps writes distanceFromCenter under the $distanceFromCenter reserved key', () => {
    const bag = makeEvalProps({ distanceFromCenter: 0.1 })
    expect(bag[DISTANCE_FROM_CENTER_KEY]).toBe(0.1)
    // Absent when not supplied (no spurious key, and 0 is a legitimate
    // value at dead centre — must not be confused with "unset").
    expect(Object.prototype.hasOwnProperty.call(makeEvalProps({}), DISTANCE_FROM_CENTER_KEY)).toBe(
      false,
    )
    const atCentre = makeEvalProps({ distanceFromCenter: 0 })
    expect(atCentre[DISTANCE_FROM_CENTER_KEY]).toBe(0)
    expect(Object.prototype.hasOwnProperty.call(atCentre, DISTANCE_FROM_CENTER_KEY)).toBe(true)
  })

  it('SHADOWING: a feature property literally named "distance-from-center" does not win', () => {
    // Build the two sibling forms exactly as the converter would:
    //   ["get", "distance-from-center"]  → reads the FEATURE's own field
    //   ["distance-from-center"]         → reads the RESERVED camera slot
    // Mirror of the $accumulated shadowing contract (reserved-keys.ts /
    // evaluator.ts), proved here on REAL converter output (parsed back into
    // an AST, not hand-assembled) over a props bag carrying BOTH values.
    const getForm = convert(['get', 'distance-from-center'])
    const accessorForm = convert(['distance-from-center'])
    expect(getForm.result).toBe('get("distance-from-center")')
    expect(accessorForm.result).toBe('get("$distanceFromCenter")')

    const getAst = parseExpressionString(getForm.result!)
    const accessorAst = parseExpressionString(accessorForm.result!)

    const props = makeEvalProps({
      // The feature's OWN property, spelled identically to the Mapbox
      // accessor name — the exact collision #2119 calls out.
      props: { 'distance-from-center': 999 },
      distanceFromCenter: 0.3,
    })
    expect(evaluate(getAst, props)).toBe(999) // the feature's field, untouched
    expect(evaluate(accessorAst, props)).toBe(0.3) // the reserved slot, not shadowed
  })

  it('units cross-check: makeEvalProps round-trips a distanceFromCenterRatio value unchanged', () => {
    // The reserved-key slot is a plain pass-through (see reserved-
    // keys.ts) — this pins that a value computed by the units module
    // survives makeEvalProps + evaluate with no re-scaling.
    const ratio = distanceFromCenterRatio(1200, 100, 1600, 400)! // an edge-ish point
    expect(evaluate(getDfc(), makeEvalProps({ distanceFromCenter: ratio }))).toBe(ratio)
  })
})
