// ═══ Static 2-D k-d tree over the quantized cluster records (#2050) ═══
//
// The cluster hierarchy needs two queries and nothing else: a circular `within` while
// building a level (design §2, "cluster the previous level's output with radius
// r = radius / (extent · 2^z)") and a rectangular `range` while serving a tile (§2, "getTile
// ranges the zoom's tree over the tile box expanded by radius/extent"). One structure
// answering both, built once per zoom, is why upstream carries a k-d tree.
//
// WHY NOT A UNIFORM GRID, the obvious simpler alternative: the cell size has to be the
// query radius, and that radius SHRINKS BY HALF PER ZOOM. At z = 14 with the default
// radius it is 6e-6 of the unit square, i.e. a 167 772² dense grid — 2.8e10 cells for a
// structure that has to be rebuilt at every one of ~15 levels. A hash grid escapes the
// allocation but not the fact that geographic data is exactly the clumped input that makes
// a fixed-cell grid degenerate. The k-d tree costs O(n log n) once per level and does not
// care what the radius is.
//
// The tree is IMPLICIT — no nodes, no pointers. `ids`/`coords` are permuted in place so
// that every subrange's median sits at its midpoint, and a traversal is a stack of
// (left, right, axis) triples. That is kdbush's layout, and it is the reason a level costs
// two typed arrays rather than n objects.

/** Subranges at or below this size are scanned linearly instead of split. 64 is kdbush's
 *  default and the point where the branch bookkeeping stops paying for itself. Build and
 *  both queries MUST agree on it: a query that splits where the build did not would
 *  address a midpoint that is not a median and silently lose points. */
const NODE_SIZE = 64

export class ClusterKdTree {
  /** Record index of each slot, permuted by the build. */
  private readonly ids: Int32Array
  /** Interleaved quantized x/y, permuted alongside `ids`. */
  private readonly coords: Int32Array
  private readonly n: number

  /** Builds over `x[i]`/`y[i]` for `i < n`, which are the level's quantized columns. */
  constructor(x: Int32Array, y: Int32Array, n: number) {
    this.n = n
    this.ids = new Int32Array(n)
    this.coords = new Int32Array(n * 2)
    for (let i = 0; i < n; i++) {
      this.ids[i] = i
      this.coords[2 * i] = x[i]
      this.coords[2 * i + 1] = y[i]
    }
    sortKd(this.ids, this.coords, 0, n - 1, 0)
  }

  /** Record indices inside the closed box, in traversal order (NOT record order).
   *  Bounds are in the quantized domain and may lie outside it — a tile's buffer at
   *  x = 0 reaches negative — so they are plain doubles compared against stored ints. */
  range(minX: number, minY: number, maxX: number, maxY: number): number[] {
    const { ids, coords, n } = this
    const result: number[] = []
    // No `n === 0` guard, deliberately — an empty tree seeds the stack with the range
    // [0, −1], whose leaf scan below iterates zero times. A cut proved the guard could
    // not change any answer, and an inert branch reads as a mechanism that is not one.
    const stack: number[] = [0, n - 1, 0]

    while (stack.length) {
      const axis = stack.pop() as number
      const right = stack.pop() as number
      const left = stack.pop() as number

      if (right - left <= NODE_SIZE) {
        for (let i = left; i <= right; i++) {
          const x = coords[2 * i]
          const y = coords[2 * i + 1]
          if (x >= minX && x <= maxX && y >= minY && y <= maxY) result.push(ids[i])
        }
        continue
      }

      const m = (left + right) >> 1
      const x = coords[2 * m]
      const y = coords[2 * m + 1]
      if (x >= minX && x <= maxX && y >= minY && y <= maxY) result.push(ids[m])

      const nextAxis = 1 - axis
      if (axis === 0 ? minX <= x : minY <= y) stack.push(left, m - 1, nextAxis)
      if (axis === 0 ? maxX >= x : maxY >= y) stack.push(m + 1, right, nextAxis)
    }
    return result
  }

  /** Record indices within `r` of (qx, qy), Euclidean, in the quantized domain. */
  within(qx: number, qy: number, r: number): number[] {
    const { ids, coords, n } = this
    const result: number[] = []
    const r2 = r * r
    const stack: number[] = [0, n - 1, 0]

    while (stack.length) {
      const axis = stack.pop() as number
      const right = stack.pop() as number
      const left = stack.pop() as number

      if (right - left <= NODE_SIZE) {
        for (let i = left; i <= right; i++) {
          if (sqDist(coords[2 * i], coords[2 * i + 1], qx, qy) <= r2) result.push(ids[i])
        }
        continue
      }

      const m = (left + right) >> 1
      const x = coords[2 * m]
      const y = coords[2 * m + 1]
      if (sqDist(x, y, qx, qy) <= r2) result.push(ids[m])

      const nextAxis = 1 - axis
      if (axis === 0 ? qx - r <= x : qy - r <= y) stack.push(left, m - 1, nextAxis)
      if (axis === 0 ? qx + r >= x : qy + r >= y) stack.push(m + 1, right, nextAxis)
    }
    return result
  }
}

function sqDist(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx
  const dy = ay - by
  return dx * dx + dy * dy
}

/** Recursively place the median of each subrange at its midpoint, alternating axis. */
function sortKd(ids: Int32Array, coords: Int32Array, left: number, right: number, axis: number) {
  if (right - left <= NODE_SIZE) return
  const m = (left + right) >> 1
  select(ids, coords, m, left, right, axis)
  sortKd(ids, coords, left, m - 1, 1 - axis)
  sortKd(ids, coords, m + 1, right, 1 - axis)
}

/** Quickselect: after it returns, slot `k` holds the k-th smallest value on `axis` within
 *  `[left, right]`, everything below `k` is ≤ it and everything above is ≥ it.
 *
 *  THREE-way partitioning, not two. The realistic degenerate input here is not adversarial
 *  ordering — it is DUPLICATE COORDINATES: a hundred features geocoded to the same city
 *  centroid, or any dataset quantized coarser than 2^−30. A two-way partition is O(n²) on
 *  a run of equal keys; the equal block below is skipped whole, so the same input is O(n).
 *  The pivot is a median-of-three, which is what keeps the ordinary case from degenerating. */
function select(
  ids: Int32Array,
  coords: Int32Array,
  k: number,
  left: number,
  right: number,
  axis: number,
) {
  while (right > left) {
    const mid = (left + right) >> 1
    if (coordAt(coords, mid, axis) < coordAt(coords, left, axis)) swapItem(ids, coords, mid, left)
    if (coordAt(coords, right, axis) < coordAt(coords, left, axis))
      swapItem(ids, coords, right, left)
    if (coordAt(coords, right, axis) < coordAt(coords, mid, axis)) swapItem(ids, coords, right, mid)
    const pivot = coordAt(coords, mid, axis)

    let lt = left
    let i = left
    let gt = right
    while (i <= gt) {
      const v = coordAt(coords, i, axis)
      if (v < pivot) swapItem(ids, coords, lt++, i++)
      else if (v > pivot) swapItem(ids, coords, i, gt--)
      else i++
    }

    // `k` inside the equal block means every ordering constraint already holds.
    if (k < lt) right = lt - 1
    else if (k > gt) left = gt + 1
    else return
  }
}

function coordAt(coords: Int32Array, i: number, axis: number): number {
  return coords[2 * i + axis]
}

function swapItem(ids: Int32Array, coords: Int32Array, i: number, j: number) {
  const t = ids[i]
  ids[i] = ids[j]
  ids[j] = t
  const tx = coords[2 * i]
  coords[2 * i] = coords[2 * j]
  coords[2 * j] = tx
  const ty = coords[2 * i + 1]
  coords[2 * i + 1] = coords[2 * j + 1]
  coords[2 * j + 1] = ty
}
