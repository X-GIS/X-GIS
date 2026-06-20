// Mapbox `["properties"]` expression accessor → `properties()` builtin,
// resolved at eval time against the live props bag (mirror of the
// `["geometry-type"]` / `["id"]` accessor pattern). Returns the whole
// feature.properties object with reserved $-sigil keys stripped.

import { describe, it, expect } from 'vitest'
import type * as AST from '../parser/ast'
import { exprToXgis } from '../convert/expressions'
import { evaluate } from '../eval/evaluator'
import { makeEvalProps } from '../eval/reserved-keys'

function convert(mapbox: unknown): { result: string | null; warnings: string[] } {
  const warnings: string[] = []
  const result = exprToXgis(mapbox as never, warnings)
  return { result, warnings }
}

/** Build a zero-arg FnCall AST node — the form `["properties"]` lowers
 *  to and the evaluator special-cases. */
const propertiesCall = (): AST.Expr => ({
  kind: 'FnCall',
  callee: { kind: 'Identifier', name: 'properties' },
  args: [],
} as unknown as AST.Expr)

describe('Mapbox ["properties"] expression accessor', () => {
  it('["properties"] → `properties()` builtin (no unknown-op warning)', () => {
    const { result, warnings } = convert(['properties'])
    expect(result).toBe('properties()')
    // Must NOT fall to the generic unknown-op catch-all (the pre-fix
    // behaviour was a silent drop with "Expression not converted").
    expect(warnings.some(w => w.startsWith('Expression not converted'))).toBe(false)
    expect(warnings.some(w => w.includes('not yet supported'))).toBe(false)
  })

  it('malformed ["properties", 1] warns about extra args but still emits', () => {
    const { result, warnings } = convert(['properties', 1])
    expect(result).toBe('properties()')
    expect(warnings.some(w => w.includes('Malformed ["properties"]'))).toBe(true)
  })

  it('evaluator returns the feature properties bag, stripped of reserved $-keys', () => {
    // makeEvalProps injects $zoom / $pitch / $featureId / $geometryType
    // alongside the feature's own properties; ["properties"] must return
    // ONLY the feature properties (Mapbox semantic).
    const bag = makeEvalProps({
      props: { name: 'Main St', kind: 'street', lanes: 2 },
      cameraZoom: 14,
      cameraPitch: 45,
      featureId: 42,
      geometryType: 'LineString',
    })
    const out = evaluate(propertiesCall(), bag)
    expect(out).toEqual({ name: 'Main St', kind: 'street', lanes: 2 })
    // No reserved sidecars leak through.
    expect(Object.keys(out as object).some(k => k.startsWith('$'))).toBe(false)
  })

  it('evaluator returns an empty object for a properties-less feature', () => {
    // DEFAULT / no-regression: a feature with no own properties (only
    // reserved injections) resolves to {} — never the camera sidecars.
    const out = evaluate(propertiesCall(), makeEvalProps({ cameraZoom: 10 }))
    expect(out).toEqual({})
  })
})
