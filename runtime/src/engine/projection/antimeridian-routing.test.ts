// Verify the antimeridian routing condition for projection types
// 1..5 (equirect, NE, ortho, azimuth, stereo) — when the camera
// sits within 45° of ±180° these projections should route through
// globeVisibleTiles so the selector picks up tiles on both sides
// of the dateline.
//
// Plan §5.3: the original heuristic only fired for projType 1+2;
// fix extended it to 1..5 inclusive so ortho / azimuthal /
// stereographic camera centred near ±180° also gets sphere-cap
// tile selection. The visible region of an azimuthal projection
// centred near ±180° straddles the dateline just as much as
// equirect's strip does.

import { describe, expect, it } from 'vitest'

// Mirror of the runtime heuristic in vector-tile-renderer.ts.
function antimeridianRoutes(projType: number, lonDeg: number): boolean {
  if (projType < 1 || projType > 5) return false
  return Math.abs(((lonDeg + 540) % 360 - 180)) > 135
}

describe('antimeridian sphere-selector routing condition', () => {
  it('mercator (0) never routes to sphere — uses WORLD_COPIES wrap instead', () => {
    expect(antimeridianRoutes(0, 0)).toBe(false)
    expect(antimeridianRoutes(0, 180)).toBe(false)
    expect(antimeridianRoutes(0, -179)).toBe(false)
  })

  it('equirect (1) routes when lon within 45° of ±180°', () => {
    expect(antimeridianRoutes(1, 0)).toBe(false)
    expect(antimeridianRoutes(1, 90)).toBe(false)
    expect(antimeridianRoutes(1, 135.1)).toBe(true)
    expect(antimeridianRoutes(1, 170)).toBe(true)
    expect(antimeridianRoutes(1, -170)).toBe(true)
    expect(antimeridianRoutes(1, 180)).toBe(true)
  })

  it('natural_earth (2) routes the same as equirect', () => {
    expect(antimeridianRoutes(2, 0)).toBe(false)
    expect(antimeridianRoutes(2, 170)).toBe(true)
    expect(antimeridianRoutes(2, -170)).toBe(true)
  })

  it('orthographic (3) routes near antimeridian (plan §5.3 extension)', () => {
    // Pre-fix this returned false for all lons — selector inherited
    // the Mercator-pyramid gap and missed tiles on the far side of
    // ±180° even though the azimuthal disc covered them.
    expect(antimeridianRoutes(3, 170)).toBe(true)
    expect(antimeridianRoutes(3, -170)).toBe(true)
    expect(antimeridianRoutes(3, 0)).toBe(false)
  })

  it('azimuthal_equidistant (4) routes near antimeridian', () => {
    expect(antimeridianRoutes(4, 170)).toBe(true)
    expect(antimeridianRoutes(4, -170)).toBe(true)
  })

  it('stereographic (5) routes near antimeridian', () => {
    expect(antimeridianRoutes(5, 170)).toBe(true)
    expect(antimeridianRoutes(5, -170)).toBe(true)
  })

  it('oblique_mercator (6) does NOT use the antimeridian heuristic — uses obliqueRouteToSphere flag instead', () => {
    expect(antimeridianRoutes(6, 0)).toBe(false)
    expect(antimeridianRoutes(6, 170)).toBe(false)
  })

  it('globe (7) does NOT use the antimeridian heuristic — globeMode always routes', () => {
    expect(antimeridianRoutes(7, 0)).toBe(false)
    expect(antimeridianRoutes(7, 170)).toBe(false)
  })

  it('boundary: exactly 135° from antimeridian does NOT route', () => {
    // lon=45 → wrap distance from 180 = 135 exactly. Heuristic uses
    // strict > 135, so this returns false.
    expect(antimeridianRoutes(1, 45)).toBe(false)
    expect(antimeridianRoutes(1, -45)).toBe(false)
  })

  it('wrap arithmetic handles lon outside [-180, 180]', () => {
    // Camera may accumulate drag distance past ±180°. The heuristic
    // normalizes via (lon + 540) % 360 - 180. Equivalents:
    //   lon = 360 + 170 = 530 → maps back to 170° → routes.
    //   lon = -360 - 170 = -530 → maps back to -170° → routes.
    //   lon = 370 → maps to 10° (far from AM) → does NOT route.
    expect(antimeridianRoutes(1, 530)).toBe(true)
    expect(antimeridianRoutes(1, -530)).toBe(true)
    expect(antimeridianRoutes(1, 370)).toBe(false)
  })
})
