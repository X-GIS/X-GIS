import { describe, it, expect } from 'vitest'
import { greedyPlaceBboxes } from '../engine/text-collision'

const bbox = (minX: number, minY: number, maxX: number, maxY: number) =>
  ({ minX, minY, maxX, maxY })

const placedFlags = (results: ReturnType<typeof greedyPlaceBboxes>) =>
  results.map(r => r.placed)

describe('greedyPlaceBboxes', () => {
  it('places a single label', () => {
    expect(placedFlags(greedyPlaceBboxes([{ bboxes: [bbox(0, 0, 10, 10)] }])))
      .toEqual([true])
  })

  it('places two non-overlapping labels', () => {
    expect(placedFlags(greedyPlaceBboxes([
      { bboxes: [bbox(0, 0, 10, 10)] },
      { bboxes: [bbox(20, 0, 30, 10)] },
    ]))).toEqual([true, true])
  })

  it('drops the second label when bboxes overlap', () => {
    expect(placedFlags(greedyPlaceBboxes([
      { bboxes: [bbox(0, 0, 10, 10)] },
      { bboxes: [bbox(5, 5, 15, 15)] },
    ]))).toEqual([true, false])
  })

  it('input order decides the winner', () => {
    expect(placedFlags(greedyPlaceBboxes([
      { bboxes: [bbox(5, 5, 15, 15)] },
      { bboxes: [bbox(0, 0, 10, 10)] },
    ]))).toEqual([true, false])
  })

  it('allowOverlap places the label even when overlapping', () => {
    expect(placedFlags(greedyPlaceBboxes([
      { bboxes: [bbox(0, 0, 10, 10)] },
      { bboxes: [bbox(5, 5, 15, 15)], allowOverlap: true },
    ]))).toEqual([true, true])
  })

  it('allowOverlap-placed label still blocks later labels by default', () => {
    expect(placedFlags(greedyPlaceBboxes([
      { bboxes: [bbox(0, 0, 10, 10)] },
      { bboxes: [bbox(5, 5, 15, 15)], allowOverlap: true },
      { bboxes: [bbox(8, 8, 12, 12)] },
    ]))).toEqual([true, true, false])
  })

  it('ignorePlacement does not block subsequent labels', () => {
    expect(placedFlags(greedyPlaceBboxes([
      { bboxes: [bbox(0, 0, 10, 10)], ignorePlacement: true },
      { bboxes: [bbox(5, 5, 15, 15)] },
    ]))).toEqual([true, true])
  })

  it('allowOverlap + ignorePlacement: always visible, never blocks', () => {
    expect(placedFlags(greedyPlaceBboxes([
      { bboxes: [bbox(0, 0, 10, 10)] },
      { bboxes: [bbox(5, 5, 15, 15)], allowOverlap: true, ignorePlacement: true },
      { bboxes: [bbox(20, 20, 30, 30)] },
      { bboxes: [bbox(7, 7, 14, 14)] },
    ]))).toEqual([true, true, true, false])
  })

  it('touching edges count as non-overlap (open intervals)', () => {
    expect(placedFlags(greedyPlaceBboxes([
      { bboxes: [bbox(0, 0, 10, 10)] },
      { bboxes: [bbox(10, 0, 20, 10)] },
    ]))).toEqual([true, true])
  })

  it('empty input returns empty array', () => {
    expect(greedyPlaceBboxes([])).toEqual([])
  })

  it('many overlapping labels — only the first survives', () => {
    const items = Array.from({ length: 5 }, (_, i) => ({
      bboxes: [bbox(i, i, i + 8, i + 8)],
    }))
    expect(placedFlags(greedyPlaceBboxes(items))).toEqual([true, false, false, false, false])
  })

  describe('variable anchor candidates', () => {
    it('falls back to second candidate when first collides', () => {
      // Label A occupies (0, 0, 10, 10). Label B's primary bbox
      // overlaps A but its second candidate is clear; greedy picks
      // the second.
      const r = greedyPlaceBboxes([
        { bboxes: [bbox(0, 0, 10, 10)] },
        { bboxes: [bbox(5, 5, 15, 15), bbox(20, 0, 30, 10)] },
      ])
      expect(r[0]).toEqual({ placed: true, chosen: 0 })
      expect(r[1]).toEqual({ placed: true, chosen: 1 })
    })

    it('drops when ALL candidates collide', () => {
      const r = greedyPlaceBboxes([
        { bboxes: [bbox(0, 0, 100, 100)] },
        { bboxes: [bbox(10, 10, 20, 20), bbox(30, 30, 40, 40)] },
      ])
      expect(r[1]).toEqual({ placed: false, chosen: -1 })
    })

    it('candidate order is priority order (first non-collide wins, not best)', () => {
      // Even if a later candidate would be "more central", greedy
      // takes the first that fits.
      const r = greedyPlaceBboxes([
        { bboxes: [bbox(0, 0, 5, 5)] },
        { bboxes: [bbox(10, 0, 15, 5), bbox(20, 0, 25, 5)] },
      ])
      expect(r[1]).toEqual({ placed: true, chosen: 0 })
    })
  })
})
