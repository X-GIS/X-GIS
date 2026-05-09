import { describe, it, expect } from 'vitest'
import { greedyPlaceBboxes } from '../engine/text-collision'

const bbox = (minX: number, minY: number, maxX: number, maxY: number) =>
  ({ minX, minY, maxX, maxY })

describe('greedyPlaceBboxes', () => {
  it('places a single label', () => {
    expect(greedyPlaceBboxes([{ bbox: bbox(0, 0, 10, 10) }])).toEqual([true])
  })

  it('places two non-overlapping labels', () => {
    expect(greedyPlaceBboxes([
      { bbox: bbox(0, 0, 10, 10) },
      { bbox: bbox(20, 0, 30, 10) },
    ])).toEqual([true, true])
  })

  it('drops the second label when bboxes overlap', () => {
    expect(greedyPlaceBboxes([
      { bbox: bbox(0, 0, 10, 10) },
      { bbox: bbox(5, 5, 15, 15) },
    ])).toEqual([true, false])
  })

  it('input order decides the winner', () => {
    // Same two bboxes, second now declared first.
    expect(greedyPlaceBboxes([
      { bbox: bbox(5, 5, 15, 15) },
      { bbox: bbox(0, 0, 10, 10) },
    ])).toEqual([true, false])
  })

  it('allowOverlap places the label even when overlapping', () => {
    expect(greedyPlaceBboxes([
      { bbox: bbox(0, 0, 10, 10) },
      { bbox: bbox(5, 5, 15, 15), allowOverlap: true },
    ])).toEqual([true, true])
  })

  it('allowOverlap-placed label still blocks later labels by default', () => {
    expect(greedyPlaceBboxes([
      { bbox: bbox(0, 0, 10, 10) },
      { bbox: bbox(5, 5, 15, 15), allowOverlap: true },
      { bbox: bbox(8, 8, 12, 12) },
    ])).toEqual([true, true, false])
  })

  it('ignorePlacement does not block subsequent labels', () => {
    expect(greedyPlaceBboxes([
      { bbox: bbox(0, 0, 10, 10), ignorePlacement: true },
      { bbox: bbox(5, 5, 15, 15) },
    ])).toEqual([true, true])
  })

  it('allowOverlap + ignorePlacement: always visible, never blocks', () => {
    expect(greedyPlaceBboxes([
      { bbox: bbox(0, 0, 10, 10) },
      { bbox: bbox(5, 5, 15, 15), allowOverlap: true, ignorePlacement: true },
      { bbox: bbox(20, 20, 30, 30) },
      { bbox: bbox(7, 7, 14, 14) },
    ])).toEqual([true, true, true, false])
  })

  it('touching edges count as non-overlap (open intervals)', () => {
    // bbox A's maxX equals bbox B's minX → not overlapping.
    expect(greedyPlaceBboxes([
      { bbox: bbox(0, 0, 10, 10) },
      { bbox: bbox(10, 0, 20, 10) },
    ])).toEqual([true, true])
  })

  it('empty input returns empty array', () => {
    expect(greedyPlaceBboxes([])).toEqual([])
  })

  it('many overlapping labels — only the first survives', () => {
    const items = Array.from({ length: 5 }, (_, i) => ({
      bbox: bbox(i, i, i + 8, i + 8),
    }))
    expect(greedyPlaceBboxes(items)).toEqual([true, false, false, false, false])
  })
})
