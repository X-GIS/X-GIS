// Regression: GeoJSON line/polygon "뒷면" (back-face) leak on the globe.
//
// Symptom (user report): on the globe (projType 7), GeoJSON line and polygon
// geometry on the far/occluded side of the sphere rendered THROUGH the front.
//
// Root cause: the polygon/line uniform writers — vector-tile-renderer (tiled
// GeoJSON), renderer.renderToPass (non-tiled GeoJSON) and graticule-renderer —
// never wrote the #600 `globe_eye` uniform. With globe_eye.w == 0 the shader
// hemisphere cull (needs_backface_cull) falls back to the PITCH-INVARIANT
// centre-hemisphere model, which keeps the whole front hemisphere out to 90°
// from the projection centre — INCLUDING the near-limb band between the true
// eye-horizon (cos = R/|eye|) and 90° that is geometrically OCCLUDED by the
// sphere's bulge. The ground earth-surface uses STENCIL_*_NO_DEPTH (no depth
// write) so it cannot depth-occlude that band, and line topology has no GPU
// winding cull — so far-side strokes/fills leaked. (raster/point/heatmap
// already wrote globe_eye and did NOT leak; only the vector path was missing.)
//
// Fix: the three vector writers now pack globe_eye = (normalize(eye), R/|eye|)
// from frame.eye, switching the globe cull to the EYE-HORIZON cap which culls
// exactly the occluded band.
//
// This test is the FAIL-BEFORE / PASS-AFTER discriminator for that band — the
// inverse of back-face-cull-comprehensive.test.ts's #600 far-cap test:
//   • centre-hemisphere fallback (globe_eye all-zero) KEEPS the band  → the leak
//   • eye-horizon (real globe_eye)                    CULLS the band  → the fix
// using the SAME CPU port of needs_backface_cull the shader emits.

import { describe, expect, it, beforeAll } from 'vitest'
import { needsBackfaceCullWgsl } from '@xgis/map'
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

// CPU port of polygon_cos_c_fragment / line back-face (same as the comprehensive
// sweep): reconstruct lon/lat from absolute Mercator then call the shared cull.
function vectorCull(lon: number, lat: number, clon: number, clat: number, eye?: readonly [number, number, number]): number {
  const [mx, my] = lonLatToMerc(lon, lat)
  const absLon = mx / (DEG2RAD * EARTH_R)
  const latRad = 2 * Math.atan(Math.exp(my / EARTH_R)) - Math.PI / 2
  const absLat = latRad / DEG2RAD
  return needsBackfaceCullWgsl(7, absLon, absLat, clon, clat, globeEyeUniform(eye) as [number, number, number, number])
}

describe('globe GeoJSON back-face leak — eye-horizon vs centre-hemisphere fallback', () => {
  const clon = 0, clat = 0
  let eye: readonly [number, number, number]
  // A near-limb point in the OCCLUDED band: kept by the centre-hemisphere
  // fallback (cull >= 0) but culled by the eye-horizon model (cull < 0).
  let occludedBandPoint: { lon: number; lat: number } | null = null

  beforeAll(() => {
    // Nadir globe view (pitch 0): eye sits on the centre normal so the cull
    // model difference is purely the occluded near-limb band (true horizon …
    // 90°). dist 2.2× radius → a finite, representative altitude.
    const v = buildGlobeMatrix(clon, clat, 2.2, 0, 0, 1280, 720)
    eye = v.eye as readonly [number, number, number]
    occludedBandPoint = (() => {
      for (let lat = -89; lat <= 89; lat += 1) {
        for (let lon = -180; lon < 180; lon += 1) {
          const kept = vectorCull(lon, lat, clon, clat, undefined)   // fallback (globe_eye=0)
          const culled = vectorCull(lon, lat, clon, clat, eye)       // eye-horizon (globe_eye written)
          if (kept >= 0 && culled < 0) return { lon, lat }
        }
      }
      return null
    })()
  })

  it('the occluded near-limb band is non-empty (the two cull models disagree)', () => {
    // If empty, the leak could not occur and the fix would be vacuous.
    expect(occludedBandPoint, 'no occluded near-limb point — fix would be vacuous').not.toBeNull()
  })

  it('centre-hemisphere fallback LEAKS the band (fail-before); eye-horizon CULLS it (fix)', () => {
    const { lon, lat } = occludedBandPoint!
    // FAIL-BEFORE: globe_eye unwritten → centre-hemisphere keeps the occluded
    // band fragment (the rendered 뒷면 leak).
    expect(vectorCull(lon, lat, clon, clat, undefined), 'fail-before: fallback already culled — no leak to fix')
      .toBeGreaterThanOrEqual(0)
    // FIX: globe_eye written → eye-horizon culls the occluded band.
    expect(vectorCull(lon, lat, clon, clat, eye), `occluded band point (${lon},${lat}) not culled by eye-horizon`)
      .toBeLessThan(0)
  })

  it('genuinely front (centre) geometry still passes under eye-horizon', () => {
    // The projection centre is always eye-visible — must NOT be culled, so the
    // fix tightens the limb without hiding the visible hemisphere.
    expect(vectorCull(clon, clat, clon, clat, eye)).toBeGreaterThan(0)
  })
})
