// Synthetic nested-expression fixture: pins the converter's behaviour
// on deeply nested expressions covering case-in-match-in-interpolate,
// let-binding with data-driven arms, format-with-spans, and `in`
// operator with literal-array keys. Catches silent regressions where
// a converter change drops or wraps a sub-expression incorrectly.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'

const FIXTURE = join(__dirname, 'fixtures', 'synthetic-nested.json')

function readFixture() {
  return JSON.parse(readFileSync(FIXTURE, 'utf8'))
}

describe('synthetic-nested expression fixture', () => {
  it('converts without throwing', () => {
    const style = readFixture()
    expect(() => convertMapboxStyle(style)).not.toThrow()
  })

  it('produces parseable xgis output', () => {
    const style = readFixture()
    const xgis = convertMapboxStyle(style)
    const tokens = new Lexer(xgis).tokenize()
    expect(() => new Parser(tokens).parse()).not.toThrow()
  })

  it('lowers to IR with at least 4 declared layers', () => {
    const style = readFixture()
    const xgis = convertMapboxStyle(style)
    const tokens = new Lexer(xgis).tokenize()
    const ast = new Parser(tokens).parse()
    const ir = lower(ast)
    // Four layers in fixture → IR should have at least 4 renderNodes
    // (some layers may split, e.g. text+icon symbols, so allow ≥4).
    expect(ir.renderNodes?.length ?? 0).toBeGreaterThanOrEqual(4)
  })

  it('does not warn about depth-exceeded on the deepest path', () => {
    const style = readFixture()
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(style, { coverage })
    expect(coverage.warnings.some((w) => w.includes('depth exceeded'))).toBe(false)
  })

  it('does not warn about match-label or interpolate-stop violations', () => {
    // All labels in the fixture are literal strings/numbers; all
    // interpolate stops are literal finite numbers. Pre-fix the
    // converter would silently mis-handle these — surface that the
    // fixture is spec-clean.
    const style = readFixture()
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(style, { coverage })
    expect(coverage.warnings.some((w) => w.includes('not literal'))).toBe(false)
    expect(coverage.warnings.some((w) => w.includes('literal finite number'))).toBe(false)
  })
})
