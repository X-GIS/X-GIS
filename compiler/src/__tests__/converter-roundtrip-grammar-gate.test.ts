// Converter emit ⇄ parser grammar round-trip GATE.
//
// Invariant under test: EVERY string `exprToXgis` emits must lex +
// parse + evaluate without throwing. Emit/parse grammar drift — the
// converter producing a token shape the parser can't accept — is a
// whole BUG CLASS that ships silently because most converter unit
// tests stop at the emitted-string assertion and never re-parse.
//
// Concrete drift this guards (match-arm-ternary, expressions.ts:352 /
// :385): a `["match", …]` arm whose value is a nested `["case", …]`
// emits an UNPARENTHESIZED ternary —
//   match(.cls) {  "a" -> .hl ? "#fff" : "#000",  _ -> "#888"  }
// `parseMatchBlock` parsed arm values via `parseCoalesce()`, which
// sits BELOW the ternary in precedence (parser.ts: ternary lives in
// `parseExpr`, above `parsePipe`→`parseCoalesce`). The parser stopped
// at the `?` token and threw "Expected RBrace, got Question". The fix
// makes parseMatchBlock parse arm values with parseExpr() so ternary /
// case arm values are accepted.
//
// We drive `exprToXgis` DIRECTLY (not `convertMapboxStyle`) so the
// `expandPerFeatureColorMatch` preprocessor — which normalises the
// fill-only + constant-colour-arms happy path and would MASK this
// drift — cannot run. This is the `bypassExpandColorMatch: true`
// equivalent at the expression layer: `exprToXgis` is the raw worker
// the preprocessor sits above.
//
// Matrix: nested Mapbox expressions across {match, case, coalesce,
// interpolate, let, format} × paint axes (fill-color, line-color,
// text-color, circle-radius). For each: emit → parse → evaluate, and
// assert no throw at either stage. Cases that legitimately bail to
// `null` (an unsupported subtree) are skipped — a null emit is not
// grammar drift, it is a documented partial-conversion.

import { describe, it, expect } from 'vitest'
import { exprToXgis } from '../convert/expressions'
import { parseExpressionString } from '../parser/parser'
import { evaluate } from '../eval/evaluator'
import { makeEvalProps } from '../eval/reserved-keys'

// Representative feature props + camera zoom so `evaluate` exercises a
// real branch of every emitted expression (rather than null-cascading
// past the interesting nodes). Built via `makeEvalProps` so the camera
// zoom lands under the reserved `$zoom` key without a literal sigil
// (the reserved-keys ratchet forbids bare `$zoom` outside its module).
const PROPS = makeEvalProps({
  cameraZoom: 12,
  props: {
    cls: 'a',
    hl: true,
    mag: 5,
    lang: 'en',
    x: null,
    rank: 2,
  },
})

// [name, mapboxExpr] — each combines a nested CONTROL-FLOW expression
// ({match, case, coalesce, interpolate, let, format}) with a paint
// axis (the comment notes which axis the shape is realistic for).
const MATRIX: Array<[string, unknown]> = [
  // match arm value = case  → ternary-valued arm (THE drift). fill-color.
  ['fill-color: match → case arm',
    ['match', ['get', 'cls'], 'a', ['case', ['get', 'hl'], '#ffffff', '#000000'], '#888888']],
  // match DEFAULT arm = case → trailing ternary before `}`. line-color.
  ['line-color: match → case default arm',
    ['match', ['get', 'cls'], 'a', '#ff0000', ['case', ['get', 'hl'], '#ffffff', '#000000']]],
  // match arm value = coalesce → `??` chain (parses on clean HEAD).
  ['text-color: match → coalesce arm',
    ['match', ['get', 'cls'], 'a', ['coalesce', ['get', 'x'], '#000000'], '#888888']],
  // case branch = match block.
  ['fill-color: case → match branch',
    ['case', ['get', 'hl'], ['match', ['get', 'cls'], 'a', '#ffffff', '#000000'], '#888888']],
  // coalesce arm = case → parenthesised by the coalesce path already.
  ['fill-color: coalesce → case arm',
    ['coalesce', ['case', ['get', 'hl'], '#ffffff', '#000000'], '#888888']],
  // match arm value = interpolate → circle-radius data-driven scaling.
  ['circle-radius: match → interpolate arm',
    ['match', ['get', 'cls'], 'a', ['interpolate', ['linear'], ['get', 'mag'], 0, 1, 10, 20], 5]],
  // let body = match → var substitution then match block.
  ['fill-color: let → match body',
    ['let', 'c', ['get', 'cls'], ['match', ['var', 'c'], 'a', '#ffffff', '#000000']]],
  // format text span = match → label text round-trip.
  ['text-field: format → match span',
    ['format', ['match', ['get', 'lang'], 'en', 'Name', 'ko', '이름', '?'], {}]],
  // case branch = coalesce → ternary-of-coalesce.
  ['fill-color: case → coalesce branch',
    ['case', ['get', 'hl'], ['coalesce', ['get', 'x'], '#abcabc'], '#defdef']],
]

describe('converter emit ⇄ parser grammar round-trip gate', () => {
  for (const [name, expr] of MATRIX) {
    it(`re-parses + evaluates without throwing: ${name}`, () => {
      const warnings: string[] = []
      const xg = exprToXgis(expr, warnings)
      // A null emit is a documented bail (unsupported subtree), not
      // grammar drift — skip it. The gate is about emitted strings the
      // parser must accept, so there is nothing to re-parse here.
      if (xg === null) return

      // 1) The emitted xgis string MUST parse. Drift surfaces as a
      //    thrown parse error (e.g. "Expected RBrace, got Question").
      let ast: ReturnType<typeof parseExpressionString>
      expect(
        () => { ast = parseExpressionString(xg) },
        `emitted xgis failed to PARSE for "${name}":\n  ${xg.replace(/\n/g, ' ')}`,
      ).not.toThrow()

      // 2) The parsed AST MUST evaluate without throwing — guards the
      //    second drift mode where a shape parses but the evaluator
      //    chokes on it.
      expect(
        () => { evaluate(ast!, PROPS) },
        `parsed AST failed to EVALUATE for "${name}":\n  ${xg.replace(/\n/g, ' ')}`,
      ).not.toThrow()
    })
  }
})
