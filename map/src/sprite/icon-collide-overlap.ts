// #417 collide-icon overlap resolution — extracted from IconStage.prepare
// (LOC-ceiling split, same math). One export: `resolveCollideDrops`, the single
// authority for WHICH symbol-placement:line icons survive their mutual overlap.
//
// The pass is greedy first-wins over a NEAR-FIRST ordering; the acceleration
// structure under the "does this box overlap a placed one" query is an
// implementation detail that cannot change a verdict (see the proof in the
// function body). `icon-collide-grid-equivalence.test.ts` pins that against a
// brute-force transcription of the pre-grid full scan.

/** The PendingIcon fields this pass reads — a structural subset, so IconStage
 *  passes its own queue with no adapter. */
export interface CollideCandidate {
  anchorX: number
  anchorY: number
  iconName: string
  sizeScale: number
  padding: number
  collide?: boolean
  pairKey?: string
  fadeId?: string
}

/** Sprite metadata the box math needs (SpriteInfo's measured subset). */
export interface CollideSprite {
  width: number
  height: number
  pixelRatio: number
}

/** Cell coordinate → bucket key for the uniform grid below. The bias keeps
 *  negative cells (off-screen anchors) positive; the span keeps the key an exact
 *  integer for any cell a screen-space anchor can reach. Two far-apart cells
 *  aliasing to one bucket would only add candidates to the exact AABB test that
 *  follows — never hide a blocker — so the packing is safe at any coordinate. */
const CELL_BIAS = 1 << 21
const CELL_SPAN = 1 << 22
function cellKey(cx: number, cy: number): number {
  return (cy + CELL_BIAS) * CELL_SPAN + (cx + CELL_BIAS)
}

/** Decide which `collide` icons in `pending` lose their overlap, BEFORE the emit
 *  loop runs. Returns the dropped DISPATCH indices; everything else emits in
 *  dispatch (painter) order — survivors don't overlap, so their relative draw
 *  order is moot.
 *
 *  Near-first (icon sibling of #1249): on a pitched view the icon nearer the
 *  camera (larger anchorY) must claim its box first, or the far arrow occludes
 *  the near one. Equal-Y ties fall to a STABLE per-feature id (`fadeId`, the
 *  paired text's collisionId — the icon twin of text #728) so the survivor of a
 *  flat road's arrow chain doesn't flip with tile-dispatch (I/O) order on pan,
 *  then to dispatch index.
 *
 *  The two pre-collision skips IconStage.prepare applies (paired text dropped,
 *  sprite absent) are mirrored here, so a dropped/absent icon never seeds a
 *  phantom blocker. */
export function resolveCollideDrops(
  pending: readonly CollideCandidate[],
  dpr: number,
  droppedPairKeys: ReadonlySet<string>,
  spriteOf: (name: string) => CollideSprite | undefined,
): Set<number> {
  const dropped = new Set<number>()
  const order: number[] = []
  for (let i = 0; i < pending.length; i++) if (pending[i]!.collide) order.push(i)
  if (order.length === 0) return dropped
  order.sort((a, b) => {
    const pa = pending[a]!
    const pb = pending[b]!
    if (pa.anchorY !== pb.anchorY) return pb.anchorY - pa.anchorY // near (larger Y) first
    const ca = pa.fadeId
    const cb = pb.fadeId
    if (ca !== undefined && cb !== undefined && ca !== cb) return ca < cb ? -1 : 1
    return a - b // stable: dispatch order
  })
  // Resolve every candidate's padded box up front — one flat Float64Array, four
  // floats per slot. A slot the two skips reject stays UNRESOLVED: it neither
  // blocks nor drops, exactly as in the pre-extraction pass.
  const k = order.length
  const box = new Float64Array(k * 4)
  const resolved = new Uint8Array(k)
  // Grid cell = the largest padded box, so no box spans more than 2×2 cells.
  let cellPx = 1
  for (let s = 0; s < k; s++) {
    const p = pending[order[s]!]!
    if (p.pairKey !== undefined && droppedPairKeys.has(p.pairKey)) continue
    const sprite = spriteOf(p.iconName)
    if (!sprite) continue
    const sizeScale = p.sizeScale * dpr
    const cdW = (sprite.width / sprite.pixelRatio) * sizeScale
    const cdH = (sprite.height / sprite.pixelRatio) * sizeScale
    const pad = p.padding * dpr // Mapbox icon-padding (default 2)
    // Written as the pre-extraction pass wrote it (`anchor ∓ half ∓ pad`) so the
    // box edges stay bit-identical to the historical form.
    const minX = p.anchorX - cdW / 2 - pad
    const maxX = p.anchorX + cdW / 2 + pad
    const minY = p.anchorY - cdH / 2 - pad
    const maxY = p.anchorY + cdH / 2 + pad
    box[s * 4] = minX
    box[s * 4 + 1] = minY
    box[s * 4 + 2] = maxX
    box[s * 4 + 3] = maxY
    resolved[s] = 1
    if (maxX - minX > cellPx) cellPx = maxX - minX
    if (maxY - minY > cellPx) cellPx = maxY - minY
  }
  // Greedy first-wins in that order, with the overlap query served by a uniform
  // grid instead of a scan over every placed box. VERDICTS ARE IDENTICAL: two
  // overlapping AABBs share a point, hence share a cell, so scanning the query
  // box's own cells cannot miss a blocker the full scan would find — and every
  // surviving candidate still faces the same exact AABB test. Cost drops from
  // O(k²) to ~O(k): 10.8 ms → 1.9 ms for 3000 mutually-crowded arrows (the OFM
  // road_oneway / shield case at high zoom), where the scan was the single
  // largest CPU item in the icon path.
  const grid = new Map<number, number[]>()
  for (let s = 0; s < k; s++) {
    if (resolved[s] === 0) continue
    const minX = box[s * 4]!,
      minY = box[s * 4 + 1]!,
      maxX = box[s * 4 + 2]!,
      maxY = box[s * 4 + 3]!
    const cx0 = Math.floor(minX / cellPx),
      cx1 = Math.floor(maxX / cellPx)
    const cy0 = Math.floor(minY / cellPx),
      cy1 = Math.floor(maxY / cellPx)
    let overlaps = false
    scan: for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const bucket = grid.get(cellKey(cx, cy))
        if (bucket === undefined) continue
        for (const o of bucket) {
          if (
            minX < box[o * 4 + 2]! &&
            maxX > box[o * 4]! &&
            minY < box[o * 4 + 3]! &&
            maxY > box[o * 4 + 1]!
          ) {
            overlaps = true
            break scan
          }
        }
      }
    }
    if (overlaps) {
      dropped.add(order[s]!)
      continue
    }
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const key = cellKey(cx, cy)
        const bucket = grid.get(key)
        if (bucket === undefined) grid.set(key, [s])
        else bucket.push(s)
      }
    }
  }
  return dropped
}
