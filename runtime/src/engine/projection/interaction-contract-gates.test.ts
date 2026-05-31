// ═══ Projection-unification step #8 — PR-C: interaction CONTRACT gates ═══
//
// TEST-ONLY. Authored against CURRENT behaviour. Several assertions FAIL
// today on purpose: they encode the TARGET contract for the inverse /
// interaction / geoid unification (#8 plan §2-§3,
// .omc/research/inverse-interaction-geoid-scope-2026-05-31.md) and turn the
// behavior-sensitive targets #7-#11 from UNFALSIFIABLE into verifiable.
//
// These gates also KILL existing FALSE COVERAGE. `ortho-unproject-parity`
// round-trips a pixel screen→world→screen through the SAME wrong Mercator
// z=0 plane, so a self-consistent WRONG geographic location passes; it
// cannot detect that the recovered point is the wrong place on Earth.
// `globe.test` exercises `unprojectGlobe`/`globeForward` in self-consistent
// SPHERE space, so a sphere→ellipsoid mismatch is invisible to it.
//
// CONVENTION (matches data/tile-high-pitch-coverage.test.ts,
// non-merc-z0-disc.test.ts): a not-yet-met contract uses vitest `it.fails`,
// which stays GREEN while the assertion throws and FLIPS to failing the
// moment the feature lands — forcing whoever fixes it to remove the marker.
// A met contract uses normal `it`.
//
// projType encoding (shaders/projection.ts + globe.ts):
//   0 mercator · 1 equirectangular · 2 natural_earth · 3 orthographic
//   4 azimuthal_equidistant · 5 stereographic · 6 oblique_mercator · 7 globe
//
// ───────────────────────────────────────────────────────────────────────
// DEFERRED GATES (authored in PR-D, NOT here) and WHY:
//
//   G3 — zoomAt-anchor invariant (cursor over a fixed geographic point stays
//        under the cursor across a zoom delta, projTypes 3/4/5 untilted).
//        Deferred: its expected value is the zoom-anchor BEHAVIOUR after the
//        disc-inverse is generalised to the azimuthal set (#9); the tolerance
//        depends on the not-yet-made geoid decision (sphere-camera vs
//        ellipsoid-everywhere) and the gesture is interaction-feel —
//        partially subjective, pairs with a human eyeball pass.
//   G4 — globe pick accuracy (click a known lat/lon on the globe, assert the
//        wired inverse returns it). Deferred: `clientToLngLat` returns null
//        for all non-mercator TODAY (the feature is unimplemented, not just
//        offset), so there is no value to assert against until the ray↔
//        surface inverse is wired (#10/#11); its tolerance is the geoid
//        decision (a few km on sphere, tightening to geoid-exact on ellipsoid).
//   G5 — globe pan/zoom round-trip (grab a surface point, pan/zoom, assert it
//        returns under the cursor). Deferred: no production path exercises
//        globe drag/zoom at all today (pan is a Cesium-style Mercator nudge,
//        zoom falls to a flat z=0 plane); the round-trip only has meaning once
//        the real ray↔surface unproject is wired (#11). Needs real-GPU /
//        interaction e2e + eyeball.
//   G8 — non-Mercator fitBounds (globe/disc frames the bbox at the correct
//        zoom). Deferred: the corrected lonSpan→zoom mapping is a #5 medium-
//        term behaviour change; its expected zoom depends on the projection
//        world-extent model that PR-D introduces.
//   G9 — antimeridian periodic-copy labels (zoom≤4 near ±180°, the wrapped
//        world copy of equirect/NE/oblique geometry is labelled). Deferred:
//        needs the label world-copy enumeration (#6) + a real label-onscreen
//        e2e harness, not a CPU unit assertion.
//
//   G7 — extruded-globe position (#4) is ALREADY authored in PR-B (#198,
//        shader-dsl/shaders/polygon-dsl.test.ts) — not duplicated here.
// ───────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest'
import {
  getProjection,
  mercator,
  mercatorYToLat,
  type Projection,
} from './projection'
import { Camera } from './camera'
import { globeForward } from './globe'
import { lonLatToECEF } from './ecef'

// ════════════════════════════════════════════════════════════════════════
// G2 — CPU per-projType inverse round-trip (foundational; PASSES today).
//
// getProjection(name).inverse(forward([lon,lat])) ≈ [lon,lat] to a tight
// tolerance, projTypes 0-6, across a lon/lat spread incl. mid + high lat
// inside each projection's valid domain. This pins the shared inverse
// authority the #8 `unprojectToLonLat` composer (PR-D D1) will route to —
// the camera is a SECOND, hand-maintained inverse that never consults it.
// ════════════════════════════════════════════════════════════════════════

const G2_TOL_DEG = 1e-3

// projType → a projection instance, centred so the sample spread sits
// inside its well-conditioned domain (cylindrical: central meridian 0;
// azimuthal/oblique: centre (0,20) so the disc covers the sampled band).
const G2_CASES: Array<{ projType: number; name: string; proj: Projection; pts: [number, number][] }> = [
  {
    projType: 0, name: 'mercator', proj: mercator,
    // Mercator forward clamps beyond ±85.05; stay inside so the round-trip
    // is the inverse's fidelity, not the clamp.
    pts: [[0, 0], [45, 30], [-90, -45], [120, 60], [-150, -60], [179, 84], [-179, -84]],
  },
  {
    projType: 1, name: 'equirectangular', proj: getProjection('equirectangular', 0),
    pts: [[0, 0], [45, 30], [-90, -45], [120, 60], [-150, -60], [30, 80], [30, -80]],
  },
  {
    projType: 2, name: 'natural_earth', proj: getProjection('natural_earth', 0),
    // NE inverse is a 5-iter Newton solve; stay ≤75° where the Jacobian is
    // well-behaved (matches projection-inverse-roundtrip.test.ts).
    pts: [[0, 0], [45, 30], [-90, -45], [120, 60], [-150, -60], [30, 70], [30, -70]],
  },
  {
    projType: 3, name: 'orthographic', proj: getProjection('orthographic', 0, 20),
    // Visible hemisphere only — points near the (0,20) centre.
    pts: [[0, 20], [20, 40], [-20, 0], [30, 45], [-30, -5], [10, 50], [-10, 5]],
  },
  {
    projType: 4, name: 'azimuthal_equidistant', proj: getProjection('azimuthal_equidistant', 0, 20),
    pts: [[0, 20], [20, 40], [-20, 0], [30, 45], [-30, -5], [10, 50], [-25, 55]],
  },
  {
    projType: 5, name: 'stereographic', proj: getProjection('stereographic', 0, 20),
    pts: [[0, 20], [20, 40], [-20, 0], [30, 45], [-30, -5], [10, 50], [-25, 55]],
  },
  {
    projType: 6, name: 'oblique_mercator', proj: getProjection('oblique_mercator', 0, 20),
    // Oblique tilts (centre→equator); near the rotated equator is well-
    // conditioned. Sample around the (0,20) centre.
    pts: [[0, 20], [30, 40], [-30, 0], [40, 45], [-40, -5], [15, 50], [-15, -10]],
  },
]

describe('G2 — CPU per-projType inverse round-trip (foundational, PASSES today)', () => {
  for (const { projType, name, proj, pts } of G2_CASES) {
    it(`projType ${projType} (${name}): inverse(forward(p)) ≈ p`, () => {
      let tested = 0
      for (const [lon, lat] of pts) {
        const [x, y] = proj.forward(lon, lat)
        // Points the forward CULLS (NaN, e.g. far hemisphere) are a domain
        // boundary, not an inverse failure — skip.
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue
        const [lon2, lat2] = proj.inverse(x, y)
        expect(Number.isFinite(lon2), `${name} lon2 non-finite @(${lon},${lat})`).toBe(true)
        expect(Number.isFinite(lat2), `${name} lat2 non-finite @(${lon},${lat})`).toBe(true)
        expect(Math.abs(lat2 - lat), `${name} lat drift @(${lon},${lat}): ${lat}→${lat2}`).toBeLessThan(G2_TOL_DEG)
        // Longitude is degenerate at the poles (every meridian collapses) —
        // only assert lon away from ±90.
        if (Math.abs(lat) < 89.5) {
          let dLon = lon2 - lon
          if (dLon > 180) dLon -= 360
          if (dLon < -180) dLon += 360
          expect(Math.abs(dLon), `${name} lon drift @(${lon},${lat}): ${lon}→${lon2}`).toBeLessThan(G2_TOL_DEG)
        }
        tested++
      }
      // Guard the guard: a domain that culls EVERY point would pass vacuously.
      expect(tested, `${name}: no point survived forward — test is vacuous`).toBeGreaterThan(0)
    })
  }
})

// ════════════════════════════════════════════════════════════════════════
// G1 — camera screen→geographic round-trip, GEOGRAPHIC correctness.
//   projType 0 (mercator): PASSES.    projTypes 1-6: FAIL today (it.fails).
//
// Drives a REAL `Camera` (no GPU). For a known geographic point we feed the
// projType's OWN flat-plane metres (the shader `flat_rel` =
// `proj.forward(pt) − proj.forward(cam)` the GPU actually renders) through
// the camera's render MVP to a screen pixel, then call the production
// `unprojectToZ0` back and recover lon/lat. The recovery is performed the
// only way the camera offers — interpreting the returned plane metres as
// MERCATOR (centerX/Y are canonically Mercator; getVisibleWorldCopies /
// zoomAt / panToScreenAnchor all do exactly this). We assert the recovered
// GEOGRAPHIC location, NOT pixel self-consistency.
//
// For mercator the camera's z=0 plane IS the Mercator plane, so it agrees.
// For projTypes 1-6 the camera inverts every projType through that same flat
// Mercator plane (camera.ts:724-743 `unprojectToZ0`; the docstring even
// mislabels the output "projection meters"), so the recovered point is the
// WRONG place on Earth. ortho-unproject-parity gives FALSE coverage by
// round-tripping through this same wrong plane.
// ════════════════════════════════════════════════════════════════════════

const G1_W = 800, G1_H = 800, G1_DPR = 1

// Column-major 4×4 × vec4.
function mat4Vec4(m: Float32Array | ArrayLike<number>, v: [number, number, number, number]): [number, number, number, number] {
  const out: [number, number, number, number] = [0, 0, 0, 0]
  for (let r = 0; r < 4; r++) {
    let s = 0
    for (let k = 0; k < 4; k++) s += m[k * 4 + r] * v[k]
    out[r] = s
  }
  return out
}

/** Project a projType-OWN-plane rel-metre point (the shader flat_rel) to a
 *  device-pixel screen coord via the camera's render MVP. Returns null if
 *  the point lands behind the camera. */
function relToScreen(cam: Camera, rel: [number, number]): [number, number] | null {
  const mvp = cam.getViewForProjection(cam.projType, G1_W, G1_H, G1_DPR).matrix
  const clip = mat4Vec4(mvp, [rel[0], rel[1], 0, 1])
  if (clip[3] <= 1e-6) return null
  const sx = (clip[0] / clip[3] + 1) * 0.5 * G1_W
  const sy = (1 - clip[1] / clip[3]) * 0.5 * G1_H
  return [sx, sy]
}

/** The camera's production screen→geographic recovery. After #8 PR-D this is
 *  the shared `unprojectToLonLat` composer: it unprojects to the projType's
 *  OWN z=0 plane, then routes through the per-projType inverse to recover TRUE
 *  lon/lat. For mercator (0) it is exactly the legacy `mercator.inverse(rel +
 *  centre)`; for the flat non-merc set (1/2/6) it re-adds the projType's own-
 *  plane centre offset and applies `getProjection(name).inverse`. For the disc
 *  set (3/4/5) the composer returns null (deferred), so those still fail. */
function cameraRecoverLonLat(cam: Camera, sx: number, sy: number): [number, number] | null {
  return cam.unprojectToLonLat(sx, sy, G1_W, G1_H, G1_DPR)
}

// Camera geographic anchor + a test point offset from it, per projType.
// Cylindrical/pseudocyl: central meridian rides the camera lon (the runtime
// recentres `centralLon` on camera longitude). Azimuthal/oblique: centre at
// the camera anchor so the sampled point sits well inside the visible disc.
const G1_CAM_LON = 20, G1_CAM_LAT = 40
const G1_PT_LON = 35, G1_PT_LAT = 60

function projForType(projType: number, centreLon: number, centreLat: number): Projection {
  switch (projType) {
    case 0: return mercator
    case 1: return getProjection('equirectangular', centreLon)
    case 2: return getProjection('natural_earth', centreLon)
    case 3: return getProjection('orthographic', centreLon, centreLat)
    case 4: return getProjection('azimuthal_equidistant', centreLon, centreLat)
    case 5: return getProjection('stereographic', centreLon, centreLat)
    case 6: return getProjection('oblique_mercator', centreLon, centreLat)
    default: throw new Error(`G1: no flat projection for projType ${projType}`)
  }
}

function makeG1Camera(projType: number, zoom: number, pitch: number): Camera {
  const cam = new Camera(G1_CAM_LON, G1_CAM_LAT, zoom)
  cam.projType = projType
  cam.globeMode = false
  cam.bearing = 0
  // The azimuthal set locks pitch (its 2D disc has no tilt); honour the
  // production accessor instead of bypassing it.
  cam.pitchLocked = projType === 3 || projType === 4 || projType === 5
  cam.pitch = pitch
  return cam
}

/** One screen→geographic round-trip through the REAL camera. Returns the
 *  geographic error in degrees (|Δlon| + |Δlat|, lon wrapped), or null if
 *  the projection culls the point or the ray misses. */
function g1RoundTripErrorDeg(projType: number, zoom: number, pitch: number): number | null {
  const cam = makeG1Camera(projType, zoom, pitch)
  const proj = projForType(projType, G1_CAM_LON, G1_CAM_LAT)
  // Shader flat_rel feed: proj.forward(pt) − proj.forward(cam).
  const [px, py] = proj.forward(G1_PT_LON, G1_PT_LAT)
  const [cx, cy] = proj.forward(G1_CAM_LON, G1_CAM_LAT)
  if (![px, py, cx, cy].every(Number.isFinite)) return null
  const screen = relToScreen(cam, [px - cx, py - cy])
  if (!screen) return null
  const recovered = cameraRecoverLonLat(cam, screen[0], screen[1])
  if (!recovered) return null
  let dLon = recovered[0] - G1_PT_LON
  if (dLon > 180) dLon -= 360
  if (dLon < -180) dLon += 360
  return Math.abs(dLon) + Math.abs(recovered[1] - G1_PT_LAT)
}

// Geographic round-trip must land within this many degrees of the input.
const G1_TOL_DEG = 1e-2

describe('G1 — camera screen→geographic round-trip (mercator + flat non-merc 1/2/6 PASS via composer; disc 3/4/5 deferred)', () => {
  // projType 0 (mercator): the camera's z=0 plane IS the Mercator plane, so
  // the geographic recovery is exact at every zoom + pitch. Normal `it`.
  for (const zoom of [2, 6, 12]) {
    for (const pitch of [0, 45]) {
      it(`projType 0 (mercator) z=${zoom} pitch=${pitch}: geographic round-trip ≈ input`, () => {
        const err = g1RoundTripErrorDeg(0, zoom, pitch)
        expect(err, `mercator round-trip returned null (z=${zoom} p=${pitch})`).not.toBeNull()
        expect(err!, `mercator geographic drift ${err}° (z=${zoom} p=${pitch})`).toBeLessThan(G1_TOL_DEG)
      })
    }
  }

  // projTypes 1/2/6 (flat non-merc set): the #8 PR-D `unprojectToLonLat`
  // composer routes the camera recovery through the projType's OWN inverse, so
  // the geographic round-trip is now exact. Flipped from `it.fails` to normal
  // `it()` (the composer landed). Cylindrical/oblique also exercise pitch>0.
  const FLAT_NONMERC: Array<[number, string]> = [
    [1, 'equirectangular'], [2, 'natural_earth'], [6, 'oblique_mercator'],
  ]
  for (const [projType, name] of FLAT_NONMERC) {
    for (const zoom of [2, 6]) {
      for (const pitch of [0, 45]) {
        it(`projType ${projType} (${name}) z=${zoom} pitch=${pitch}: geographic round-trip ≈ input`, () => {
          const err = g1RoundTripErrorDeg(projType, zoom, pitch)
          expect(err, `${name} round-trip returned null (z=${zoom} p=${pitch})`).not.toBeNull()
          expect(err!, `${name} geographic drift ${err}° (z=${zoom} p=${pitch})`).toBeLessThan(G1_TOL_DEG)
        })
      }
    }
  }

  // projTypes 3/4/5 (azimuthal disc set): STILL TARGET contract — out of #8
  // scope (limb singularity + zoom-feel; deferred to #9). `unprojectToLonLat`
  // returns null for these, so `cameraRecoverLonLat` yields null and the body
  // throws → `it.fails` stays GREEN. They pitch-lock, so only pitch 0 (tilted
  // promotes to globeMode).
  const DISC: Array<[number, string]> = [
    [3, 'orthographic'], [4, 'azimuthal_equidistant'], [5, 'stereographic'],
  ]
  for (const [projType, name] of DISC) {
    for (const zoom of [2, 6]) {
      it.fails(
        `projType ${projType} (${name}) z=${zoom} pitch=0: geographic round-trip ≈ input ` +
        `[target contract — disc inverse deferred to #9; unprojectToLonLat returns ` +
        `null for the azimuthal set (limb singularity + zoom-feel)]`,
        () => {
          const err = g1RoundTripErrorDeg(projType, zoom, 0)
          expect(err, `${name} round-trip returned null (z=${zoom} p=0)`).not.toBeNull()
          expect(err!, `${name} geographic drift ${err}° (z=${zoom} p=0)`).toBeLessThan(G1_TOL_DEG)
        },
      )
    }
  }

  // Quantified evidence (not gated — informational). The #8 composer ELIMINATES
  // the flat non-merc gap: equirect now round-trips to ~0° (was ≈6.4°). The
  // disc set (3/4/5) is still unsupported (composer returns null → recovery
  // null), documenting that the remaining gap is the #9 disc inverse.
  it('flat non-merc gap is now ~0 after composer; disc set still unsupported (informational)', () => {
    const eqErr = g1RoundTripErrorDeg(1, 6, 0)
    expect(eqErr).not.toBeNull()
    // Was ≈6.4° latitude error for the (20,40)→(35,60) pair through the wrong
    // Mercator plane; the composer recovers the equirect plane exactly.
    expect(eqErr!, `equirect geographic gap ${eqErr}° — expected ≈0 after composer`).toBeLessThan(G1_TOL_DEG)
    // Disc set: the composer does not handle it, so recovery is null.
    const orthoErr = g1RoundTripErrorDeg(3, 6, 0)
    expect(orthoErr, 'ortho recovery should be null (composer out of scope for disc)').toBeNull()
  })
})

// ════════════════════════════════════════════════════════════════════════
// G6 — globe tile-rim geoid: sphere-forward vs ellipsoid-render.
//
// globe.ts `globeForward` (and the inline forward in `globeVisibleTiles`,
// globe.ts:561-567) places tile-selection samples on a SPHERE of radius
// EARTH_R; the tiles those coords select are RENDERED on the WGS84
// ELLIPSOID (vector-tile-renderer.ts:2174-2178 = shared `lonLatToECEF`).
// At high latitude the two surfaces differ by ~21 km of polar flattening,
// so the front-hemisphere horizon-cull and screen-AABB emit/cull gates run
// against a surface ~21 km inside the rendered one — a tile-edge mis-
// classification at z14+ pitched polar views. globe.test cannot see this:
// it asserts dateline-wrap + hemisphere count in self-consistent SPHERE
// space. This is the #7 contract.
// ════════════════════════════════════════════════════════════════════════

describe('G6 — globe tile-rim sphere-forward vs ellipsoid-render parity', () => {
  // Tight tolerance: the render basis is the ellipsoid, so a geoid-correct
  // tile selector forward must land on it to within metres, not km.
  const G6_TOL_M = 1

  // EQUATOR: sphere == ellipsoid (E2·sin²(0) = 0). Normal `it` — PASSES.
  // Proves the test is REAL (a measurement, not an always-fail), and pins
  // the one latitude where the two frames provably coincide.
  it('equator: globeForward == lonLatToECEF (sphere==ellipsoid at lat 0)', () => {
    for (const lon of [-150, -60, 0, 45, 120, 179]) {
      const [sx, sy, sz] = globeForward(lon, 0)
      const [ex, ey, ez] = lonLatToECEF(lon, 0)
      const d = Math.hypot(sx - ex, sy - ey, sz - ez)
      expect(d, `equator lon=${lon}: sphere-vs-ellipsoid dist ${d} m`).toBeLessThan(G6_TOL_M)
    }
  })

  // HIGH LATITUDE: ~21 km gap today → TARGET contract. `it.fails` flips to
  // failing once globeVisibleTiles' forward is routed through the shared
  // ellipsoid primitive (#7 fix, PR-D D4).
  it.fails(
    'high latitude: globeForward == lonLatToECEF ' +
    '[#7 contract — fails until globeVisibleTiles forward routes through ' +
    'shared ellipsoid lonLatToECEF; sphere vs ellipsoid differ ~21 km at the poles]',
    () => {
      for (const lat of [60, 75, 85.05]) {
        for (const lon of [-120, 0, 90]) {
          const [sx, sy, sz] = globeForward(lon, lat)
          const [ex, ey, ez] = lonLatToECEF(lon, lat)
          const d = Math.hypot(sx - ex, sy - ey, sz - ez)
          expect(d, `lat=${lat} lon=${lon}: sphere-vs-ellipsoid dist ${d} m`).toBeLessThan(G6_TOL_M)
        }
      }
    },
  )

  // Quantified evidence of the geoid gap (not gated — informational). Pins
  // the magnitude so the ~21 km claim is measured, not asserted.
  it('globe sphere↔ellipsoid gap is ~20-24 km at mid/high lat (informational)', () => {
    const gap = (lon: number, lat: number): number => {
      const [sx, sy, sz] = globeForward(lon, lat)
      const [ex, ey, ez] = lonLatToECEF(lon, lat)
      return Math.hypot(sx - ex, sy - ey, sz - ez)
    }
    expect(gap(0, 0), 'equator gap must be ~0').toBeLessThan(1)
    // Max flattening offset is near lat 45 (~24 km), still ~21 km at the
    // pole. Pin a band that documents the defect without being brittle.
    for (const lat of [45, 60, 75, 85.05]) {
      const d = gap(30, lat)
      expect(d, `lat=${lat} gap ${(d / 1000).toFixed(1)} km — expected 18-26 km`).toBeGreaterThan(18_000)
      expect(d, `lat=${lat} gap ${(d / 1000).toFixed(1)} km — expected 18-26 km`).toBeLessThan(26_000)
    }
  })
})

// ════════════════════════════════════════════════════════════════════════
// G1b — streamed-pinch zoom-anchor convergence (MEDIUM robustness lock).
//
// G1 proves a SINGLE `unprojectToLonLat` recovery is geographically exact for
// the flat non-merc set (1/2/6). It does NOT exercise the COMPOUNDING fixed-
// point iteration inside `zoomAt`: a real pinch streams many tiny zoom deltas,
// and the camera's central meridian RIDES centerX/Y, so each step re-centres
// the whole flat frame and the geo-anchor must re-converge every step. The
// review flagged the worst case: a stream NEAR the ±85.051129° Mercator clamp,
// where the clat clamp inside `_relToLonLat`/`unprojectToLonLat` could poison
// the iteration's convergence (the recovered centre stops tracking centerY).
//
// This gate streams N successive `zoomAt` steps at a FIXED cursor offset and
// asserts the geographic point under the cursor stays put to a tight CUMULATIVE
// pixel budget across the WHOLE stream — at mid latitude (control), high
// latitude (84.9°), and right at the clamp (85.0°, centerY near max camera Y).
// A regression in the zoomAt 1/2/6 branch (e.g. dropping the iteration, or the
// clamp poisoning convergence) makes the anchor slide and this fails.
//
// FINDING (PR-D-1 review follow-up): the existing fixed-point loop ALREADY
// converges to drift = 0.000 px at and beside the clamp, so NO code fix to
// `zoomAt` was needed — this is a pure regression LOCK. The clat clamp inside
// `_relToLonLat` does NOT poison convergence (the reviewer's hypothesised
// failure mode does not occur). The only genuine high-lat constraint is the
// `maxCameraY` viewport clamp (camera.ts:900), which is SHARED with mercator
// (projType 0) and legitimately caps how close the centre may sit to the pole;
// the start zoom is chosen so that clamp permits the near-clamp centre, isolating
// the iteration's behaviour rather than the viewport limit.
// ════════════════════════════════════════════════════════════════════════

const RAD2DEG_G1B = 180 / Math.PI
const EARTH_R_G1B = 6378137

/** The camera's CURRENT centre lon/lat, reconstructed exactly as the render
 *  path + `_relToLonLat` do: clon = centerX/R·RAD2DEG, clat = mercatorYToLat
 *  clamped to ±MERCATOR_LAT_LIMIT. Lets us rebuild the live render `flat_rel`
 *  feed after the camera has moved. */
function camCentreLonLat(cam: Camera): [number, number] {
  const clon = (cam.centerX / EARTH_R_G1B) * RAD2DEG_G1B
  const lat = mercatorYToLat(cam.centerY)
  const clat = Math.max(-85.051129, Math.min(85.051129, lat))
  return [clon, clat]
}

/** Project a geographic lon/lat to a device-pixel screen coord through the
 *  camera's LIVE render MVP — mirrors the GPU flat_rel = proj.forward(pt) −
 *  proj.forward(camCentre) feed, using the camera's current centre. Returns
 *  null if culled / behind camera. */
function geoToScreen(cam: Camera, lon: number, lat: number): [number, number] | null {
  const [clon, clat] = camCentreLonLat(cam)
  const proj = projForType(cam.projType, clon, clat)
  const [px, py] = proj.forward(lon, lat)
  const [cx, cy] = proj.forward(clon, clat)
  if (![px, py, cx, cy].every(Number.isFinite)) return null
  return relToScreen(cam, [px - cx, py - cy])
}

describe('G1b — flat non-merc 1/2/6 streamed-pinch zoom-anchor convergence (MEDIUM lock)', () => {
  // Cumulative under-cursor drift across the WHOLE stream must stay sub-pixel.
  const G1B_PX_BUDGET = 1.0
  const STREAM_STEPS = 20
  // Per-step zoom delta — a realistic pinch increment (~+0.04 zoom/step), so
  // 20 steps walk a full +0.8 zoom while keeping each step small (the regime
  // where the fixed-point geo-anchor matters most).
  const STREAM_DELTA = 0.04

  const FLAT_NONMERC_G1B: Array<[number, string]> = [
    [1, 'equirectangular'], [2, 'natural_earth'], [6, 'oblique_mercator'],
  ]

  // Camera centre latitudes: a MID-LATITUDE control, a HIGH-latitude case, and
  // a NEAR-CLAMP case sitting right at the ±85.051129° Mercator limit (centerY
  // ≈ max camera Y) — the regime the reviewer flagged.
  const CENTRE_LATS: Array<[number, string]> = [
    [40, 'mid-lat (control)'],
    [84.9, 'high-lat'],
    [85.0, 'near-clamp'],
  ]

  // Cursor offset from screen centre — far enough that a wrong-scale or non-
  // converged anchor slides visibly, but well inside the canvas. The Y offset
  // is BELOW centre (screen-Y down = lower latitude in the flat frame) so the
  // anchored geographic point stays at a latitude ≤ the centre latitude — i.e.
  // INSIDE the ±85.051129° Mercator-representable band even when the centre is
  // pinned at the clamp. Anchoring a point ABOVE the clamp is physically
  // impossible in a Mercator-centre camera (its centerY saturates), so that
  // would test the clamp's hard limit, not the iteration's convergence.
  const CURSOR_X = G1_W * 0.5 + 180
  const CURSOR_Y = G1_H * 0.5 + 120

  /** Stream `STREAM_STEPS` zoomAt calls at the fixed cursor and return the
   *  cumulative under-cursor pixel drift (where the originally-under-cursor
   *  geographic point ends up on screen vs the cursor itself), or null if the
   *  recovery is unavailable at any sampled step. */
  function streamedPinchDriftPx(projType: number, centreLat: number, startZoom: number): number | null {
    const cam = new Camera(G1_CAM_LON, centreLat, startZoom)
    cam.projType = projType
    cam.globeMode = false
    cam.bearing = 0
    cam.pitch = 0

    // Geographic point under the cursor BEFORE any zoom.
    const g0 = cam.unprojectToLonLat(CURSOR_X, CURSOR_Y, G1_W, G1_H, G1_DPR)
    if (!g0) return null

    for (let s = 0; s < STREAM_STEPS; s++) {
      cam.zoomAt(STREAM_DELTA, CURSOR_X, CURSOR_Y, G1_W, G1_H)
    }

    // Where does that ORIGINAL geographic point now sit on screen? The anchor
    // contract says it must still be under the cursor.
    const screen = geoToScreen(cam, g0[0], g0[1])
    if (!screen) return null
    return Math.hypot(screen[0] - CURSOR_X, screen[1] - CURSOR_Y)
  }

  for (const [projType, name] of FLAT_NONMERC_G1B) {
    for (const [centreLat, latLabel] of CENTRE_LATS) {
      it(`projType ${projType} (${name}) ${latLabel}: ${STREAM_STEPS}-step streamed pinch keeps the under-cursor point < ${G1B_PX_BUDGET}px`, () => {
        // z9 start: high enough that `maxCameraY` (camera.ts:900 — caps the
        // centre so the Mercator pole edge stays off-screen) PERMITS a centre at
        // the near-clamp latitude (85.0°) throughout the stream. At a lower zoom
        // the viewport clamp legitimately pulls the centre away from the pole
        // (shared with mercator projType 0 — NOT a 1/2/6 branch effect), which
        // would mask the iteration-convergence behaviour this gate isolates.
        const drift = streamedPinchDriftPx(projType, centreLat, 9)
        expect(drift, `${name} ${latLabel}: streamed-pinch recovery returned null`).not.toBeNull()
        expect(
          drift!,
          `${name} ${latLabel}: cumulative under-cursor drift ${drift!.toFixed(4)}px over ${STREAM_STEPS} steps (budget ${G1B_PX_BUDGET}px)`,
        ).toBeLessThan(G1B_PX_BUDGET)
      })
    }
  }
})
