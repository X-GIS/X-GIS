// Polar cap synthesizer for PMTiles / TileJSON sources.
//
// Background: WGS84 / GeoJSON sources can contain polygon rings that
// reach ±90° latitude (e.g. Antarctica), but the Web Mercator tile
// pyramid clamps geometry at ±MERCATOR_LAT_LIMIT (~85.0511°). For
// projections that DO render the poles (globe, orthographic,
// azimuthal, stereographic, equirectangular, natural_earth), the
// missing ±5° band leaves a circular hole at each pole.
//
// loader/polar-cap-detect.ts handles GeoJSON inputs by walking
// existing polygons that touch the clamp boundary and stitching a
// cap ring. That works for raw GeoJSON because the original
// coordinates are still on the boundary post-clamp. PMTiles /
// TileJSON sources, however, deliver pre-tiled MVT geometry: by the
// time the runtime sees it, polygons have already been clipped to
// tile bounds and the polar tile (z=N, y=0 or y=2^N-1) has nothing
// to anchor a cap to.
//
// Approach in this module: synthesise FALLBACK cap polygons as a
// standalone GeoJSON FeatureCollection that the host attaches as a
// separate source. The polygons are simple ring-of-the-pole shapes
// approximating "everything north of latN" / "everything south of
// latS", segmented in longitude so the renderer's per-vertex
// projection produces smooth curves on globe / stereographic. The
// host styles them with the basemap's ocean / land colour and they
// fill the visible hole.
//
// Excluded projections: Mercator and Oblique Mercator — both blow
// up at ±90° (Mercator goes to infinity, oblique inherits the same
// pole singularity rotated). Their tile pyramids are spec-correct
// at ±85.05° clamp; no synthesis needed.

export interface PolarCapOptions {
  /** Latitude at which the cap starts. Defaults to MERCATOR_LAT_LIMIT
   *  (85.0511°) which is the maximum latitude in the Mercator tile
   *  pyramid. Above this latitude is the "hole" the cap fills. */
  latThreshold?: number
  /** Number of longitude segments around the pole. More = smoother
   *  curve on globe / azimuthal projections, more vertices. */
  lonSegments?: number
  /** Which poles to synthesise. Default: both. */
  poles?: 'both' | 'north' | 'south'
  /** Property key set on each emitted feature. Useful for the host
   *  to filter / style cap features distinctly. */
  featureProperty?: Record<string, unknown>
}

const MERCATOR_LAT_LIMIT = 85.0511287798066

interface PolygonGeometry {
  type: 'Polygon'
  coordinates: [number, number][][]
}
interface Feature {
  type: 'Feature'
  geometry: PolygonGeometry
  properties: Record<string, unknown>
  id?: string | number
}
export interface PolarCapFeatureCollection {
  type: 'FeatureCollection'
  features: Feature[]
}

/** Build a polygon ring covering "everything north of latThreshold"
 *  or "everything south of -latThreshold" (sign of `pole`). The
 *  ring is segmented in longitude so per-vertex spherical projection
 *  produces a smooth curve. The pole vertex itself is NOT included
 *  (degenerate point at ±90° causes triangle-fan singularities in
 *  the tessellator); instead the ring runs at latThreshold all the
 *  way around then steps up to lat * 0.999 toward the pole to give
 *  the GPU vertex projector something well-defined. */
function buildCapRing(
  pole: 1 | -1,
  latThreshold: number,
  lonSegments: number,
): [number, number][] {
  const targetLat = pole === 1 ? latThreshold : -latThreshold
  const innerLat = pole === 1 ? 89.999 : -89.999
  const ring: [number, number][] = []
  // Outer perimeter at latThreshold from -180 → +180.
  for (let i = 0; i <= lonSegments; i++) {
    const lon = -180 + (360 * i) / lonSegments
    ring.push([lon, targetLat])
  }
  // Inner perimeter at innerLat from +180 → -180 (reverse winding so
  // the polygon is a thin annulus rather than a self-intersecting
  // bow-tie; tessellator can handle this as a single ring because
  // the inner vertices are all very close to the pole).
  for (let i = lonSegments; i >= 0; i--) {
    const lon = -180 + (360 * i) / lonSegments
    ring.push([lon, innerLat])
  }
  // Close the ring.
  ring.push([ring[0]![0], ring[0]![1]])
  return ring
}

/** Synthesize polar cap polygons as a standalone GeoJSON
 *  FeatureCollection. The host attaches the result as a new source
 *  with a fill layer using the appropriate ocean / land colour. */
export function synthesizePolarCaps(opts: PolarCapOptions = {}): PolarCapFeatureCollection {
  const latThreshold = opts.latThreshold ?? MERCATOR_LAT_LIMIT
  const lonSegments = Math.max(8, Math.floor(opts.lonSegments ?? 36))
  const poles = opts.poles ?? 'both'
  const baseProps = opts.featureProperty ?? {}

  const features: Feature[] = []
  if (poles === 'both' || poles === 'north') {
    features.push({
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [buildCapRing(1, latThreshold, lonSegments)],
      },
      properties: { ...baseProps, pole: 'north' },
      id: '__xgis_polar_cap_north__',
    })
  }
  if (poles === 'both' || poles === 'south') {
    features.push({
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [buildCapRing(-1, latThreshold, lonSegments)],
      },
      properties: { ...baseProps, pole: 'south' },
      id: '__xgis_polar_cap_south__',
    })
  }
  return { type: 'FeatureCollection', features }
}

/** Projection name → whether polar cap synthesis is meaningful.
 *  Mercator and Oblique Mercator blow up at ±90° so the spec
 *  intentionally excludes the polar region; synthesis would either
 *  produce infinite-coordinate vertices or rotated-frame artefacts.
 *  Globe and all azimuthal / pseudocylindrical projections benefit. */
export function projectionNeedsPolarCaps(projectionName: string): boolean {
  switch (projectionName) {
    case 'mercator':
    case 'oblique_mercator':
    case 'obliqueMercator':
      return false
    case 'globe':
    case 'orthographic':
    case 'azimuthal_equidistant':
    case 'stereographic':
    case 'equirectangular':
    case 'natural_earth':
      return true
    default:
      return false
  }
}
