// Greedy axis-aligned bbox collision for label placement.
//
// Input order is significant — the first item to claim its bbox wins
// against any later overlapper. Two opt-outs match Mapbox semantics:
//   - allowOverlap: skip the collision check for this item (it always
//     places, and it does block later items by default).
//   - ignorePlacement: this item places, but does NOT block later items.
// Combining `allowOverlap + ignorePlacement` produces Mapbox's "always
// visible, never blocks" behaviour.

export interface CollisionBbox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface CollisionItem {
  bbox: CollisionBbox
  allowOverlap?: boolean
  ignorePlacement?: boolean
}

/** Run the greedy pass. Returns a boolean[] aligned with `items` —
 *  true = placed (visible), false = dropped (collided). */
export function greedyPlaceBboxes(items: readonly CollisionItem[]): boolean[] {
  const out = new Array<boolean>(items.length).fill(false)
  const blocking: CollisionBbox[] = []
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!
    let collides = false
    if (!it.allowOverlap) {
      for (const b of blocking) {
        if (it.bbox.minX < b.maxX && it.bbox.maxX > b.minX
            && it.bbox.minY < b.maxY && it.bbox.maxY > b.minY) {
          collides = true
          break
        }
      }
    }
    if (collides) continue
    out[i] = true
    if (!it.ignorePlacement) blocking.push(it.bbox)
  }
  return out
}
