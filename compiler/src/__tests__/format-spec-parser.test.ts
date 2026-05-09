import { describe, it, expect } from 'vitest'
import { parseFormatSpec, GIS_TYPES } from '../format/spec-parser'

describe('parseFormatSpec', () => {
  describe('empty', () => {
    it('returns empty spec for empty string', () => {
      const { spec, consumed } = parseFormatSpec('')
      expect(spec).toEqual({})
      expect(consumed).toBe(0)
    })
  })

  describe('numeric specs (Python compat)', () => {
    it('".4f" → precision 4 fixed', () => {
      const { spec, consumed } = parseFormatSpec('.4f')
      expect(spec).toEqual({ precision: 4, type: 'f' })
      expect(consumed).toBe(3)
    })

    it('",.0f" → grouping comma, precision 0, fixed', () => {
      const { spec } = parseFormatSpec(',.0f')
      expect(spec).toEqual({ grouping: ',', precision: 0, type: 'f' })
    })

    it('"+.3e" → force sign, precision 3, scientific', () => {
      const { spec } = parseFormatSpec('+.3e')
      expect(spec).toEqual({ sign: '+', precision: 3, type: 'e' })
    })

    it('"03d" → zero pad, width 3, integer', () => {
      const { spec } = parseFormatSpec('03d')
      expect(spec).toEqual({ zero: true, width: 3, type: 'd' })
    })

    it('"03.0f" → zero pad, width 3, precision 0, fixed', () => {
      const { spec } = parseFormatSpec('03.0f')
      expect(spec).toEqual({ zero: true, width: 3, precision: 0, type: 'f' })
    })

    it('".1%" → precision 1 percent', () => {
      const { spec } = parseFormatSpec('.1%')
      expect(spec).toEqual({ precision: 1, type: '%' })
    })

    it('"_.2f" → underscore grouping', () => {
      const { spec } = parseFormatSpec('_.2f')
      expect(spec).toEqual({ grouping: '_', precision: 2, type: 'f' })
    })
  })

  describe('alignment + fill', () => {
    it('">10" → right-align width 10, no fill', () => {
      const { spec } = parseFormatSpec('>10')
      expect(spec).toEqual({ align: '>', width: 10 })
    })

    it('"<20" → left-align width 20', () => {
      const { spec } = parseFormatSpec('<20')
      expect(spec).toEqual({ align: '<', width: 20 })
    })

    it('"*^15s" → fill *, center, width 15, string', () => {
      const { spec } = parseFormatSpec('*^15s')
      expect(spec).toEqual({ fill: '*', align: '^', width: 15, type: 's' })
    })

    it('first char that is NOT followed by align is treated as align/sign/etc, not fill', () => {
      // ">10" — '>' is align, no fill (fill defaults to space)
      const { spec } = parseFormatSpec('>10')
      expect(spec.fill).toBeUndefined()
    })
  })

  describe('GIS types', () => {
    it('"dms" → degrees-minutes-seconds', () => {
      const { spec, consumed } = parseFormatSpec('dms')
      expect(spec).toEqual({ type: 'dms' })
      expect(consumed).toBe(3)
    })

    it('"dm" → degrees-minutes', () => {
      const { spec } = parseFormatSpec('dm')
      expect(spec).toEqual({ type: 'dm' })
    })

    it('"mgrs" → MGRS', () => {
      const { spec } = parseFormatSpec('mgrs')
      expect(spec).toEqual({ type: 'mgrs' })
    })

    it('"utm" → UTM', () => {
      const { spec } = parseFormatSpec('utm')
      expect(spec).toEqual({ type: 'utm' })
    })

    it('"bearing" → 3-digit bearing', () => {
      const { spec } = parseFormatSpec('bearing')
      expect(spec).toEqual({ type: 'bearing' })
    })

    it('partial consumption: "dmsx" parses "d" as int type, leaves "msx"', () => {
      // GIS prefix matcher rejects "dms" because next char isn't ';'
      // or end. Parser falls through to single-char path, takes 'd'
      // as integer type, returns consumed=1. The TEMPLATE parser
      // (1c-3) is responsible for verifying full consumption.
      const { spec, consumed } = parseFormatSpec('dmsx')
      expect(spec).toEqual({ type: 'd' })
      expect(consumed).toBe(1)
    })

    it('GIS_TYPES set is exposed for converter use', () => {
      expect(GIS_TYPES.has('dms')).toBe(true)
      expect(GIS_TYPES.has('mgrs')).toBe(true)
      expect(GIS_TYPES.has('foo')).toBe(false)
    })
  })

  describe('strftime types', () => {
    it('"%Y-%m-%d" → date format', () => {
      const { spec, consumed } = parseFormatSpec('%Y-%m-%d')
      expect(spec).toEqual({ type: '%Y-%m-%d' })
      expect(consumed).toBe(8)
    })

    it('"%H:%M:%SZ" → time format', () => {
      const { spec } = parseFormatSpec('%H:%M:%SZ')
      expect(spec.type).toBe('%H:%M:%SZ')
    })

    it('strftime + locale', () => {
      const { spec, consumed } = parseFormatSpec('%H:%M;ko-KR')
      expect(spec).toEqual({ type: '%H:%M', locale: 'ko-KR' })
      expect(consumed).toBe(11)
    })
  })

  describe('locale tail', () => {
    it('".4f;C" → deterministic POSIX', () => {
      const { spec } = parseFormatSpec('.4f;C')
      expect(spec).toEqual({ precision: 4, type: 'f', locale: 'C' })
    })

    it('",;ko-KR" → grouping with Korean locale', () => {
      const { spec } = parseFormatSpec(',;ko-KR')
      expect(spec).toEqual({ grouping: ',', locale: 'ko-KR' })
    })

    it('GIS type + locale', () => {
      const { spec } = parseFormatSpec('mgrs;C')
      expect(spec).toEqual({ type: 'mgrs', locale: 'C' })
    })

    it('empty locale throws', () => {
      expect(() => parseFormatSpec('.4f;')).toThrow(/empty locale/)
    })
  })

  describe('error cases', () => {
    it('precision dot without digits throws', () => {
      expect(() => parseFormatSpec('.f')).toThrow(/precision digits/)
    })

    it('unknown single-char type throws', () => {
      expect(() => parseFormatSpec('z')).toThrow(/unknown type/)
    })
  })

  describe('combined complex specs', () => {
    it('"+10,.3f" full numeric chain', () => {
      const { spec } = parseFormatSpec('+10,.3f')
      expect(spec).toEqual({
        sign: '+',
        width: 10,
        grouping: ',',
        precision: 3,
        type: 'f',
      })
    })

    it('"0>5d" zero fill, right-align, width 5, integer', () => {
      const { spec } = parseFormatSpec('0>5d')
      expect(spec).toEqual({ fill: '0', align: '>', width: 5, type: 'd' })
    })
  })
})
