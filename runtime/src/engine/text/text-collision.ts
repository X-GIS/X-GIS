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
  /** Stable identifier of the line / feature this label follows.
   *  Two labels with the same lineId enforce a minimum along-line
   *  distance (`minLineSpacingPx`) so labels on the same road
   *  don't crowd. Undefined → label not subject to same-line min
   *  spacing (point-placement labels, icons). */
  lineId?: number | string
  /** Cumulative arc-length (CSS px) of this label's anchor along
   *  the line from start, used together with `lineId` + the
   *  greedy pass's `minLineSpacingPx` to drop labels within the
   *  symbol-spacing window of a higher-priority same-line label.
   *  Undefined → unused. */
  anchorDistancePx?: number
}

export interface CollisionPlacement {
  /** True when one of the candidate bboxes survived collision. */
  placed: boolean
  /** Index into `bboxes` of the chosen candidate, or -1 if dropped. */
  chosen: number
}

export interface GreedyOptions {
  /** Minimum along-line distance (CSS px) between labels on the
   *  SAME `lineId`. A later same-line label is dropped if its
   *  `anchorDistancePx` is within this window of any already-placed
   *  same-line label. Maps directly to Mapbox `symbol-spacing` —
   *  default 250 px per spec. Set to 0 (or undefined) to disable.
   *  Items without lineId / anchorDistancePx are unaffected. */
  minLineSpacingPx?: number
}

/** Run the greedy pass. Returns one `CollisionPlacement` per item
 *  (indexed by ORIGINAL input order, not sortKey order).
 *
 *  When any item carries `sortKey`, the pass first builds a sorted
 *  iteration order by sortKey ascending (stable — items with equal
 *  keys keep their input order). Lower-key labels claim their bboxes
 *  first and block higher-key labels that overlap. When no item has
 *  sortKey, iteration order = input order (byte-identical legacy).
 *
 *  When `opts.minLineSpacingPx` is set and an item carries lineId +
 *  anchorDistancePx, a same-line label whose anchorDistance is
 *  within the window of an already-placed same-line label is
 *  dropped (visibility win — prevents identical labels crowding
 *  adjacent segments of the same road). Mirror of MapLibre's
 *  along-line spacing logic on top of the AABB collision. */
export function greedyPlaceBboxes(
  items: readonly CollisionItem[],
  opts: GreedyOptions = {},
): CollisionPlacement[] {
  const out: CollisionPlacement[] = new Array(items.length)
  const blocking: CollisionBbox[] = []
  // Per-lineId list of along-line distances already claimed by a
  // placed label. Same-line check is O(items-per-line) but items
  // per line is small in real styles (highway labels every ~250px).
  const placedByLine: Map<number | string, number[]> = new Map()
  const minLineSp = opts.minLineSpacingPx ?? 0
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
    // Same-line min-distance gate runs BEFORE bbox collision so a
    // crowded same-line label is rejected even if its bbox doesn't
    // overlap any blocker. Saves a per-bbox scan when minLineSp > 0.
    if (minLineSp > 0 && it.lineId !== undefined && it.anchorDistancePx !== undefined && !it.allowOverlap) {
      const claimed = placedByLine.get(it.lineId)
      if (claimed) {
        let crowded = false
        for (const d of claimed) {
          if (Math.abs(d - it.anchorDistancePx) < minLineSp) { crowded = true; break }
        }
        if (crowded) {
          out[i] = { placed: false, chosen: -1 }
          continue
        }
      }
    }
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
    if (it.lineId !== undefined && it.anchorDistancePx !== undefined) {
      let arr = placedByLine.get(it.lineId)
      if (!arr) { arr = []; placedByLine.set(it.lineId, arr) }
      arr.push(it.anchorDistancePx)
    }
  }
  return out
}
