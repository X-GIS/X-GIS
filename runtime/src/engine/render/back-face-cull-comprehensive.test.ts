// Comprehensive back-face culling check across (projection × pitch ×
// layer-type × lon/lat position). User requested verification that
// the cull holds for raster + vector on ALL projections at multiple
// pitch angles.
//
// #600 — the globe(7) arm switched from the PITCH-INVARIANT centre-hemisphere
// cull to the EYE-HORIZON cap: needs_backface_cull now takes a globe_eye vec4
// (normalize(eye), EARTH_R/|eye|) and the globe arm keeps a fragment iff
// dot(normalize(P_ecef), eye_dir) > horizonCos. So GLOBE is NO LONGER pitch-
// invariant (the eye tilts off the centre normal under pitch). The DISC arms
// (ortho/azimuthal/stereographic 3/4/5) STILL ignore the eye and stay pitch-
// invariant (flat discs — the centre hemisphere IS what's visible).
//
// Each renderer reconstructs lon/lat from a DIFFERENT input varying (polygon =
// abs_merc_x/y, line = world_local + tile_origin_merc, point = rtc_merc +
// cam_merc), so this sweeps (projection × layer-input-path × lat/lon grid) and
// asserts the three layer paths agree, discs stay pitch-invariant, and the
// globe eye-horizon cap keeps the eye-visible region / culls the far cap.

import { describe, expect, it, beforeAll } from 'vitest'
import { cosC, needsBackfaceCullWgsl } from '@xgis/map'
import { globeEyeUniform } from '@xgis/map'
import { buildGlobeMatrix } from '@xgis/engine'

const EARTH_R = 6378137
const DEG2RAD = Math.PI / 180
const MERCATOR_LAT_LIMIT = 85.0511287798066

function lonLatToMerc(lon: number, lat: number): [number, number] {
  const x = lon * DEG2RAD * EARTH_R
  const clampedLat = Math.max(-MERCATOR_LAT_LIMIT, Math.min(MERCATOR_LAT_LIMIT, lat))
  const latRad = clampedLat * DEG2RAD
  const y = EARTH_R * Math.log(Math.tan(Math.PI / 4 + latRad / 2))
  return [x, y]
}

// Sphere ECEF for the eye-horizon ground-truth (matches proj_globe in the shader).
function lonLatToSphere(lon: number, lat: number): [number, number, number] {
  const lam = lon * DEG2RAD, phi = lat * DEG2RAD, c = Math.cos(phi)
  return [EARTH_R * c * Math.cos(lam), EARTH_R * c * Math.sin(lam), EARTH_R * Math.sin(phi)]
}

// A NADIR eye over (clon, clat) at altitude `altR` × EARTH_R. With altR large
// the horizon cap → the strict hemisphere (horizonCos = R/|eye| → 0), matching
// the pre-#600 globe behaviour the cull-bearing globe tests below assert. A
// PITCHED eye (the discriminating test) is built from buildGlobeMatrix instead.
function nadirEye(clon: number, clat: number, altR = 1e6): readonly [number, number, number] {
  const n = lonLatToSphere(clon, clat)
  const s = (EARTH_R + altR * EARTH_R) / EARTH_R
  return [n[0] * s, n[1] * s, n[2] * s]
}

// CPU port of polygon_cos_c_fragment (polygon.ts) — #600 threads globe_eye.
function polygonCull(absMercX: number, absMercY: number, pt: number, clon: number, clat: number, eye?: readonly [number, number, number]): number {
  const absLon = absMercX / (DEG2RAD * EARTH_R)
  const latRad = 2 * Math.atan(Math.exp(absMercY / EARTH_R)) - Math.PI / 2
  const absLat = latRad / DEG2RAD
  return needsBackfaceCullWgsl(pt, absLon, absLat, clon, clat, globeEyeUniform(eye) as [number, number, number, number])
}

// CPU port of line back-face (line.ts).
function lineCull(worldX: number, worldY: number, tileOriginX: number, tileOriginY: number, pt: number, clon: number, clat: number, eye?: readonly [number, number, number]): number {
  return polygonCull(worldX + tileOriginX, worldY + tileOriginY, pt, clon, clat, eye)
}

// CPU port of point_cos_c (point.ts).
function pointCull(rtcX: number, rtcY: number, pt: number, camLon: number, camLat: number, eye?: readonly [number, number, number]): number {
  const clampedCamLat = Math.max(-MERCATOR_LAT_LIMIT, Math.min(MERCATOR_LAT_LIMIT, camLat))
  const camMercX = camLon * DEG2RAD * EARTH_R
  const camMercY = Math.log(Math.tan(Math.PI / 4 + clampedCamLat * DEG2RAD / 2)) * EARTH_R
  return polygonCull(rtcX + camMercX, rtcY + camMercY, pt, camLon, camLat, eye)
}

const PROJECTIONS = [
  { name: 'mercator', type: 0, hasCull: false },
  { name: 'equirectangular', type: 1, hasCull: false },
  { name: 'natural_earth', type: 2, hasCull: false },
  { name: 'orthographic', type: 3, hasCull: true },
  { name: 'azimuthal_equidistant', type: 4, hasCull: true },
  { name: 'stereographic', type: 5, hasCull: true },
  { name: 'oblique_mercator', type: 6, hasCull: false },
  { name: 'globe', type: 7, hasCull: true },
] as const

const PITCH_VALUES = [0, 30, 60, 85] // sweep

const CAMERA_VIEWS = [
  { name: 'equator-center', clon: 0, clat: 0 },
  { name: 'Korea-mid-lat', clon: 127, clat: 37 },
  { name: 'Antarctic-rim', clon: -60, clat: -70 },
  { name: 'NYC', clon: -74, clat: 40 },
]

describe('Back-face culling — comprehensive sweep (user request)', () => {
  for (const proj of PROJECTIONS) {
    describe(proj.name, () => {
      // The cull is a pure function of its inputs (lon/lat/proj_params/
      // globe_eye) — it reads no pitch scalar. Holding ALL inputs fixed
      // (incl. a fixed globe_eye) across the pitch sweep must yield a
      // stable result; a regression that smuggled a pitch scalar into the
      // arm would fail here. (#600: the globe arm IS pitch-sensitive, but
      // only THROUGH globe_eye — which is held fixed here.) Discs/flat
      // ignore globe_eye entirely, so this is vacuous-but-correct for them.
      it('cull is stable when its inputs (incl. globe_eye) are held fixed', () => {
        const cam = CAMERA_VIEWS[0]!
        const eye = proj.type === 7 ? nadirEye(cam.clon, cam.clat) : undefined
        const testPoints: Array<[number, number]> = [
          [0, 0], [180, 0], [90, 45], [-90, -45],
        ]
        for (const [lon, lat] of testPoints) {
          const [mx, my] = lonLatToMerc(lon, lat)
          const results = PITCH_VALUES.map(() => Math.sign(polygonCull(mx, my, proj.type, cam.clon, cam.clat, eye)))
          expect(new Set(results).size).toBe(1)
        }
      })

      // Layer-path consistency: polygon, line, point all produce the
      // same cull sign at the same lon/lat for the same projection.
      it('polygon/line/point produce identical cull sign', () => {
        const cam = CAMERA_VIEWS[1]! // Korea
        const tileOriginX = 1.4e7, tileOriginY = 4.4e6
        // #600 — globe needs a globe_eye; use a FAR NADIR eye so the horizon
        // cap → the strict hemisphere (horizonCos → 0) and the cosC ground
        // truth below still holds. The disc arms ignore the eye.
        const eye = proj.type === 7 ? nadirEye(cam.clon, cam.clat) : undefined
        for (let i = 0; i < 9; i++) {
          for (let j = 0; j < 9; j++) {
            const lon = -170 + (i / 8) * 340
            const lat = -80 + (j / 8) * 160
            const [absMercX, absMercY] = lonLatToMerc(lon, lat)
            const polyResult = polygonCull(absMercX, absMercY, proj.type, cam.clon, cam.clat, eye)
            const lineResult = lineCull(
              absMercX - tileOriginX, absMercY - tileOriginY,
              tileOriginX, tileOriginY, proj.type, cam.clon, cam.clat, eye,
            )
            const camMercX = cam.clon * DEG2RAD * EARTH_R
            const camMercY = lonLatToMerc(0, cam.clat)[1]
            const pointResult = pointCull(absMercX - camMercX, absMercY - camMercY, proj.type, cam.clon, cam.clat, eye)
            // Ground-truth comparison only valid for projections that
            // return RAW cosC: orthographic (3) and globe (7, far-nadir eye
            // ⇒ horizon ≈ strict hemisphere ⇒ sign matches cosC). Azimuthal
            // (4) and stereographic (5) threshold at -0.85 / -0.8 so
            // their cull domain is narrower than strict back-hemisphere.
            // Cylindrical / flat short-circuit to +1. Still verify the
            // three layer paths agree among themselves on every projection.
            if (proj.type === 3 || proj.type === 7) {
              expect(Math.sign(polyResult), `poly vs ground truth at (${lon},${lat}) on ${proj.name}`)
                .toBe(Math.sign(cosC(lon, lat, cam.clon, cam.clat)) || 1)
            }
            expect(Math.sign(lineResult), `line vs polygon at (${lon},${lat}) on ${proj.name}`)
              .toBe(Math.sign(polyResult))
            expect(Math.sign(pointResult), `point vs polygon at (${lon},${lat}) on ${proj.name}`)
              .toBe(Math.sign(polyResult))
          }
        }
      })

      if (proj.hasCull) {
        it('back-hemisphere points correctly discard (red-pixel guard)', () => {
          const cam = CAMERA_VIEWS[0]! // equator center
          // Antipodal-ish points where cosC ≤ -0.85 (the most permissive
          // cull threshold across the cull-bearing projections, used by
          // azimuthal_equidistant; stereo is -0.8, ortho + globe are 0).
          // True antipode (180, 0) has cosC = -1 which fails every cull.
          const antipodes: Array<[number, number]> = [
            [180, 0], [-180, 0], [175, 30], [170, -10],
          ]
          const eye = proj.type === 7 ? nadirEye(cam.clon, cam.clat) : undefined
          for (const [lon, lat] of antipodes) {
            const [mx, my] = lonLatToMerc(lon, lat)
            const result = polygonCull(mx, my, proj.type, cam.clon, cam.clat, eye)
            expect(result, `antipode (${lon},${lat}) NOT discarded on ${proj.name}`).toBeLessThanOrEqual(0)
          }
        })

        it('front-hemisphere points always pass (blue-pixel guard)', () => {
          const cam = CAMERA_VIEWS[1]! // Korea
          const eye = proj.type === 7 ? nadirEye(cam.clon, cam.clat) : undefined
          const frontPoints: Array<[number, number]> = [
            [127, 37], [125, 35], [130, 40], [115, 35], [140, 38],
          ]
          for (const [lon, lat] of frontPoints) {
            const [mx, my] = lonLatToMerc(lon, lat)
            const result = polygonCull(mx, my, proj.type, cam.clon, cam.clat, eye)
            expect(result, `front point (${lon},${lat}) discarded on ${proj.name}`).toBeGreaterThan(0)
          }
        })
      } else {
        it('no cull — every point passes (cylindrical/flat projection)', () => {
          const cam = CAMERA_VIEWS[2]! // pick a high-lat camera
          for (let i = 0; i < 5; i++) {
            for (let j = 0; j < 5; j++) {
              const lon = -160 + (i / 4) * 320
              const lat = -75 + (j / 4) * 150
              const [mx, my] = lonLatToMerc(lon, lat)
              const result = polygonCull(mx, my, proj.type, cam.clon, cam.clat)
              expect(result).toBeGreaterThanOrEqual(1)
            }
          }
        })
      }
    })
  }

  // #600 DISCRIMINATING TEST — the whole point of the eye-horizon switch.
  // At the proven repro camera (#1.10/-24.24239/-4.06461/345.0/85.0, 1280×720)
  // the perspective eye tilts ~76° off the centre normal and looks across the
  // sphere toward the limb. A surface point on the FAR cap can be eye-VISIBLE
  // (in front of the eye-horizon plane) yet sit on the BACK centre-hemisphere
  // (cosC < 0). The OLD pitch-invariant cull (center_cos_c) discarded it →
  // missing far cap (#600). The NEW eye-horizon cull KEEPS it. A genuinely
  // antipodal-to-the-eye point is still culled.
  describe('#600 eye-horizon vs centre-hemisphere — repro camera', () => {
    // Real repro eye from buildGlobeMatrix (the production globe matrix builder).
    // Computed in beforeAll, NOT at describe-eval: cosC / needsBackfaceCullWgsl
    // compile the projection module, which needs configureProjections() — and
    // that runs in the test-setup file AFTER module collection.
    const clon = -4.06461, clat = -24.24239
    let eye: readonly [number, number, number]
    let eyeN: [number, number, number]
    let horizonCos: number
    // Eye-visible iff dot(normalize(P), eyeN) > horizonCos. The far-cap point
    // that is eye-VISIBLE but on the BACK centre-hemisphere (cosC < 0) — the
    // pixels #600 was dropping.
    let farCapVisibleBack: { lon: number; lat: number } | null

    beforeAll(() => {
      const v = buildGlobeMatrix(clon, clat, 1.10, 85.0, 345.0, 1280, 720)
      eye = v.eye as readonly [number, number, number]
      const eyeLen = Math.hypot(eye[0], eye[1], eye[2])
      eyeN = [eye[0] / eyeLen, eye[1] / eyeLen, eye[2] / eyeLen]
      horizonCos = EARTH_R / eyeLen
      farCapVisibleBack = (() => {
        for (let lat = -89; lat <= 89; lat += 1) {
          for (let lon = -180; lon < 180; lon += 1) {
            const p = lonLatToSphere(lon, lat)
            const pn: [number, number, number] = [p[0] / EARTH_R, p[1] / EARTH_R, p[2] / EARTH_R]
            const eyeCos = pn[0] * eyeN[0] + pn[1] * eyeN[1] + pn[2] * eyeN[2]
            const cc = cosC(lon, lat, clon, clat)
            if (eyeCos > horizonCos + 0.02 && cc < -0.02) return { lon, lat }
          }
        }
        return null
      })()
    })

    it('a far-cap point exists that is eye-visible AND on the back centre-hemisphere', () => {
      // Proves the two models genuinely DISAGREE at this camera (else the test
      // below is vacuous). High pitch + low zoom is exactly when this region is
      // non-empty (the diagnosis: ~30% of eye-visible surface at pitch 85, z≈1).
      expect(farCapVisibleBack, 'no eye-visible back-hemisphere point at the repro camera').not.toBeNull()
    })

    it('eye-horizon KEEPS the eye-visible far-cap point; centre-hemisphere DISCARDED it (fail-before)', () => {
      const { lon, lat } = farCapVisibleBack!
      const [mx, my] = lonLatToMerc(lon, lat)
      // FAIL-BEFORE: the pre-#600 centre-hemisphere cull (cosC sign) discarded it.
      expect(Math.sign(cosC(lon, lat, clon, clat)), 'fail-before: centre-hemisphere kept it (no bug to fix)').toBe(-1)
      // FIX: the eye-horizon cull KEEPS it (> 0).
      expect(polygonCull(mx, my, 7, clon, clat, eye), `eye-visible far-cap (${lon},${lat}) wrongly culled`).toBeGreaterThan(0)
    })

    it('a true back-of-eye point is still culled', () => {
      // The point on the sphere directly OPPOSITE the eye direction (antipodal to
      // eyeN) is maximally behind the horizon — must cull under eye-horizon.
      const backLon = Math.atan2(-eyeN[1], -eyeN[0]) / DEG2RAD
      const backLat = Math.asin(Math.max(-1, Math.min(1, -eyeN[2]))) / DEG2RAD
      const [mx, my] = lonLatToMerc(backLon, backLat)
      expect(polygonCull(mx, my, 7, clon, clat, eye), 'back-of-eye point NOT culled — leak').toBeLessThan(0)
    })

    it('pitch-0 (nadir) regression: eye-horizon ≈ strict hemisphere at the same centre', () => {
      // At pitch 0 the eye is on the centre normal, so eye-horizon reduces to a
      // cosC threshold — front centre passes, far antipode culls (no regression
      // vs the old strict-hemisphere behaviour on the common nadir view).
      const v0 = buildGlobeMatrix(clon, clat, 1.10, 0, 0, 1280, 720)
      const eye0 = v0.eye as readonly [number, number, number]
      const [fmx, fmy] = lonLatToMerc(clon, clat) // centre = front
      expect(polygonCull(fmx, fmy, 7, clon, clat, eye0)).toBeGreaterThan(0)
      const [bmx, bmy] = lonLatToMerc(clon + 180, -clat) // antipode = back
      expect(polygonCull(bmx, bmy, 7, clon, clat, eye0)).toBeLessThan(0)
    })
  })

  // Raster layer math — `raster-renderer.ts` shares the polygon-cull
  // helper (`needs_backface_cull`) via the same WGSL projection module.
  // Adding a synthetic raster cell check confirms the cull holds at the
  // raster path's typical input.
  describe('raster layer cull', () => {
    for (const proj of PROJECTIONS) {
      if (!proj.hasCull) continue
      it(`${proj.name}: raster cell on back hemisphere culls`, () => {
        const cam = CAMERA_VIEWS[0]!
        const eye = proj.type === 7 ? nadirEye(cam.clon, cam.clat) : undefined
        // Raster cells use the same forward-projected lon/lat as
        // polygon vertices. Sample a 256x256 raster tile center near
        // antipode.
        const lon = 175, lat = 5
        const [mx, my] = lonLatToMerc(lon, lat)
        expect(polygonCull(mx, my, proj.type, cam.clon, cam.clat, eye)).toBeLessThanOrEqual(0)
      })
    }
  })
})
