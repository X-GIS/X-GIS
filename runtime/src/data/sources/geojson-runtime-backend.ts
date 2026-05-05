// GeoJSONRuntimeBackend — owns raw decomposed GeoJSON parts and the
// spatial index used to look up which parts overlap a given tile.
// Extracted from XGVTSource as Step 4 of the layer-type refactor
// (plans/delegated-hopping-cray.md).
//
// Scope: state holder only. Catalog (XGVTSource for now,
// TileCatalog post-rename) still orchestrates compileTileOnDemand
// because the per-frame compile budget is a catalog-level concern
// shared with sub-tile generation. Backend's job is "given a tile
// (z, x, y), return the geometry parts that potentially overlap it"
// — fast O(1) cell lookup via a z=3 spatial grid.
//
// Step 5 may push more orchestration into the backend (compileSync
// signature in the TileSource interface). Keeping that out of Step 4
// minimises the per-step regression surface.

import {
  tileKey,
  type GeometryPart,
} from '@xgis/compiler'

export class GeoJSONRuntimeBackend {
  private rawParts: GeometryPart[] = []
  private _maxZoom = 7

  /** Spatial grid index: z=3 tile key → indices into rawParts. */
  private partGrid: Map<number, number[]> = new Map()
  private static readonly GRID_ZOOM = 3

  get maxZoom(): number {
    return this._maxZoom
  }

  get partCount(): number {
    return this.rawParts.length
  }

  /** Replace the backend's raw geometry + rebuild the spatial grid. */
  setParts(parts: GeometryPart[], maxZoom: number): void {
    this.rawParts = parts
    this._maxZoom = maxZoom
    this.buildPartGrid(parts)
  }

  /** Synchronous predicate — does this backend potentially have data
   *  for the given (z, x, y)? Used by catalog.hasEntryInIndex for
   *  on-demand sources. */
  has(z: number): boolean {
    return this.rawParts.length > 0 && z <= this._maxZoom
  }

  /** Get parts that potentially overlap a tile (via grid index).
   *  Returns null when there are no overlapping parts (lets the
   *  caller cache an empty placeholder instead of repeatedly
   *  retrying). */
  getRelevantParts(z: number, x: number, y: number): GeometryPart[] | null {
    if (this.rawParts.length === 0) return null
    if (this.partGrid.size === 0) return this.rawParts
    const gz = GeoJSONRuntimeBackend.GRID_ZOOM

    if (z >= gz) {
      // Tile fits within one grid cell
      const shift = z - gz
      const k = tileKey(gz, x >> shift, y >> shift)
      const indices = this.partGrid.get(k)
      if (!indices) return null
      return indices.map(i => this.rawParts[i])
    }

    // z < gz: tile covers multiple grid cells — aggregate with dedup
    const shift = gz - z
    const gx0 = x << shift
    const gy0 = y << shift
    const span = 1 << shift
    const seen = new Set<number>()
    const result: GeometryPart[] = []
    for (let gx = gx0; gx < gx0 + span; gx++) {
      for (let gy = gy0; gy < gy0 + span; gy++) {
        const k = tileKey(gz, gx, gy)
        const indices = this.partGrid.get(k)
        if (!indices) continue
        for (const idx of indices) {
          if (!seen.has(idx)) { seen.add(idx); result.push(this.rawParts[idx]) }
        }
      }
    }
    return result.length > 0 ? result : null
  }

  /** Build spatial grid index at z=3 (64 cells) for fast part lookup. */
  private buildPartGrid(parts: GeometryPart[]): void {
    const z = GeoJSONRuntimeBackend.GRID_ZOOM
    const n = Math.pow(2, z)
    const grid = new Map<number, number[]>()

    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]
      const minTX = Math.max(0, Math.floor((p.minLon + 180) / 360 * n))
      const maxTX = Math.min(n - 1, Math.floor((p.maxLon + 180) / 360 * n))
      const minTY = Math.max(0, Math.floor((1 - Math.log(Math.tan(Math.max(p.minLat, -85) * Math.PI / 180) + 1 / Math.cos(Math.max(p.minLat, -85) * Math.PI / 180)) / Math.PI) / 2 * n))
      const maxTY = Math.min(n - 1, Math.floor((1 - Math.log(Math.tan(Math.min(p.maxLat, 85) * Math.PI / 180) + 1 / Math.cos(Math.min(p.maxLat, 85) * Math.PI / 180)) / Math.PI) / 2 * n))

      // Note: in Mercator tile coords, smaller Y = higher latitude
      const yLo = Math.min(minTY, maxTY)
      const yHi = Math.max(minTY, maxTY)

      for (let tx = minTX; tx <= maxTX; tx++) {
        for (let ty = yLo; ty <= yHi; ty++) {
          const k = tileKey(z, tx, ty)
          let arr = grid.get(k)
          if (!arr) { arr = []; grid.set(k, arr) }
          arr.push(i)
        }
      }
    }
    this.partGrid = grid
  }
}
