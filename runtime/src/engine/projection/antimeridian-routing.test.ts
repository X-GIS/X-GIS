// Antimeridian / dateline routing contract.
//
// HISTORY: tile selection used to route equirect/NE (and, in a later
// extension, ortho/azimuth/stereo) through the hemisphere-culling
// globeVisibleTiles selector whenever the camera centre sat within 45°
// of ±180°, to pick up tiles on both sides of the dateline. That was a
// workaround for the flat selector using Mercator's forward for every
// projection. It had two failure modes for the full-world cylindrical
// projections (equirect=1 / natural_earth=2): the hemisphere cull
// dropped the back-of-world tiles they actually display, and the
// camera-centre-only heuristic missed wide low-zoom views that span
// ±180 while centred far from it.
//
// FIX: the flat selectors are now projection-aware (selectorProj carries
// the real forward/inverse) and enumerate world copies, so the
// cylindrical projections cover both sides of the dateline on the flat
// path — they NEVER sphere-route. Only the centre-relative projections
// (azimuthal family 3/4/5, oblique 6, globe 7) sphere-route, and they do
// so at ALL longitudes (the routing no longer depends on camera lon).

import { describe, expect, it } from 'vitest'
import { routeToSphereSelector } from '../gpu/gpu-shared'

describe('dateline routing — cylindrical projections stay on the flat selector', () => {
  it('mercator (0) never sphere-routes — WORLD_COPIES wrap handles the dateline', () => {
    expect(routeToSphereSelector(0, false)).toBe(false)
  })

  it('equirect (1) / natural_earth (2) never sphere-route — world-copy enumeration covers both sides', () => {
    // The behaviour change: previously these routed to globeVisibleTiles
    // near ±180 and lost the back-of-world tiles. Now the projection-aware
    // flat selector covers the dateline directly.
    expect(routeToSphereSelector(1, false)).toBe(false)
    expect(routeToSphereSelector(2, false)).toBe(false)
  })

  it('azimuthal family (3/4/5) always sphere-routes, independent of longitude', () => {
    for (const p of [3, 4, 5]) {
      expect(routeToSphereSelector(p, false), `proj ${p} must sphere-route`).toBe(true)
    }
  })

  it('oblique_mercator (6) always sphere-routes (centre-relative)', () => {
    expect(routeToSphereSelector(6, false)).toBe(true)
  })

  it('globe (7) sphere-routes via globeMode', () => {
    expect(routeToSphereSelector(7, true)).toBe(true)
    // globeMode forces the route even for a projType that otherwise wouldn't.
    expect(routeToSphereSelector(0, true)).toBe(true)
  })
})
