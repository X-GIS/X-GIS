// #729 — the shared projType world-copy ROUTER (visibleWorldCopiesFor).
//
// The ECEF migration regressed flat-display world-copy fan-out per-path because
// each renderer decided fan-out locally (graticule `for wi<1`, point-renderer
// `COPIES=[0]`) and there was no shared "visible world copies for this projType"
// authority. This pins the router: it delegates to the EXISTING copy
// computations (getVisibleWorldCopies for Mercator / worldCopiesFor for the
// periodic family) keyed on the EXPLICIT projType, and collapses globe /
// azimuthal to the single absolute-ECEF world.
//
// Distinct from visible-world-copies.test.ts (which pins Camera.
// getVisibleWorldCopies itself): here the ROUTER's per-projType branch is the
// subject — in particular that the x-periodic projections (1/2/6) fan out
// (whereas a naive `projType===0 ? … : [0]` router — the point-renderer bug —
// would wrongly collapse them to [0]).

import { describe, expect, it } from 'vitest'
import { Camera, visibleWorldCopiesFor } from '@xgis/map'

const W = 800,
  H = 600,
  DPR = 1

function camAt(projType: number, zoom: number, lon = 0, lat = 0, pitch = 0, bearing = 0): Camera {
  const c = new Camera()
  // lonLatToMercator inline (mirrors visible-world-copies.test.ts — avoids a
  // depender import) so the corner-unprojection path sees a real camera centre.
  const R = 6378137,
    DEG2RAD = Math.PI / 180
  c.centerX = lon * DEG2RAD * R
  c.centerY = Math.log(Math.tan(Math.PI / 4 + (lat * DEG2RAD) / 2)) * R
  c.zoom = zoom
  c.pitch = pitch
  c.bearing = bearing
  // The render loop keeps cam.projType in lockstep with the projType it draws;
  // mirror that invariant so the Mercator branch's getVisibleWorldCopies (which
  // reads cam.projType) sees the same projType the router was asked for.
  c.projType = projType
  c.globeMode = false
  return c
}

describe('visibleWorldCopiesFor — #729 shared projType router', () => {
  it('Mercator(0) delegates to the camera corner-unprojection set (matches getVisibleWorldCopies)', () => {
    // Low zoom + pitch spreads the frustum across worlds; the router must return
    // exactly what the camera authority does for Mercator.
    const c = camAt(0, 0, -54, 0, 63, 90)
    const routed = visibleWorldCopiesFor(0, c, W, H, DPR)
    expect(routed).toEqual(c.getVisibleWorldCopies(W, H, DPR))
    expect(routed.length).toBeGreaterThan(1)
    expect(routed).toContain(0)
  })

  it('Mercator(0) high zoom collapses to [0]', () => {
    const c = camAt(0, 15, 0, 0)
    expect(visibleWorldCopiesFor(0, c, W, H, DPR)).toEqual([0])
  })

  it('x-periodic flat (equirect 1 / natural_earth 2 / oblique_mercator 6) FANS OUT at low zoom', () => {
    // The regression-critical case: a naive `projType===0 ? … : [0]` router
    // (the point-renderer #722 bug) collapses these to [0]; the shared router
    // must emit the full periodic set the tile selector + GPU fills use.
    for (const pt of [1, 2, 6]) {
      const c = camAt(pt, 2, 0, 0)
      expect(visibleWorldCopiesFor(pt, c, W, H, DPR)).toEqual([-2, -1, 0, 1, 2])
    }
  })

  it('x-periodic flat collapses to [0] above the world-copy zoom gate', () => {
    for (const pt of [1, 2, 6]) {
      const c = camAt(pt, 10, 0, 0)
      expect(visibleWorldCopiesFor(pt, c, W, H, DPR)).toEqual([0])
    }
  })

  it('azimuthal discs (3/4/5) stay single-world (non-periodic)', () => {
    for (const pt of [3, 4, 5]) {
      const c = camAt(pt, 2, 0, 0)
      expect(visibleWorldCopiesFor(pt, c, W, H, DPR)).toEqual([0])
    }
  })

  it('globe(7) collapses to the single absolute-ECEF world', () => {
    const c = camAt(7, 2, 0, 0)
    expect(visibleWorldCopiesFor(7, c, W, H, DPR)).toEqual([0])
  })

  it('globeMode (tilted azimuthal promoted) collapses to [0] regardless of projType', () => {
    // render-loop promotes a tilted disc to projType 7 + globeMode; even if a
    // caller passes an x-periodic projType, globeMode wins → single ECEF world.
    for (const pt of [0, 1, 2, 6]) {
      const c = camAt(pt, 2, 0, 0)
      c.globeMode = true
      expect(visibleWorldCopiesFor(pt, c, W, H, DPR)).toEqual([0])
    }
  })

  it('routes on the EXPLICIT projType, not cam.projType', () => {
    // A Mercator-configured camera asked for an x-periodic projType must take
    // the periodic branch (the router decouples the copy decision from the
    // camera field so a promoted/overridden projType gets its own set).
    const merc = camAt(0, 2, 0, 0)
    expect(visibleWorldCopiesFor(1, merc, W, H, DPR)).toEqual([-2, -1, 0, 1, 2])
    // …and globe(7) collapses even on that Mercator camera.
    expect(visibleWorldCopiesFor(7, merc, W, H, DPR)).toEqual([0])
  })
})
