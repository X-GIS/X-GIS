// Mapbox `["pitch"]` expression accessor → bare `pitch` identifier,
// resolved at eval time via the reserved $pitch key (CAMERA_PITCH_KEY),
// mirror of the `["zoom"]` → `zoom` path.

import { describe, it, expect } from 'vitest'
import type * as AST from '../parser/ast'
import { exprToXgis } from '../convert/expressions'
import { evaluate } from '../eval/evaluator'
import { makeEvalProps, CAMERA_PITCH_KEY } from '../eval/reserved-keys'

function convert(mapbox: unknown): { result: string | null; warnings: string[] } {
  const warnings: string[] = []
  const result = exprToXgis(mapbox as never, warnings)
  return { result, warnings }
}

/** Build a bare identifier AST node — the form `["pitch"]` lowers to and
 *  the evaluator special-cases. Mirror of evaluator-builtins-fuzz's `id`. */
const id = (name: string): AST.Expr => ({ kind: 'Identifier', name } as AST.Expr)

describe('Mapbox ["pitch"] expression accessor', () => {
  it('["pitch"] → bare `pitch` identifier (no warning)', () => {
    const { result, warnings } = convert(['pitch'])
    expect(result).toBe('pitch')
    expect(warnings.some(w => w.includes('Camera pitch accessor'))).toBe(false)
    expect(warnings.some(w => w.startsWith('Expression not converted'))).toBe(false)
  })

  it('["pitch"] nested in a `case` / arithmetic still converts', () => {
    // pitch / 60 → "pitch / 60" — the accessor lowers inside larger exprs.
    const { result } = convert(['/', ['pitch'], 60])
    expect(result).toContain('pitch')
  })

  it('malformed ["pitch", 1] warns about extra args but still returns pitch', () => {
    const { result, warnings } = convert(['pitch', 1])
    expect(result).toBe('pitch')
    expect(warnings.some(w => w.includes('Malformed ["pitch"]'))).toBe(true)
  })

  it('evaluator resolves `pitch` identifier via injected camera pitch', () => {
    // With camera pitch injected → resolves to the value.
    expect(evaluate(id('pitch'), makeEvalProps({ cameraPitch: 45 }))).toBe(45)
    // Direct reserved-key form (the runtime injection contract).
    expect(evaluate(id('pitch'), { [CAMERA_PITCH_KEY]: 30 })).toBe(30)
    // Without injection (decode-time / worker) → null, like zoom.
    expect(evaluate(id('pitch'), makeEvalProps({}))).toBeNull()
  })

  it('makeEvalProps writes the camera pitch under the $pitch reserved key', () => {
    const bag = makeEvalProps({ cameraPitch: 30 })
    expect(bag[CAMERA_PITCH_KEY]).toBe(30)
    // Absent when not supplied (no spurious key).
    expect(Object.prototype.hasOwnProperty.call(makeEvalProps({}), CAMERA_PITCH_KEY)).toBe(false)
  })
})
