// ═══ Raster tile ROW geometry — the (z, y) half of a tile's bounds ═══
//
// #2560. `RasterRenderer.emitTileAt` computed a drawn tile's latitude bounds and
// Mercator-Y span inline, per tile per frame: two `atan(sinh(...))` and two
// `log(tan(...))`. An owner CPU profile of the deployed build put 325 ms in that
// builder over a 13.2 s raster session.
//
// All four are functions of `(z, y)` ALONE — not of `x`, and not of the world
// copy, whose entire contribution is the `+ wc * 360` applied to `west`/`east`
// downstream. That is what makes a memo worth having: the (z, y) domain a
// viewport touches is a handful of rows, while (z, x, y, ox) is every drawn
// tile, so the same work was being redone across columns AND across copies.
//
// Extracted rather than left in the renderer for the reason `draw-dedup-key.ts`
// was (#2495): the arithmetic and the argument for it belong together, and a
// pure function can be held to the retired expression byte-for-byte by a
// differential test. The CACHE stays on the renderer — it is per-instance state;
// this file has none.

/** Web-Mercator latitude bounds of one tile ROW, plus its Mercator-Y span.
 *
 *  #2560: every one of these is a function of `(z, y)` ALONE — not of `x`, and
 *  not of the world copy. `emitTileAt` recomputed all four per drawn tile per
 *  frame: two `atan(sinh(...))` for the bounds and two `log(tan(...))` for the
 *  Mercator span. An owner CPU profile of the deployed build put 325 ms in that
 *  builder over a 13.2 s raster session.
 *
 *  Splitting the row math out is what makes the memo cheap: the (z, y) domain a
 *  viewport touches is a handful of rows, while (z, x, y, ox) is every drawn
 *  tile. `west`/`east` stay per-call because they are two multiplies. */
export interface RasterRowGeom {
  readonly north: number
  readonly south: number
  /** `log(tan(π/4 + φ/2))` at the SOUTH edge, kept separate from the span so the
   *  shader's f64→f32 hand-off does not cancel at high zoom (the reason the
   *  original stored south + diff rather than south + north). */
  readonly mercSouth: number
  readonly mercDiff: number
}

const DEG2RAD = Math.PI / 180
/** The Web-Mercator latitude limit; beyond it `tan(π/4 + φ/2)` runs away. */
const MERC_LIMIT = 85.051129

export function computeRowGeom(z: number, y: number): RasterRowGeom {
  const rn = Math.pow(2, z)
  const north = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / rn))) * 180) / Math.PI
  const south = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / rn))) * 180) / Math.PI
  const clamp = (v: number): number => Math.max(-MERC_LIMIT, Math.min(MERC_LIMIT, v))
  const mercSouth = Math.log(Math.tan(Math.PI / 4 + (clamp(south) * DEG2RAD) / 2))
  const mercNorth = Math.log(Math.tan(Math.PI / 4 + (clamp(north) * DEG2RAD) / 2))
  return { north, south, mercSouth, mercDiff: mercNorth - mercSouth }
}

/** Rows retained per zoom before the level is dropped wholesale. A viewport
 *  spans well under ten rows at any zoom; this is slack for a pan, not a
 *  budget, and dropping a level costs only the recompute it was avoiding. */
export const ROW_GEOM_MAX_PER_Z = 128

/** The per-instance memo over `computeRowGeom`, `z → y → geom`.
 *
 *  A class rather than a couple of fields on the renderer so the memo itself is
 *  reachable by a test. The accessor is where the interesting way to be wrong
 *  lives: drop `y` from the inner key and every row in a level silently takes
 *  the first row's latitude bounds — a whole-level misplacement that the pure
 *  function's own tests cannot see, because they never go through the cache.
 *
 *  Two levels rather than one packed `(z, y)` key because a packed key needs an
 *  arithmetic premise about the ranges, and this repo has twice paid for one of
 *  those being wrong (#2495's world-copy unit, and the stride before it).
 *  Nothing here needs the premise. */
export class RowGeomCache {
  private readonly byZ = new Map<number, Map<number, RasterRowGeom>>()

  get(z: number, y: number): RasterRowGeom {
    let byY = this.byZ.get(z)
    if (byY === undefined) {
      byY = new Map()
      this.byZ.set(z, byY)
    }
    const hit = byY.get(y)
    if (hit !== undefined) return hit
    // Overflow drops the LEVEL wholesale rather than evicting one entry: the
    // values are pure functions of their key, so the loss costs exactly the
    // recompute this memo avoids, and never correctness.
    if (byY.size >= ROW_GEOM_MAX_PER_Z) byY.clear()
    const g = computeRowGeom(z, y)
    byY.set(y, g)
    return g
  }

  /** Rows currently retained at `z` — the cap's observable, for tests. */
  sizeAt(z: number): number {
    return this.byZ.get(z)?.size ?? 0
  }
}
