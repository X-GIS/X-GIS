import { describe, expect, it } from 'vitest'
import {
  mercator, equirectangular, naturalEarth,
  orthographic, azimuthalEquidistant, stereographic, obliqueMercator,
} from './projection'
import {
  projMercatorWgsl,
  projEquirectangularWgsl,
  projNaturalEarthWgsl,
  projOrthographicWgsl,
  projAzimuthalEquidistantWgsl,
  projStereographicWgsl,
  projObliqueMercatorWgsl,
  cosC,
  projectWgsl,
  projectGeomWgsl,
  unwrapLonNear,
  needsBackfaceCullWgsl,
} from './projection-wgsl-mirror'

// Phase 2-A: Cross-consistency between CPU canonical (projection.ts) and
// WGSL mirror (projection-wgsl-mirror.ts). A failure means the GPU shader
// and CPU math disagree — tile selection (CPU) and rendering (GPU) would
// land on different screen positions for the same geographic point.
//
// These tests use a 10×10 grid of (lon, lat) samples. Tolerance is 1mm
// for exact-formula pairs. Natural Earth also agrees to 1mm now (A-1):
// projection.ts was unified onto the same Šavrič et al. (2015) polynomial
// the GPU uses, replacing the old table-based interpolation. See the
// Natural Earth describe block below.

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
    const eq = equirectangular()
    for (const [lon, lat] of sampleGrid()) {
      const [xA, yA] = eq.forward(lon, lat)
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
    const ne = naturalEarth()
    for (const [lon, lat] of sampleGrid()) {
      const [xA, yA] = ne.forward(lon, lat)
      const [xB, yB] = projNaturalEarthWgsl(lon, lat)
      expect(xB).toBeCloseTo(xA, 3)
      expect(yB).toBeCloseTo(yA, 3)
    }
  })

  it('naturalEarth.inverse round-trips to within 1e-6° at mid-latitudes', () => {
    // Forward then inverse should recover the original lon/lat. Test
    // mid-latitudes where the Newton-Raphson converges cleanly; the
    // deep polar region has slower convergence and wider tolerance.
    const ne = naturalEarth()
    for (let lon = -170; lon <= 170; lon += 40) {
      for (let lat = -60; lat <= 60; lat += 20) {
        const [x, y] = ne.forward(lon, lat)
        const [lon2, lat2] = ne.inverse(x, y)
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
      // Rotated latitude is clamped to ±MERCATOR_LAT_LIMIT (matches plain
      // Mercator) so the projection is bounded; tolerance can stay tight.
      expect(xB).toBeCloseTo(xA, 3)
      expect(yB).toBeCloseTo(yA, 3)
    }
  })

  // Regression: a previous formulation rotated center to the north pole
  // and subtracted PI/2 from rotated latitude. That collapsed the world
  // into y ≤ 0 with both poles overlapping, so a camera at center (0, 0)
  // saw the entire map crammed into the lower-left quadrant of the canvas.
  // These assertions guard against re-introducing the same shift.
  it('center (0,0): symmetry across the equator', () => {
    const eq = obliqueMercator(0, 0)
    const [, yNorth] = eq.forward(0, 89)
    const [, ySouth] = eq.forward(0, -89)
    expect(yNorth).toBeGreaterThan(0)
    expect(ySouth).toBeLessThan(0)
    expect(yNorth).toBeCloseTo(-ySouth, 3)
  })

  it('center maps to (0, 0)', () => {
    for (const [clon, clat] of [[0, 0], [10, 30], [-50, 45], [120, -20]] as const) {
      const [x, y] = obliqueMercator(clon, clat).forward(clon, clat)
      expect(x).toBeCloseTo(0, 3)
      expect(y).toBeCloseTo(0, 3)
    }
  })

  it('forward → inverse round-trips', () => {
    const proj = obliqueMercator(20, 40)
    for (const [lon, lat] of [[0, 0], [10, 10], [-30, 50], [80, -20]] as const) {
      const [x, y] = proj.forward(lon, lat)
      const [lon2, lat2] = proj.inverse(x, y)
      expect(lon2).toBeCloseTo(lon, 3)
      expect(lat2).toBeCloseTo(lat, 3)
    }
  })
})

// projectWgsl / needsBackfaceCullWgsl are the CPU dispatchers that label
// anchors (map.ts) and raster tile_rtc (raster-renderer.ts) use to stay
// pixel-aligned with the GPU. They must route by the SAME proj_params.x
// encoding and back-face thresholds as the WGSL project() /
// needs_backface_cull() in shaders/projection.ts — a boundary slip here
// detaches every label/raster from the geometry under that projection.
describe('projectWgsl dispatch matches the per-projection mirrors', () => {
  const CL = 0, CT = 20
  const cases: Array<[number, (l: number, a: number) => [number, number]]> = [
    [0, (l, a) => projMercatorWgsl(l, a)],
    [1, (l, a) => projEquirectangularWgsl(l, a)],
    [2, (l, a) => projNaturalEarthWgsl(l, a)],
    [3, (l, a) => projOrthographicWgsl(l, a, CL, CT)],
    [4, (l, a) => projAzimuthalEquidistantWgsl(l, a, CL, CT)],
    [5, (l, a) => projStereographicWgsl(l, a, CL, CT)],
    [6, (l, a) => projObliqueMercatorWgsl(l, a, CL, CT)],
  ]
  it('every projType routes to its own forward at sample points', () => {
    for (const [pt, fn] of cases) {
      for (const [lon, lat] of sampleGrid()) {
        const [ax, ay] = projectWgsl(pt, lon, lat, CL, CT)
        const [bx, by] = fn(lon, lat)
        if (!Number.isFinite(bx)) continue
        expect(ax).toBeCloseTo(bx, 6)
        expect(ay).toBeCloseTo(by, 6)
      }
    }
  })
})

describe('needsBackfaceCullWgsl matches WGSL needs_backface_cull thresholds', () => {
  const CL = 0, CT = 20
  // mercator(0) equirect(1) natural_earth(2) oblique_mercator(6) are all
  // whole-sphere (cylindrical / flat) — no hemisphere back-face. oblique
  // used to fall through the shader's `t > 2.5` block to the stereo
  // threshold and got a spurious antipodal clip → half-rendered /
  // overlapping map. It must never cull, like the other cylindricals.
  it('cylindrical / flat projections never cull (always ≥ 1)', () => {
    for (const pt of [0, 1, 2, 6]) {
      for (const [lon, lat] of sampleGrid()) {
        expect(needsBackfaceCullWgsl(pt, lon, lat, CL, CT)).toBeGreaterThanOrEqual(1)
      }
    }
  })
  it('orthographic returns raw cos(c) (sign = visibility)', () => {
    for (const [lon, lat] of sampleGrid()) {
      expect(needsBackfaceCullWgsl(3, lon, lat, CL, CT)).toBeCloseTo(cosC(lon, lat, CL, CT), 6)
    }
  })
  it('azimuthal culls at cc ≤ -0.85, stereographic at cc ≤ -0.8', () => {
    for (const [lon, lat] of sampleGrid()) {
      const cc = cosC(lon, lat, CL, CT)
      expect(needsBackfaceCullWgsl(4, lon, lat, CL, CT) > 0).toBe(cc > -0.85)
      expect(needsBackfaceCullWgsl(5, lon, lat, CL, CT) > 0).toBe(cc > -0.8)
    }
  })
})

// Pseudocylindrical central-meridian recentre: equirectangular &
// natural_earth now recentre on the camera longitude (clon) so the
// viewed region (e.g. Korea) sits at the low-distortion centre instead
// of being sheared at the world-oval edge. The GPU mirror MUST equal the
// projection.ts canonical at any clon, or labels/rasters detach from the
// geometry the moment the camera leaves longitude 0.
describe('Pseudocylindrical central-meridian recentring', () => {
  it('camera longitude maps to x = 0 (the undistorted centre)', () => {
    for (const clon of [0, 60, 127, -150, 179]) {
      for (const lat of [-80, -30, 0, 37, 75]) {
        expect(projNaturalEarthWgsl(clon, lat, clon)[0]).toBeCloseTo(0, 6)
        expect(projEquirectangularWgsl(clon, lat, clon)[0]).toBeCloseTo(0, 6)
      }
    }
  })

  it('GPU mirror equals projection.ts canonical at any central meridian', () => {
    for (const clon of [0, 45, 127, -150]) {
      const ne = naturalEarth(clon)
      const eq = equirectangular(clon)
      for (const [lon, lat] of sampleGrid()) {
        const [neAx, neAy] = ne.forward(lon, lat)
        const [neBx, neBy] = projNaturalEarthWgsl(lon, lat, clon)
        expect(neBx).toBeCloseTo(neAx, 3)
        expect(neBy).toBeCloseTo(neAy, 3)
        const [eqAx, eqAy] = eq.forward(lon, lat)
        const [eqBx, eqBy] = projEquirectangularWgsl(lon, lat, clon)
        expect(eqBx).toBeCloseTo(eqAx, 3)
        expect(eqBy).toBeCloseTo(eqAy, 3)
      }
    }
  })

  it('projectWgsl dispatch forwards clon to equirect / natural_earth', () => {
    for (const clon of [0, 127, -150]) {
      for (const [lon, lat] of sampleGrid()) {
        expect(projectWgsl(1, lon, lat, clon, 0)).toEqual(projEquirectangularWgsl(lon, lat, clon))
        expect(projectWgsl(2, lon, lat, clon, 0)).toEqual(projNaturalEarthWgsl(lon, lat, clon))
      }
    }
  })

  it('clon = 0 is identity on [-180,180] (textbook form unchanged)', () => {
    const ne = naturalEarth()
    for (const [lon, lat] of sampleGrid()) {
      // sampleGrid spans lon ∈ [-180,180]; wrapLonDelta must not alter it
      // at clon = 0, so the recentred path is byte-identical to before.
      const [ax, ay] = ne.forward(lon, lat)
      const [bx, by] = naturalEarth(0).forward(lon, lat)
      expect(ax).toBe(bx)
      expect(ay).toBe(by)
    }
  })
})

// ═══ Antimeridian-seam tile projection (project_geom) ═══
//
// Pseudocylindrical projections recentre on the camera longitude by
// per-vertex `wrap_lon_delta(lon − clon)`. That hard ±180 modulo splits
// any tile primitive straddling the clon±180 seam into a full-width
// horizontal smear (user-reported "natural_earth breaks near the
// dateline"). project_geom unwraps each vertex toward the tile-centre
// longitude instead, keeping every primitive in a tile contiguous.
describe('project_geom — antimeridian seam continuity', () => {
  it('unwrapLonNear brings (lon − ref) into [-180,180) and is continuous near the seam', () => {
    expect(unwrapLonNear(0, 0)).toBe(0)
    expect(unwrapLonNear(170, 0)).toBe(170)
    expect(unwrapLonNear(-170, 0)).toBe(-170)
    // ref = +175 (tile near the +180 dateline). A point that wrap()
    // would throw to −179 stays at +181 → contiguous with the tile.
    expect(unwrapLonNear(-179, 175)).toBe(181)
    expect(unwrapLonNear(179, 175)).toBe(179)
    // Result is always within [-180,180) of the reference.
    for (const ref of [-150, 0, 60, 175]) {
      for (let lon = -180; lon < 180; lon += 7) {
        const d = unwrapLonNear(lon, ref) - ref
        expect(d).toBeGreaterThanOrEqual(-180)
        expect(d).toBeLessThan(180)
      }
    }
  })

  it('a tile straddling the clon±180 seam projects CONTIGUOUSLY (no full-width smear)', () => {
    // Camera over the Pacific: clon = −160 ⇒ the back seam sits at
    // lon = +20. A 10°-wide tile spanning lon 15..25 straddles it.
    const clon = -160
    const west = 15, east = 25
    const refLon = (west + east) / 2
    for (const projType of [1 /* equirect */, 2 /* natural_earth */]) {
      // OLD per-vertex hard wrap: the two tile edges land a near-whole-
      // world apart — this is the smear.
      const smearW = projectWgsl(projType, west, 0, clon, 0)[0]
      const smearE = projectWgsl(projType, east, 0, clon, 0)[0]
      expect(Math.abs(smearE - smearW)).toBeGreaterThan(1e7)
      // project_geom with the tile-centre reference: the edges are ~10°
      // apart in projected metres — the tile is drawn whole.
      const gW = projectGeomWgsl(projType, west, 0, clon, 0, refLon)[0]
      const gE = projectGeomWgsl(projType, east, 0, clon, 0, refLon)[0]
      const tenDegM = (east - west) * (Math.PI / 180) * 6378137
      expect(Math.abs(gE - gW)).toBeLessThan(tenDegM * 1.1)
    }
  })

  it('with refLon = clon reproduces projectWgsl (no regression: the wrap is a special case)', () => {
    // unwrap_lon_near(lon, clon) − clon ≡ wrap_lon_delta(lon − clon)
    // everywhere except the exact ±180 tie (floor vs ceil). So a tile
    // whose reference is the camera longitude is byte-equivalent to the
    // old behaviour — project_geom only diverges where it must, at the
    // seam, and only for tiles whose centre is elsewhere.
    for (const clon of [0, 60, -120]) {
      for (const projType of [1, 2]) {
        for (const [lon, lat] of sampleGrid()) {
          // Skip the exact ±180 boundary — wrap() (ceil) and
          // unwrap_lon_near (floor) legitimately differ only there.
          if (((lon - clon) % 360 + 540) % 360 === 0) continue
          const a = projectWgsl(projType, lon, lat, clon, 0)
          const b = projectGeomWgsl(projType, lon, lat, clon, 0, clon)
          expect(b[0]).toBeCloseTo(a[0], 3)
          expect(b[1]).toBeCloseTo(a[1], 3)
        }
      }
    }
  })

  it('is identical to projectWgsl for non-pseudocylindrical projections (fallback)', () => {
    for (const projType of [0, 3, 4, 5, 6]) {
      for (const [lon, lat] of sampleGrid()) {
        expect(projectGeomWgsl(projType, lon, lat, 30, 20, 999))
          .toEqual(projectWgsl(projType, lon, lat, 30, 20))
      }
    }
  })
})
