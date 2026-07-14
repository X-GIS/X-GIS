// Fail-before regression suite for #1068 — match{} arm lists, typed numeric
// patterns, and removal of the identifier-minus arm-value ambiguity.
//
//   (a) comma-separated pattern lists: `"a", "b" -> v` — both labels hit the
//       SAME arm. Pre-fix the parser accepted exactly one pattern before the
//       arrow, so the list comma reached `expect(Arrow)` and threw.
//   (b) numeric patterns compare NUMERICALLY with Mapbox type-strict
//       semantics: label `2` matches the number 2 and NOT the string "2"
//       (both directions). Pre-fix the evaluator compared `String(key)`, so a
//       string "2" input wrongly matched a numeric `2` label.
//   (c) arithmetic in an arm value: `_ -> foo - 1`. Pre-fix a bare Identifier
//       followed by `-` was swallowed as a utility colour name (`foo-1`), so
//       the subtraction was unwritable. (`.x - 1` already parsed pre-fix
//       because `.x` lexes as Dot+Identifier, not a bare Identifier — asserted
//       too, for the arithmetic-capability half of the story.)

import { describe, expect, it } from 'vitest'
import { parseExpressionString } from '../parser/parser'
import { evaluate } from '../eval/evaluator'
import { lowerMatchColorToMatch } from '../codegen/compute-lowering'
import type * as AST from '../parser/ast'

describe('#1068 match arm lists', () => {
  it('(a) parses a comma-separated pattern list and routes both labels to arm 1', () => {
    // Pre-fix: throws `[Parser] Expected Arrow, got Comma`.
    const ast = parseExpressionString('match(.t) { "a", "b" -> 1  _ -> 0 }')
    expect(evaluate(ast, { t: 'a' })).toBe(1)
    expect(evaluate(ast, { t: 'b' })).toBe(1)
    expect(evaluate(ast, { t: 'z' })).toBe(0)
  })

  it('(a) mixes list arms and single arms, with and without arm separators', () => {
    const ast = parseExpressionString('match(.t) { "a", "b" -> 1, "c" -> 2, _ -> 0 }')
    expect(evaluate(ast, { t: 'a' })).toBe(1)
    expect(evaluate(ast, { t: 'b' })).toBe(1)
    expect(evaluate(ast, { t: 'c' })).toBe(2)
    expect(evaluate(ast, { t: 'q' })).toBe(0)
  })

  it('(a) three-label list all route to the same value', () => {
    const ast = parseExpressionString('match(.t) { "x", "y", "z" -> 7, _ -> 0 }')
    expect(evaluate(ast, { t: 'x' })).toBe(7)
    expect(evaluate(ast, { t: 'y' })).toBe(7)
    expect(evaluate(ast, { t: 'z' })).toBe(7)
    expect(evaluate(ast, { t: 'w' })).toBe(0)
  })
})

describe('#1068 typed numeric patterns', () => {
  it('(b) numeric label 2 matches the NUMBER 2', () => {
    const ast = parseExpressionString('match(.count) { 2 -> "two", _ -> "other" }')
    expect(evaluate(ast, { count: 2 })).toBe('two')
  })

  it('(b) numeric label 2 does NOT match the STRING "2" (Mapbox type-strict)', () => {
    // Pre-fix: evaluator did `String(key) === "2"`, so "2" wrongly matched.
    const ast = parseExpressionString('match(.count) { 2 -> "two", _ -> "other" }')
    expect(evaluate(ast, { count: '2' })).toBe('other')
  })

  it('(b) string label "2" matches the STRING "2" and NOT the number 2', () => {
    const ast = parseExpressionString('match(.count) { "2" -> "str-two", _ -> "other" }')
    expect(evaluate(ast, { count: '2' })).toBe('str-two')
    expect(evaluate(ast, { count: 2 })).toBe('other')
  })

  it('(b) negative numeric label -3 matches -3 numerically, not its string form', () => {
    const ast = parseExpressionString('match(.delta) { -3 -> "neg", _ -> "fb" }')
    expect(evaluate(ast, { delta: -3 })).toBe('neg')
    expect(evaluate(ast, { delta: '-3' })).toBe('fb')
  })

  it('(b) numeric labels also work inside an arm list', () => {
    const ast = parseExpressionString('match(.count) { 1, 2 -> "lo", 3 -> "hi", _ -> "other" }')
    expect(evaluate(ast, { count: 1 })).toBe('lo')
    expect(evaluate(ast, { count: 2 })).toBe('lo')
    expect(evaluate(ast, { count: 3 })).toBe('hi')
    expect(evaluate(ast, { count: '1' })).toBe('other')
  })
})

describe('#1068 arithmetic in arm value (identifier-minus removal)', () => {
  it('(c) `_ -> foo - 1` parses as subtraction, not a utility name', () => {
    // Pre-fix: `foo - 1` was swallowed into Identifier("foo-1").
    const ast = parseExpressionString('match(.k) { "hit" -> 100, _ -> foo - 1 }') as AST.FnCall
    const arms = (ast.matchBlock as AST.MatchBlock).arms
    const defArm = arms.find((a) => a.pattern === '_')!
    expect(defArm.value.kind).toBe('BinaryExpr')
    expect(evaluate(ast, { k: 'miss', foo: 10 })).toBe(9)
  })

  it('(c) `_ -> .x - 1` (field-access arithmetic) parses and evaluates', () => {
    const ast = parseExpressionString('match(.k) { _ -> .x - 1 }')
    expect(evaluate(ast, { k: 'any', x: 5 })).toBe(4)
  })
})

describe('#1068 parsed source through GPU match lowering', () => {
  // Regression for the continent-match-compute-mock CI failure: with the
  // identifier-minus special case gone, a palette-token arm value
  // (`"Africa" -> amber-600`) parses as BinaryExpr, and the compute
  // adapter's colour resolver must reconstruct the token exactly like
  // shader-gen's resolveColorFromAST does — otherwise every arm is
  // silently skipped and the kernel's categoryOrder comes out EMPTY
  // while the inline-shader path still resolves all arms (cross-path
  // category-ID drift).
  it('palette-token arm values from source survive lowerMatchColorToMatch', () => {
    const ast = parseExpressionString(
      'match(.CONTINENT) { "Africa" -> amber-600, "Asia", "Oceania" -> #0ea5e9, _ -> #9ca3af }',
    )
    const spec = lowerMatchColorToMatch({ ast } as never)!
    expect(spec).not.toBeNull()
    expect(spec.fieldName).toBe('CONTINENT')
    // Arm-list desugaring: "Asia" and "Oceania" become two arms sharing the hex.
    expect(spec.arms.map((a) => a.pattern)).toEqual(['Africa', 'Asia', 'Oceania'])
    expect(spec.arms[0]!.colorHex).toBe('#d97706') // amber-600 via token reconstruction
    expect(spec.arms[1]!.colorHex).toBe('#0ea5e9')
    expect(spec.arms[2]!.colorHex).toBe('#0ea5e9')
    expect(spec.defaultColorHex).toBe('#9ca3af')
  })
})
