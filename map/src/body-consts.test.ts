// ═══ Body → GPU-const injection: byte-identity + single-sourced e2 (#798 P3 / #1152 INC-3) ═══
//
// The GPU half of the Body authority. Guarantees:
//   1. EARTH is BYTE-IDENTICAL at the compiled f32 — configureBodyConsts(EARTH)
//      emits the shipped radius/axis WGSL verbatim (A/R goldens from origin/main)
//      and respells e2 to an f32-identical value (guarantee #3), so the test
//      proves invariance, not self-consistency. Compiled-f32 DC=0 by construction.
//   2. A non-Earth body injects its radius / eccentricity into the GPU consts.
//   3. The CPU/GPU e2 is SINGLE-SOURCED (#1152 INC-3 un-pinned #798 PIN #2): the GPU
//      WGS84_E2 / EARTH_E2 now spell EARTH.e2's f·(2−f) value, not the retired
//      divergent literal (0.0066943799901975955). They differ by 5.63e-14 absolute,
//      four orders below the f32 ULP at 0.0067, so Math.fround collapses both to the
//      identical f32 — the compiled shader constant is bit-unchanged (zero GPU delta),
//      which is why the "byte-identical Earth" golden (below) still holds.

import { afterEach, describe, expect, it } from 'vitest'
import { emitConst } from '@xgis/shader-dsl'
import { EARTH, MOON, MARS_IAU2000 } from '@xgis/shared'
import { ECEF_CONSTS } from './shaders/dsl/ecef'
import { PROJECTION_CONSTS } from './shaders/dsl/projections'
import { configureBodyConsts } from './body-consts'

const ecefBlock = (): string => ECEF_CONSTS.map(emitConst).join('\n')
const projBlock = (): string => PROJECTION_CONSTS.map(emitConst).join('\n')
const valOf = (arr: typeof ECEF_CONSTS, name: string): number =>
  arr.find((c) => c.name === name)!.wgslValue

// ── Goldens: emitConst output for the shipped Earth defaults. WGS84_E2 / EARTH_E2
//    now spell EARTH.e2 (single-sourced); WGS84_A / EARTH_R keep the spelled radius
//    default (the byte-identical-Earth guarantee needs the number spelled). ──
const GOLDEN_ECEF = 'const WGS84_A: f32 = 6378137.0;\nconst WGS84_E2: f32 = 0.0066943799901413165;'
const GOLDEN_PROJ =
  'const PI: f32 = 3.14159265;\n' +
  'const EARTH_R: f32 = 6378137.0;\n' +
  'const EARTH_E2: f32 = 0.0066943799901413165;\n' +
  'const MERCATOR_LAT_LIMIT: f32 = 85.051129;\n' +
  'const DEG2RAD: f32 = 0.01745329;'

// The RETIRED divergent GPU e2 literal (#798 PIN #2), kept ONLY to prove the
// zero-compiled-delta identity below. It is no longer spelled in any src.
// Parsed from a string on purpose: written as a numeric literal it would trip
// no-loss-of-precision (the f64-rounding it exercises IS the point of the test).
const RETIRED_GPU_E2 = Number('0.0066943799901975955')

afterEach(() => configureBodyConsts(EARTH)) // restore byte-identical Earth for isolation

describe('Body GPU-const injection (#798 P3 / #1152 INC-3)', () => {
  it('shipped default emit === golden (byte-identical Earth)', () => {
    // The shipped ConstDecl defaults ARE Earth — no configure needed.
    expect(ecefBlock()).toBe(GOLDEN_ECEF)
    expect(projBlock()).toBe(GOLDEN_PROJ)
  })

  it('configureBodyConsts(EARTH) restores the golden after perturbation (uniform route)', () => {
    configureBodyConsts(MARS_IAU2000) // perturb to a non-Earth body
    configureBodyConsts(EARTH) // restore (no === EARTH special case; body.e2 is EARTH.e2)
    expect(ecefBlock()).toBe(GOLDEN_ECEF)
    expect(projBlock()).toBe(GOLDEN_PROJ)
  })

  it('single-sourced e2: GPU WGS84_E2 === EARTH.e2 (bit) AND is a zero-delta respell of the retired literal', () => {
    configureBodyConsts(EARTH)
    const e2 = valOf(ECEF_CONSTS, 'WGS84_E2')
    // #1152 INC-3 — the divergence is GONE: the GPU e2 IS Body.e2, bit-for-bit.
    expect(Object.is(e2, EARTH.e2)).toBe(true) // 0.0066943799901413165
    // ...and the respell is provably zero-delta at f32 (the compiled shader constant):
    // Math.fround(new) === Math.fround(retired) ⟹ identical GPU literal ⟹ DC=0.
    expect(Math.fround(EARTH.e2)).toBe(Math.fround(RETIRED_GPU_E2))
    expect(e2).not.toBe(RETIRED_GPU_E2) // the f64 source value did change (by 5.63e-14)
  })

  it('EARTH_E2 (proj_globe) and WGS84_E2 (lonlat_to_ecef) are two names for the ONE body.e2', () => {
    configureBodyConsts(EARTH)
    // Cross-array bit-equality — the two-names-one-value invariant (EARTH_R/WGS84_A precedent).
    expect(Object.is(valOf(PROJECTION_CONSTS, 'EARTH_E2'), valOf(ECEF_CONSTS, 'WGS84_E2'))).toBe(
      true,
    )
    expect(Object.is(valOf(PROJECTION_CONSTS, 'EARTH_E2'), EARTH.e2)).toBe(true)
  })

  it('EARTH value fields are the exact shipped doubles (covers WGSL + GLSL emit)', () => {
    configureBodyConsts(EARTH)
    // GLSL emitConst reads the SAME wgslValue/cpuValue fields, so field-identity
    // proves byte-identity on both backends without a private GLSL accessor.
    for (const [arr, name, expected] of [
      [PROJECTION_CONSTS, 'EARTH_R', 6378137],
      [PROJECTION_CONSTS, 'EARTH_E2', EARTH.e2],
      [ECEF_CONSTS, 'WGS84_A', 6378137],
      [ECEF_CONSTS, 'WGS84_E2', EARTH.e2],
    ] as const) {
      const c = arr.find((d) => d.name === name)!
      expect(c.wgslValue).toBe(expected)
      expect(c.cpuValue).toBe(expected)
    }
  })

  it('Mars (IAU2000 ellipsoid) injects sphereR + e2 into the GPU consts (both e2 names)', () => {
    configureBodyConsts(MARS_IAU2000)
    expect(projBlock()).toContain('const EARTH_R: f32 = 3396190.0;')
    expect(ecefBlock()).toContain('const WGS84_A: f32 = 3396190.0;')
    expect(valOf(ECEF_CONSTS, 'WGS84_E2')).toBe(MARS_IAU2000.e2)
    expect(valOf(PROJECTION_CONSTS, 'EARTH_E2')).toBe(MARS_IAU2000.e2)
    expect(valOf(ECEF_CONSTS, 'WGS84_E2')).toBeGreaterThan(0) // oblate
  })

  it('Moon injects a perfect sphere: radius 1737400, e2 = 0 (proj_globe degenerates to sphere)', () => {
    configureBodyConsts(MOON)
    expect(projBlock()).toContain('const EARTH_R: f32 = 1737400.0;')
    expect(ecefBlock()).toContain('const WGS84_A: f32 = 1737400.0;')
    expect(valOf(ECEF_CONSTS, 'WGS84_E2')).toBe(0)
    expect(valOf(PROJECTION_CONSTS, 'EARTH_E2')).toBe(0) // N → EARTH_R, z → EARTH_R·sinφ
  })
})
