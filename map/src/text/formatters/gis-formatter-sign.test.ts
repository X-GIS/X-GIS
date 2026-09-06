import { describe, it, expect } from 'vitest'
import { formatDMS, formatDM } from './gis-formatter'
import { formatValue } from '../format-value'

// #2328: with no axis hint the suffix is documented as OMITTED (gis-formatter.ts:17-22),
// but a negative value's sign was emitted as a trailing '-' after the seconds/minutes
// instead of a leading '-' before the degrees — the label reads as positive with a
// stray trailing dash. Sign must lead, and the axis-suffix arms must be untouched.

describe('gis-formatter: negative value with no axis hint', () => {
  it('formatDMS(-37.5665) leads with "-", does not trail it', () => {
    const out = formatDMS(-37.5665)
    expect(out.endsWith('-')).toBe(false)
    expect(out).toBe(`-37°33'59.4"`)
  })

  it('formatDM(-122.4) leads with "-", does not trail it', () => {
    const out = formatDM(-122.4)
    expect(out.endsWith('-')).toBe(false)
    expect(out).toBe(`-122°24.000'`)
  })

  it('formatValue(-37.5665, {type:"dms"}) — the only template-reachable arm', () => {
    const out = formatValue(-37.5665, { type: 'dms' })
    expect(out.endsWith('-')).toBe(false)
    expect(out).toBe(`-37°33'59.4"`)
  })

  it('formatValue(-122.4, {type:"dm"})', () => {
    const out = formatValue(-122.4, { type: 'dm' })
    expect(out.endsWith('-')).toBe(false)
    expect(out).toBe(`-122°24.000'`)
  })

  it('axis suffix arms are unaffected by the fix', () => {
    expect(formatDMS(-37.5665, 'lat')).toBe(`37°33'59.4"S`)
    expect(formatDM(-122.4, 'lon')).toBe(`122°24.000'W`)
  })
})
