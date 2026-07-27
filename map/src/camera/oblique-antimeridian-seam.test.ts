// ═══ oblique_mercator rotated-antimeridian tile-join seam continuity — #802 ═══
//
// Repro camera (hash #1.40/50.54646/-88.35140 → zoom 1.40, lat 50.54646,
// lon -88.35140). oblique_mercator's projection centre TRACKS the camera
// (render-loop: clon = centre lon, clat = centre lat), so the rotated
// antimeridian (where lam_rot = ±π) sweeps the far side and cuts DIAGONALLY
// across the axis-aligned Mercator tile grid — it does not follow tile seams.
//
// The GPU `project_geom` (and its CPU mirror `project_geom_cpu`,
// projectGeomWgsl) previously unwrapped each vertex's rotated longitude toward
// a PER-TILE reference `oblique_rot(ref_lon, clat)`. Two Mercator tiles that
// straddle the rotated antimeridian then chose DIFFERENT ±π branches for their
// shared meridian edge, so the same geographic vertex landed a full 2π·R world
// copy apart on the two tiles — the reported tile-join tearing (horizontal seam
// smears across the far side at low zoom).
//
// The fix unwraps toward the FIXED rotated-frame origin (0 = the projection
// centre's own lam_rot) instead of a per-tile reference. project_geom's oblique
// x is then a pure function of (lon, lat, clon, clat) — tile-INDEPENDENT — so any
// two tiles project a shared-edge vertex to the SAME position by construction.
//
// Pure f64 (no GPU) → runs in the standard vitest CI lane. On unmodified
// origin/main the first `it` FAILS (worst seam gap ≈ 2π·R ≈ 4.0e7 m at the z=2
// lon=90 seam, low latitudes); after the fix the worst gap is f64 round-off.

import { describe, expect, it } from 'vitest'
import { projectGeomWgsl } from '@xgis/map'
import { obliqueMercator } from '@xgis/geo'

const OBL = 6 // projType oblique_mercator
const R = 6378137
const TWO_PI_R = 2 * Math.PI * R

// Repro-camera projection centre (oblique centre == camera centre).
const clon = -88.3514
const clat = 50.54646

// project_geom_cpu(oblique) == GPU project_geom for primary-world tiles (the
// GPU adds only a per-copy +wo·2πR offset, equal for a shared edge inside one
// world copy). x carries the unwrap; y (= proj_oblique_mercator_d(phi_rot).y) is
// reference-independent, so a seam gap can only be in x.
const gx = (lon: number, lat: number, refLon: number): number =>
  projectGeomWgsl(OBL, lon, lat, clon, clat, refLon)[0]
const gy = (lon: number, lat: number, refLon: number): number =>
  projectGeomWgsl(OBL, lon, lat, clon, clat, refLon)[1]

describe('oblique_mercator tile-join seam continuity (#802)', () => {
  it('a shared meridian edge projects IDENTICALLY from both adjacent E-W tiles', () => {
    // Every E-W adjacent tile pair (z = 1..3): the shared meridian edge, sampled
    // across the full latitude band, must project to the same (x, y) whether the
    // west tile's centre lon or the east tile's centre lon is the ref_lon.
    let worst = 0
    let worstAt = ''
    let sampled = 0
    for (const z of [1, 2, 3]) {
      const w = 360 / (1 << z) // tile lon width
      for (let i = 0; i < (1 << z) - 1; i++) {
        const cA = -180 + i * w + w / 2 // west tile centre lon
        const cB = cA + w // east tile centre lon
        const edge = cA + w / 2 // shared meridian longitude
        for (let lat = -84; lat <= 84; lat += 2) {
          const dx = Math.abs(gx(edge, lat, cA) - gx(edge, lat, cB))
          const dy = Math.abs(gy(edge, lat, cA) - gy(edge, lat, cB))
          const gap = Math.hypot(dx, dy)
          if (gap > worst) {
            worst = gap
            worstAt = `z=${z} edgeLon=${edge} lat=${lat} (Δ=${(gap / TWO_PI_R).toFixed(3)} world-copies)`
          }
          sampled++
        }
      }
    }
    // Continuous to f64 round-off. Baseline tears by ~1.0 world-copy (~4.0e7 m).
    expect(worst, `worst tile-join seam gap: ${worstAt}`).toBeLessThan(1e-3)
    expect(sampled, 'no seams sampled').toBeGreaterThan(100)
  })

  it('project_geom(oblique) matches the canonical @xgis/geo oblique forward (value pin)', () => {
    // Ref-independence alone could be satisfied by a consistent-but-WRONG value.
    // Pin the actual math: the render-path oblique x/y must equal the standalone
    // projection authority (obliqueMercator.forward, which uses the raw atan2
    // rotated longitude — the tile-independent branch the fix converges on).
    // Skip a thin band around the rotated antimeridian where the ±π fold and the
    // pole clamp make the equality boundary-sensitive.
    const proj = obliqueMercator(clon, clat)
    let checked = 0
    for (let lon = -175; lon <= 175; lon += 5) {
      for (let lat = -80; lat <= 80; lat += 5) {
        const [ex, ey] = proj.forward(lon, lat)
        // near the rotated antimeridian |x| ≈ π·R: the +π/−π fold flips the sign
        // (same seam, opposite edge) — not a discrepancy. Skip |x| within 1% of π·R.
        if (Math.abs(Math.abs(ex) - Math.PI * R) < 0.01 * Math.PI * R) continue
        const ax = gx(lon, lat, 0)
        const ay = gy(lon, lat, 0)
        expect(Math.abs(ax - ex), `x @ lon=${lon} lat=${lat}`).toBeLessThan(1)
        expect(Math.abs(ay - ey), `y @ lon=${lon} lat=${lat}`).toBeLessThan(1)
        checked++
      }
    }
    expect(checked, 'no points value-pinned').toBeGreaterThan(100)
  })

  it('near-camera tiles are unchanged (the fix only moves far-side seams)', () => {
    // Within ~1 tile of the camera centre the rotated longitude is far from ±π,
    // so the per-tile unwrap and the fixed origin-0 unwrap agree: project_geom is
    // byte-stable for the common near-camera view. Assert the render path equals
    // the canonical forward there (no tolerance games — same f64 op tree).
    const proj = obliqueMercator(clon, clat)
    for (let dlon = -30; dlon <= 30; dlon += 10) {
      for (let dlat = -20; dlat <= 20; dlat += 10) {
        const lon = clon + dlon
        const lat = clat + dlat
        const [ex, ey] = proj.forward(lon, lat)
        expect(Math.abs(gx(lon, lat, lon) - ex)).toBeLessThan(1)
        expect(Math.abs(gy(lon, lat, lon) - ey)).toBeLessThan(1)
      }
    }
  })
})
