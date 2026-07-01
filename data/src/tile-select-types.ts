// ═══ Tile-select shared types ═══
// Extracted verbatim from tile-select.ts (behaviour-preserving refactor).

/** A tile coordinate triple — wrapped (x, y) for data lookup, plus
 *  absolute `ox` for world-copy positioning.
 *
 *  CONTRACT — all selectors and consumers MUST follow this:
 *
 *    - `x` is the wrapped tile-x in [0, 2^z). Used to look up data
 *      (catalog key derives from this).
 *    - `ox` is the ABSOLUTE tile-x including world-copy shift. May be
 *      negative or ≥ 2^z when the camera spans the antimeridian.
 *      Equals `x + worldCopy * 2^z` where worldCopy is the integer
 *      offset (… -2, -1, 0, 1, 2 …) of the world copy this tile
 *      belongs to.
 *
 *  The renderer derives the per-tile longitude shift via
 *  `(ox - x) * 360 / 2^z`. If a selector emits `ox` as a small copy
 *  index (e.g. -2..+2) instead of the absolute tile-x, every rendered
 *  tile gets a multi-thousand-degree wrong offset and the canvas
 *  blanks at non-zero zoom — root cause of the commit-71dd401
 *  Phase-2 regression. `ox` is REQUIRED, not optional, so the type
 *  system catches a missing assignment at the source.
 *
 *  See `worldCopyOf(coord)` for the inverse — extract the world-copy
 *  index from a TileCoord. */
export interface TileCoord {
  z: number
  x: number
  y: number
  ox: number
  /** Marks a parent-injected tile that exists in `result` only to
   *  keep its data resident (eviction protection). The renderer
   *  routes these into `fallbackKeys` instead of `neededKeys`, so
   *  they render via stencil-test (only where the children failed)
   *  rather than as primaries — preventing parent + child both
   *  drawing the same screen region. Default false / undefined for
   *  selector-derived tiles. */
  fallbackOnly?: boolean
}

export interface LoadedTile {
  coord: TileCoord
  texture: GPUTexture
  // Tile bounds in lon/lat degrees
  west: number
  south: number
  east: number
  north: number
}
