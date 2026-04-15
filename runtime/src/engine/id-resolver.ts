// Stable feature-id resolver for external data injection.
//
// Default X-GIS featId is the feature's array index — stable only
// within a single rebuildLayers() pass. For pushed data (setSourceData
// / updateFeature) the caller needs an id that survives retiles so
// picking, updates, and trails can follow the same logical feature.
//
// Policy:
//   1. GeoJSON standard `feature.id` wins (top-level).
//   2. Fallback to `properties.id`.
//   3. Otherwise use the array index.
//
// Coerce rules (toU32Id):
//   - Non-negative integer in [0, 2^31) → passthrough.
//   - Anything else → FNV-1a 32-bit hash of its string form.
//
// FNV-1a is chosen for compactness and speed. Collision probability at
// realistic volumes (tens of thousands of tracks) is negligible; the
// host can always supply pre-hashed numeric ids if it needs stronger
// guarantees.

const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193

/** FNV-1a 32-bit hash of a string. Always returns a u32. */
export function fnv1a32(s: string): number {
  let h = FNV_OFFSET
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, FNV_PRIME)
  }
  return h >>> 0
}

/** Coerce any value to a stable u32 feature id. */
export function toU32Id(v: unknown): number {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 0x80000000) {
    return v
  }
  if (v === null || v === undefined) return 0
  return fnv1a32(String(v))
}

// ═══ Typed-array point patch → synthetic FeatureCollection ═══════════

import type { GeoJSONFeature, GeoJSONFeatureCollection } from '../loader/geojson'

/** Parallel typed-array point patch. See XGISMap.setSourcePoints. */
export interface PointPatch {
  lon: Float32Array | number[]
  lat: Float32Array | number[]
  ids?: Uint32Array | number[]
  properties?: Record<string, ArrayLike<unknown>>
}

/** Convert a PointPatch to a minimal GeoJSON FeatureCollection.
 *  Throws on length mismatch between lon/lat/ids/properties. */
export function pointPatchToFeatureCollection(data: PointPatch): GeoJSONFeatureCollection {
  const n = data.lon.length
  if (data.lat.length !== n) {
    throw new Error(`[X-GIS] setSourcePoints: lon/lat length mismatch (${n} vs ${data.lat.length})`)
  }
  if (data.ids && data.ids.length !== n) {
    throw new Error(`[X-GIS] setSourcePoints: ids length ${data.ids.length} != points ${n}`)
  }
  if (data.properties) {
    for (const k of Object.keys(data.properties)) {
      if (data.properties[k].length !== n) {
        throw new Error(`[X-GIS] setSourcePoints: property "${k}" length ${data.properties[k].length} != points ${n}`)
      }
    }
  }

  const features: GeoJSONFeature[] = new Array(n)
  const propKeys = data.properties ? Object.keys(data.properties) : []
  for (let i = 0; i < n; i++) {
    const props: Record<string, unknown> = {}
    for (const k of propKeys) {
      props[k] = data.properties![k][i]
    }
    features[i] = {
      type: 'Feature',
      id: data.ids ? data.ids[i] : i,
      geometry: { type: 'Point', coordinates: [data.lon[i], data.lat[i]] },
      properties: props,
    }
  }
  return { type: 'FeatureCollection', features }
}
