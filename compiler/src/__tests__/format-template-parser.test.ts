import { describe, it, expect } from 'vitest'
import {
  parseTextTemplate,
  isBareExpressionTemplate,
} from '../format/template-parser'

describe('parseTextTemplate', () => {
  describe('plain literals', () => {
    it('empty input → []', () => {
      expect(parseTextTemplate('')).toEqual([])
    })

    it('plain text → single literal', () => {
      expect(parseTextTemplate('Hello world')).toEqual([
        { kind: 'literal', text: 'Hello world' },
      ])
    })
  })

  describe('bare interpolation', () => {
    it('"{name}" → single interp, no spec', () => {
      expect(parseTextTemplate('{name}')).toEqual([
        { kind: 'interp', text: 'name' },
      ])
    })

    it('"{.name}" → field access syntax', () => {
      expect(parseTextTemplate('{.name}')).toEqual([
        { kind: 'interp', text: '.name' },
      ])
    })

    it('whitespace inside braces is trimmed', () => {
      expect(parseTextTemplate('{  name  }')).toEqual([
        { kind: 'interp', text: 'name' },
      ])
    })

    it('isBareExpressionTemplate detects single bare interp', () => {
      expect(isBareExpressionTemplate(parseTextTemplate('{name}'))).toBe(true)
      expect(isBareExpressionTemplate(parseTextTemplate('{name:.4f}'))).toBe(false)
      expect(isBareExpressionTemplate(parseTextTemplate('a{name}'))).toBe(false)
      expect(isBareExpressionTemplate(parseTextTemplate('hello'))).toBe(false)
    })
  })

  describe('mixed literal + interpolation', () => {
    it('literal + interp', () => {
      expect(parseTextTemplate('Hello {name}')).toEqual([
        { kind: 'literal', text: 'Hello ' },
        { kind: 'interp', text: 'name' },
      ])
    })

    it('interp + literal', () => {
      expect(parseTextTemplate('{name}!')).toEqual([
        { kind: 'interp', text: 'name' },
        { kind: 'literal', text: '!' },
      ])
    })

    it('literal + interp + literal', () => {
      expect(parseTextTemplate('Lat: {lat}°N')).toEqual([
        { kind: 'literal', text: 'Lat: ' },
        { kind: 'interp', text: 'lat' },
        { kind: 'literal', text: '°N' },
      ])
    })

    it('multiple interps', () => {
      expect(parseTextTemplate('{name} ({country})')).toEqual([
        { kind: 'interp', text: 'name' },
        { kind: 'literal', text: ' (' },
        { kind: 'interp', text: 'country' },
        { kind: 'literal', text: ')' },
      ])
    })
  })

  describe('format specs', () => {
    it('"{lat:.4f}" → numeric spec', () => {
      expect(parseTextTemplate('{lat:.4f}')).toEqual([
        { kind: 'interp', text: 'lat', spec: { precision: 4, type: 'f' } },
      ])
    })

    it('"{coord:dms}" → GIS spec', () => {
      expect(parseTextTemplate('{coord:dms}')).toEqual([
        { kind: 'interp', text: 'coord', spec: { type: 'dms' } },
      ])
    })

    it('"{ts:%H:%M:%S}" → strftime', () => {
      // The `:` between '%H' and '%M' is INSIDE the spec, not a
      // second separator — first colon at depth 0 splits expr
      // from spec, the rest is spec content.
      expect(parseTextTemplate('{ts:%H:%M:%S}')).toEqual([
        { kind: 'interp', text: 'ts', spec: { type: '%H:%M:%S' } },
      ])
    })

    it('"Lat: {lat:.4f}°N" — full template', () => {
      expect(parseTextTemplate('Lat: {lat:.4f}°N')).toEqual([
        { kind: 'literal', text: 'Lat: ' },
        { kind: 'interp', text: 'lat', spec: { precision: 4, type: 'f' } },
        { kind: 'literal', text: '°N' },
      ])
    })

    it('multiple specs', () => {
      expect(parseTextTemplate('[{lat:.6f}, {lon:.6f}]')).toEqual([
        { kind: 'literal', text: '[' },
        { kind: 'interp', text: 'lat', spec: { precision: 6, type: 'f' } },
        { kind: 'literal', text: ', ' },
        { kind: 'interp', text: 'lon', spec: { precision: 6, type: 'f' } },
        { kind: 'literal', text: ']' },
      ])
    })

    it('locale tail in spec', () => {
      expect(parseTextTemplate('{n:,.2f;C}')).toEqual([
        { kind: 'interp', text: 'n', spec: { grouping: ',', precision: 2, type: 'f', locale: 'C' } },
      ])
    })
  })

  describe('escape sequences', () => {
    it('"\\\\{x\\\\}" → literal "{x}"', () => {
      expect(parseTextTemplate('\\{x\\}')).toEqual([
        { kind: 'literal', text: '{x}' },
      ])
    })

    it('"\\\\\\\\" → literal "\\\\"', () => {
      expect(parseTextTemplate('\\\\')).toEqual([
        { kind: 'literal', text: '\\' },
      ])
    })

    it('escape mixed with interp', () => {
      expect(parseTextTemplate('Set \\{key\\}={val}')).toEqual([
        { kind: 'literal', text: 'Set {key}=' },
        { kind: 'interp', text: 'val' },
      ])
    })

    it('non-recognised escape preserved verbatim (paths)', () => {
      expect(parseTextTemplate('C:\\Users\\file')).toEqual([
        { kind: 'literal', text: 'C:\\Users\\file' },
      ])
    })
  })

  describe('brace depth (nested expressions)', () => {
    it('match expression with braces inside interp', () => {
      // expression: `match(.kind) { city -> .name, _ -> "?" }`
      const out = parseTextTemplate('{match(.kind) { city -> .name, _ -> "?" }}')
      expect(out).toHaveLength(1)
      expect(out[0]!.kind).toBe('interp')
      expect((out[0] as { text: string }).text).toBe('match(.kind) { city -> .name, _ -> "?" }')
    })

    it('colon inside nested braces is part of expression, not spec', () => {
      // First `:` at depth 0 splits — the inner colon stays in expr.
      const out = parseTextTemplate('{f({a: 1}):.2f}')
      expect(out).toEqual([
        { kind: 'interp', text: 'f({a: 1})', spec: { precision: 2, type: 'f' } },
      ])
    })
  })

  describe('error cases', () => {
    it('unmatched } throws', () => {
      expect(() => parseTextTemplate('hello}')).toThrow(/unmatched '\}'/)
    })

    it('unclosed { throws', () => {
      expect(() => parseTextTemplate('hello {name')).toThrow(/unclosed '\{'/)
    })

    it('empty {} throws', () => {
      expect(() => parseTextTemplate('hello {}')).toThrow(/empty expression/)
    })

    it('trailing chars after spec throws', () => {
      // Spec parser consumes "f" then sees trailing "X" — template
      // detects the gap and errors clearly so the user knows where.
      expect(() => parseTextTemplate('{x:fX}')).toThrow(/trailing characters/)
    })

    it('malformed spec throws', () => {
      expect(() => parseTextTemplate('{x:.f}')).toThrow(/precision digits/)
    })
  })
})
