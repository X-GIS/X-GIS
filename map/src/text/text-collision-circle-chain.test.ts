// INC-3 of docs/plans/2026-07-27-line-label-world-anchored-placement.md — path
// collision, representation.
//
// MapLibre models a line symbol's collision footprint as a chain of circles along
// the label's PATH; X-GIS used one AABB. The consequences were both observed at
// #16/37.79172/126.79102: a long curved road name only conflicts where its single
// box overlaps, so X-GIS drew "Dogam-ro 도감로" where MapLibre dropped it; and a
// straight label's box is a poor fit for a curved path, over-blocking on the
// concave side.
//
// This increment adds the representation only — nothing emits chains yet (INC-4).
// So the load-bearing property is that it is a strict REFINEMENT: with no chain
// supplied, every verdict is exactly what it was, and a chain that covers its own
// box must not place where the box would not.

import { describe, expect, it } from 'vitest'
import { greedyPlaceBboxes, type CollisionItem } from './text-collision'

const box = (minX: number, minY: number, maxX: number, maxY: number) => ({
  minX,
  minY,
  maxX,
  maxY,
})
const placed = (items: CollisionItem[]) => greedyPlaceBboxes(items).map((p) => p.placed)

/** Circles of radius `r` spaced along a straight horizontal run, plus the box that
 *  bounds them — the shape INC-4 will emit for a straight label. */
function straightChain(x0: number, x1: number, y: number, r: number, n: number) {
  const circles = []
  for (let i = 0; i < n; i++) circles.push({ x: x0 + ((x1 - x0) * i) / (n - 1), y, r })
  return { circles, bbox: box(x0 - r, y - r, x1 + r, y + r) }
}

describe('greedyPlaceBboxes — circle-chain footprints (INC-3)', () => {
  it('is byte-identical when no item supplies a chain', () => {
    // The dormant-capability guarantee: every existing caller keeps its verdicts.
    const items: CollisionItem[] = [
      { bboxes: [box(0, 0, 10, 10)] },
      { bboxes: [box(5, 5, 15, 15)] }, // overlaps the first → dropped
      { bboxes: [box(20, 20, 30, 30)] },
    ]
    expect(placed(items)).toEqual([true, false, true])
  })

  it('circle ↔ circle: chains that overlap collide', () => {
    const items: CollisionItem[] = [
      { bboxes: [box(-100, -100, 100, 100)], circles: [[{ x: 0, y: 0, r: 5 }]] },
      { bboxes: [box(-100, -100, 100, 100)], circles: [[{ x: 9, y: 0, r: 5 }]] },
    ]
    // Boxes overlap grossly; only the circles decide, and 9 < 5 + 5.
    expect(placed(items)).toEqual([true, false])
  })

  it('circle ↔ circle: chains that clear each other both place', () => {
    const items: CollisionItem[] = [
      { bboxes: [box(-100, -100, 100, 100)], circles: [[{ x: 0, y: 0, r: 5 }]] },
      { bboxes: [box(-100, -100, 100, 100)], circles: [[{ x: 11, y: 0, r: 5 }]] },
    ]
    // The BOXES overlap almost entirely — with AABB collision the second is
    // dropped. This is the whole point of the chain.
    expect(placed(items)).toEqual([true, true])
    expect(placed(items.map((i) => ({ bboxes: i.bboxes })))).toEqual([true, false])
  })

  it('exactly touching circles do NOT collide (strict, matching the box test)', () => {
    const items: CollisionItem[] = [
      { bboxes: [box(-100, -100, 100, 100)], circles: [[{ x: 0, y: 0, r: 5 }]] },
      { bboxes: [box(-100, -100, 100, 100)], circles: [[{ x: 10, y: 0, r: 5 }]] },
    ]
    expect(placed(items)).toEqual([true, true])
  })

  it('circle ↔ box: a chain is tested against a box-only blocker', () => {
    const hit: CollisionItem[] = [
      { bboxes: [box(0, 0, 10, 10)] },
      { bboxes: [box(-50, -50, 50, 50)], circles: [[{ x: 13, y: 5, r: 4 }]] }, // 3 away
    ]
    expect(placed(hit)).toEqual([true, false])
    const clear: CollisionItem[] = [
      { bboxes: [box(0, 0, 10, 10)] },
      { bboxes: [box(-50, -50, 50, 50)], circles: [[{ x: 16, y: 5, r: 4 }]] }, // 6 away
    ]
    expect(placed(clear)).toEqual([true, true])
  })

  it('circle ↔ box: nearest point is a CORNER, not an edge projection', () => {
    // Centre is diagonally off the box's corner at (10, 10): the corner distance is
    // hypot(6, 6) ≈ 8.49, while either axis alone reads only 6. A per-axis test
    // would wrongly collide at r = 7.
    const diag = (r: number): CollisionItem[] => [
      { bboxes: [box(0, 0, 10, 10)] },
      { bboxes: [box(-50, -50, 50, 50)], circles: [[{ x: 16, y: 16, r }]] },
    ]
    expect(placed(diag(7))).toEqual([true, true])
    expect(placed(diag(9))).toEqual([true, false])
  })

  it('a placed item BLOCKS with the footprint it was judged by', () => {
    // Seeding the box for an item judged by its chain would make it block more than
    // it occupies — the third item sits in the box's slack and must survive.
    const items: CollisionItem[] = [
      { bboxes: [box(-100, -100, 100, 100)], circles: [[{ x: 0, y: 0, r: 5 }]] },
      { bboxes: [box(-100, -100, 100, 100)], circles: [[{ x: 80, y: 80, r: 5 }]] },
    ]
    expect(placed(items)).toEqual([true, true])
  })

  it('obstacles carry chains too', () => {
    const item: CollisionItem = {
      bboxes: [box(-50, -50, 50, 50)],
      circles: [[{ x: 0, y: 0, r: 5 }]],
    }
    const blockedByCircle = greedyPlaceBboxes([item], {
      obstacles: [{ bbox: box(-100, -100, 100, 100), circles: [{ x: 8, y: 0, r: 5 }] }],
    })
    expect(blockedByCircle[0]!.placed).toBe(false)
    const clearOfCircle = greedyPlaceBboxes([item], {
      obstacles: [{ bbox: box(-100, -100, 100, 100), circles: [{ x: 12, y: 0, r: 5 }] }],
    })
    // The obstacle BOX swallows the item; only its chain lets the item through.
    expect(clearOfCircle[0]!.placed).toBe(true)
  })

  it('an empty chain falls back to the box rather than never colliding', () => {
    // The dangerous failure mode: treat "no circles" as "no footprint" and every
    // such label places on top of everything.
    const items: CollisionItem[] = [
      { bboxes: [box(0, 0, 10, 10)] },
      { bboxes: [box(5, 5, 15, 15)], circles: [[]] },
      { bboxes: [box(5, 5, 15, 15)], circles: [undefined] },
      { bboxes: [box(5, 5, 15, 15)], circles: undefined },
    ]
    expect(placed(items)).toEqual([true, false, false, false])
  })

  it('chains are PARALLEL to candidates: each variable-anchor candidate gets its own', () => {
    // Candidate 0 collides, candidate 1 is clear ⇒ chosen === 1. If the pass read
    // circles[0] for every candidate it would reject the item outright.
    const items: CollisionItem[] = [
      { bboxes: [box(-100, -100, 100, 100)], circles: [[{ x: 0, y: 0, r: 5 }]] },
      {
        bboxes: [box(-100, -100, 100, 100), box(-100, -100, 100, 100)],
        circles: [[{ x: 3, y: 0, r: 5 }], [{ x: 40, y: 0, r: 5 }]],
      },
    ]
    const res = greedyPlaceBboxes(items)
    expect(res[1]!.placed).toBe(true)
    expect(res[1]!.chosen).toBe(1)
  })

  it('REFINEMENT: a straight label’s chain places exactly where its AABB does', () => {
    // The doc's gate. A chain covering its own box must not change any verdict when
    // the path is straight — the chain is a refinement of the box, not a different
    // model. Swept across a blocker that starts clear and ends deep inside.
    const { circles, bbox } = straightChain(0, 100, 0, 6, 9)
    for (let bx = -60; bx <= 160; bx += 5) {
      const blocker = { bboxes: [box(bx, -6, bx + 20, 6)] }
      const withBox = placed([blocker, { bboxes: [bbox] }])
      const withChain = placed([blocker, { bboxes: [bbox], circles: [circles] }])
      expect(withChain, `blocker at x=${bx}`).toEqual(withBox)
    }
  })

  it('REFINEMENT is one-directional: a CURVED chain places where its AABB cannot', () => {
    // The behaviour INC-4 is after. An L-shaped label's bounding box covers the
    // whole quadrant; its path does not, so a label in the concave corner survives
    // the chain and is over-blocked by the box.
    const curved: CollisionItem = {
      bboxes: [box(-6, -6, 106, 106)],
      circles: [
        [
          { x: 0, y: 0, r: 6 },
          { x: 50, y: 0, r: 6 },
          { x: 100, y: 0, r: 6 },
          { x: 100, y: 50, r: 6 },
          { x: 100, y: 100, r: 6 },
        ],
      ],
    }
    const inTheCorner = { bboxes: [box(30, 40, 60, 70)] }
    expect(placed([curved, inTheCorner])).toEqual([true, true])
    expect(placed([{ bboxes: curved.bboxes }, inTheCorner])).toEqual([true, false])
  })

  it('same-group items still never block each other, chain or not', () => {
    const items: CollisionItem[] = [
      {
        bboxes: [box(-100, -100, 100, 100)],
        circles: [[{ x: 0, y: 0, r: 5 }]],
        groupKey: 'pair-1',
      },
      {
        bboxes: [box(-100, -100, 100, 100)],
        circles: [[{ x: 1, y: 0, r: 5 }]],
        groupKey: 'pair-1',
      },
    ]
    expect(placed(items)).toEqual([true, true])
  })
})
