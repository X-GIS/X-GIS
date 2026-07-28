// ═══ Host-pushed source data — shape normalise + validate ═══
//
// The input-contract half of `SourceManager.setSourceData`, extracted verbatim
// (no `this`, no side effects but the throws it already had). What is left in
// setSourceData is its actual job: choosing between the virtual-PMTiles re-seed
// and the raw `rawDatasets` write. What lives here is the guard that decides
// whether the caller handed us something we can store at all — and it is now
// assertable without constructing a SourceManager.

import { assertIngestBudget } from '@xgis/shared'
import type { GeoJSONFeatureCollection, GeoJSONFeature, GeoJSONGeometry } from '@xgis/data'

/** Normalise whatever a host passed to `setSourceData` into a validated
 *  FeatureCollection, or throw with a caller-attributable message.
 *  `sourceId` is used only to attribute the ingest-budget rejection. */
export function normaliseHostPushedData(
  sourceId: string,
  data: GeoJSONFeatureCollection | GeoJSONFeature | GeoJSONGeometry,
): GeoJSONFeatureCollection {
  // Validate FeatureCollection shape. Pre-fix a host passing
  // `null` / `[]` / a Feature / a Geometry directly polluted the
  // rawDatasets entry and crashed rebuildLayers on .features
  // access. Normalise to a safe FeatureCollection rather than
  // storing whatever the caller passed verbatim.
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`[X-GIS] setSourceData: data must be a FeatureCollection object`)
  }
  // Auto-promote a single Feature → FeatureCollection (Mapbox API
  // accepts both; was previously a confusing throw). Same lift the
  // compiler-side normaliseInlineGeoJSON does for inline source.data.
  // Also accept a bare Geometry (`{ type: 'Point', coordinates: … }`)
  // by wrapping it in a Feature inside a FeatureCollection.
  // The typed union narrows directly: `data.type === 'Feature'` and the
  // `'coordinates' in data` presence check discriminate the three arms with
  // no cast. A GeometryCollection (no `coordinates`) falls to the FC arm and
  // is rejected by the features-array guard below, matching the prior path.
  let normalized: GeoJSONFeatureCollection
  if (data.type === 'Feature') {
    normalized = { type: 'FeatureCollection', features: [data] }
  } else if ('coordinates' in data) {
    // Bare Geometry (Point / LineString / Polygon / Multi*).
    normalized = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: data, properties: {} }],
    }
  } else {
    normalized = data as GeoJSONFeatureCollection
  }
  if (!Array.isArray((normalized as { features?: unknown }).features)) {
    throw new Error(
      `[X-GIS] setSourceData: data.features must be an array (got ${typeof (normalized as { features?: unknown }).features})`,
    )
  }
  // DoS guard: refuse a pathological host-pushed collection before it
  // is reprojected / retiled / uploaded (unbounded feature/vertex OOM).
  assertIngestBudget(
    (normalized as { features?: unknown }).features,
    `setSourceData("${sourceId}")`,
  )
  return normalized
}
