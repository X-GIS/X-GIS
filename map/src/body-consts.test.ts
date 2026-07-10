// ═══ Body → GPU-const injection: byte-identity + emit-snapshot invariance (#798 P3) ═══
//
// The GPU half of the Body authority. Two guarantees:
//   1. EARTH is BYTE-IDENTICAL — configureBodyConsts(EARTH) emits the EXACT
//      pre-refactor WGSL the shipped consts held (goldens captured from
//      origin/main BEFORE this seam existed, so the test proves invariance, not
//      self-consistency). Byte-identical WGSL ⟹ real-GPU DC=0 by construction.
//   2. A non-Earth body injects its radius / eccentricity into the GPU consts.
//
// The CPU/GPU e2 DIVERGENCE is preserved (issue #798 PIN #2): the GPU Earth e2
// literal (0.0066943799901975955) is NOT Body.e2 (the CPU f·(2−f) value); the
// === EARTH guard restores the GPU literal verbatim.

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

// ── Goldens captured from origin/main (pre-seam) emitConst output. ──
const GOLDEN_ECEF = 'const WGS84_A: f32 = 6378137.0;\nconst WGS84_E2: f32 = 0.006694379990197595;'
const GOLDEN_PROJ =
  'const PI: f32 = 3.14159265;\n' +
  'const EARTH_R: f32 = 6378137.0;\n' +
  'const MERCATOR_LAT_LIMIT: f32 = 85.051129;\n' +
  'const DEG2RAD: f32 = 0.01745329;'

// The GPU Earth e2 literal — deliberately DISTINCT from EARTH.e2 (PIN #2).
// Canonical f64 form (=== 0.0066943799901975955; the extra digit is below f64
// precision, so the short form is what emitConst prints and what avoids the
// no-loss-of-precision lint).
const GPU_EARTH_E2 = 0.006694379990197595

afterEach(() => configureBodyConsts(EARTH)) // restore byte-identical Earth for isolation

describe('Body GPU-const injection (#798 P3)', () => {
  it('shipped default emit === origin/main golden (byte-identical Earth)', () => {
    // The shipped ConstDecl defaults ARE Earth — no configure needed.
    expect(ecefBlock()).toBe(GOLDEN_ECEF)
    expect(projBlock()).toBe(GOLDEN_PROJ)
  })

  it('configureBodyConsts(EARTH) restores the golden after perturbation (=== EARTH guard)', () => {
    configureBodyConsts(MARS_IAU2000) // perturb to a non-Earth body
    configureBodyConsts(EARTH) // restore
    expect(ecefBlock()).toBe(GOLDEN_ECEF)
    expect(projBlock()).toBe(GOLDEN_PROJ)
  })

  it('preserves the CPU/GPU e2 divergence for Earth (GPU e2 !== Body.e2)', () => {
    configureBodyConsts(EARTH)
    const e2 = valOf(ECEF_CONSTS, 'WGS84_E2')
    expect(e2).toBe(GPU_EARTH_E2)
    expect(e2).not.toBe(EARTH.e2) // 0.0066943799901413165 — never overwritten
  })

  it('EARTH value fields are the exact shipped doubles (covers WGSL + GLSL emit)', () => {
    configureBodyConsts(EARTH)
    // GLSL emitConst reads the SAME wgslValue/cpuValue fields, so field-identity
    // proves byte-identity on both backends without a private GLSL accessor.
    for (const [arr, name, expected] of [
      [PROJECTION_CONSTS, 'EARTH_R', 6378137],
      [ECEF_CONSTS, 'WGS84_A', 6378137],
      [ECEF_CONSTS, 'WGS84_E2', GPU_EARTH_E2],
    ] as const) {
      const c = arr.find((d) => d.name === name)!
      expect(c.wgslValue).toBe(expected)
      expect(c.cpuValue).toBe(expected)
    }
  })

  it('Mars (IAU2000 ellipsoid) injects sphereR + e2 into the GPU consts', () => {
    configureBodyConsts(MARS_IAU2000)
    expect(projBlock()).toContain('const EARTH_R: f32 = 3396190.0;')
    expect(ecefBlock()).toContain('const WGS84_A: f32 = 3396190.0;')
    expect(valOf(ECEF_CONSTS, 'WGS84_E2')).toBe(MARS_IAU2000.e2)
    expect(valOf(ECEF_CONSTS, 'WGS84_E2')).toBeGreaterThan(0) // oblate
  })

  it('Moon injects a perfect sphere: radius 1737400, e2 = 0', () => {
    configureBodyConsts(MOON)
    expect(projBlock()).toContain('const EARTH_R: f32 = 1737400.0;')
    expect(ecefBlock()).toContain('const WGS84_A: f32 = 1737400.0;')
    expect(valOf(ECEF_CONSTS, 'WGS84_E2')).toBe(0)
  })
})
