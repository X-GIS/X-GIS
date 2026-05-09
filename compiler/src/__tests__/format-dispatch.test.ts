import { describe, it, expect } from 'vitest'
import {
  formatValue, formatNumber, formatString, formatDMS, formatDM,
  formatBearing, formatDate, parseFormatSpec,
} from '../format'

describe('formatValue dispatch', () => {
  it('no spec → String coercion', () => {
    expect(formatValue('Seoul', undefined)).toBe('Seoul')
    expect(formatValue(42, {})).toBe('42')
    expect(formatValue(null, undefined)).toBe('')
  })

  it('routes "f" to numeric', () => {
    expect(formatValue(3.14159, { precision: 2, type: 'f' })).toBe('3.14')
  })

  it('routes "s" to string', () => {
    expect(formatValue('hi', { width: 5, type: 's' })).toBe('hi   ')
  })

  it('routes "dms" to GIS', () => {
    const out = formatValue(37.5665, { type: 'dms', precision: 1 })
    expect(out).toMatch(/37°33'59\.\d"/)
  })

  it('routes "%Y" prefix to datetime', () => {
    const out = formatValue('2026-05-09T12:00:00Z', { type: '%Y-%m-%d', locale: 'C' })
    expect(out).toBe('2026-05-09')
  })

  it('routes "bearing" to 3-digit pad', () => {
    expect(formatValue(5, { type: 'bearing' })).toBe('005°')
    expect(formatValue(45, { type: 'bearing' })).toBe('045°')
    expect(formatValue(360, { type: 'bearing' })).toBe('000°')  // wrap
  })

  it('falls back gracefully on string + numeric spec', () => {
    expect(formatValue('foo', { precision: 4, type: 'f', width: 6 })).toBe('   foo')
  })
})

describe('formatNumber', () => {
  it('toFixed precision', () => {
    expect(formatNumber(3.14159, { precision: 2, type: 'f' })).toBe('3.14')
    expect(formatNumber(3.14159, { precision: 4, type: 'f' })).toBe('3.1416')
  })

  it('grouping with comma', () => {
    expect(formatNumber(1234567, { grouping: ',', type: 'd' })).toBe('1,234,567')
    expect(formatNumber(1234.5, { grouping: ',', precision: 2, type: 'f' })).toBe('1,234.50')
  })

  it('grouping with underscore', () => {
    expect(formatNumber(1234567, { grouping: '_', type: 'd' })).toBe('1_234_567')
  })

  it('force-sign', () => {
    expect(formatNumber(5, { sign: '+', type: 'd' })).toBe('+5')
    expect(formatNumber(-5, { sign: '+', type: 'd' })).toBe('-5')
    expect(formatNumber(5, { sign: ' ', type: 'd' })).toBe(' 5')
  })

  it('zero pad with width', () => {
    expect(formatNumber(5, { zero: true, width: 3, type: 'd' })).toBe('005')
    expect(formatNumber(45, { zero: true, width: 5, precision: 1, type: 'f' })).toBe('045.0')
  })

  it('percent', () => {
    expect(formatNumber(0.5, { precision: 1, type: '%' })).toBe('50.0%')
    expect(formatNumber(0.6342, { precision: 2, type: '%' })).toBe('63.42%')
  })

  it('scientific', () => {
    expect(formatNumber(12345, { precision: 2, type: 'e' })).toBe('1.23e+4')
  })

  it('right-align width', () => {
    expect(formatNumber(42, { width: 5, type: 'd' })).toBe('   42')
  })

  it('NaN/Infinity passthrough', () => {
    expect(formatNumber(NaN, { type: 'f' })).toBe('NaN')
    expect(formatNumber(Infinity, { type: 'f' })).toBe('Infinity')
  })

  it("locale 'C' is deterministic (no Intl)", () => {
    // toFixed is byte-identical across V8 versions for normal floats.
    expect(formatNumber(1234.5, { precision: 2, type: 'f', locale: 'C', grouping: ',' }))
      .toBe('1,234.50')
  })
})

describe('formatString', () => {
  it('left-align by default', () => {
    expect(formatString('hi', { width: 5 })).toBe('hi   ')
  })

  it('right-align with explicit >', () => {
    expect(formatString('hi', { width: 5, align: '>' })).toBe('   hi')
  })

  it('center align', () => {
    expect(formatString('hi', { width: 6, align: '^' })).toBe('  hi  ')
  })

  it('truncate via precision', () => {
    expect(formatString('helloworld', { precision: 5 })).toBe('hello')
  })

  it('fill char', () => {
    expect(formatString('hi', { width: 5, fill: '*', align: '>' })).toBe('***hi')
  })
})

describe('GIS formatters', () => {
  it('formatDMS basic', () => {
    expect(formatDMS(37.5665)).toBe(`37°33'59.4"`)
  })

  it('formatDMS with N axis', () => {
    expect(formatDMS(37.5665, 'lat')).toBe(`37°33'59.4"N`)
  })

  it('formatDMS with S axis (negative)', () => {
    expect(formatDMS(-37.5665, 'lat')).toBe(`37°33'59.4"S`)
  })

  it('formatDMS with E axis', () => {
    expect(formatDMS(126.978, 'lon', 1)).toMatch(/126°58'\d{1,2}\.\d"E/)
  })

  it('formatDM', () => {
    expect(formatDM(37.5665, 'lat', 3)).toBe(`37°33.990'N`)
  })

  it('formatBearing pads to 3 digits', () => {
    expect(formatBearing(0)).toBe('000°')
    expect(formatBearing(5)).toBe('005°')
    expect(formatBearing(45)).toBe('045°')
    expect(formatBearing(180)).toBe('180°')
    expect(formatBearing(360)).toBe('000°')  // wraps
    expect(formatBearing(-90)).toBe('270°')  // negative wraps
  })
})

describe('formatDate', () => {
  it('strftime UTC default', () => {
    expect(formatDate('2026-05-09T14:32:18Z', { type: '%Y-%m-%d %H:%M:%SZ', locale: 'C' }))
      .toBe('2026-05-09 14:32:18Z')
  })

  it('time only', () => {
    expect(formatDate('2026-05-09T14:32:18Z', { type: '%H:%M:%S', locale: 'C' }))
      .toBe('14:32:18')
  })

  it('Date object', () => {
    const d = new Date(Date.UTC(2026, 4, 9, 14, 32, 18))
    expect(formatDate(d, { type: '%Y-%m-%d', locale: 'C' })).toBe('2026-05-09')
  })

  it('Unix epoch (seconds)', () => {
    // 2026-05-09T00:00:00Z = 1778284800
    expect(formatDate(1778284800, { type: '%Y-%m-%d', locale: 'C' })).toBe('2026-05-09')
  })

  it('Unix epoch (ms)', () => {
    expect(formatDate(1778284800000, { type: '%Y-%m-%d', locale: 'C' })).toBe('2026-05-09')
  })

  it('literal % escape', () => {
    expect(formatDate('2026-05-09T00:00:00Z', { type: '%Y%%', locale: 'C' })).toBe('2026%')
  })
})

describe('end-to-end: parse spec then format', () => {
  it('"{lat:.4f}°N" — parse and apply', () => {
    const { spec } = parseFormatSpec('.4f')
    expect(formatValue(37.566535, spec)).toBe('37.5665')
  })

  it('"{pop:,}" — grouping', () => {
    const { spec } = parseFormatSpec(',')
    expect(formatValue(9733509, spec)).toBe('9,733,509')
  })

  it('"{lat:dms}" — DMS', () => {
    const { spec } = parseFormatSpec('dms')
    expect(formatValue(37.5665, spec)).toBe(`37°33'59.4"`)
  })

  it('"{brg:bearing}" — 3-digit pad', () => {
    const { spec } = parseFormatSpec('bearing')
    expect(formatValue(45, spec)).toBe('045°')
  })

  it('"{ts:%H:%M:%SZ}" — strftime', () => {
    const { spec } = parseFormatSpec('%H:%M:%SZ;C')
    expect(formatValue('2026-05-09T14:32:18Z', spec)).toBe('14:32:18Z')
  })

  it("locale 'C' deterministic", () => {
    const { spec } = parseFormatSpec(',.2f;C')
    expect(formatValue(1234.567, spec)).toBe('1,234.57')
  })
})
