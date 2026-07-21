import { describe, expect, it } from 'vitest'
import { anchorTranslatePercent, flipPopupAnchor, markerTransform } from './marker'

// Marker/Popup (#1262) — the pure positioning geometry. The DOM wiring
// (element creation, event listeners, camera tracking) runs only in a
// browser and is covered by the e2e/§5 gate; here we pin the math that
// decides WHERE the element lands, which a screenshot can't cheaply prove.

describe('anchorTranslatePercent', () => {
  it('centre pulls the element back by half on both axes', () => {
    expect(anchorTranslatePercent('center')).toEqual([-50, -50])
  })
  it('bottom anchors the element ABOVE the point (tip on the coordinate)', () => {
    // bottom edge at the point → shift up by full height, centre horizontally.
    expect(anchorTranslatePercent('bottom')).toEqual([-50, -100])
  })
  it('top-left leaves the element growing down-right from the point', () => {
    expect(anchorTranslatePercent('top-left')).toEqual([0, 0])
  })
  it('every anchor maps to a {0,-50,-100} lattice pair', () => {
    const anchors = [
      'center',
      'top',
      'bottom',
      'left',
      'right',
      'top-left',
      'top-right',
      'bottom-left',
      'bottom-right',
    ] as const
    for (const a of anchors) {
      const [x, y] = anchorTranslatePercent(a)
      expect([0, -50, -100]).toContain(x)
      expect([0, -50, -100]).toContain(y)
    }
  })
})

describe('markerTransform', () => {
  it('snaps the pixel translate to integers and appends the anchor percentage', () => {
    expect(markerTransform(100.4, 200.6, 'center', 0, 0)).toBe(
      'translate(100px, 201px) translate(-50%, -50%)',
    )
  })
  it('applies the px offset before snapping', () => {
    expect(markerTransform(100, 200, 'bottom', 5, -8)).toBe(
      'translate(105px, 192px) translate(-50%, -100%)',
    )
  })
})

describe('flipPopupAnchor', () => {
  const VW = 900
  const VH = 600
  it('a point near the TOP edge anchors top (balloon grows DOWN into view)', () => {
    expect(flipPopupAnchor(450, 30, VW, VH)).toBe('top')
  })
  it('a point near the BOTTOM edge anchors bottom (grows UP)', () => {
    expect(flipPopupAnchor(450, 570, VW, VH)).toBe('bottom')
  })
  it('a top-left corner point composes to top-left', () => {
    expect(flipPopupAnchor(50, 30, VW, VH)).toBe('top-left')
  })
  it('a bottom-right corner point composes to bottom-right', () => {
    expect(flipPopupAnchor(850, 560, VW, VH)).toBe('bottom-right')
  })
  it('a left-edge, vertically-centred point anchors left', () => {
    expect(flipPopupAnchor(50, 300, VW, VH)).toBe('left')
  })
  it('a dead-centre point defaults to bottom (MapLibre convention)', () => {
    expect(flipPopupAnchor(450, 300, VW, VH)).toBe('bottom')
  })
})
