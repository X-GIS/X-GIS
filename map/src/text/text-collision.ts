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

interface CollisionBbox {
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
   *  collisions). Default 0 — items at the same sortKey are ordered by
   *  `tieBreak` (below), falling back to input order. When neither
   *  sortKey nor tieBreak is set on any item, behaviour is byte-identical
   *  to the pre-sortKey input order. */
  sortKey?: number
  /** STABLE per-feature identity used as the deterministic collision
   *  tie-break AFTER sortKey. Two overlapping labels resolve to the SAME
   *  winner regardless of input (tile-dispatch) order — the caller derives
   *  it from already-stable keys (resolvedText + quantized world position
   *  for points, layer+route for lines) so the survivor no longer flips on
   *  pan or on which tiles happen to be loaded. Compared ascending; items
   *  WITH a tieBreak place before items without at the same sortKey. When
   *  undefined on every item, placement order is byte-identical to the
   *  legacy input-order (dispatch-order) behaviour. */
  tieBreak?: string
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
  /** Collision group — MapLibre `collisionGroupID`. A blocker with
   *  the SAME groupKey never blocks this item, so a paired icon
   *  obstacle never collides with its own text label (they share the
   *  same anchor by design). Undefined → blocked by every overlapper. */
  groupKey?: string
}

/** A pre-placed collision blocker seeded into the grid BEFORE the greedy
 *  pass runs. MapLibre inserts each placed icon box into the shared collision
 *  grid so later labels avoid it. X-GIS runs text + icon stages separately,
 *  so the label pass seeds the dispatched icon boxes here; every label is
 *  then tested against them (except an icon's own paired text via groupKey).
 *  Obstacles always block and are never themselves dropped. */
export interface CollisionObstacle {
  bbox: CollisionBbox
  /** Same-group items (the icon's own paired text) are not blocked. */
  groupKey?: string
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
  /** Pre-placed blockers seeded into the grid BEFORE any item is
   *  tested — MapLibre inserts each placed symbol's icon box into the
   *  shared collision grid so subsequent labels avoid it. X-GIS runs
   *  text collision separately from icons, so the caller passes the
   *  dispatched icons' screen boxes here; every label is then tested
   *  against them (except an icon's own paired text via groupKey).
   *  Obstacles always block and are never dropped. */
  obstacles?: readonly CollisionObstacle[]
}

/** Run the greedy pass. Returns one `CollisionPlacement` per item
 *  (indexed by ORIGINAL input order, not sortKey order).
 *
 *  When any item carries `sortKey` or `tieBreak`, the pass first builds
 *  a sorted iteration order: sortKey ascending, then `tieBreak` ascending
 *  (a stable per-feature identity — the same overlapping label wins
 *  regardless of input order), then input index. Lower-key labels claim
 *  their bboxes first and block higher-key labels that overlap. When no
 *  item has either key, iteration order = input order (byte-identical
 *  legacy first-wins).
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
  // Each blocker carries its groupKey so an item is never blocked by a
  // blocker of its OWN collision group (a paired symbol's icon vs its text).
  const blocking: { bbox: CollisionBbox; groupKey?: string }[] = []
  // Seed the icon obstacles first (MapLibre: placed icon boxes live in the
  // same grid every later label hit-tests against). They always block.
  if (opts.obstacles) {
    for (const o of opts.obstacles) blocking.push({ bbox: o.bbox, groupKey: o.groupKey })
  }
  // Per-lineId list of along-line distances already claimed by a
  // placed label. Same-line check is O(items-per-line) but items
  // per line is small in real styles (highway labels every ~250px).
  const placedByLine: Map<number | string, number[]> = new Map()
  const minLineSp = opts.minLineSpacingPx ?? 0
  const order: number[] = new Array(items.length)
  for (let i = 0; i < items.length; i++) order[i] = i
  // Deterministic placement order. Primary: symbol-sort-key ascending
  // (lower wins). Secondary: `tieBreak` — a STABLE per-feature identity
  // supplied by the caller so two overlapping labels resolve to the SAME
  // winner regardless of input (tile-dispatch) order. Final fallback:
  // input index, so a caller that sets NEITHER key gets byte-identical
  // legacy first-wins order (the sort is skipped entirely in that case).
  let anyOrdering = false
  for (const it of items)
    if (it.sortKey !== undefined || it.tieBreak !== undefined) {
      anyOrdering = true
      break
    }
  if (anyOrdering) {
    order.sort((a, b) => {
      const ka = items[a]!.sortKey ?? 0
      const kb = items[b]!.sortKey ?? 0
      if (ka !== kb) return ka - kb
      const ta = items[a]!.tieBreak
      const tb = items[b]!.tieBreak
      if (ta !== undefined && tb !== undefined) {
        if (ta < tb) return -1
        if (ta > tb) return 1
      } else if (ta !== undefined) return -1
      else if (tb !== undefined) return 1
      return a - b
    })
  }
  for (let k = 0; k < order.length; k++) {
    const i = order[k]!
    const it = items[i]!
    // Same-line min-distance gate runs BEFORE bbox collision so a
    // crowded same-line label is rejected even if its bbox doesn't
    // overlap any blocker. Saves a per-bbox scan when minLineSp > 0.
    if (
      minLineSp > 0 &&
      it.lineId !== undefined &&
      it.anchorDistancePx !== undefined &&
      !it.allowOverlap
    ) {
      const claimed = placedByLine.get(it.lineId)
      if (claimed) {
        let crowded = false
        for (const d of claimed) {
          if (Math.abs(d - it.anchorDistancePx) < minLineSp) {
            crowded = true
            break
          }
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
      if (it.allowOverlap) {
        pickedIdx = c
        break
      }
      let collides = false
      for (const b of blocking) {
        // Same collision group (icon ↔ its own paired text) never collides.
        if (it.groupKey !== undefined && b.groupKey === it.groupKey) continue
        const bb = b.bbox
        if (
          bbox.minX < bb.maxX &&
          bbox.maxX > bb.minX &&
          bbox.minY < bb.maxY &&
          bbox.maxY > bb.minY
        ) {
          collides = true
          break
        }
      }
      if (!collides) {
        pickedIdx = c
        break
      }
    }
    if (pickedIdx < 0) {
      out[i] = { placed: false, chosen: -1 }
      continue
    }
    out[i] = { placed: true, chosen: pickedIdx }
    if (!it.ignorePlacement) blocking.push({ bbox: it.bboxes[pickedIdx]!, groupKey: it.groupKey })
    if (it.lineId !== undefined && it.anchorDistancePx !== undefined) {
      let arr = placedByLine.get(it.lineId)
      if (!arr) {
        arr = []
        placedByLine.set(it.lineId, arr)
      }
      arr.push(it.anchorDistancePx)
    }
  }
  return out
}
