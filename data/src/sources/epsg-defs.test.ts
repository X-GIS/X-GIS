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
import { normalizeEPSG, resolveEPSG, utmDefFor, REGISTERED_EPSG_CODES } from './epsg-defs'

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

// ─── WGS 84 / UTM, derived from the code (#1366 INC-1) ───────────────────────
// Real IHO S-100 gridded cells arrive in UTM (a NOAA S-102 Chesapeake cell declares
// 32618). The defs are DERIVED, so these gates own the derivation rule; the numeric
// agreement with pyproj is the separate cross-validation (16 samples, 8 zones).
describe('epsg-defs: WGS 84 / UTM derivation', () => {
  it('derives north and south zones, and marks ONLY the south ones +south', () => {
    expect(utmDefFor('EPSG:32618')).toBe(
      '+proj=utm +zone=18 +datum=WGS84 +units=m +no_defs +type=crs',
    )
    expect(utmDefFor('EPSG:32718')).toBe(
      '+proj=utm +zone=18 +datum=WGS84 +units=m +south +no_defs +type=crs',
    )
    // A dropped `+south` is a ~10 000 km error (the false northing), not a subtle one.
    expect(utmDefFor('EPSG:32601')).toContain('+zone=1 ')
    expect(utmDefFor('EPSG:32760')).toContain('+south')
  })

  it('covers the whole 1-60 range for both hemispheres', () => {
    for (let zone = 1; zone <= 60; zone++) {
      expect(utmDefFor(`EPSG:${32600 + zone}`)).toContain(`+zone=${zone} `)
      expect(utmDefFor(`EPSG:${32700 + zone}`)).toContain(`+zone=${zone} `)
    }
  })

  it('does NOT claim the UPS codes that sit just past zone 60', () => {
    // The load-bearing bound. EPSG:32661 and 32766 are real codes — WGS 84 / UPS North
    // and South, POLAR STEREOGRAPHIC — not "UTM zone 61/66". Deriving a UTM def for
    // them would silently project polar data with the wrong projection.
    expect(utmDefFor('EPSG:32661')).toBeNull()
    expect(utmDefFor('EPSG:32766')).toBeNull()
    expect(() => resolveEPSG('EPSG:32661')).toThrow(/Unsupported EPSG code/)
    // …and the zone-0 slots are not codes at all.
    expect(utmDefFor('EPSG:32600')).toBeNull()
    expect(utmDefFor('EPSG:32700')).toBeNull()
  })

  it('is not fooled by neighbouring code ranges', () => {
    expect(utmDefFor('EPSG:32518')).toBeNull() // different family entirely
    expect(utmDefFor('EPSG:32818')).toBeNull()
    expect(utmDefFor('EPSG:4326')).toBeNull()
    expect(utmDefFor('WGS84')).toBeNull()
  })

  it('resolves a UTM code and actually transforms through proj4', () => {
    // Registration is lazy, so the real check is that a transform WORKS after resolve —
    // resolving the string without registering the def would throw here instead.
    expect(resolveEPSG(32618)).toBe('EPSG:32618')
    const [lon, lat] = proj4('EPSG:32618', 'EPSG:4326', [420767.84475419234, 4183856.856912584])
    // The real S-102 Chesapeake cell's grid origin: it must land in Chesapeake Bay.
    expect(lon).toBeCloseTo(-75.9, 1)
    expect(lat).toBeCloseTo(37.8, 1)
  })

  it('resolves the same UTM code twice (idempotent registration)', () => {
    expect(resolveEPSG('EPSG:32633')).toBe('EPSG:32633')
    expect(resolveEPSG('EPSG:32633')).toBe('EPSG:32633')
    expect(resolveEPSG(32633)).toBe('EPSG:32633')
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
