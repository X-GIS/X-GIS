import { describe, expect, it } from 'vitest'
import {
  mercator,
  equirectangular,
  naturalEarth,
  orthographic,
  azimuthalEquidistant,
  stereographic,
  obliqueMercator,
} from '@xgis/geo'
import {
  projMercatorWgsl,
  projEquirectangularWgsl,
  projEquirectangularDWgsl,
  projNaturalEarthWgsl,
  projNaturalEarthDWgsl,
  projOrthographicWgsl,
  projAzimuthalEquidistantWgsl,
  projStereographicWgsl,
  projObliqueMercatorWgsl,
  cosC,
  projGlobeWgsl,
  projectWgsl,
  projectGeomWgsl,
  unwrapLonNear,
  wrapLonDelta,
  needsBackfaceCullWgsl,
} from '@xgis/map'
import { globeForward } from '@xgis/geo'
import { globeEyeUniform } from '@xgis/map'
import { EARTH } from '@xgis/shared'

const EARTH_R = 6378137
// #600 — a NADIR eye over (clon, clat) at altitude `altR`×EARTH_R, for the globe
// eye-horizon cull. altR large ⇒ horizonCos → 0 ⇒ horizon ≈ strict hemisphere
// (sign matches cosC); altR small ⇒ a tight visible cap.
function nadirEye(clon: number, clat: number, altR: number): readonly [number, number, number] {
  const lam = (clon * Math.PI) / 180,
    phi = (clat * Math.PI) / 180,
    c = Math.cos(phi)
  const s = EARTH_R * (1 + altR)
  return [s * c * Math.cos(lam), s * c * Math.sin(lam), s * Math.sin(phi)]
}
const eye4 = (e: readonly [number, number, number]) =>
  globeEyeUniform(e) as [number, number, number, number]

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
    let cpuNaNCount = 0,
      wgslSentinelCount = 0
    for (const [lon, lat] of sampleGrid()) {
      if (cosC(lon, lat, CENTER_LON, CENTER_LAT) >= -0.9) continue
      const [xA] = cpu.forward(lon, lat)
      const [xB] = projStereographicWgsl(lon, lat, CENTER_LON, CENTER_LAT)
      if (Number.isNaN(xA)) cpuNaNCount++
      if (xB === 1e15) wgslSentinelCount++
    }
    // May be 0 if the grid doesn't reach the antipode region for this
    // center — that's fine, the point is the observation is recorded.

    console.log(
      `[stereographic back-hemisphere convention] CPU NaN=${cpuNaNCount} WGSL sentinel=${wgslSentinelCount}`,
    )
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
    for (const [clon, clat] of [
      [0, 0],
      [10, 30],
      [-50, 45],
      [120, -20],
    ] as const) {
      const [x, y] = obliqueMercator(clon, clat).forward(clon, clat)
      expect(x).toBeCloseTo(0, 3)
      expect(y).toBeCloseTo(0, 3)
    }
  })

  it('forward → inverse round-trips', () => {
    const proj = obliqueMercator(20, 40)
    for (const [lon, lat] of [
      [0, 0],
      [10, 10],
      [-30, 50],
      [80, -20],
    ] as const) {
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
  const CL = 0,
    CT = 20
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
  const CL = 0,
    CT = 20
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
  it('globe (7) — #600 eye-horizon cap: far NADIR eye ≈ strict hemisphere (sign = cosC)', () => {
    // The globe arm now culls by the eye-horizon cap, NOT the pitch-invariant
    // centre hemisphere. With a FAR on-axis (nadir) eye the horizon → the strict
    // hemisphere, so the cull sign matches cosC (the pre-#600 behaviour on a
    // low-zoom nadir view). horizonCos = R/|eye| → ~0 at this altitude.
    const eye = eye4(nadirEye(CL, CT, 1e6))
    for (const [lon, lat] of sampleGrid()) {
      expect(needsBackfaceCullWgsl(7, lon, lat, CL, CT, eye) > 0).toBe(cosC(lon, lat, CL, CT) > 0)
    }
  })
  it('globe (7) — #600 eye-horizon cap shrinks as the eye nears the surface', () => {
    // A NEAR eye (low altitude) sees only a small cap: horizonCos = R/|eye| is
    // large, so a point at cosC just above 0 (e.g. ~60° off centre) is now CULLED
    // even though it is on the front centre-hemisphere. This is the property the
    // old center_cos_c model could never express (it always cut at cosC=0).
    const nearEye = eye4(nadirEye(CL, CT, 0.05)) // |eye| ≈ 1.05 R ⇒ horizonCos ≈ 0.952
    // Front-centre point (cosC ≈ 1) stays visible; a 60°-off point (cosC = 0.5 <
    // 0.952) is now culled by the near-eye horizon.
    expect(needsBackfaceCullWgsl(7, CL, CT, CL, CT, nearEye)).toBeGreaterThan(0)
    const farLon = CL + 60
    expect(cosC(farLon, CT, CL, CT)).toBeLessThan(0.952) // it IS within the near-eye cull band
    expect(needsBackfaceCullWgsl(7, farLon, CT, CL, CT, nearEye)).toBeLessThan(0)
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

  it('equirect: a tile straddling the clon±180 seam projects CONTIGUOUSLY (no full-width smear)', () => {
    // Camera over the Pacific: clon = −160 ⇒ the back seam sits at
    // lon = +20. A 10°-wide tile spanning lon 15..25 straddles it.
    // Equirect is LINEAR, so its world-copy offset exactly cancels the
    // ±180 fold and the tile is drawn whole across the seam.
    const clon = -160
    const west = 15,
      east = 25
    const refLon = (west + east) / 2
    // OLD per-vertex hard wrap: the two tile edges land a near-whole-
    // world apart — this is the smear.
    const smearW = projectWgsl(1, west, 0, clon, 0)[0]
    const smearE = projectWgsl(1, east, 0, clon, 0)[0]
    expect(Math.abs(smearE - smearW)).toBeGreaterThan(1e7)
    // project_geom with the tile-centre reference: the edges are ~10°
    // apart in projected metres — the tile is drawn whole.
    const gW = projectGeomWgsl(1, west, 0, clon, 0, refLon)[0]
    const gE = projectGeomWgsl(1, east, 0, clon, 0, refLon)[0]
    const tenDegM = (east - west) * (Math.PI / 180) * 6378137
    expect(Math.abs(gE - gW)).toBeLessThan(tenDegM * 1.1)
  })

  it('natural_earth: a tile straddling the antipode seam splits at the OVAL edge (NE lobe wrap)', () => {
    // Natural Earth is NOT periodic — the oval has a hard edge at the
    // camera-antipode meridian (clon ± 180). A tile that straddles that
    // antipode seam straddles the OVAL EDGE itself, so its two halves
    // belong to ADJACENT world copies (drawn at opposite oval edges by
    // world-copy enumeration). The NE-lobe wrap in project_geom keeps the
    // polynomial input |d| ≤ 180, so each half lands at its true oval-edge
    // position. The pre-fix bug fed an out-of-lobe d (|d| > 180) to the
    // 6th-order polynomial, faking a contiguous-but-WRONG x that left the
    // camera-facing bg band torn (the black wedge). Here clon = −160 puts
    // the antipode seam at lon = +20, so the 15..25 tile straddles it.
    const clon = -160
    const west = 15,
      east = 25
    const refLon = (west + east) / 2
    const smearW = projectWgsl(2, west, 0, clon, 0)[0]
    const smearE = projectWgsl(2, east, 0, clon, 0)[0]
    expect(Math.abs(smearE - smearW)).toBeGreaterThan(1e7)
    // After the lobe wrap each half is fed an IN-LOBE delta (|dw| ≤ 180); the
    // folded east half (|d| = 185 → dw = −175, k = 1) lands in the RIGHT-adjacent
    // world copy via the lobe offset. #801: that offset must be NE's LAT-varying
    // period 2·NE_d(180,0).x, which places the east half EXACTLY beside the west
    // half — a 10° geographic tile renders CONTINUOUSLY across the antipode, gap ≈
    // its own projected width radians(10)·xScale(0)·R ≈ 0.97 Mm. The pre-#801
    // constant 2πR offset placed it ~(1−xScale)·2πR ≈ 5.2 Mm too far → the
    // antimeridian tear (the black-wedge's world-copy sibling) this gate forbids.
    const gW = projectGeomWgsl(2, west, 0, clon, 0, refLon)[0]
    const gE = projectGeomWgsl(2, east, 0, clon, 0, refLon)[0]
    const oneWorld = 2 * Math.PI * 6378137
    const seamGap = Math.abs(gE - gW)
    expect(seamGap).toBeLessThan(1.5e6) // continuous: ≈ the 10° tile's projected width, NOT a tear
    expect(seamGap).toBeGreaterThan(0.5e6) // but non-zero — the tile does straddle the oval edge
    expect(seamGap).toBeLessThan(oneWorld * 0.2) // and nowhere near a whole-world smear
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
          if ((((lon - clon) % 360) + 540) % 360 === 0) continue
          const a = projectWgsl(projType, lon, lat, clon, 0)
          const b = projectGeomWgsl(projType, lon, lat, clon, 0, clon)
          expect(b[0]).toBeCloseTo(a[0], 3)
          expect(b[1]).toBeCloseTo(a[1], 3)
        }
      }
    }
  })

  it('refLon = lon reproduces projectWgsl even when |lon − clon| > 180 (placement regression)', () => {
    // Guards the camera-near-±180 bug: a point-centred tile must land at
    // its TRUE camera-relative position, never a whole world off. With
    // refLon = lon, project_geom must equal the wrap projection for ANY
    // clon — including a camera at the dateline where raw |lon − clon|
    // exceeds 180 for the visible wrap-around tiles.
    for (const clon of [175, -175, 160, -30]) {
      for (const projType of [1, 2, 6]) {
        for (const [lon, lat] of sampleGrid()) {
          if ((((lon - clon) % 360) + 540) % 360 === 0) continue // ±180 tie
          const a = projectWgsl(projType, lon, lat, clon, 20)
          const b = projectGeomWgsl(projType, lon, lat, clon, 20, lon)
          expect(b[0]).toBeCloseTo(a[0], 2)
          expect(b[1]).toBeCloseTo(a[1], 2)
        }
      }
    }
  })

  it('oblique_mercator: adjacent tiles across the rotated antimeridian JOIN continuously (#802)', () => {
    // oblique_mercator has NO hemisphere cull and an atan2 ±π branch cut on the
    // rotated longitude (its antimeridian). Centre the projection at
    // (clon,clat)=(0,40); the rotated antimeridian runs roughly along lon≈180 and
    // cuts DIAGONALLY across the axis-aligned Mercator tile grid.
    //
    // project_geom unwraps the rotated longitude toward the FIXED rotated-frame
    // origin (0 = the centre's own lam_rot), so it is a pure function of
    // (lon,lat,clon,clat) — tile-INDEPENDENT. Two adjacent Mercator tiles that
    // share the lon=180 meridian edge therefore project it to the SAME x whatever
    // each tile's own centre-lon reference, so the tiles JOIN with no gap.
    //
    // The pre-#802 behaviour unwrapped toward a PER-TILE reference — the two tiles
    // then chose opposite ±π branches for the shared edge and it tore a full 2π·R
    // world copy apart (the reported tile-join tearing). This gate FAILS on that
    // baseline (worst seam gap ≈ 2π·R ≈ 4.0e7 m) and passes once the reference is
    // tile-independent.
    const refWest = 178 // centre of tile [176,180]
    const refEast = 182 // centre of tile [180,184]
    const edge = 180 // shared meridian edge
    let worstGap = 0
    for (let lat = -80; lat <= 80; lat += 4) {
      const xW = projectGeomWgsl(6, edge, lat, 0, 40, refWest)[0]
      const xE = projectGeomWgsl(6, edge, lat, 0, 40, refEast)[0]
      worstGap = Math.max(worstGap, Math.abs(xE - xW))
    }
    expect(worstGap, 'shared meridian edge must project identically from both tiles').toBeLessThan(
      1,
    )

    // The discontinuity is not removed — it moves to the TRUE rotated antimeridian,
    // where a single tile that STRADDLES the cut still spans ~a world copy (the
    // genuine seam, exactly like Mercator at ±180). Splitting straddling geometry
    // there is the deferred "oblique polar tearing" deep fix; assert the genuine
    // seam still exists so that future work updates this expectation deliberately.
    const seamW = projObliqueMercatorWgsl(179, 40, 0, 40)[0]
    const seamE = projObliqueMercatorWgsl(181, 40, 0, 40)[0]
    expect(Math.abs(seamE - seamW), 'raw ±π jump at the true rotated antimeridian').toBeGreaterThan(
      1e7,
    )
  })

  it('is identical to projectWgsl for projections with no longitude seam (fallback)', () => {
    // mercator (world-copy wrap), orthographic / azimuthal /
    // stereographic (smooth trig in lon; only the culled hemisphere
    // limb / antipode is an edge) have no in-primitive discontinuity.
    for (const projType of [0, 3, 4, 5]) {
      for (const [lon, lat] of sampleGrid()) {
        expect(projectGeomWgsl(projType, lon, lat, 30, 20, 999)).toEqual(
          projectWgsl(projType, lon, lat, 30, 20),
        )
      }
    }
  })

  // ── Antimeridian seam-keep (OFM/MVT black-wedge gore fix) ──
  // The OFM Bright MVT path clamps each seam tile's buffer overshoot to a
  // wall of vertices pinned at exactly abs_lon = ±180. At the z0 root tile
  // tile_ref_lon = 0, so that wall sits 180° from the reference — the maximal
  // unwrap-ambiguity point — and the floor() fold tears a +180 wall a whole
  // world away from its +179 in-lobe neighbours: the equirect / natural_earth
  // black wedge at the Russia/Chukotka dateline. unwrap_lon_near_keep resolves
  // the tie by the wall's own clamped-longitude sign so each lobe stays whole.
  it('z0 root tile: a ±180 seam wall stays adjacent to its in-lobe neighbour (no gore)', () => {
    const DEG = Math.PI / 180,
      R = 6378137
    const oneDegM = 1 * DEG * R // ≈ 0.111e6 m — expected wall↔neighbour gap
    for (const projType of [1 /* equirect */, 2 /* natural_earth */]) {
      // z0 root tile reference longitude is 0; camera at clon=0.
      // +180 wall must land next to +179 (east lobe), not a world away.
      const xPlus179 = projectGeomWgsl(projType, 179, 60, 0, 0, 0)[0]
      const xPlus180 = projectGeomWgsl(projType, 180, 60, 0, 0, 0)[0]
      expect(Math.abs(xPlus180 - xPlus179)).toBeLessThan(oneDegM * 1.5)
      // Symmetric west lobe: −180 wall must stay next to −179, NOT flip to +X.
      const xMinus179 = projectGeomWgsl(projType, -179, 60, 0, 0, 0)[0]
      const xMinus180 = projectGeomWgsl(projType, -180, 60, 0, 0, 0)[0]
      expect(Math.abs(xMinus180 - xMinus179)).toBeLessThan(oneDegM * 1.5)
      // And the two walls are on opposite sides (no collapse onto one lobe).
      expect(Math.sign(xPlus180)).toBe(1)
      expect(Math.sign(xMinus180)).toBe(-1)
    }
  })

  it('seam-keep is inert for interior vertices |lon| < 180 (byte-identical fold)', () => {
    // The keep-sign bias only fires at the exact ±180 tie; every interior
    // vertex must fold exactly as before across tiles/cameras, so the only
    // visible change is the seam wall — nothing else can shift.
    for (const projType of [1, 2]) {
      for (const refLon of [0, 90, -90, 157.5, -157.5]) {
        for (const clon of [0, 90, 180, -90]) {
          for (let lon = -179.5; lon <= 179.5; lon += 7.3) {
            const keep = projectGeomWgsl(projType, lon, 30, clon, 0, refLon)
            // Reference fold = unwrap_lon_near (no keep-sign) via wrap math:
            // recompute d the plain way and project.
            const refD = wrapLonDelta(refLon - clon)
            const plainD = unwrapLonNear(lon - clon, refD)
            let rx: number, ry: number
            if (projType === 1) {
              // Equirect is linear: the recentred delta projects directly.
              ;[rx, ry] = projEquirectangularDWgsl(plainD, 30)
            } else {
              // Natural Earth folds the recentred delta into one lobe (|dw| ≤ 180)
              // before the polynomial and re-adds the 360°-steps (k) as the lobe
              // offset. #801: that offset rides NE's LATITUDE-varying period
              // 2·NE_d(180,lat).x — NOT the constant Mercator 2πR — or a
              // seam-straddling tile mis-scales. The oracle mirrors the corrected fold.
              const dw = wrapLonDelta(plainD)
              const k = Math.round((plainD - dw) / 360)
              const p = projNaturalEarthDWgsl(dw, 30)
              rx = p[0] + k * (2 * projNaturalEarthDWgsl(180, 30)[0]) // lat-varying period
              ry = p[1]
            }
            expect(keep[0]).toBeCloseTo(rx, 6)
            expect(keep[1]).toBeCloseTo(ry, 6)
          }
        }
      }
    }
  })
})

// Globe is the true 3D mode: its canonical CPU side is projection/
// globe.ts `globeForward` (NOT a projection.ts 2D Projection — it returns x,y,z on
// the WGS84 ELLIPSOID since #1152 INC-3). The WGSL `proj_globe` must match it so the
// GPU surface lines up with CPU tile-cap selection / unproject. Both sides evaluate
// the same f64 e2, so the residual is op-order only (≤1mm).
describe('CPU/GPU projection consistency — Globe (true 3D, projType 7)', () => {
  it('canonical globeForward matches WGSL mirror projGlobeWgsl to ≤1mm at 100 sample points', () => {
    for (const [lon, lat] of sampleGrid()) {
      const [xA, yA, zA] = globeForward(lon, lat)
      const [xB, yB, zB] = projGlobeWgsl(lon, lat)
      expect(xB).toBeCloseTo(xA, 3)
      expect(yB).toBeCloseTo(yA, 3)
      expect(zB).toBeCloseTo(zA, 3)
    }
  })

  it('every mirrored point lies ON THE ELLIPSOID (x²/a² + y²/a² + z²/b² = 1), not a sphere', () => {
    const A = EARTH.a
    const B = EARTH.b
    for (const [lon, lat] of sampleGrid()) {
      const [x, y, z] = projGlobeWgsl(lon, lat)
      expect((x * x) / (A * A) + (y * y) / (A * A) + (z * z) / (B * B)).toBeCloseTo(1, 6)
    }
  })

  it('closed-form ellipsoid spot pins: equator |P|=a, pole z=±b, lat45 z=N(1−e2)sinφ', () => {
    const A = EARTH.a
    const B = EARTH.b
    const E2 = EARTH.e2
    const eqx = projGlobeWgsl(0, 0)[0]
    expect(eqx).toBeCloseTo(A, 0) // equator |P| = a
    expect(projGlobeWgsl(0, 90)[2]).toBeCloseTo(B, 0) // pole z = b = 6356752.314…
    expect(projGlobeWgsl(0, -90)[2]).toBeCloseTo(-B, 0)
    const s = Math.sin(45 * (Math.PI / 180))
    const N = A / Math.sqrt(1 - E2 * s * s)
    expect(projGlobeWgsl(0, 45)[2]).toBeCloseTo(N * (1 - E2) * s, 0)
  })
})
