// Diagnostic: pin the polar-tile gap in the Mercator tile pyramid
// for projections that CAN show the pole — ortho / azimuthal_eqdist /
// stereographic / globe — when the selector reaches for Mercator
// (z/x/y) tile coverage of lat > ±85.05°.
//
// User report 2026-05-18 (memory note project_projection_issues_2026_05_18 #3):
// "Orthgraphic, Azimuthal eq, stereographic, oblique mercator 타일 선택
// 문제 있음. 극지 및 날짜변경선 검토 필요".
//
// Globe handles this via globeVisibleTiles + the setPolarCapsEnabled
// data-synthesis path (iter 394-398). Ortho / azimuthal / stereo
// currently fall through to visibleTilesSSE with the Mercator
// selector (vector-tile-renderer.ts:2891 — nearAntimeridian check
// only routes projType 1/2 to the globe traversal, NOT 3/4/5).
//
// This test pins the numeric symptom: the Web Mercator tile pyramid
// has NO tile covering lat > ±85.05°. The standard projection-name
// mapping is 0=mercator, 1=equirect, 2=natural_earth, 3=orthographic,
// 4=azimuthal_equidistant, 5=stereographic, 6=oblique_mercator,
// 7=globe.

import { describe, expect, it } from 'vitest'
import { mercator } from '@xgis/geo'

const EARTH_R = 6378137
const HALF_CIRC = Math.PI * EARTH_R

// Returns the [minLat, maxLat] covered by the Mercator pyramid at
// zoom z. y=0 tile-top is the highest representable latitude.
function pyramidLatRange(_z: number): [number, number] {
  // Mercator y at y-tile=0 (north edge of north-most tile)
  // = HALF_CIRC * (1 - 2 * 0 / n) = HALF_CIRC
  const yNorth = HALF_CIRC
  const ySouth = -HALF_CIRC
  const [, latN] = mercator.inverse(0, yNorth)
  const [, latS] = mercator.inverse(0, ySouth)
  return [latS, latN]
}

describe('Mercator tile pyramid polar gap (user issue #3)', () => {
  it('Mercator pyramid does NOT cover lat > +85.05° or < -85.05°', () => {
    for (const z of [0, 1, 5, 10, 22]) {
      const [latS, latN] = pyramidLatRange(z)
      // Web Mercator clamp at ±85.0511287798066°. Tile pyramid edge
      // is exactly the clamp boundary, so any lat past this has no
      // tile representation.
      expect(latN).toBeGreaterThan(85.05)
      expect(latN).toBeLessThan(85.06)
      expect(latS).toBeLessThan(-85.05)
      expect(latS).toBeGreaterThan(-85.06)
      // Critical assertion: lat=89° (near-pole) is OUTSIDE the
      // pyramid bounds. visibleTilesSSE cannot return a tile that
      // covers lat=89° regardless of zoom or canvas size.
      expect(latN).toBeLessThan(89)
      expect(latS).toBeGreaterThan(-89)
    }
  })

  it('Mercator.forward of pole returns clamped y (loss of polar identity)', () => {
    // The forward projection clamps lat to ±MERCATOR_LAT_LIMIT.
    // After clamp, lat=89.99 and lat=85.05 map to the SAME y.
    // Tile selector loses ability to distinguish near-pole positions.
    const [, yPole] = mercator.forward(0, 89.99)
    const [, yClamp] = mercator.forward(0, 85.0511287798066)
    expect(Math.abs(yPole - yClamp)).toBeLessThan(1) // identical clamp
    // Inverse round-trip from this y → lat≈85.05, NOT 89.99.
    const [, latBack] = mercator.inverse(0, yPole)
    expect(latBack).toBeLessThan(85.06)
    expect(latBack).toBeGreaterThan(85.04)
    expect(Math.abs(latBack - 89.99)).toBeGreaterThan(4.9) // ~5° loss
  })

  it('antipodal lon points map to identical Mercator y but x differs by full circumference', () => {
    // Selector reasons about a flat strip [-HALF_CIRC, +HALF_CIRC].
    // (lon=170, lat=0) and (lon=-170, lat=0) sit at OPPOSITE strip
    // ends. For globe / ortho centered near the antimeridian, the
    // selector picks tiles from ONE strip end but the renderer
    // shows BOTH ends as adjacent (dateline cross). Globe handles
    // this via globeVisibleTiles; ortho/azimuthal/stereo do not.
    const [xA] = mercator.forward(170, 0)
    const [xB] = mercator.forward(-170, 0)
    expect(Math.abs(xA - xB)).toBeGreaterThan(HALF_CIRC * 1.8)
    // Both nominally on-screen for an ortho centered at lon=180, but
    // visibleTilesSSE's flat-strip frustum projects them to opposite
    // sides of the camera-x — at z=1 the camera-side tile is picked,
    // wrap-side tile is dropped. Result: half the visible disc blank.
  })

  it('z=0 root tile covers full lon range but NOT polar regions (lat 85.05° → ±90°)', () => {
    // Tile (z=0, x=0, y=0) is the WHOLE mercator pyramid in one tile.
    // Its lat span is clamped to ±85.05°. So even the "root" doesn't
    // cover the poles. The setPolarCapsEnabled synthesis path
    // (polar-cap-detect.ts) was added specifically to fill this gap
    // via injected GeoJSON polygons.
    const [latS, latN] = pyramidLatRange(0)
    const polarUncoveredNorth = 90 - latN
    const polarUncoveredSouth = latS - -90
    // ~4.95° each pole, ~9.9° total uncovered band.
    expect(polarUncoveredNorth).toBeGreaterThan(4.9)
    expect(polarUncoveredNorth).toBeLessThan(5)
    expect(polarUncoveredSouth).toBeGreaterThan(4.9)
    expect(polarUncoveredSouth).toBeLessThan(5)
  })
})
