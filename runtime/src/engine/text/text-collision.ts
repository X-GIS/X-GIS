// Greedy axis-aligned bbox collision for label placement.
//
// Input order is significant — the first item to claim its bbox wins
// against any later overlapper. Two opt-outs match Mapbox semantics:
//   - allowOverlap: skip the collision check for this item (it always
//     places, and it does block later items by default).
//   - ignorePlacement: this item places, but does NOT block later items.
// Combining `allowOverlap + ignorePlacement` produces Mapbox's "always
// visible, never blocks" behaviour.
//
// Variable anchor (Mapbox `text-variable-anchor`): a single label
// can supply multiple candidate bboxes (one per anchor candidate).
// The greedy pass tries each in order and picks the first that
// doesn't collide; the chosen index is returned so the caller can
// rebuild the label at the picked anchor's offset. Single-candidate
// labels use a one-element array.

export interface CollisionBbox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface CollisionItem {
  /** Candidate bboxes in priority order. Greedy pass tries each
   *  and picks the first non-colliding one. Single-anchor labels
   *  pass a one-element array. */
  bboxes: CollisionBbox[]
  allowOverlap?: boolean
  ignorePlacement?: boolean
  /** Mapbox `symbol-sort-key`. Lower values place first (win
   *  collisions). Default 0 — items at the same sortKey keep input
   *  order (stable sort). When undefined on every item, behaviour
   *  is byte-identical to the pre-sortKey input order. */
  sortKey?: number
}

export interface CollisionPlacement {
  /** True when one of the candidate bboxes survived collision. */
  placed: boolean
  /** Index into `bboxes` of the chosen candidate, or -1 if dropped. */
  chosen: number
}

/** Run the greedy pass. Returns one `CollisionPlacement` per item
 *  (indexed by ORIGINAL input order, not sortKey order).
 *
 *  When any item carries `sortKey`, the pass first builds a sorted
 *  iteration order by sortKey ascending (stable — items with equal
 *  keys keep their input order). Lower-key labels claim their bboxes
 *  first and block higher-key labels that overlap. When no item has
 *  sortKey, iteration order = input order (byte-identical legacy). */
export function greedyPlaceBboxes(items: readonly CollisionItem[]): CollisionPlacement[] {
  const out: CollisionPlacement[] = new Array(items.length)
  const blocking: CollisionBbox[] = []
  // Sort indices by sortKey ascending. Stable sort: items at the
  // same key keep their original order, so callers that don't set
  // sortKey at all see exactly the legacy iteration order.
  const order: number[] = new Array(items.length)
  for (let i = 0; i < items.length; i++) order[i] = i
  let anySortKey = false
  for (const it of items) if (it.sortKey !== undefined) { anySortKey = true; break }
  if (anySortKey) {
    order.sort((a, b) => (items[a]!.sortKey ?? 0) - (items[b]!.sortKey ?? 0))
  }
  for (let k = 0; k < order.length; k++) {
    const i = order[k]!
    const it = items[i]!
    let pickedIdx = -1
    for (let c = 0; c < it.bboxes.length; c++) {
      const bbox = it.bboxes[c]!
      if (it.allowOverlap) { pickedIdx = c; break }
      let collides = false
      for (const b of blocking) {
        if (bbox.minX < b.maxX && bbox.maxX > b.minX
            && bbox.minY < b.maxY && bbox.maxY > b.minY) {
          collides = true
          break
        }
      }
      if (!collides) { pickedIdx = c; break }
    }
    if (pickedIdx < 0) {
      out[i] = { placed: false, chosen: -1 }
      continue
    }
    out[i] = { placed: true, chosen: pickedIdx }
    if (!it.ignorePlacement) blocking.push(it.bboxes[pickedIdx]!)
  }
  return out
}
