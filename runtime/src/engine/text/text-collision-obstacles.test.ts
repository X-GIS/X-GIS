// #609 — icon↔text cross-collision invariant.
//
// Bug: text and icon ran SEPARATE collision grids that never cross-tested.
// A text label (e.g. a curved road name) could draw directly over a POI
// icon because the text-collision pass only tested text-vs-text. MapLibre
// inserts every placed icon box into the shared collision grid so subsequent
// labels avoid it.
//
// FIX: greedyPlaceBboxes now accepts `obstacles` (the dispatched icon boxes)
// and drops any label whose bbox overlaps an obstacle — EXCEPT a label whose
// groupKey matches the obstacle's groupKey (a paired icon must never block
// its own text label — they share the anchor by design).
//
// fail-before: remove the `opts.obstacles` seed block in greedyPlaceBboxes →
// the label-over-icon cases below flip to placed (the bug).

import { describe, it, expect } from 'vitest'
import { greedyPlaceBboxes, type CollisionItem, type CollisionObstacle } from './text-collision'

const box = (x: number, y: number, w = 10, h = 10) => ({ minX: x, minY: y, maxX: x + w, maxY: y + h })
const label = (b: ReturnType<typeof box>, extra: Partial<CollisionItem> = {}): CollisionItem => ({ bboxes: [b], ...extra })

describe('greedyPlaceBboxes — icon obstacles (#609 icon↔text cross-collision)', () => {
  it('a label overlapping a seeded icon obstacle is DROPPED', () => {
    const obstacles: CollisionObstacle[] = [{ bbox: box(5, 5) }]
    // fail-before (no obstacle seeding): the label places despite the icon.
    expect(greedyPlaceBboxes([label(box(0, 0))], { obstacles })[0]).toEqual({ placed: false, chosen: -1 })
  })

  it('without the obstacle the same label PLACES (control)', () => {
    expect(greedyPlaceBboxes([label(box(0, 0))])[0]).toEqual({ placed: true, chosen: 0 })
  })

  it('an obstacle does NOT drop a label of its OWN group (paired icon vs its text)', () => {
    // A POI icon (groupKey="poi:1") must not block its own text label.
    const obstacles: CollisionObstacle[] = [{ bbox: box(5, 5), groupKey: 'poi:1' }]
    expect(greedyPlaceBboxes([label(box(0, 0), { groupKey: 'poi:1' })], { obstacles })[0].placed).toBe(true)
  })

  it('an obstacle blocks a DIFFERENT-group label (road name vs POI icon)', () => {
    const obstacles: CollisionObstacle[] = [{ bbox: box(5, 5), groupKey: 'poi:1' }]
    expect(greedyPlaceBboxes([label(box(0, 0), { groupKey: 'road:9' })], { obstacles })[0].placed).toBe(false)
  })

  it('an obstacle with no groupKey blocks ALL labels (ungrouped icon)', () => {
    const obstacles: CollisionObstacle[] = [{ bbox: box(5, 5) }]
    // Even a grouped label is blocked by an ungrouped obstacle.
    expect(greedyPlaceBboxes([label(box(0, 0), { groupKey: 'any:1' })], { obstacles })[0].placed).toBe(false)
  })

  it('a non-overlapping label is unaffected by an obstacle', () => {
    const obstacles: CollisionObstacle[] = [{ bbox: box(0, 0) }]
    expect(greedyPlaceBboxes([label(box(100, 100))], { obstacles })[0].placed).toBe(true)
  })

  it('no obstacles → legacy behaviour preserved (first of two overlappers wins)', () => {
    const p = greedyPlaceBboxes([label(box(0, 0)), label(box(5, 5))])
    expect(p[0]!.placed).toBe(true)
    expect(p[1]!.placed).toBe(false)
  })

  it('a placed item with groupKey becomes a blocker for different-group items (bidirectional)', () => {
    // Text placed first (groupKey="text:1") must block a later label with a different group.
    const items: CollisionItem[] = [
      label(box(0, 0), { groupKey: 'text:1' }),
      label(box(5, 5), { groupKey: 'other:2' }),
    ]
    const p = greedyPlaceBboxes(items)
    expect(p[0]!.placed).toBe(true)
    expect(p[1]!.placed).toBe(false)
  })

  it('a placed item with groupKey does NOT block a same-group sibling', () => {
    // Two items in the same collision group (rare in practice, but the rule
    // must be symmetric: same-group items never block each other).
    const items: CollisionItem[] = [
      label(box(0, 0), { groupKey: 'sym:1' }),
      label(box(5, 5), { groupKey: 'sym:1' }),
    ]
    const p = greedyPlaceBboxes(items)
    expect(p[0]!.placed).toBe(true)
    // Same group → second item is not blocked by the first.
    expect(p[1]!.placed).toBe(true)
  })

  it('allowOverlap label is still placed despite obstacle', () => {
    // allowOverlap bypasses the collision check entirely — obstacles don't
    // override author intent (Mapbox parity: allow-overlap always places).
    const obstacles: CollisionObstacle[] = [{ bbox: box(5, 5) }]
    expect(greedyPlaceBboxes([label(box(0, 0), { allowOverlap: true })], { obstacles })[0].placed).toBe(true)
  })
})
