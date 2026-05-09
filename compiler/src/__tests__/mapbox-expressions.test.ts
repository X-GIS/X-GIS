// Batch 6 — Mapbox expression operator mapping.
//
// Each test feeds a minimal Mapbox v8 style with the operator under
// test inside `text-field` (or a similar string-emitting context),
// runs convertMapboxStyle, and asserts the xgis output contains the
// expected lowered shape. parses() round-trips the output through
// the lexer + parser so we know it's not just byte-correct but
// actually valid xgis grammar.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'

function parses(xgis: string): boolean {
  try {
    const tokens = new Lexer(xgis).tokenize()
    new Parser(tokens).parse()
    return true
  } catch { return false }
}

function convertWithFontGet(expr: unknown): string {
  return convertMapboxStyle({
    version: 8,
    sources: { x: { type: 'vector', url: 'a.pmtiles' } },
    layers: [{
      id: 'l', type: 'symbol', source: 'x', 'source-layer': 'pts',
      layout: { 'text-field': expr } as never,
    }],
  })
}

describe('Math operators', () => {
  it('["^", a, b] → pow(a, b)', () => {
    const out = convertMapboxStyle({
      version: 8, sources: { x: { type: 'vector', url: 'a.pmtiles' } },
      layers: [{
        id: 'p', type: 'fill', source: 'x', 'source-layer': 'a',
        paint: { 'fill-opacity': ['^', ['get', 'rank'], 2] } as never,
      }],
    })
    expect(out).toMatch(/pow\(\.rank,\s*2\)/)
    expect(parses(out)).toBe(true)
  })

  for (const op of ['abs', 'ceil', 'floor', 'round', 'sqrt']) {
    it(`["${op}", x] → ${op}(x)`, () => {
      const out = convertMapboxStyle({
        version: 8, sources: { x: { type: 'vector', url: 'a.pmtiles' } },
        layers: [{
          id: 'p', type: 'fill', source: 'x', 'source-layer': 'a',
          paint: { 'fill-opacity': [op, ['get', 'v']] } as never,
        }],
      })
      expect(out).toContain(`${op}(.v)`)
      expect(parses(out)).toBe(true)
    })
  }

  for (const op of ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'ln', 'log10', 'log2']) {
    it(`["${op}", x] → ${op}(x)`, () => {
      const out = convertMapboxStyle({
        version: 8, sources: { x: { type: 'vector', url: 'a.pmtiles' } },
        layers: [{
          id: 'p', type: 'fill', source: 'x', 'source-layer': 'a',
          paint: { 'fill-opacity': [op, ['get', 'v']] } as never,
        }],
      })
      expect(out).toContain(`${op}(.v)`)
      expect(parses(out)).toBe(true)
    })
  }

  for (const op of ['pi', 'e', 'ln2']) {
    it(`["${op}"] → ${op}() builtin call`, () => {
      const out = convertMapboxStyle({
        version: 8, sources: { x: { type: 'vector', url: 'a.pmtiles' } },
        layers: [{
          id: 'p', type: 'fill', source: 'x', 'source-layer': 'a',
          paint: { 'fill-opacity': ['/', ['get', 'v'], [op]] } as never,
        }],
      })
      expect(out).toContain(`${op}()`)
      expect(parses(out)).toBe(true)
    })
  }
})

describe('String operators', () => {
  it('["concat", a, b, c] → concat(a, b, c)', () => {
    const out = convertWithFontGet(['concat', ['get', 'name'], ' ', ['get', 'desc']])
    expect(out).toMatch(/concat\(\.name,\s*"\s*",\s*\.desc\)/)
    expect(parses(out)).toBe(true)
  })

  it('["downcase", x] → downcase(x)', () => {
    const out = convertWithFontGet(['downcase', ['get', 'name']])
    expect(out).toContain('downcase(.name)')
    expect(parses(out)).toBe(true)
  })

  it('["upcase", x] → upcase(x)', () => {
    const out = convertWithFontGet(['upcase', ['get', 'name']])
    expect(out).toContain('upcase(.name)')
    expect(parses(out)).toBe(true)
  })

  it('["length", arr] → length(arr)', () => {
    const out = convertMapboxStyle({
      version: 8, sources: { x: { type: 'vector', url: 'a.pmtiles' } },
      layers: [{
        id: 'p', type: 'fill', source: 'x', 'source-layer': 'a',
        paint: { 'fill-opacity': ['length', ['get', 'tags']] } as never,
      }],
    })
    expect(out).toContain('length(.tags)')
    expect(parses(out)).toBe(true)
  })
})

describe('step expression', () => {
  it('["step", input, def, s1, v1, s2, v2] → step(input, def, s1, v1, s2, v2)', () => {
    const out = convertMapboxStyle({
      version: 8, sources: { x: { type: 'vector', url: 'a.pmtiles' } },
      layers: [{
        id: 'p', type: 'fill', source: 'x', 'source-layer': 'a',
        paint: { 'fill-opacity': ['step', ['get', 'rank'], 0.1, 5, 0.5, 10, 1] } as never,
      }],
    })
    // The fill-opacity step came through as an opacity binding
    // (lower pass keeps it as a constant numeric pipeline) — we
    // care about step() landing in the output with the correct
    // operand reference, not where exactly in the pipeline.
    expect(out).toContain('step(')
    expect(out).toContain('.rank')
    expect(parses(out)).toBe(true)
  })
})

describe('let / var (substitution)', () => {
  it('["let", "x", expr, body-using-var] → expr inlined in body', () => {
    const out = convertMapboxStyle({
      version: 8, sources: { x: { type: 'vector', url: 'a.pmtiles' } },
      layers: [{
        id: 'p', type: 'fill', source: 'x', 'source-layer': 'a',
        paint: {
          'fill-opacity': ['let', 'r', ['get', 'rank'], ['*', ['var', 'r'], 0.1]],
        } as never,
      }],
    })
    // After substitution: ["*", ["get", "rank"], 0.1] → ".rank * 0.1"
    expect(out).toMatch(/\.rank\s*\*\s*0\.1/)
    expect(out).not.toContain('var')   // substituted out
    expect(out).not.toContain('let')   // ditto
    expect(parses(out)).toBe(true)
  })
})

describe('conversion casts (passthrough)', () => {
  it('["to-string", x] passes through as inner expression', () => {
    const out = convertMapboxStyle({
      version: 8, sources: { x: { type: 'vector', url: 'a.pmtiles' } },
      layers: [{
        id: 'p', type: 'symbol', source: 'x', 'source-layer': 'a',
        layout: { 'text-field': ['to-string', ['get', 'name']] } as never,
      }],
    })
    expect(out).toContain('.name')
    expect(out).not.toContain('to-string')
    expect(parses(out)).toBe(true)
  })

  it('["to-number", x] passes through (existing behavior)', () => {
    const out = convertMapboxStyle({
      version: 8, sources: { x: { type: 'vector', url: 'a.pmtiles' } },
      layers: [{
        id: 'p', type: 'fill', source: 'x', 'source-layer': 'a',
        paint: { 'fill-opacity': ['to-number', ['get', 'v']] } as never,
      }],
    })
    expect(out).toContain('.v')
    expect(parses(out)).toBe(true)
  })
})

describe('rgb / rgba constant fold', () => {
  it('["rgb", 255, 0, 128] → #ff0080 hex', () => {
    const out = convertMapboxStyle({
      version: 8, sources: { x: { type: 'vector', url: 'a.pmtiles' } },
      layers: [{
        id: 'p', type: 'fill', source: 'x', 'source-layer': 'a',
        paint: { 'fill-color': ['rgb', 255, 0, 128] } as never,
      }],
    })
    expect(out).toContain('#ff0080')
    expect(parses(out)).toBe(true)
  })

  it('["rgba", 255, 0, 128, 0.5] → #ff008080 hex', () => {
    const out = convertMapboxStyle({
      version: 8, sources: { x: { type: 'vector', url: 'a.pmtiles' } },
      layers: [{
        id: 'p', type: 'fill', source: 'x', 'source-layer': 'a',
        paint: { 'fill-color': ['rgba', 255, 0, 128, 0.5] } as never,
      }],
    })
    expect(out).toContain('#ff0080')  // alpha 0.5 → 0x80; full = #ff008080
    expect(parses(out)).toBe(true)
  })
})

describe('non-identifier field name guard (regression)', () => {
  it('["get", "name:latin"] is dropped to null with warning', () => {
    // Real-world repro: OpenFreeMap Bright text-field uses
    // ["concat", ["get", "name:latin"], " ", ["get", "name:nonlatin"]]
    // for bilingual labels. Without the guard, the converter emitted
    // `.name:latin` which the lexer rejected (the `:` token starts
    // a modifier).
    const out = convertMapboxStyle({
      version: 8, sources: { x: { type: 'vector', url: 'a.pmtiles' } },
      layers: [{
        id: 'p', type: 'symbol', source: 'x', 'source-layer': 'a',
        layout: {
          'text-field': ['coalesce',
            ['concat', ['get', 'name:latin'], ' ', ['get', 'name:nonlatin']],
            ['get', 'name'],
          ],
        } as never,
      }],
    })
    expect(out).not.toContain('.name:latin')
    expect(out).not.toContain('.name:nonlatin')
    // The fallback `.name` survives.
    expect(out).toContain('.name')
    expect(parses(out)).toBe(true)
  })

  it('text-field token "{name:latin}" falls back to ".name"', () => {
    const out = convertMapboxStyle({
      version: 8, sources: { x: { type: 'vector', url: 'a.pmtiles' } },
      layers: [{
        id: 'p', type: 'symbol', source: 'x', 'source-layer': 'a',
        layout: { 'text-field': '{name:latin}' } as never,
      }],
    })
    expect(out).toContain('.name')
    expect(out).not.toMatch(/\.name:latin/)
    expect(parses(out)).toBe(true)
  })
})
