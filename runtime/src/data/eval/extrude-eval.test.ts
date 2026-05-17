// Unit tests for the extrude expression evaluator. Wraps the compiler's
// `evaluate()` with a numeric coercion + finite-check so the upload
// path can fall back to the layer's default height when the
// expression doesn't yield a usable value.

import { describe, expect, it } from 'vitest'
import { evalExtrudeExpr } from './extrude-eval'

const lit = (value: number) => ({ kind: 'NumberLiteral' as const, value })
const fld = (field: string) => ({ kind: 'FieldAccess' as const, object: null, field })
const bin = (op: string, left: unknown, right: unknown) =>
  ({ kind: 'BinaryExpr' as const, op, left, right })
const fn = (name: string, args: unknown[]) =>
  ({
    kind: 'FnCall' as const,
    callee: { kind: 'Identifier' as const, name },
    args,
  })

describe('evalExtrudeExpr', () => {
  it('evaluates a NumberLiteral', () => {
    expect(evalExtrudeExpr(lit(50), {})).toBe(50)
  })

  it('reads a feature field via FieldAccess', () => {
    expect(evalExtrudeExpr(fld('height'), { height: 30 })).toBe(30)
  })

  it('returns null for missing fields', () => {
    expect(evalExtrudeExpr(fld('height'), {})).toBeNull()
  })

  it('returns null for non-numeric fields', () => {
    expect(evalExtrudeExpr(fld('name'), { name: 'tower' })).toBeNull()
  })

  it('evaluates `.levels * 3.5` (BinaryExpr *)', () => {
    expect(evalExtrudeExpr(bin('*', fld('levels'), lit(3.5)), { levels: 10 })).toBe(35)
  })

  it('evaluates `.height + 10` (BinaryExpr +)', () => {
    expect(evalExtrudeExpr(bin('+', fld('height'), lit(10)), { height: 25 })).toBe(35)
  })

  it('evaluates nested binary expressions', () => {
    // (.levels * 3.5) + .min_height
    const ast = bin('+', bin('*', fld('levels'), lit(3.5)), fld('min_height'))
    expect(evalExtrudeExpr(ast, { levels: 4, min_height: 2 })).toBe(16)
  })

  it('returns null when any operand is missing', () => {
    expect(evalExtrudeExpr(bin('*', fld('levels'), lit(3.5)), {})).toBeNull()
  })

  it('returns null on division by zero', () => {
    expect(evalExtrudeExpr(bin('/', lit(10), lit(0)), {})).toBeNull()
  })

  it('returns null for negative results', () => {
    expect(evalExtrudeExpr(bin('-', lit(5), lit(20)), {})).toBeNull()
  })

  it('returns null for zero results', () => {
    expect(evalExtrudeExpr(bin('-', lit(20), lit(20)), {})).toBeNull()
  })

  it('evaluates `max(.height, 20)` via FnCall', () => {
    const ast = fn('max', [fld('height'), lit(20)])
    expect(evalExtrudeExpr(ast, { height: 5 })).toBe(20)
    expect(evalExtrudeExpr(ast, { height: 50 })).toBe(50)
  })

  it('evaluates `min(.height, 100)` via FnCall', () => {
    const ast = fn('min', [fld('height'), lit(100)])
    expect(evalExtrudeExpr(ast, { height: 250 })).toBe(100)
    expect(evalExtrudeExpr(ast, { height: 30 })).toBe(30)
  })

  it('evaluates `clamp(.height, 5, 200)` via FnCall', () => {
    const ast = fn('clamp', [fld('height'), lit(5), lit(200)])
    expect(evalExtrudeExpr(ast, { height: 1 })).toBe(5)
    expect(evalExtrudeExpr(ast, { height: 999 })).toBe(200)
    expect(evalExtrudeExpr(ast, { height: 50 })).toBe(50)
  })

  it('evaluates `abs(.delta)` via FnCall', () => {
    const ast = fn('abs', [fld('delta')])
    expect(evalExtrudeExpr(ast, { delta: -42 })).toBe(42)
  })

  describe('reserved-key injection', () => {
    // Pins the tileZoom + feature.id + feature.geometry.type passthrough
    // added in 6018086 / 73f3880. Without makeEvalProps the helper
    // saw undefined for the reserved identifiers — a future refactor
    // that drops the reserved-key wiring would silently regress
    // every per-feature extrude using `["zoom"]` / `["geometry-type"]`
    // / `["id"]`.

    // FieldAccess('$zoom') simulates the AST lowered from `["zoom"]`
    // / `interpolate(zoom, …)` — the evaluator reads props['$zoom']
    // for the reserved camera-zoom slot.
    it('resolves the reserved $zoom key when tileZoom is provided', () => {
      const ast = fld('$zoom')
      expect(evalExtrudeExpr(ast, {}, 14)).toBe(14)
      // Backward-compat: tileZoom omitted ⇒ raw props bag ⇒ $zoom
      // resolves to undefined ⇒ helper returns null.
      expect(evalExtrudeExpr(ast, {})).toBeNull()
    })

    it('resolves $featureId from feature.id when feature is provided', () => {
      const ast = fld('$featureId')
      expect(evalExtrudeExpr(ast, {}, 14, { id: 42 })).toBe(42)
    })

    it('does not blow up when feature is provided but tileZoom is not', () => {
      // The geometryType / featureId branches inside makeEvalProps
      // must work without cameraZoom — sanity that the gate is on
      // "ANY reserved key present" rather than "tileZoom present".
      const ast = fld('$featureId')
      expect(evalExtrudeExpr(ast, {}, undefined, { id: 7 })).toBe(7)
    })

    it('accepts null / undefined props (properties-less features)', () => {
      // MVT and GeoJSON both allow features with no properties bag.
      // The reserved keys ($zoom / $geometryType / $featureId) must
      // still resolve so a zoom-gated or geometry-type-only extrude
      // expression isn't silently skipped. Pre-fix the caller's
      // `if (!props) continue` early-skip dropped these features.
      const ast = fld('$zoom')
      expect(evalExtrudeExpr(ast, null, 14)).toBe(14)
      expect(evalExtrudeExpr(ast, undefined, 14)).toBe(14)
    })
  })
})
