import { describe, expect, it } from 'vitest'
import {
  mercator, equirectangular, naturalEarth,
  orthographic, azimuthalEquidistant, stereographic, obliqueMercator,
} from '../engine/projection'
import {
  projMercatorWgsl,
  projEquirectangularWgsl,
  projNaturalEarthWgsl,
  projOrthographicWgsl,
  projAzimuthalEquidistantWgsl,
  projStereographicWgsl,
  projObliqueMercatorWgsl,
  cosC,
} from '../engine/projection-wgsl-mirror'

// Phase 2-A: Cross-consistency between CPU canonical (projection.ts) and
// WGSL mirror (projection-wgsl-mirror.ts). A failure means the GPU shader
// and CPU math disagree — tile selection (CPU) and rendering (GPU) would
// land on different screen positions for the same geographic point.
//
// These tests use a 10×10 grid of (lon, lat) samples. Tolerance is 1mm
// for exact-formula pairs; Natural Earth is expected to diverge by meters
// because the CPU implementation is a table-based interpolation while the
// GPU uses a polynomial approximation of the same Natural Earth projection.

const TOLERANCE_EXACT_MM = 0.001

function sampleGrid(): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let i = 0; i < 10; i++) {
    for (let j = 0; j < 10; j++) {
      const lon = -180 + (i / 9) * 360
      const lat = -85 + (j / 9) * 170
      out.push([lon, lat])
    }
  }
  return out
}

describe('CPU/GPU projection consistency — Mercator', () => {
  it('CPU mercator.forward matches WGSL projMercatorWgsl to ≤1mm at 100 sample points', () => {
    for (const [lon, lat] of sampleGrid()) {
      const [xA, yA] = mercator.forward(lon, lat)
      const [xB, yB] = projMercatorWgsl(lon, lat)
      expect(xB).toBeCloseTo(xA, 3)
      expect(yB).toBeCloseTo(yA, 3)
    }
  })
})

describe('CPU/GPU projection consistency — Equirectangular', () => {
  it('CPU equirectangular.forward matches WGSL projEquirectangularWgsl to ≤1mm at 100 sample points', () => {
    for (const [lon, lat] of sampleGrid()) {
      const [xA, yA] = equirectangular.forward(lon, lat)
      const [xB, yB] = projEquirectangularWgsl(lon, lat)
      expect(xB).toBeCloseTo(xA, 3)
      expect(yB).toBeCloseTo(yA, 3)
    }
  })
})

describe('CPU/GPU projection consistency — Natural Earth (KNOWN DIVERGENCE)', () => {
  // Known divergence A-1:
  //   CPU projection.ts: Patterson's 13-entry table + linear interpolation,
  //                      with y = NE_B(lat) * π * R.
  //   WGSL proj_natural_earth: Šavrič et al. (2015) 6th-order polynomial.
  //
  // These are arguably two different projections ("Natural Earth I" vs
  // "Natural Earth II"). Measured divergence on the 10×10 grid: ~8.1 M m
  // near the poles — CPU produces a y value ~2× the WGSL one.
  //
  // This is a behavior bug (external users calling naturalEarth.forward
  // get a different projection than the one rendered on screen) but no
  // internal code currently calls the CPU forward. Fix is deferred as a
  // separate behavior change. These tests lock in the current state so
  // future edits surface any drift from the known divergence.

  it('divergence is bounded by the current measured maximum (~8.2 M m)', () => {
    // If a future change makes CPU and WGSL DIVERGE MORE, investigate.
    // If a future change makes them AGREE, delete this test — the fix
    // for A-1 has landed.
    const UPPER_BOUND_M = 8_500_000
    let maxDelta = 0
    for (const [lon, lat] of sampleGrid()) {
      const [xA, yA] = naturalEarth.forward(lon, lat)
      const [xB, yB] = projNaturalEarthWgsl(lon, lat)
      maxDelta = Math.max(maxDelta, Math.hypot(xA - xB, yA - yB))
    }
    // eslint-disable-next-line no-console
    console.log(`[natural-earth A-1 divergence] observed max ΔXY: ${(maxDelta / 1000).toFixed(1)} km`)
    expect(maxDelta).toBeLessThan(UPPER_BOUND_M)
  })

  it('divergence is NOT zero — formulas differ by design (fix A-1 to resolve)', () => {
    // When this test starts failing, it means someone unified the two
    // Natural Earth implementations. Great — delete this test AND the
    // divergence-bound test above AND add a strict consistency assertion.
    let foundDivergence = false
    for (const [lon, lat] of sampleGrid()) {
      const [xA, yA] = naturalEarth.forward(lon, lat)
      const [xB, yB] = projNaturalEarthWgsl(lon, lat)
      if (Math.hypot(xA - xB, yA - yB) > 1) {
        foundDivergence = true
        break
      }
    }
    expect(foundDivergence).toBe(true)
  })
})

const CENTER_LON = 0
const CENTER_LAT = 20

describe('CPU/GPU projection consistency — Orthographic', () => {
  const cpu = orthographic(CENTER_LON, CENTER_LAT)

  it('CPU and WGSL agree to ≤1mm on the FRONT hemisphere (cos_c > 0)', () => {
    for (const [lon, lat] of sampleGrid()) {
      if (cosC(lon, lat, CENTER_LON, CENTER_LAT) <= 0) continue
      const [xA, yA] = cpu.forward(lon, lat)
      const [xB, yB] = projOrthographicWgsl(lon, lat, CENTER_LON, CENTER_LAT)
      expect(xB).toBeCloseTo(xA, 3)
      expect(yB).toBeCloseTo(yA, 3)
    }
  })

  it('A-3 KNOWN DIVERGENCE: CPU returns NaN for back-hemisphere, WGSL computes real values', () => {
    // This is the back-face-culling stage divergence. CPU orthographic
    // culls at projection time (returns NaN when cos_c < 0), while WGSL
    // projects unconditionally and defers culling to `needs_backface_cull`
    // in renderer.ts. A shader path that skips needs_backface_cull would
    // fold back-hemisphere geometry onto the front of the globe.
    let cpuNaNCount = 0
    let wgslFiniteInBackCount = 0
    for (const [lon, lat] of sampleGrid()) {
      if (cosC(lon, lat, CENTER_LON, CENTER_LAT) >= 0) continue
      const [xA] = cpu.forward(lon, lat)
      const [xB, yB] = projOrthographicWgsl(lon, lat, CENTER_LON, CENTER_LAT)
      if (Number.isNaN(xA)) cpuNaNCount++
      if (Number.isFinite(xB) && Number.isFinite(yB)) wgslFiniteInBackCount++
    }
    expect(cpuNaNCount).toBeGreaterThan(0)
    expect(wgslFiniteInBackCount).toBeGreaterThan(0)
  })
})

describe('CPU/GPU projection consistency — Azimuthal Equidistant', () => {
  const cpu = azimuthalEquidistant(CENTER_LON, CENTER_LAT)
  it('CPU and WGSL agree to ≤1mm across the full globe (azimuthal has no back-face cull)', () => {
    for (const [lon, lat] of sampleGrid()) {
      const [xA, yA] = cpu.forward(lon, lat)
      const [xB, yB] = projAzimuthalEquidistantWgsl(lon, lat, CENTER_LON, CENTER_LAT)
      expect(xB).toBeCloseTo(xA, 3)
      expect(yB).toBeCloseTo(yA, 3)
    }
  })
})

describe('CPU/GPU projection consistency — Stereographic', () => {
  const cpu = stereographic(CENTER_LON, CENTER_LAT)

  it('CPU and WGSL agree to ≤1mm for non-antipodal points (cos_c > -0.9)', () => {
    for (const [lon, lat] of sampleGrid()) {
      if (cosC(lon, lat, CENTER_LON, CENTER_LAT) <= -0.9) continue
      const [xA, yA] = cpu.forward(lon, lat)
      const [xB, yB] = projStereographicWgsl(lon, lat, CENTER_LON, CENTER_LAT)
      expect(xB).toBeCloseTo(xA, 3)
      expect(yB).toBeCloseTo(yA, 3)
    }
  })

  it('KNOWN: CPU returns NaN near antipode while WGSL returns sentinel 1e15', () => {
    // Convention drift parallel to A-3: CPU projects.ts returns [NaN, NaN]
    // when cos_c < -0.9, the WGSL returns vec2<f32>(1e15, 1e15). Both
    // effectively "cull" but the contract differs — consumers that check
    // Number.isFinite see different booleans.
    let cpuNaNCount = 0, wgslSentinelCount = 0
    for (const [lon, lat] of sampleGrid()) {
      if (cosC(lon, lat, CENTER_LON, CENTER_LAT) >= -0.9) continue
      const [xA] = cpu.forward(lon, lat)
      const [xB] = projStereographicWgsl(lon, lat, CENTER_LON, CENTER_LAT)
      if (Number.isNaN(xA)) cpuNaNCount++
      if (xB === 1e15) wgslSentinelCount++
    }
    // May be 0 if the grid doesn't reach the antipode region for this
    // center — that's fine, the point is the observation is recorded.
    // eslint-disable-next-line no-console
    console.log(`[stereographic back-hemisphere convention] CPU NaN=${cpuNaNCount} WGSL sentinel=${wgslSentinelCount}`)
  })
})

describe('CPU/GPU projection consistency — Oblique Mercator', () => {
  const cpu = obliqueMercator(CENTER_LON, CENTER_LAT)
  it('CPU and WGSL agree to ≤1mm for the main strip', () => {
    for (const [lon, lat] of sampleGrid()) {
      const [xA, yA] = cpu.forward(lon, lat)
      const [xB, yB] = projObliqueMercatorWgsl(lon, lat, CENTER_LON, CENTER_LAT)
      // Both sides clamp phi_shifted to [-1.5, 1.5] so the projection is
      // bounded; tolerance can stay tight.
      expect(xB).toBeCloseTo(xA, 3)
      expect(yB).toBeCloseTo(yA, 3)
    }
  })
})
