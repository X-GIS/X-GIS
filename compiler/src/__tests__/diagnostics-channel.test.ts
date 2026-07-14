// ═══ Unified spanned diagnostics channel (#1065) ═══
//
// One `Diagnostic { code, severity, span, message, help? }` shared by
// lexer/parser/lower/converter. This suite proves the four stages route
// through the ONE type, that the parser recovers to report N errors in a
// single pass (the LSP/playground substrate), and that the #1064 pragma
// gate stays a hard stop even in recovering mode.

import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { convertMapboxStyle, type StyleCoverage } from '../convert/mapbox-to-xgis'
import { ParseError, diagnosticMessages, type Diagnostic } from '../diagnostics/diagnostic'
import { withPragma } from './_pragma'

function tokens(src: string) {
  return new Lexer(withPragma(src)).tokenize()
}

describe('parser error-recovery — N errors in one pass (#1065)', () => {
  // Three `layer { … }` blocks that omit the layer NAME (a syntax error
  // at the `{`), interleaved with valid `source` blocks. The recovering
  // parser must report all THREE and still parse the three valid sources.
  const MULTI_ERR = `
source s1 { type: geojson, url: "a.geojson" }
layer { fill: red-500 }
source s2 { type: geojson, url: "b.geojson" }
layer { fill: blue-500 }
source s3 { type: geojson, url: "c.geojson" }
layer { stroke: black }`

  it('parseCollect reports N>1 errors in a single pass', () => {
    const { program, diagnostics } = new Parser(tokens(MULTI_ERR)).parseCollect()
    // FAIL-BEFORE: today's parser throws at the FIRST error, so this
    // never returns a diagnostics list — it could only ever surface one.
    expect(diagnostics.length).toBe(3)
    for (const d of diagnostics) {
      expect(d.severity).toBe('error')
      expect(d.code).toBe('X-GIS0010')
      expect(d.span.line).toBeGreaterThan(0)
    }
    // Recovery kept the three valid sources — the errors did not eat them.
    expect(program.body.filter((s) => s.kind === 'SourceStatement')).toHaveLength(3)
  })

  it('the three errors land on the three distinct `layer {` lines', () => {
    const { diagnostics } = new Parser(tokens(MULTI_ERR)).parseCollect()
    // withPragma reuses the leading blank line, so source lines are
    // unchanged: the `layer {` rows are 3, 5, 7.
    expect(diagnostics.map((d) => d.span.line)).toEqual([3, 5, 7])
  })
})

describe('span accuracy — line AND col (#1065)', () => {
  it('a known-position error carries the exact 1-based line + col of the offending token', () => {
    // `xgis 1` on line 1; `layer {` on line 2. The name is expected at
    // the `{`, which sits at column 7 (`layer ` = 6 chars, `{` = 7th).
    const { diagnostics } = new Parser(tokens('\nlayer { fill: red }')).parseCollect()
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0].span).toMatchObject({ line: 2, col: 7 })
  })
})

describe('pragma gate stays a HARD stop under recovery (#1064 × #1065)', () => {
  it('a missing pragma throws even in parseCollect — recovery never resumes past it', () => {
    // No withPragma: the source has no `xgis <major>` first token.
    const raw = new Lexer('layer { fill: red }').tokenize()
    expect(() => new Parser(raw).parseCollect()).toThrow('X-GIS0008')
  })

  it('a newer major throws in parseCollect (a wrong-version file must not half-parse)', () => {
    const raw = new Lexer('xgis 999\nlayer { fill: red }').tokenize()
    expect(() => new Parser(raw).parseCollect()).toThrow('X-GIS0009')
  })

  it('the pragma error is a structured ParseError carrying code X-GIS0008', () => {
    const raw = new Lexer('source w { type: geojson }').tokenize()
    let err: unknown
    try {
      new Parser(raw).parseCollect()
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ParseError)
    expect((err as ParseError).diagnostic.code).toBe('X-GIS0008')
    expect((err as ParseError).diagnostic.severity).toBe('error')
  })
})

describe('default parse() stays throw-on-first, now carrying the structured diagnostic', () => {
  it('parse() throws a ParseError whose .diagnostic is the FIRST error (span + code)', () => {
    let err: unknown
    try {
      new Parser(tokens('\nlayer { fill: red }')).parse()
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ParseError)
    const pe = err as ParseError
    // Message shape is unchanged for string-pinning callers.
    expect(pe.message).toContain('[Parser]')
    expect(pe.diagnostic.code).toBe('X-GIS0010')
    expect(pe.diagnostic.span).toMatchObject({ line: 2, col: 7 })
  })
})

describe('lower diagnostics flow through the unified type (#1065)', () => {
  it('a lower warning carries severity + code + a line+col span', () => {
    // A layer with no `source:` → X-GIS0002 warn at the layer's line.
    const scene = lower(new Parser(tokens('\nlayer solo { fill: red-500 }')).parse())
    const diags: Diagnostic[] = scene.diagnostics ?? []
    const noSource = diags.find((d) => d.code === 'X-GIS0002')
    expect(noSource).toBeDefined()
    expect(noSource!.severity).toBe('warn')
    // Migrated from line-only: the span widens to line+col (col defaults
    // to 1 where only the line is known).
    expect(noSource!.span).toMatchObject({ line: 2, col: 1 })
  })
})

describe('converter diagnostics flow through the unified type (#1065)', () => {
  it('coverage.diagnostics is Diagnostic[] and the string accessor round-trips', () => {
    // A style missing the top-level `version` produces exactly one warning.
    const coverage: StyleCoverage = { sources: [], layers: [], warnings: [] }
    convertMapboxStyle({ sources: {}, layers: [] }, { coverage })

    expect(coverage.warnings.length).toBeGreaterThan(0)
    expect(coverage.diagnostics).toBeDefined()
    const diags = coverage.diagnostics!
    for (const d of diags) {
      expect(d.severity).toBe('warn')
      expect(d.code).toBe('X-GIS0011')
    }
    // The compatibility accessor reproduces the pinned string channel.
    expect(diagnosticMessages(diags)).toEqual(coverage.warnings)
  })
})
