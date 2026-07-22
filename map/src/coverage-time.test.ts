import { describe, expect, it } from 'vitest'
import { resolveForecastGroup } from './coverage-time'
import type { CoverageTime } from '@xgis/data'

const axis = (over: Partial<CoverageTime> = {}): CoverageTime => ({
  index: 0,
  count: 48,
  valueISO: null,
  firstISO: '2026-07-22T00:00:00Z',
  intervalSeconds: 3600,
  ...over,
})

describe('resolveForecastGroup (#1272 E-③)', () => {
  it('maps a 0-based hour index to a 1-based group', () => {
    expect(resolveForecastGroup(axis(), 0)).toBe(1)
    expect(resolveForecastGroup(axis(), 5)).toBe(6)
    expect(resolveForecastGroup(axis(), 47)).toBe(48)
  })

  it('clamps an out-of-range index to the axis ends (never throws — play can wrap)', () => {
    expect(resolveForecastGroup(axis({ count: 48 }), -3)).toBe(1)
    expect(resolveForecastGroup(axis({ count: 48 }), 999)).toBe(48)
  })

  it('maps an ISO valid-time onto the regular axis (nearest hour)', () => {
    // firstISO 00:00Z, hourly → 03:00Z is hour index 3 → group 4
    expect(resolveForecastGroup(axis(), '2026-07-22T03:00:00Z')).toBe(4)
    // 02:40Z rounds to hour 3 → group 4
    expect(resolveForecastGroup(axis(), '2026-07-22T02:40:00Z')).toBe(4)
    // before the first record clamps to group 1
    expect(resolveForecastGroup(axis(), '2026-07-21T23:00:00Z')).toBe(1)
  })

  it('throws for an ISO time when the cell has no regular axis (interval 0)', () => {
    expect(() =>
      resolveForecastGroup(axis({ intervalSeconds: 0 }), '2026-07-22T03:00:00Z'),
    ).toThrow(/regular time axis/)
  })
})
