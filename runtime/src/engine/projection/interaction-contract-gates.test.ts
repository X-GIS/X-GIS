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
//   G4 — globe pick accuracy. PARTIALLY LANDED (#10/#11 globe-mode wiring):
//        `clientToLngLat` now routes globeMode (true globe 7 + tilted discs
//        promoted to the sphere) through the ray↔sphere inverse — gated in
//        controller-interaction-gate.test.ts GATE 2C. Still deferred for the
//        UNTILTED disc set (3/4/5, #9: stays null); the sphere-vs-ellipsoid
//        geoid tolerance also remains open (#7).
//   G5 — globe pan/zoom round-trip. CPU-LANDED (#11): zoomAt routes globeMode
//        through unprojectGlobe (G5c below — flipped to a regression lock) and
//        the drag anchor ground-tracks via panGlobeToScreenAnchor (G5d below).
//        The real-GPU interaction e2e + eyeball feel pass remains open.
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
import { globeForward, buildGlobeMatrix, unprojectGlobe } from './globe'
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

// ════════════════════════════════════════════════════════════════════════
// G1c — flat non-merc 1/2/6 streamed-DRAG anchor convergence (B3 lock).
//
// THE INVARIANT: the geographic point grabbed at pointer-down stays under the
// cursor across a streamed drag. G1b locks this for the PINCH path (zoomAt's
// ≤6-pass fixed-point iteration); the DRAG path (panToScreenAnchor) ran a
// SINGLE pass for 1/2/6 — and a wrong-space one at that: it subtracted the
// cursor point's ABSOLUTE Mercator metres where the Mercator arm subtracts
// camera-RELATIVE metres, so the grabbed point slid tens of px off the cursor
// over a 30-step drag (B3 — the residual controller-interaction-gate.test.ts
// documented unasserted). Both gestures now share the same fixed-point loop
// (camera-helpers.ts convergeFlatAnchor); this gate locks the DRAG side.
//
// HARNESS (G3a/G5d oracle style — NOT the camera's own recovery): derive the
// grabbed geographic point from the start-cursor offset via the per-projType
// ORACLE inverse (projForType; the pitch-0 dpr-1 flat MVP maps own-plane rel
// metres to screen px linearly at mpp per px — the mapping only SEEDS where
// the grabbed point is, its true pixel is then taken from the oracle forward
// geoToScreen through the live MVP). Feed panToScreenAnchor the point's
// canonical Mercator-metre anchor (mercator.forward — exactly what the
// controller stashes at pointer-down via unprojectToMercatorAnchor), stream
// 30 cursor moves (+2, −1.5 px/step — the same drag the controller wiring
// gate fires), then re-project the grabbed point via geoToScreen and assert
// it is still under the moved cursor. The camera's own unprojectToLonLat is
// never consulted by the measurement (it is what the loop under test
// iterates on).
// ════════════════════════════════════════════════════════════════════════
describe('G1c — flat non-merc 1/2/6 streamed-drag anchor convergence (B3 lock)', () => {
  // Cumulative under-cursor drift after the WHOLE 30-step drag must stay
  // sub-pixel — same budget as G1b's pinch stream.
  const G1C_PX_BUDGET = 1.0
  const DRAG_STEPS = 30
  // Per-step cursor motion: the controller wiring gate's stream (GATE 2A).
  const DRAG_DX = 2, DRAG_DY = -1.5

  // Metres per device pixel at the start zoom (TILE_PX=512 pyramid, dpr 1) —
  // seeds the grabbed point's own-plane offset from the cursor offset.
  const WORLD_MERC_G1C = 40075016.686
  const TILE_PX_G1C = 512

  const FLAT_NONMERC_G1C: Array<[number, string]> = [
    [1, 'equirectangular'], [2, 'natural_earth'], [6, 'oblique_mercator'],
  ]

  // Same latitude spread as G1b: mid-lat control, high-lat, and the centre
  // pinned at the ±85.051129° Mercator clamp. The cursor stream drags UP the
  // screen (DRAG_DY < 0), which moves the centre to LOWER latitudes — away
  // from the clamp — so the near-clamp case exercises convergence beside the
  // clamp, not the (mercator-shared) maxCameraY hard limit.
  const CENTRE_LATS_G1C: Array<[number, string]> = [
    [40, 'mid-lat (control)'],
    [84.9, 'high-lat'],
    [85.0, 'near-clamp'],
  ]

  // Same start-cursor offset as G1b — below screen centre, so the grabbed
  // latitude sits INSIDE the Mercator-representable band at the clamp.
  const G1C_CURSOR_X = G1_W * 0.5 + 180
  const G1C_CURSOR_Y = G1_H * 0.5 + 120

  /** Stream a DRAG_STEPS-step drag through panToScreenAnchor and return the
   *  final under-cursor pixel drift of the grabbed geographic point
   *  (oracle-measured), or null if any oracle step is unavailable. */
  function streamedDragDriftPx(projType: number, centreLat: number, startZoom: number): number | null {
    const cam = new Camera(G1_CAM_LON, centreLat, startZoom)
    cam.projType = projType
    cam.globeMode = false
    cam.bearing = 0
    cam.pitch = 0

    // Grabbed geographic point — oracle inverse of the start-cursor offset.
    const mpp = (WORLD_MERC_G1C / TILE_PX_G1C) / Math.pow(2, startZoom)
    const [clon0, clat0] = camCentreLonLat(cam)
    const proj0 = projForType(projType, clon0, clat0)
    const cv0 = proj0.forward(clon0, clat0)
    const g0 = proj0.inverse(
      (G1C_CURSOR_X - G1_W / 2) * mpp + cv0[0],
      (G1_H / 2 - G1C_CURSOR_Y) * mpp + cv0[1],
    )
    if (!g0.every(Number.isFinite)) return null

    // TRUE start pixel of the grabbed point through the live render MVP, and
    // the canonical Mercator-metre anchor the controller would stash for it.
    const s0 = geoToScreen(cam, g0[0], g0[1])
    if (!s0) return null
    const [ax, ay] = mercator.forward(g0[0], g0[1])

    let px = s0[0], py = s0[1]
    for (let s = 0; s < DRAG_STEPS; s++) {
      px += DRAG_DX; py += DRAG_DY
      cam.panToScreenAnchor(ax, ay, px, py, G1_W, G1_H)
    }

    // Where does the grabbed geographic point now sit on screen? The drag
    // anchor contract says: still under the (moved) cursor.
    const sEnd = geoToScreen(cam, g0[0], g0[1])
    if (!sEnd) return null
    return Math.hypot(sEnd[0] - px, sEnd[1] - py)
  }

  // MERCATOR CONTROL: projType 0's drag anchor is the exact single-pass
  // `centre = anchor − rel` (its z=0 plane IS the Mercator plane). Drift here
  // is pure float32-MVP oracle noise — proves the harness itself is sound.
  it('projType 0 (mercator) mid-lat control: 30-step streamed drag is exact (harness soundness)', () => {
    const drift = streamedDragDriftPx(0, 40, 9)
    expect(drift, 'mercator: streamed-drag oracle returned null').not.toBeNull()
    expect(drift!, `mercator control drift ${drift!.toFixed(6)}px`).toBeLessThan(0.01)
  })

  for (const [projType, name] of FLAT_NONMERC_G1C) {
    for (const [centreLat, latLabel] of CENTRE_LATS_G1C) {
      it(`projType ${projType} (${name}) ${latLabel}: ${DRAG_STEPS}-step streamed drag keeps the grabbed point < ${G1C_PX_BUDGET}px under the cursor`, () => {
        // z9 start — same maxCameraY rationale as G1b: the viewport clamp
        // must PERMIT the near-clamp centre so the gate isolates the
        // iteration's convergence, not the (mercator-shared) viewport limit.
        const drift = streamedDragDriftPx(projType, centreLat, 9)
        expect(drift, `${name} ${latLabel}: streamed-drag oracle returned null`).not.toBeNull()
        expect(
          drift!,
          `${name} ${latLabel}: cumulative under-cursor drift ${drift!.toFixed(4)}px over ${DRAG_STEPS}-step drag (budget ${G1C_PX_BUDGET}px)`,
        ).toBeLessThan(G1C_PX_BUDGET)
      })
    }
  }
})

// ════════════════════════════════════════════════════════════════════════
// GATE 1 (PR-D) — disc + globe zoomAt-anchor invariant.
//
// THE INVARIANT: the geographic point under the cursor must stay under the
// cursor across a zoom delta. This is the zoom-anchor contract G1/G1b do NOT
// reach for the azimuthal disc set (3/4/5) or the globe (7):
//   - G1 proves a single screen→geo recovery; it never calls zoomAt for the
//     disc set (unprojectToLonLat returns null for 3/4/5/7).
//   - G1b streams zoomAt but ONLY for the flat non-merc set (1/2/6), which
//     has a fixed-point iteration in zoomAt; the disc/globe branches are
//     structurally different (disc: the promotesToGlobeWhenTilted geo-anchor
//     branch; globe: the globeMode dispatch into globe-anchor.ts
//     zoomAtGlobeAnchored).
//
// HARNESS: pick a screen pixel offset from centre; recover the geographic
// point there via the CORRECT per-projType ORACLE (NOT the camera's own
// recovery, which is the thing under test); stream zoomAt at that fixed
// cursor; re-project that geographic point to screen via the projType
// forward + the live render MVP; assert it is still ~ the original pixel.
//
// The streamed (many small deltas) form matches a real wheel/pinch and is
// the regime the disc special case is tuned for (its per-step geographic
// rotation is clamped, so a single large delta leaves a larger residual than
// a stream of small ones — see STREAM_DELTA).
//
//   G3a projType 3 (orthographic): normal it() — PASSES. zoomAt has the disc
//        geo-anchor branch (camera.ts, discAnchorFor → invOrthographic).
//        Regression LOCK: drop that branch and the anchor flings like old G3b.
//   G3b projType 4 (azimuthal_equidistant) + 5 (stereographic): normal it() —
//        PASSES (regression lock). zoomAt's disc geo-anchor covers the whole
//        promotesToGlobeWhenTilted set {3,4,5}: discAnchorFor dispatches
//        invAzimuthalEquidistant / invStereographic (camera-helpers.ts). Was
//        ~10-18 px fling while the branch was gated `projType === 3` and 4/5
//        fell to the general arm's Mercator-metre subtraction of a disc-plane
//        `before`/`after` (wrong scale). Oracle = getProjection(name,clon,
//        clat).inverse on the disc plane (these are NOT globeMode at pitch 0 —
//        an untilted disc renders through the flat MVP, getFrameView).
//   G5c projType 7 (globe): normal it() — PASSES (regression lock, #11 landed).
//        zoomAt now dispatches globeMode to the ray↔sphere fixed point
//        (globe-anchor.ts zoomAtGlobeAnchored) instead of anchoring against
//        the phantom flat Mercator z=0 plane. Oracle = unprojectGlobe on the
//        live globe MVP (the same buildGlobeMatrix the renderer uses via
//        getViewForProjection(7)). Dropping the globe dispatch returns this
//        to the 16-20 px phantom-plane fling.
//   G5d projType 7 (globe) DRAG: normal it() — landed with G5c. The drag
//        anchor is the grabbed lon/lat (controller globeMode branch) and
//        panToScreenAnchor ground-tracks it via panGlobeToScreenAnchor.
//
// OBSERVED anchor drift (this environment, see body for the exact harness):
//   G3a ortho(3) z10/z12 streamed 20×0.04 : ~2e-4 px  (PASS, locked; iterated)
//   G3b azim_eq(4) / stereo(5) z4..z8       : ~2e-4 px  (PASS, locked; was ~10-18 px)
//   G5c globe(7)  z4/z8 pitch0/30           : was 16-20 px phantom-plane →
//        0.011-0.35 px wired. The z8 residual is the f32 GlobeView.matrix +
//        f32 invert4x4 noise floor (~1 m at 6.4e6 m sphere coords), which
//        grows ~2×/zoom level in px terms (measured 1.05 px z10 / 3.4 px z12 /
//        7.4 px z14) — an unprojectGlobe precision property, not an anchor-
//        logic defect; a deep-zoom fix needs an f64 (or RTC) unproject matrix.
//   G5d globe(7) drag z4/z8 pitch0/45       : 0.005-0.06 px worst per-move
//        (was 7-11 px through the phantom-plane Mercator-metre anchor).
// ════════════════════════════════════════════════════════════════════════

describe('GATE 1 — disc(3/4/5) + globe(7) zoomAt-anchor invariant (G3a+G3b disc set + G5c/G5d globe all locked)', () => {
  const GZ_W = 800, GZ_H = 800, GZ_DPR = 1
  const GZ_R = 6378137
  const GZ_RAD2DEG = 180 / Math.PI
  // Streamed pinch: 20 small deltas (~+0.8 zoom total) — the regime the disc
  // geo-anchor's clamped per-step rotation is designed for and a wheel/pinch
  // actually produces. Matches G1b's STREAM_DELTA.
  const GZ_STEPS = 20
  const GZ_DELTA = 0.04
  // Cursor offset from screen centre (device px == CSS px at dpr 1).
  const GZ_OFF_X = 150
  const GZ_OFF_Y = 100

  /** camera centre lon/lat reconstructed exactly as the render path does
   *  (centerX/Y are canonical Mercator metres; the disc/globe frames recentre
   *  on this). Mirror of camCentreLonLat in the G1b block. */
  function gzCentre(cam: Camera): [number, number] {
    const clon = (cam.centerX / GZ_R) * GZ_RAD2DEG
    const lat = mercatorYToLat(cam.centerY)
    const clat = Math.max(-85.051129, Math.min(85.051129, lat))
    return [clon, clat]
  }

  // ── DISC (3/4/5) oracle: forward/inverse on the projType's own disc plane,
  //    projected through the camera's flat render MVP (getViewForProjection
  //    routes an untilted disc to getFrameView — the flat 2D MVP). ──

  /** Recover the geographic point under a screen pixel via the disc inverse on
   *  the disc plane (the CORRECT oracle — independent of the camera's own
   *  recovery, which is what zoomAt is being tested against). */
  function discGeoUnderScreen(cam: Camera, name: string, sx: number, sy: number): [number, number] | null {
    const rel = cam.unprojectToZ0(sx * GZ_DPR, sy * GZ_DPR, GZ_W, GZ_H, GZ_DPR)
    if (!rel) return null
    const [clon, clat] = gzCentre(cam)
    const proj = getProjection(name, clon, clat)
    const [cx, cy] = proj.forward(clon, clat)
    if (![cx, cy].every(Number.isFinite)) return null
    const g = proj.inverse(rel[0] + cx, rel[1] + cy)
    return g.every(Number.isFinite) ? [g[0], g[1]] : null
  }

  /** Project a geographic point to a screen pixel via the disc forward on the
   *  disc plane + the camera's live render MVP. */
  function discScreenForGeo(cam: Camera, name: string, lon: number, lat: number): [number, number] | null {
    const [clon, clat] = gzCentre(cam)
    const proj = getProjection(name, clon, clat)
    const [px, py] = proj.forward(lon, lat)
    const [cx, cy] = proj.forward(clon, clat)
    if (![px, py, cx, cy].every(Number.isFinite)) return null
    return relToScreen(cam, [px - cx, py - cy])
  }

  /** Stream GZ_STEPS zoomAt calls at a fixed cursor on a disc projType and
   *  return the cumulative under-cursor pixel drift (where the
   *  originally-under-cursor geographic point ends up vs the cursor). */
  function discStreamedDriftPx(projType: number, name: string, startZoom: number): number | null {
    const cam = new Camera(20, 30, startZoom)
    cam.projType = projType
    cam.globeMode = false
    cam.bearing = 0
    // The azimuthal set pitch-locks (its 2D disc has no tilt) — honour the
    // production accessor so an untilted disc renders through the flat MVP.
    cam.pitchLocked = true
    cam.pitch = 0
    const SX = GZ_W * 0.5 + GZ_OFF_X, SY = GZ_H * 0.5 + GZ_OFF_Y
    const g0 = discGeoUnderScreen(cam, name, SX, SY)
    if (!g0) return null
    for (let s = 0; s < GZ_STEPS; s++) cam.zoomAt(GZ_DELTA, SX, SY, GZ_W, GZ_H)
    const screen = discScreenForGeo(cam, name, g0[0], g0[1])
    if (!screen) return null
    return Math.hypot(screen[0] - SX, screen[1] - SY)
  }

  // ── GLOBE (7) oracle: ray↔sphere unproject + sphere forward through the
  //    live globe MVP (the same buildGlobeMatrix getViewForProjection(7) uses
  //    via _globeFrame). ──

  function gzGlobeView(cam: Camera): ReturnType<typeof buildGlobeMatrix> {
    const [clon, clat] = gzCentre(cam)
    return buildGlobeMatrix(
      clon, clat, cam.zoom, cam.pitch, cam.bearing,
      GZ_W / GZ_DPR, GZ_H / GZ_DPR, cam.globeOrtho,
    )
  }

  /** Project a geographic point to a screen pixel via the sphere forward +
   *  the live globe MVP (absolute-coords matrix). */
  function globeScreenForGeo(cam: Camera, lon: number, lat: number): [number, number] | null {
    const v = gzGlobeView(cam)
    const p = globeForward(lon, lat)
    const clip = mat4Vec4(v.matrix, [p[0], p[1], p[2], 1])
    if (clip[3] <= 1e-6) return null
    return [(clip[0] / clip[3] + 1) * 0.5 * GZ_W, (1 - clip[1] / clip[3]) * 0.5 * GZ_H]
  }

  /** Stream GZ_STEPS zoomAt calls at a fixed cursor on the globe and return
   *  the cumulative under-cursor pixel drift, recovering the geographic point
   *  via the on-screen sphere (unprojectGlobe), NOT the camera's flat z=0
   *  unproject. */
  function globeStreamedDriftPx(startZoom: number, pitch: number): number | null {
    const cam = new Camera(20, 30, startZoom)
    cam.projType = 7
    cam.globeMode = true
    cam.bearing = 0
    cam.pitch = pitch
    const SX = GZ_W * 0.5 + GZ_OFF_X, SY = GZ_H * 0.5 + GZ_OFF_Y
    const g0 = unprojectGlobe(SX, SY, GZ_W, GZ_H, gzGlobeView(cam))
    if (!g0) return null
    for (let s = 0; s < GZ_STEPS; s++) cam.zoomAt(GZ_DELTA, SX, SY, GZ_W, GZ_H)
    const screen = globeScreenForGeo(cam, g0[0], g0[1])
    if (!screen) return null
    return Math.hypot(screen[0] - SX, screen[1] - SY)
  }

  // ── G3a — orthographic(3): PASSES (regression lock on the disc geo-anchor). ──
  // The disc geo-anchor (camera.ts:917) keeps the geographic point under the
  // cursor. The anchor now ITERATES recover-and-rotate inside zoomAt (the
  // single-pass local-linear residual used to grow toward low zoom: 0.06 px
  // @z10 then, ~3.4 px @z4 for the G3b pair), so the streamed drift is ~2e-4
  // px at every zoom; the lock stays at z≥10 (its historical regime) with the
  // 1.0 px G1b-mirror budget — a regression (dropping the disc geo-anchor
  // branch) jumps this to the ~10-18 px pre-fix fling range.
  const G3A_PX_BUDGET = 1.0
  for (const zoom of [10, 12]) {
    it(`G3a projType 3 (orthographic) z=${zoom}: ${GZ_STEPS}-step zoom keeps the under-cursor geo point < ${G3A_PX_BUDGET}px [regression lock — disc geo-anchor, camera.ts:1000]`, () => {
      const drift = discStreamedDriftPx(3, 'orthographic', zoom)
      expect(drift, `ortho streamed-zoom recovery returned null (z=${zoom})`).not.toBeNull()
      expect(
        drift!,
        `ortho cumulative under-cursor drift ${drift!.toFixed(4)}px over ${GZ_STEPS} steps (budget ${G3A_PX_BUDGET}px)`,
      ).toBeLessThan(G3A_PX_BUDGET)
    })
  }

  // ── G3b — azimuthal_equidistant(4) + stereographic(5): PASSES (lock). ──
  // zoomAt's disc geo-anchor covers the whole promotesToGlobeWhenTilted set:
  // discAnchorFor (camera-helpers.ts) dispatches invAzimuthalEquidistant /
  // invStereographic, so the under-cursor geo point stays put. Regression
  // LOCK (flipped from it.fails when the inverses were wired): re-gating the
  // branch to ortho only — or breaking an inverse's ρ→c map — returns 4/5 to
  // the general arm's ~10-18 px wrong-scale Mercator-metre fling.
  const G3B_PX_BUDGET = 1.0
  const G3B_DISC: Array<[number, string]> = [
    [4, 'azimuthal_equidistant'], [5, 'stereographic'],
  ]
  for (const [projType, name] of G3B_DISC) {
    for (const zoom of [4, 8]) {
      it(
        `G3b projType ${projType} (${name}) z=${zoom}: ${GZ_STEPS}-step zoom keeps the under-cursor geo point < ${G3B_PX_BUDGET}px ` +
        `[regression lock — disc geo-anchor via discAnchorFor (camera-helpers.ts); ` +
        `was ~10-18px fling while the branch was gated projType===3]`,
        () => {
          const drift = discStreamedDriftPx(projType, name, zoom)
          expect(drift, `${name} streamed-zoom recovery returned null (z=${zoom})`).not.toBeNull()
          expect(
            drift!,
            `${name} cumulative under-cursor drift ${drift!.toFixed(4)}px over ${GZ_STEPS} steps (budget ${G3B_PX_BUDGET}px)`,
          ).toBeLessThan(G3B_PX_BUDGET)
        },
      )
    }
  }

  // ── G5c — globe(7): PASSES (regression lock — #11 landed). ──
  // zoomAt dispatches globeMode to zoomAtGlobeAnchored (globe-anchor.ts): the
  // cursor anchor is recovered on the RENDERED SPHERE via the ray↔sphere
  // unprojectGlobe and the centre re-converges through a ≤6-pass fixed point,
  // replacing the phantom flat Mercator z=0-plane anchor (was 16-20 px drift
  // over this stream; wired = 0.011-0.35 px, see the OBSERVED table above).
  // Dropping the globe dispatch in camera.zoomAt returns this to the fling.
  const G5C_PX_BUDGET = 1.0
  for (const zoom of [4, 8]) {
    for (const pitch of [0, 30]) {
      it(
        `G5c projType 7 (globe) z=${zoom} pitch=${pitch}: ${GZ_STEPS}-step zoom keeps the under-cursor geo point < ${G5C_PX_BUDGET}px ` +
        `[regression lock — zoomAt routes globeMode through zoomAtGlobeAnchored (ray↔sphere fixed point); ` +
        `was 16-20px against the phantom flat Mercator plane]`,
        () => {
          const drift = globeStreamedDriftPx(zoom, pitch)
          expect(drift, `globe streamed-zoom recovery returned null (z=${zoom} p=${pitch})`).not.toBeNull()
          expect(
            drift!,
            `globe cumulative under-cursor drift ${drift!.toFixed(4)}px over ${GZ_STEPS} steps (budget ${G5C_PX_BUDGET}px)`,
          ).toBeLessThan(G5C_PX_BUDGET)
        },
      )
    }
  }

  // ── G5d — globe(7) drag ground-tracking (landed WITH the #11 wiring). ──
  // The controller's globeMode drag anchor is the grabbed lon/lat (ray↔sphere,
  // controller.ts globeMode branch); each pointermove panToScreenAnchor
  // rotates the centre so that lon/lat returns under the cursor
  // (globe-anchor.ts panGlobeToScreenAnchor — centerLatDeg pole semantics,
  // NOT the flat arm's Mercator-metre subtraction). Streams the SAME 30-move
  // drag the GATE 2A controller harness fires and asserts the WORST per-move
  // under-cursor drift, so one bad step cannot hide behind a good final frame.
  // Budget 1.0 px mirrors G3a/G5c; measured 0.005-0.06 px (16× headroom).
  // Pre-wiring (phantom Mercator-metre anchor + flat-plane cursor unproject)
  // measured 7-11 px on this harness.
  const G5D_PX_BUDGET = 1.0

  /** Worst per-move under-cursor pixel drift across a streamed 30-move drag,
   *  driving the PRODUCTION camera path (panToScreenAnchor) with the anchor
   *  the controller's globeMode branch captures. */
  function globeDragWorstDriftPx(startZoom: number, pitch: number): number | null {
    const cam = new Camera(20, 30, startZoom)
    cam.projType = 7
    cam.globeMode = true
    cam.bearing = 0
    cam.pitch = pitch
    const SX0 = GZ_W * 0.5 - 120, SY0 = GZ_H * 0.5 + 80
    // The sphere point under the cursor at drag start = the controller's
    // globeMode anchor (unprojectGlobeFromCamera ≡ this oracle at dpr 1).
    const g0 = unprojectGlobe(SX0, SY0, GZ_W, GZ_H, gzGlobeView(cam))
    if (!g0) return null
    let px = SX0, py = SY0
    let worst = 0
    for (let s = 0; s < 30; s++) {
      px += 2; py -= 1.5
      cam.panToScreenAnchor(g0[0], g0[1], px, py, GZ_W, GZ_H)
      const screen = globeScreenForGeo(cam, g0[0], g0[1])
      if (!screen) return null
      worst = Math.max(worst, Math.hypot(screen[0] - px, screen[1] - py))
    }
    return worst
  }

  for (const zoom of [4, 8]) {
    for (const pitch of [0, 45]) {
      it(
        `G5d projType 7 (globe) z=${zoom} pitch=${pitch}: 30-move drag keeps the grabbed sphere point < ${G5D_PX_BUDGET}px under the cursor (worst move) ` +
        `[globe drag ground-tracking — panGlobeToScreenAnchor; was 7-11px through the phantom-plane Mercator-metre anchor]`,
        () => {
          const worst = globeDragWorstDriftPx(zoom, pitch)
          expect(worst, `globe drag recovery returned null (z=${zoom} p=${pitch})`).not.toBeNull()
          expect(
            worst!,
            `globe worst per-move under-cursor drift ${worst!.toFixed(4)}px across 30 moves (budget ${G5D_PX_BUDGET}px)`,
          ).toBeLessThan(G5D_PX_BUDGET)
        },
      )
    }
  }

  // G5d pole semantics: an anchored globe drag must keep the centerLatDeg
  // pole-reach (roadmap S12) — the globe branch writes centerLatDeg directly
  // and must NOT fall into the flat arm's trailing _syncCenterLatFromMercator,
  // which clamps back to ±85.051129 and would make the pole unreachable by
  // anchored drag (the pre-fix panToScreenAnchor-vs-pan conflict). centerY
  // stays Mercator-bounded for the 2D / tile-pyramid readers.
  it('G5d pole-reach: anchored globe drag crosses 85.05° (centerLatDeg authoritative; centerY mirror stays bounded)', () => {
    const cam = new Camera(0, 84.5, 3)
    cam.projType = 7
    cam.globeMode = true
    cam.bearing = 0
    cam.pitch = 0
    // Grab the screen centre (= the 84.5° centre point) and drag it 300 px
    // DOWN: content follows the cursor, the centre rolls poleward (measured:
    // centerLatDeg reaches the poleLimit(7)=90 clamp on this drag).
    const anchor = unprojectGlobe(GZ_W / 2, GZ_H / 2, GZ_W, GZ_H, gzGlobeView(cam))
    expect(anchor, 'pole-reach: anchor unproject returned null').not.toBeNull()
    cam.panToScreenAnchor(anchor![0], anchor![1], GZ_W / 2, GZ_H / 2 + 300, GZ_W, GZ_H)
    expect(cam.centerLatDeg, `centerLatDeg ${cam.centerLatDeg}° did not cross the Mercator wall`).toBeGreaterThan(85.051129)
    // Mercator mirror stays representable for the 2D / tile-pyramid readers.
    expect(mercatorYToLat(cam.centerY)).toBeLessThanOrEqual(85.051129 + 1e-6)
    expect(Number.isFinite(cam.centerX)).toBe(true)
  })

  // Quantified evidence (not gated — informational). Pins the anchor-drift
  // magnitudes so the "anchored" claims are MEASURED, not asserted: with #9
  // (disc geo-anchor over all of promotesToGlobeWhenTilted) AND #11 (globe
  // ray↔sphere dispatch) both landed, ALL FOUR are sub-pixel.
  it('disc/globe zoomAt-anchor drift: disc set (3/4/5) + globe(7) all anchored sub-px (informational)', () => {
    const ortho = discStreamedDriftPx(3, 'orthographic', 10)
    const azim = discStreamedDriftPx(4, 'azimuthal_equidistant', 8)
    const stereo = discStreamedDriftPx(5, 'stereographic', 8)
    const globe = globeStreamedDriftPx(8, 0)
    for (const [label, v] of [['ortho', ortho], ['azim', azim], ['stereo', stereo], ['globe', globe]] as const) {
      expect(v, `${label} drift returned null`).not.toBeNull()
    }
    // #9 + #11 both landed: every projection class is anchored. Pin sub-px.
    expect(ortho!, `ortho(3) drift ${ortho}px — expected sub-px (anchored)`).toBeLessThan(1.0)
    expect(azim!, `azim_eq(4) drift ${azim}px — expected sub-px (anchored)`).toBeLessThan(1.0)
    expect(stereo!, `stereo(5) drift ${stereo}px — expected sub-px (anchored)`).toBeLessThan(1.0)
    expect(globe!, `globe(7) drift ${globe}px — expected sub-px (ray↔sphere anchored)`).toBeLessThan(1.0)
  })
})
