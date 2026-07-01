// Unit test for the EPSG definitions registry.
//
// Covers:
//   1. Registered codes (5179 / 5186) and proj4 built-ins resolve.
//   2. normalizeEPSG accepts EPSG:n / epsg:n / "n" / numeric n.
//   3. Unregistered or malformed EPSG throws a clear, code-bearing error.
//   4. AC0 precision regression guard: proj4js 5179/5186 reprojection to
//      EPSG:3857 matches the pyproj cross-validation reference within the
//      DECIDED 1mm tolerance (actual margin is ~6 orders below 1mm).

import { describe, expect, it } from 'vitest'
import proj4 from 'proj4'
import {
  normalizeEPSG,
  resolveEPSG,
  REGISTERED_EPSG_CODES,
} from './epsg-defs'

describe('epsg-defs registry', () => {
  it('resolves registered Korea codes', () => {
    expect(resolveEPSG('EPSG:5179')).toBe('EPSG:5179')
    expect(resolveEPSG('EPSG:5186')).toBe('EPSG:5186')
  })

  it('resolves proj4 built-ins (4326 / 3857)', () => {
    expect(resolveEPSG('EPSG:4326')).toBe('EPSG:4326')
    expect(resolveEPSG('EPSG:3857')).toBe('EPSG:3857')
  })

  it('exposes the registered codes', () => {
    expect(REGISTERED_EPSG_CODES).toContain('EPSG:5179')
    expect(REGISTERED_EPSG_CODES).toContain('EPSG:5186')
  })

  it('normalizes alternate EPSG spellings', () => {
    expect(normalizeEPSG('5179')).toBe('EPSG:5179')
    expect(normalizeEPSG(5179)).toBe('EPSG:5179')
    expect(normalizeEPSG('epsg:5186')).toBe('EPSG:5186')
    expect(normalizeEPSG('  EPSG:5179  ')).toBe('EPSG:5179')
    expect(resolveEPSG('5179')).toBe('EPSG:5179')
  })

  it('throws a clear error for an unregistered EPSG code', () => {
    expect(() => resolveEPSG('EPSG:9999')).toThrow(/Unsupported EPSG code.*EPSG:9999/)
    expect(() => resolveEPSG(9999)).toThrow(/Unsupported EPSG code/)
  })

  it('throws for malformed EPSG identifiers', () => {
    expect(() => normalizeEPSG('')).toThrow(/Invalid EPSG code/)
    expect(() => normalizeEPSG('not-an-epsg')).toThrow(/Invalid EPSG code/)
    expect(() => normalizeEPSG(-1)).toThrow(/Invalid EPSG code/)
    expect(() => normalizeEPSG(5179.5)).toThrow(/Invalid EPSG code/)
    expect(() => resolveEPSG('garbage')).toThrow(/Invalid EPSG code/)
  })
})

describe('epsg-defs AC0 precision (proj4js vs pyproj reference, at EPSG:3857)', () => {
  // DECIDED <1mm cross-validation tolerance, measured at EPSG:3857 meters.
  const TOLERANCE_M = 1e-3 // 1 mm

  // pyproj reference values (scripts/cross-validation, pyproj 3.7.2):
  //   EPSG:5179|5186 native (x,y) -> EPSG:3857 (mercX,mercY).
  const REF_5179 = [
    { srcX: 958000, srcY: 1950000, mercX: 14140305.775209341, mercY: 4515822.097062339 },
    { srcX: 1130000, srcY: 1680000, mercX: 14352025.307556191, mercY: 4178401.098306538 },
    { srcX: 900000, srcY: 1480000, mercX: 14073656.743819173, mercY: 3936098.383433227 },
    { srcX: 1200000, srcY: 2000000, mercX: 14446725.703505421, mercY: 4576311.4838990355 },
    { srcX: 750000, srcY: 2070000, mercX: 13873684.256394967, mercY: 4663915.598102761 },
  ]
  const REF_5186 = [
    { srcX: 200000, srcY: 550000, mercX: 14137575.330745745, mercY: 4515981.820923662 },
    { srcX: 380000, srcY: 280000, mercX: 14357326.160041835, mercY: 4177512.8410004033 },
    { srcX: 150000, srcY: 80000, mercX: 14077805.372541705, mercY: 3936812.2676500836 },
    { srcX: 450000, srcY: 600000, mercX: 14454247.25277895, mercY: 4574565.494437885 },
    { srcX: 200000, srcY: 500000, mercX: 14137575.330745745, mercY: 4452915.317485821 },
  ]

  function maxErr(code: string, ref: typeof REF_5179): number {
    const epsg = resolveEPSG(code)
    let worst = 0
    for (const p of ref) {
      const [mx, my] = proj4(epsg, 'EPSG:3857', [p.srcX, p.srcY])
      worst = Math.max(worst, Math.hypot(mx - p.mercX, my - p.mercY))
    }
    return worst
  }

  it('EPSG:5179 reprojection matches pyproj within 1mm', () => {
    expect(maxErr('EPSG:5179', REF_5179)).toBeLessThan(TOLERANCE_M)
  })

  it('EPSG:5186 reprojection matches pyproj within 1mm', () => {
    expect(maxErr('EPSG:5186', REF_5186)).toBeLessThan(TOLERANCE_M)
  })
})
