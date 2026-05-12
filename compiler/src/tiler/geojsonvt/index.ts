// In-memory GeoJSON → vector tile index.
//
// Algorithm: Douglas-Peucker simplification + per-axis range
// clipping + recursive 4-quad splitTile. Originally pioneered by
// mapbox/geojson-vt; this implementation takes only the algorithm
// shape and integrates with X-GIS conventions:
//
//   - tile keys use X-GIS's Morton-encoded `tileKey()`
//     (compiler/src/tiler/vector-tiler.ts) instead of geojson-vt's
//     32×z-bit pack. That formula caps at z=24 (and the underlying
//     `1 << z` shift wraps to negative at z=31); the Morton scheme
//     stays accurate to z=25 without bit-width issues and is what
//     the rest of the X-GIS pipeline already uses.
//   - cluster / lineMetrics / debug counters / tileCoords array
//     dropped — none of them feed the X-GIS render path. Stripping
//     them takes ~50 LoC off the hot path.
//   - Defaults pre-baked for MapLibre's 512-px tile convention
//     (extent=8192, buffer=2048 = 128 css px, tolerance=6 = 0.375
//     css px). Same numerics MapLibre's geojson_source.ts produces.

import { tileKey } from '../vector-tiler'
import { convert } from './convert'
import { clip } from './clip'
import { wrap } from './wrap'
import { transformTile } from './transform'
import { createTile } from './tile'
import type {
  GeoJSONInput, GeoJSONVTOptions, InternalTile, ProjectedFeature, TransformedTile,
} from './types'

export const DEFAULT_OPTIONS: GeoJSONVTOptions = {
  maxZoom: 14,
  indexMaxZoom: 5,
  indexMaxPoints: 100_000,
  tolerance: 6,    // 0.375 css px × (8192 / 512)
  extent: 8192,
  buffer: 2048,    // 128 css px × (8192 / 512)
  promoteId: null,
  generateId: false,
}

/** Hard ceiling on maxZoom. Above this, `1 << z` inside splitTile
 *  loses precision on 32-bit JS bit-shifts, and the Morton tileKey
 *  approaches JS's 2^53 safe-integer limit. 25 is conservative —
 *  enough for any street-level detail and well below the cliff. */
const MAX_ALLOWED_ZOOM = 25

export class GeoJSONVT {
  options: GeoJSONVTOptions
  tiles: Map<number, InternalTile> = new Map()

  constructor(data: GeoJSONInput, options?: Partial<GeoJSONVTOptions>) {
    this.options = { ...DEFAULT_OPTIONS, ...(options ?? {}) }

    if (this.options.maxZoom < 0 || this.options.maxZoom > MAX_ALLOWED_ZOOM) {
      throw new Error(`maxZoom should be in the 0-${MAX_ALLOWED_ZOOM} range`)
    }
    if (this.options.promoteId !== null && this.options.generateId) {
      throw new Error('promoteId and generateId cannot be used together.')
    }

    const features = wrap(convert(data, this.options), this.options)

    if (features.length) this.splitTile(features, 0, 0, 0)
  }

  /** Recurse through tile quadrants down to `indexMaxZoom` (or the
   *  point-density threshold, whichever hits first). When `cz/cx/cy`
   *  are set, recursion follows only the branch that leads to that
   *  specific tile — used by `getTile()` for on-demand drilldown
   *  past `indexMaxZoom`. */
  splitTile(
    features: ProjectedFeature[],
    z: number,
    x: number,
    y: number,
    cz?: number,
    cx?: number,
    cy?: number,
  ): void {
    // Iterative queue to keep stack bounded at any zoom.
    const stack: unknown[] = [features, z, x, y]
    const options = this.options

    while (stack.length) {
      y = stack.pop() as number
      x = stack.pop() as number
      z = stack.pop() as number
      features = stack.pop() as ProjectedFeature[]

      const z2 = 1 << z
      const id = tileKey(z, x, y)
      let tile = this.tiles.get(id)

      if (!tile) {
        tile = createTile(features, z, x, y, options)
        this.tiles.set(id, tile)
      }

      // Keep a reference to the source feature list — `getTile()`
      // needs it to drill down past indexMaxZoom on demand.
      tile.source = features

      if (cz === undefined) {
        // First-pass indexing: stop at indexMaxZoom or when the tile
        // is sparse enough to serve directly.
        if (z === options.indexMaxZoom || tile.numPoints <= options.indexMaxPoints) continue
      } else if (z === options.maxZoom || z === cz) {
        continue
      } else if (cx !== undefined && cy !== undefined) {
        // Drilldown mode — only follow the ancestor branch of the
        // target tile, skip sibling quadrants.
        const zoomSteps = cz - z
        if (x !== (cx >> zoomSteps) || y !== (cy >> zoomSteps)) continue
      }

      // Going deeper — drop the source-feature ref so it can be
      // collected after the four child clips run.
      tile.source = null

      if (features.length === 0) continue

      // 4-quad clip. Buffer overlap k1 = half the per-side buffer in
      // unit-square coords; left/right pairs first, then split each
      // into top/bottom.
      const k1 = 0.5 * options.buffer / options.extent
      const k2 = 0.5 - k1
      const k3 = 0.5 + k1
      const k4 = 1 + k1

      let tl: ProjectedFeature[] | null = null
      let bl: ProjectedFeature[] | null = null
      let tr: ProjectedFeature[] | null = null
      let br: ProjectedFeature[] | null = null

      let left = clip(features, z2, x - k1, x + k3, 0, tile.minX, tile.maxX)
      let right = clip(features, z2, x + k2, x + k4, 0, tile.minX, tile.maxX)

      if (left) {
        tl = clip(left, z2, y - k1, y + k3, 1, tile.minY, tile.maxY)
        bl = clip(left, z2, y + k2, y + k4, 1, tile.minY, tile.maxY)
        left = null
      }
      if (right) {
        tr = clip(right, z2, y - k1, y + k3, 1, tile.minY, tile.maxY)
        br = clip(right, z2, y + k2, y + k4, 1, tile.minY, tile.maxY)
        right = null
      }

      stack.push(tl ?? [], z + 1, x * 2, y * 2)
      stack.push(bl ?? [], z + 1, x * 2, y * 2 + 1)
      stack.push(tr ?? [], z + 1, x * 2 + 1, y * 2)
      stack.push(br ?? [], z + 1, x * 2 + 1, y * 2 + 1)
    }
  }

  /** Returns the tile at `(z, x, y)` with coordinates in extent
   *  units, or null when the tile has no features. Drills down from
   *  the nearest indexed ancestor when the request goes past
   *  `indexMaxZoom`. */
  getTile(z: number, x: number, y: number): TransformedTile | null {
    z = +z; x = +x; y = +y
    if (z < 0 || z > MAX_ALLOWED_ZOOM) return null

    const extent = this.options.extent
    const z2 = 1 << z
    x = (x + z2) & (z2 - 1) // wrap x around the antimeridian

    const id = tileKey(z, x, y)
    const cached = this.tiles.get(id)
    if (cached) return transformTile(cached, extent)

    // Walk up to the nearest indexed ancestor that still carries its
    // source-feature reference.
    let z0 = z, x0 = x, y0 = y
    let parent: InternalTile | undefined
    while (!parent && z0 > 0) {
      z0--
      x0 = x0 >> 1
      y0 = y0 >> 1
      parent = this.tiles.get(tileKey(z0, x0, y0))
    }
    if (!parent || !parent.source) return null

    this.splitTile(parent.source, z0, x0, y0, z, x, y)

    const drilled = this.tiles.get(id)
    return drilled ? transformTile(drilled, extent) : null
  }
}

export function geojsonvt(
  data: GeoJSONInput,
  options?: Partial<GeoJSONVTOptions>,
): GeoJSONVT {
  return new GeoJSONVT(data, options)
}
