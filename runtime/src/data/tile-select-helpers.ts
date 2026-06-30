// ═══ Tile-select pure helpers ═══
// Extracted verbatim from tile-select.ts (behaviour-preserving refactor).
// These are pure tile-math free functions with no module-level mutable
// state and no side effects.
import { worldCopiesFor, TILE_PX } from '@xgis/engine'
import { tileKeyParent } from '@xgis/compiler'
import type { TileCoord } from './tile-select-types'

/** Walk from `leafKey` up the quad-tree until the first parent for
 *  which `hasEntry(pk)` returns true, returning that ancestor's key.
 *  Returns -1 when no ancestor up to z=0 is in the index.
 *
 *  Hoisted out of `VectorTileRenderer.renderTileKeys` so the extreme
 *  over-zoom bug (user pans to z=20 while the source maxLevel is 5)
 *  can be CPU-tested without a GPU device. The previous in-place loop
 *  capped at 2 levels, which silently dropped every descendant whose
 *  real parent lived more than 2 levels up — the entire visible set
 *  would miss its prefetch target and render black.
 *
 *  Cap (`MAX_WALK`) mirrors the DSFUN zoom ceiling (22); past that
 *  `tileKeyParent` loses precision.
 *
 *  Complexity: O(z_leaf - z_parent). Typical extreme case at z=20
 *  terminates in 15 iterations per distinct column; Set-based dedup
 *  at the call site avoids the N²ish cost when many descendants share
 *  one ancestor. */
export function firstIndexedAncestor(
  leafKey: number,
  hasEntry: (key: number) => boolean,
): number {
  const MAX_WALK = 22
  let pk = leafKey
  for (let i = 0; i < MAX_WALK && pk > 1; i++) {
    pk = tileKeyParent(pk)
    if (hasEntry(pk)) return pk
  }
  return -1
}

/** World-copy index (-2..+2 typically) of a tile coord. Returns 0 for
 *  the central copy, +1 for east, -1 for west, etc. Inverse of
 *  `ox = x + worldCopy * 2^z`. */
export function worldCopyOf(coord: TileCoord): number {
  return Math.floor(coord.ox / Math.pow(2, coord.z))
}

/** Build a TileCoord with the absolute-x contract pre-computed. Use
 *  this from any new selector to ensure the contract holds. */
export function makeTileCoord(z: number, wrappedX: number, y: number, worldCopy: number = 0): TileCoord {
  return { z, x: wrappedX, y, ox: wrappedX + worldCopy * Math.pow(2, z) }
}

/** Calculate tile coordinates from lon/lat bounds and zoom level */
export function visibleTiles(
  centerLon: number,
  centerLat: number,
  zoom: number,
  viewportWidth: number,
  viewportHeight: number,
  cameraZoom?: number,
  bearing?: number,
  pitch?: number,
): TileCoord[] {
  const z = Math.max(0, Math.min(18, Math.round(zoom)))
  const n = Math.pow(2, z)

  // Center tile
  const cx = Math.floor((centerLon + 180) / 360 * n)
  const cy = Math.floor((1 - Math.log(Math.tan(centerLat * Math.PI / 180) + 1 / Math.cos(centerLat * Math.PI / 180)) / Math.PI) / 2 * n)

  // How many tiles fit in viewport — account for overzoom
  // At camera zoom >> tile zoom, each tile covers many screen pixels
  const effectiveZoom = cameraZoom ?? zoom
  const scale = Math.pow(2, effectiveZoom - z) // how many screen-tile-sizes per actual tile
  const tileSize = TILE_PX * scale

  // When the map is rotated, the axis-aligned bounding box of the viewport
  // is larger than the viewport itself. Scale up by the AABB of a rotated rect.
  let effW = viewportWidth
  let effH = viewportHeight
  if (bearing) {
    const rad = Math.abs(bearing * Math.PI / 180)
    const cos = Math.abs(Math.cos(rad))
    const sin = Math.abs(Math.sin(rad))
    effW = viewportWidth * cos + viewportHeight * sin
    effH = viewportWidth * sin + viewportHeight * cos
  }

  const tilesX = Math.ceil(effW / tileSize / 2) + 1
  let tilesY = Math.ceil(effH / tileSize / 2) + 1

  // Pitch: camera tilted → need more tiles in the "forward" direction
  // Quantize pitch to 5° steps to stabilize tile set (prevents oscillation)
  if (pitch && pitch > 0) {
    const quantizedPitch = Math.ceil(Math.min(pitch, 85) / 5) * 5
    const pitchFactor = 1 / Math.cos(quantizedPitch * Math.PI / 180)
    const extra = Math.ceil(tilesY * (pitchFactor - 1))
    tilesY += Math.min(extra, tilesY * 4)
  }

  const tiles: TileCoord[] = []

  // Wrap cx to [0, n) so world copies are symmetric around the primary world
  const wrappedCx = ((cx % n) + n) % n
  const wrapOffset = cx - wrappedCx  // how many tiles the camera is shifted

  for (let dx = -tilesX; dx <= tilesX; dx++) {
    for (let dy = -tilesY; dy <= tilesY; dy++) {
      const ox = wrapOffset + wrappedCx + dx
      const y = cy + dy
      if (y < 0 || y >= n) continue
      const x = ((ox % n) + n) % n

      // Limit world copies. visibleTiles is invoked from xgvt-source
      // sub-tile generation and the Canvas 2D fallback — both pure
      // Mercator paths — so the Mercator wrap range applies.
      const maxCopies = (worldCopiesFor(0).length - 1) / 2  // mercator → 2
      if (ox < -maxCopies * n || ox >= (maxCopies + 1) * n) continue

      tiles.push({ z, x, y, ox })
    }
  }
  return tiles
}

/** Get lon/lat bounds for a tile */
export function tileBounds(coord: TileCoord): { west: number; south: number; east: number; north: number } {
  const n = Math.pow(2, coord.z)
  const west = coord.x / n * 360 - 180
  const east = (coord.x + 1) / n * 360 - 180
  const north = Math.atan(Math.sinh(Math.PI * (1 - 2 * coord.y / n))) * 180 / Math.PI
  const south = Math.atan(Math.sinh(Math.PI * (1 - 2 * (coord.y + 1) / n))) * 180 / Math.PI
  return { west, south, east, north }
}

/** Build tile URL from template */
export function tileUrl(template: string, coord: TileCoord): string {
  // Global replace + {ratio} substitution mirror the vector-tile
  // loader's fix:
  //   - Single-pass `.replace('{z}', …)` left subsequent
  //     occurrences intact, fetch 400'd on duplicate placeholders
  //     in URLs like `…/{z}/{x}/{y}/{z}-{x}.png`.
  //   - `{ratio}` (Mapbox DPR suffix `""` / `"@2x"`) wasn't
  //     substituted, so a raster source using a retina-aware
  //     template fetched the unsubstituted URL and 404'd.
  return template
    .replace(/\{z\}/g, String(coord.z))
    .replace(/\{x\}/g, String(coord.x))
    .replace(/\{y\}/g, String(coord.y))
    .replace(/\{ratio\}/g, '')
}

/** Check if a URL is a tile template */
export function isTileTemplate(url: string): boolean {
  // Defensive: non-string url would crash on `.includes`. Type
  // assertion at the boundary (TS-typed-as-string) lets unexpected
  // values reach here.
  if (typeof url !== 'string') return false
  return url.includes('{z}') && url.includes('{x}') && url.includes('{y}')
}

/**
 * Sort tiles by distance from center (closest first → highest priority).
 */
export function sortByPriority(tiles: TileCoord[], centerTileX: number, centerTileY: number): TileCoord[] {
  return tiles.sort((a, b) => {
    // Use original x (ox) for distance — correct for world copies
    const ax = a.ox ?? a.x
    const bx = b.ox ?? b.x
    const da = Math.abs(ax - centerTileX) + Math.abs(a.y - centerTileY)
    const db = Math.abs(bx - centerTileX) + Math.abs(b.y - centerTileY)
    return da - db
  })
}
