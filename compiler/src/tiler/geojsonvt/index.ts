// 1:1 port of geojson-vt/src/index.js — top-level GeoJSONVT class
// with splitTile (recursive 4-quad clip), getTile (on-demand
// drilldown), and default options.
//
// Default `buffer` and `tolerance` match MapLibre GL JS's
// production usage (geojson_source.ts ~line 193): css px values
// scaled into extent units via `cssPx * (extent / tileSize)`. At
// X-GIS's MapLibre-compatible 512 css px tile + 8192 extent:
//
//   buffer    = 128 css px × 16 = 2048 extent units
//   tolerance = 0.375 css px × 16 = 6 extent units

import { convert } from './convert'
import { clip } from './clip'
import { wrap } from './wrap'
import { transformTile } from './transform'
import { createTile } from './tile'
import type {
  GeoJSONInput, GeoJSONVTOptions, InternalTile, ProjectedFeature, TransformedTile,
} from './types'

/** MapLibre-style defaults. `buffer` and `tolerance` are pre-baked
 *  for X-GIS's 8192-extent / 512-tile convention; callers wanting a
 *  different tile size should override both. */
export const DEFAULT_OPTIONS: GeoJSONVTOptions = {
  maxZoom: 14,
  indexMaxZoom: 5,
  indexMaxPoints: 100_000,
  tolerance: 6,    // 0.375 css px × (8192 / 512)
  extent: 8192,
  buffer: 2048,    // 128 css px × (8192 / 512)
  lineMetrics: false,
  promoteId: null,
  generateId: false,
  debug: 0,
}

export class GeoJSONVT {
  options: GeoJSONVTOptions
  tiles: Map<number, InternalTile> = new Map()
  tileCoords: { z: number; x: number; y: number }[] = []
  // Stats kept for debug output parity with the upstream JS.
  stats: Record<string, number> = {}
  total: number = 0

  constructor(data: GeoJSONInput, options?: Partial<GeoJSONVTOptions>) {
    this.options = { ...DEFAULT_OPTIONS, ...(options ?? {}) }
    const debug = this.options.debug

    if (this.options.maxZoom < 0 || this.options.maxZoom > 24) {
      throw new Error('maxZoom should be in the 0-24 range')
    }
    if (this.options.promoteId !== null && this.options.generateId) {
      throw new Error('promoteId and generateId cannot be used together.')
    }

    let features = convert(data, this.options)

    if (debug) {
      // eslint-disable-next-line no-console
      console.log('index: maxZoom: %d, maxPoints: %d', this.options.indexMaxZoom, this.options.indexMaxPoints)
    }

    features = wrap(features, this.options)

    if (features.length) this.splitTile(features, 0, 0, 0)
  }

  /** Splits features from a parent tile to sub-tiles. `z, x, y` are
   *  the parent's coordinates; `cz, cx, cy` (if set) are a specific
   *  drilldown target — recursion stops as soon as the target is
   *  produced. */
  splitTile(
    features: ProjectedFeature[],
    z: number,
    x: number,
    y: number,
    cz?: number,
    cx?: number,
    cy?: number,
  ): void {
    // Iterative queue to avoid recursion depth issues at high zooms.
    const stack: unknown[] = [features, z, x, y]
    const options = this.options
    const debug = options.debug

    while (stack.length) {
      y = stack.pop() as number
      x = stack.pop() as number
      z = stack.pop() as number
      features = stack.pop() as ProjectedFeature[]

      const z2 = 1 << z
      const id = toID(z, x, y)
      let tile = this.tiles.get(id)

      if (!tile) {
        tile = createTile(features, z, x, y, options)
        this.tiles.set(id, tile)
        this.tileCoords.push({ z, x, y })

        if (debug) {
          const key = `z${z}`
          this.stats[key] = (this.stats[key] ?? 0) + 1
          this.total++
        }
      }

      // Save reference to original geometry so getTile() can drill
      // down later if we stop recursion here.
      tile.source = features

      if (cz === undefined) {
        // First-pass tiling: stop at indexMaxZoom or when tile is sparse.
        if (z === options.indexMaxZoom || tile.numPoints <= options.indexMaxPoints) continue
      } else if (z === options.maxZoom || z === cz) {
        continue
      } else if (cz !== undefined) {
        // Not an ancestor of the target tile — skip recursion.
        const zoomSteps = cz - z
        if (cx === undefined || cy === undefined) continue
        if (x !== (cx >> zoomSteps) || y !== (cy >> zoomSteps)) continue
      }

      // We're going deeper; drop the source-feature reference so it
      // can be GC'd after the next sub-tile generation step.
      tile.source = null

      if (features.length === 0) continue

      // 4-quad clip: split features into top-left / bottom-left /
      // top-right / bottom-right children, each with a buffer
      // overlap (k1) so polygons spanning boundaries render seamlessly.
      const k1 = 0.5 * options.buffer / options.extent
      const k2 = 0.5 - k1
      const k3 = 0.5 + k1
      const k4 = 1 + k1

      let tl: ProjectedFeature[] | null = null
      let bl: ProjectedFeature[] | null = null
      let tr: ProjectedFeature[] | null = null
      let br: ProjectedFeature[] | null = null

      let left = clip(features, z2, x - k1, x + k3, 0, tile.minX, tile.maxX, options)
      let right = clip(features, z2, x + k2, x + k4, 0, tile.minX, tile.maxX, options)

      if (left) {
        tl = clip(left, z2, y - k1, y + k3, 1, tile.minY, tile.maxY, options)
        bl = clip(left, z2, y + k2, y + k4, 1, tile.minY, tile.maxY, options)
        left = null
      }

      if (right) {
        tr = clip(right, z2, y - k1, y + k3, 1, tile.minY, tile.maxY, options)
        br = clip(right, z2, y + k2, y + k4, 1, tile.minY, tile.maxY, options)
        right = null
      }

      stack.push(tl ?? [], z + 1, x * 2, y * 2)
      stack.push(bl ?? [], z + 1, x * 2, y * 2 + 1)
      stack.push(tr ?? [], z + 1, x * 2 + 1, y * 2)
      stack.push(br ?? [], z + 1, x * 2 + 1, y * 2 + 1)
    }
  }

  /** Returns the tile at (z, x, y) in extent-coordinate space, or
   *  null when the tile is empty / out of range. Drills down from
   *  the nearest indexed ancestor if the tile wasn't pre-built. */
  getTile(z: number, x: number, y: number): TransformedTile | null {
    z = +z
    x = +x
    y = +y

    const options = this.options
    const extent = options.extent

    if (z < 0 || z > 24) return null

    const z2 = 1 << z
    x = (x + z2) & (z2 - 1) // wrap tile x coordinate around the antimeridian

    const id = toID(z, x, y)
    const cached = this.tiles.get(id)
    if (cached) return transformTile(cached, extent)

    let z0 = z, x0 = x, y0 = y
    let parent: InternalTile | undefined

    while (!parent && z0 > 0) {
      z0--
      x0 = x0 >> 1
      y0 = y0 >> 1
      parent = this.tiles.get(toID(z0, x0, y0))
    }

    if (!parent || !parent.source) return null

    this.splitTile(parent.source, z0, x0, y0, z, x, y)

    const drilledTile = this.tiles.get(id)
    return drilledTile ? transformTile(drilledTile, extent) : null
  }
}

/** Stable 32-bit composite ID for a tile address. Matches upstream
 *  geojson-vt's `toID` formula so cached tile IDs are byte-comparable
 *  across implementations during oracle testing. */
function toID(z: number, x: number, y: number): number {
  return (((1 << z) * y + x) * 32) + z
}

/** Functional entry point — mirrors the default export of upstream. */
export function geojsonvt(
  data: GeoJSONInput,
  options?: Partial<GeoJSONVTOptions>,
): GeoJSONVT {
  return new GeoJSONVT(data, options)
}
