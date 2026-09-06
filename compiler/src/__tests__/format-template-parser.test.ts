import { describe, it, expect } from 'vitest'
import { parseTextTemplate, isBareExpressionTemplate } from '../format/template-parser'

describe('parseTextTemplate', () => {
  describe('plain literals', () => {
    it('empty input → []', () => {
      expect(parseTextTemplate('')).toEqual([])
    })

    it('plain text → single literal', () => {
      expect(parseTextTemplate('Hello world')).toEqual([{ kind: 'literal', text: 'Hello world' }])
    })
  })

  describe('bare interpolation', () => {
    it('"{name}" → single interp, no spec', () => {
      expect(parseTextTemplate('{name}')).toEqual([{ kind: 'interp', text: 'name' }])
    })

    it('"{.name}" → field access syntax', () => {
      expect(parseTextTemplate('{.name}')).toEqual([{ kind: 'interp', text: '.name' }])
    })

    it('whitespace inside braces is trimmed', () => {
      expect(parseTextTemplate('{  name  }')).toEqual([{ kind: 'interp', text: 'name' }])
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
        {
          kind: 'interp',
          text: 'n',
          spec: { grouping: ',', precision: 2, type: 'f', locale: 'C' },
        },
      ])
    })
  })

  describe('escape sequences', () => {
    it('"\\\\{x\\\\}" → literal "{x}"', () => {
      expect(parseTextTemplate('\\{x\\}')).toEqual([{ kind: 'literal', text: '{x}' }])
    })

    it('"\\\\\\\\" → literal "\\\\"', () => {
      expect(parseTextTemplate('\\\\')).toEqual([{ kind: 'literal', text: '\\' }])
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

  describe('colons inside the expression (#2551)', () => {
    // The separator is the first depth-1 `:` that the EXPRESSION
    // grammar has not already spoken for: a `:` inside a `"…"`
    // string literal belongs to the string, and the `:` that closes
    // a ternary `? :` (parser-expressions.ts:24-29) belongs to the
    // ternary. `??` (QuestionQuestion) is one token, not a ternary.

    it('colon inside a string literal is not the spec separator', () => {
      expect(parseTextTemplate('{.name ?? "n/a: none"}')).toEqual([
        { kind: 'interp', text: '.name ?? "n/a: none"' },
      ])
    })

    it('the ternary arm colon is not the spec separator', () => {
      expect(parseTextTemplate('{.pop > 1000 ? "big" : "sml"}')).toEqual([
        { kind: 'interp', text: '.pop > 1000 ? "big" : "sml"' },
      ])
    })

    it('a ternary AND a real spec — the spec is still found', () => {
      expect(parseTextTemplate('{.pop > 1000 ? "big" : "sml":>8}')).toEqual([
        {
          kind: 'interp',
          text: '.pop > 1000 ? "big" : "sml"',
          spec: { align: '>', width: 8 },
        },
      ])
    })

    it('nested ternary consumes one colon per `?`', () => {
      expect(parseTextTemplate('{.a ? 1 : .b ? 2 : 3:d}')).toEqual([
        { kind: 'interp', text: '.a ? 1 : .b ? 2 : 3', spec: { type: 'd' } },
      ])
    })

    it('a brace inside a string literal does not close the interp', () => {
      expect(parseTextTemplate('{.name ?? "a}b"}')).toEqual([
        { kind: 'interp', text: '.name ?? "a}b"' },
      ])
    })

    it('control — a quote is a legal spec FILL char, so the spec side is not scanned as a string', () => {
      // `"^10` = fill '"', align '^', width 10. Byte-identical to
      // the pre-#2551 behaviour: the string machine models the
      // EXPRESSION and must stop at the separator.
      expect(parseTextTemplate('{x:"^10}')).toEqual([
        { kind: 'interp', text: 'x', spec: { fill: '"', align: '^', width: 10 } },
      ])
    })

    it('control — a ternary-free template still splits at its first colon', () => {
      expect(parseTextTemplate('{ts:%H:%M:%S}')).toEqual([
        { kind: 'interp', text: 'ts', spec: { type: '%H:%M:%S' } },
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

  describe('string literals and ternaries in the expression (#2551)', () => {
    it('a `:` inside a string literal is not the spec separator', () => {
      expect(parseTextTemplate('{.name ?? "n/a: none"}')).toEqual([
        { kind: 'interp', text: '.name ?? "n/a: none"' },
      ])
    })

    it('a ternary `:` separates the arms, not expr from spec', () => {
      expect(parseTextTemplate('{.pop > 1000 ? "big" : "sml"}')).toEqual([
        { kind: 'interp', text: '.pop > 1000 ? "big" : "sml"' },
      ])
    })

    it('a ternary AND a real trailing spec both survive', () => {
      // The fix must not simply stop looking for specs: the `:` after
      // the ternary's second arm is outside it and IS the separator.
      expect(parseTextTemplate('{.pop > 1000 ? "big" : "sml":>8}')).toEqual([
        { kind: 'interp', text: '.pop > 1000 ? "big" : "sml"', spec: { align: '>', width: 8 } },
      ])
    })

    it('nested ternaries consume one `:` each', () => {
      expect(parseTextTemplate('{.a ? .b : .c ? .d : .e}')).toEqual([
        { kind: 'interp', text: '.a ? .b : .c ? .d : .e' },
      ])
    })

    it('`??` is the nullish operator, not two ternary openers', () => {
      // Counting each `?` of `??` as a ternary opener would swallow
      // the separator below and lose the spec.
      expect(parseTextTemplate('{.name ?? .alt:.2f}')).toEqual([
        { kind: 'interp', text: '.name ?? .alt', spec: { precision: 2, type: 'f' } },
      ])
    })

    it('a quote used as a spec fill char still parses', () => {
      // Everything after the separator is spec text, where `"` is a
      // legal fill char — string tracking must not reach into it.
      expect(parseTextTemplate('{x:"^8}')).toEqual([
        { kind: 'interp', text: 'x', spec: { fill: '"', align: '^', width: 8 } },
      ])
    })
  })
})
