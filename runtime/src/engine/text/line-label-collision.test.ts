// Along-line label collision — verifies the symbol-spacing window
// drops same-line labels that crowd a higher-priority placement.
//
// Pre-fix the greedy AABB pass placed every non-overlapping
// candidate, producing visible crowding on long roads at zooms
// where the road's label arc length is small enough that one
// label's bbox already cleared another's even with the same text
// repeated every few hundred pixels. MapLibre's logic enforces a
// minimum along-line distance per symbol-spacing — this test pins
// the equivalent X-GIS behaviour.

import { describe, expect, it } from 'vitest'
import { greedyPlaceBboxes, type CollisionItem } from '@xgis/map'

const bbox = (x: number, y: number, w = 40, h = 12) => ({
  minX: x, minY: y, maxX: x + w, maxY: y + h,
})

describe('line-label along-line min spacing', () => {
  it('drops same-line label within symbol-spacing window', () => {
    const items: CollisionItem[] = [
      { bboxes: [bbox(0, 0)],   lineId: 'A', anchorDistancePx: 100 },
      { bboxes: [bbox(0, 50)],  lineId: 'A', anchorDistancePx: 150 }, // 50 px gap
      { bboxes: [bbox(0, 100)], lineId: 'A', anchorDistancePx: 400 }, // 300 px gap (above 250)
    ]
    const placements = greedyPlaceBboxes(items, { minLineSpacingPx: 250 })
    expect(placements[0]!.placed).toBe(true)
    expect(placements[1]!.placed).toBe(false) // crowded
    expect(placements[2]!.placed).toBe(true)
  })

  it('allows same-line labels outside symbol-spacing window', () => {
    const items: CollisionItem[] = [
      { bboxes: [bbox(0, 0)],   lineId: 'A', anchorDistancePx: 100 },
      { bboxes: [bbox(0, 50)],  lineId: 'A', anchorDistancePx: 400 }, // 300 px gap
      { bboxes: [bbox(0, 100)], lineId: 'A', anchorDistancePx: 700 }, // 300 px gap
    ]
    const placements = greedyPlaceBboxes(items, { minLineSpacingPx: 250 })
    expect(placements.every(p => p.placed)).toBe(true)
  })

  it('does not penalise labels on different lineIds', () => {
    const items: CollisionItem[] = [
      { bboxes: [bbox(0, 0)],   lineId: 'A', anchorDistancePx: 100 },
      { bboxes: [bbox(0, 50)],  lineId: 'B', anchorDistancePx: 150 }, // different line
      { bboxes: [bbox(0, 100)], lineId: 'A', anchorDistancePx: 200 }, // same line, < 250 gap
    ]
    const placements = greedyPlaceBboxes(items, { minLineSpacingPx: 250 })
    expect(placements[0]!.placed).toBe(true)
    expect(placements[1]!.placed).toBe(true) // different line, free
    expect(placements[2]!.placed).toBe(false) // same line as 0, within window
  })

  it('disabled (minLineSpacingPx=0) falls back to AABB-only behaviour', () => {
    const items: CollisionItem[] = [
      { bboxes: [bbox(0, 0)],   lineId: 'A', anchorDistancePx: 100 },
      { bboxes: [bbox(0, 50)],  lineId: 'A', anchorDistancePx: 150 }, // would crowd if enabled
    ]
    const placements = greedyPlaceBboxes(items, { minLineSpacingPx: 0 })
    expect(placements.every(p => p.placed)).toBe(true)
  })

  it('allowOverlap bypasses same-line spacing too', () => {
    const items: CollisionItem[] = [
      { bboxes: [bbox(0, 0)],   lineId: 'A', anchorDistancePx: 100 },
      { bboxes: [bbox(0, 50)],  lineId: 'A', anchorDistancePx: 150, allowOverlap: true },
    ]
    const placements = greedyPlaceBboxes(items, { minLineSpacingPx: 250 })
    expect(placements.every(p => p.placed)).toBe(true)
  })

  it('respects sortKey: lower key wins the same-line spot', () => {
    const items: CollisionItem[] = [
      // Input order would place this first, but sortKey says no.
      { bboxes: [bbox(0, 0)],   lineId: 'A', anchorDistancePx: 100, sortKey: 10 },
      { bboxes: [bbox(0, 50)],  lineId: 'A', anchorDistancePx: 150, sortKey: 1 },
    ]
    const placements = greedyPlaceBboxes(items, { minLineSpacingPx: 250 })
    expect(placements[1]!.placed).toBe(true)  // lower sortKey wins
    expect(placements[0]!.placed).toBe(false) // higher sortKey dropped (crowded)
  })

  it('items without lineId are unaffected by the gate', () => {
    const items: CollisionItem[] = [
      { bboxes: [bbox(0, 0)] },
      { bboxes: [bbox(0, 50)] },
      { bboxes: [bbox(0, 100)] },
    ]
    const placements = greedyPlaceBboxes(items, { minLineSpacingPx: 250 })
    expect(placements.every(p => p.placed)).toBe(true)
  })
})
