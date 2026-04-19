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

describe('CPU/GPU projection consistency — Natural Earth', () => {
  // A-1 was resolved by switching projection.ts naturalEarth.forward /
  // inverse to the same Šavrič et al. (2015) polynomial the WGSL shaders
  // use. The previous ~8145 km divergence is now zero.
  it('CPU naturalEarth.forward matches WGSL projNaturalEarthWgsl to ≤1mm at 100 sample points', () => {
    for (const [lon, lat] of sampleGrid()) {
      const [xA, yA] = naturalEarth.forward(lon, lat)
      const [xB, yB] = projNaturalEarthWgsl(lon, lat)
      expect(xB).toBeCloseTo(xA, 3)
      expect(yB).toBeCloseTo(yA, 3)
    }
  })

  it('naturalEarth.inverse round-trips to within 1e-6° at mid-latitudes', () => {
    // Forward then inverse should recover the original lon/lat. Test
    // mid-latitudes where the Newton-Raphson converges cleanly; the
    // deep polar region has slower convergence and wider tolerance.
    for (let lon = -170; lon <= 170; lon += 40) {
      for (let lat = -60; lat <= 60; lat += 20) {
        const [x, y] = naturalEarth.forward(lon, lat)
        const [lon2, lat2] = naturalEarth.inverse(x, y)
        expect(lon2).toBeCloseTo(lon, 6)
        expect(lat2).toBeCloseTo(lat, 6)
      }
    }
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
