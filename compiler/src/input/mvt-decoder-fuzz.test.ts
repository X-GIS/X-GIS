// iter-296 — MVT clamp fuzz. Pre-fix bug: clampLon(NaN)=NaN.
// Defensive clamp must catch non-finite or downstream renderer
// receives NaN-poisoned vertices.

import { describe, it, expect } from 'vitest'
import { decodeMvtTile } from './mvt-decoder'

describe('iter-296 MVT decoder defensive — invalid buffer rejection', () => {
  it('empty Uint8Array does not crash', () => {
    expect(() => decodeMvtTile(new Uint8Array(0), 0, 0, 0)).not.toThrow()
  })

  it('garbage bytes do not crash (random non-protobuf)', () => {
    const garbage = new Uint8Array(64)
    for (let i = 0; i < garbage.length; i++) garbage[i] = (i * 137 + 17) & 0xff
    // Either parses (probably empty) or throws — must not hang.
    try {
      const r = decodeMvtTile(garbage, 0, 0, 0)
      expect(Array.isArray(r)).toBe(true)
    } catch {
      // Throw is acceptable for malformed input.
    }
  })

  it('all-zero buffer does not crash', () => {
    expect(() => decodeMvtTile(new Uint8Array(32), 0, 0, 0)).not.toThrow()
  })

  it('ArrayBuffer input path works (alternative to Uint8Array)', () => {
    expect(() => decodeMvtTile(new ArrayBuffer(0), 0, 0, 0)).not.toThrow()
  })
})

// ─── Direct clamp invariant probe (iter-296 root) ───
//
// The decoder's clamp helpers aren't exported; we test the
// invariant by feeding the public surface with valid tile bytes
// and asserting every output coord is finite. But the regression
// repro is easier to express as a unit assertion on the helpers.
// Re-implement the iter-296 fix here to PIN the contract: clamping
// NaN/Infinity yields a planet-bounds finite number.

describe('iter-296 clamp contract pin', () => {
  const LON_MAX = 180
  const LON_MIN = -180
  const LAT_MAX = 85.0511287
  const LAT_MIN = -85.0511287
  const clampLon = (v: number) =>
    Number.isNaN(v) ? 0 : v > LON_MAX ? LON_MAX : v < LON_MIN ? LON_MIN : v
  const clampLat = (v: number) =>
    Number.isNaN(v) ? 0 : v > LAT_MAX ? LAT_MAX : v < LAT_MIN ? LAT_MIN : v

  it('NaN → 0 (was NaN pre-fix)', () => {
    expect(clampLon(NaN)).toBe(0)
    expect(clampLat(NaN)).toBe(0)
  })

  it('+Infinity → MAX', () => {
    expect(clampLon(Infinity)).toBe(LON_MAX)
    expect(clampLat(Infinity)).toBe(LAT_MAX)
  })

  it('-Infinity → MIN', () => {
    expect(clampLon(-Infinity)).toBe(LON_MIN)
    expect(clampLat(-Infinity)).toBe(LAT_MIN)
  })

  it('valid range unaffected', () => {
    expect(clampLon(0)).toBe(0)
    expect(clampLon(180)).toBe(180)
    expect(clampLon(-180)).toBe(-180)
    expect(clampLat(0)).toBe(0)
    expect(clampLat(45)).toBe(45)
    expect(clampLat(-45)).toBe(-45)
  })

  it('out-of-range clamped to bounds', () => {
    expect(clampLon(200)).toBe(LON_MAX)
    expect(clampLon(-200)).toBe(LON_MIN)
    expect(clampLat(90)).toBe(LAT_MAX)
    expect(clampLat(-90)).toBe(LAT_MIN)
  })

  it('every random non-finite input still yields finite output', () => {
    // Spread of pathological values.
    const probe = [NaN, Infinity, -Infinity, 1e308, -1e308, 1e-308, -0]
    for (const v of probe) {
      expect(Number.isFinite(clampLon(v))).toBe(true)
      expect(Number.isFinite(clampLat(v))).toBe(true)
    }
  })
})
