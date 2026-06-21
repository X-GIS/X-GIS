// fill-extrusion-translate-anchor wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: paint
// `fill-extrusion-translate-anchor` (Mapbox/xgis) is marked `supported`. It
// shares fill's translate path: viewport (default) leaves the [dx,dy] CSS-px
// offset in screen space; `map` rotates it by the map bearing so the offset
// tracks the MAP world axes (MapLibre map-anchor). render() computes this via
// the shared pure helper rotateTranslateForAnchor (vector-tile-renderer.ts:109)
// before baking into the slot 46/47 uniform, so that helper IS the anchor wire
// (the extrude path inherits the rotation for free).
//
// This tests the helper directly (a pure 2D rotation — no GPU, no stub). The
// map case asserts the bearing-rotated result, which can only hold if the
// anchorMap flag actually selects rotation → non-vacuous.
//
// Fail-before: collapse the guard to `return [dx, dy]` (ignore anchorMap, always
// screen-space) and the map-anchor rotation assertion fails — the wire that
// makes translate-anchor:map track the world axes is gone.

import { describe, it, expect } from 'vitest'
import { rotateTranslateForAnchor } from './vector-tile-renderer'

describe('fill-extrusion-translate-anchor wiring (GPU-free)', () => {
  it('viewport (anchorMap=false) returns the offset unchanged (screen-space)', () => {
    expect(rotateTranslateForAnchor(10, 4, false, 90)).toEqual([10, 4])
    // undefined anchor == viewport default.
    expect(rotateTranslateForAnchor(10, 4, undefined, 90)).toEqual([10, 4])
  })

  it('map (anchorMap=true) rotates the offset by the map bearing', () => {
    // bearing 90°: [dx,dy]=[10,0] → [dx·cos − dy·sin, dx·sin + dy·cos]
    //            = [10·0 − 0·1, 10·1 + 0·0] = [0, 10].
    const [rx, ry] = rotateTranslateForAnchor(10, 0, true, 90)
    expect(rx).toBeCloseTo(0, 6)   // ← the discriminating assertion: rotated, not 10
    expect(ry).toBeCloseTo(10, 6)
  })

  it('map at bearing 0 is identity (rotation math pinned, not a no-op shortcut)', () => {
    const [rx, ry] = rotateTranslateForAnchor(7, -3, true, 0)
    expect(rx).toBeCloseTo(7, 6)
    expect(ry).toBeCloseTo(-3, 6)
  })

  it('a zero offset is never rotated (allocation-free fast path)', () => {
    expect(rotateTranslateForAnchor(0, 0, true, 45)).toEqual([0, 0])
  })
})
