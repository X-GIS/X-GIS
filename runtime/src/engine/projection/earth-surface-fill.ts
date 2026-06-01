// ═══ Earth-surface fill mesh (Phase 2 PR 2c-prep scaffolding) ═══
//
// Replacement-in-waiting for `BackgroundRenderer`. Phase 2 PR 2c will dispatch
// this mesh through the standard opaque tile pipeline at sort-order 0, so the
// style background colour appears INSIDE the projected world band and curves
// naturally on sphere projections (the ECEF vertices project through the same
// VS that polygon/line/point tiles do).
//
// This module ships the pure-TS geometry generator only. No shader inline yet
// — PR 2c is the first consumer.
//
// Design contract (locked by Phase 2 plan v4, AGENTS.md):
//   - Mesh density: minimum 32×16 lat/lon grid (16,2 + 32,1 = 528 verts).
//     4-corner quad is INSUFFICIENT — under the ECEF VS it stays planar.
//   - World-band geometry per projType (caller picks):
//       Mercator / equirect / oblique_mercator: ±180° × ±85.0511° rectangle
//       Natural Earth:                          NE polygon-band clip
//       Orthographic / Azimuthal_eq / Stereo /  ±180° × ±90° sphere band
//         Globe                                 (source-honest at the poles)
//   - clearValue contract preservation: opaque-pass keeps the iter-196
//     pure-black `{r:0,g:0,b:0,a:1}` clear. The earth-surface fill only
//     paints INSIDE the world band; outside falls through to black.
//
// The mesh is emitted as a flat lat/lon vertex array (degrees) — Phase 2 PR 2c
// will convert these to ECEF in the tiler or runtime decode path. Keeping the
// generator in lat/lon space here makes the world-band geometry trivially
// reviewable and re-usable for future EPSG:4326 / S2 schemes.

import { MERCATOR_LAT_LIMIT } from './projection'

// WorldBandKind + worldBandForProjType now live on the authority table
// (projections-table.ts) as the per-row `worldBand` data column — folding the
// former hand-encoded magic-int branches onto the single source of truth.
// Re-exported here to preserve this module's public surface for
// synthetic-earth-surface-backend.ts, map.ts, and the tests. Direction is
// table ← earth-surface-fill (acyclic: the table imports nothing).
export { worldBandForProjType, type WorldBandKind } from './projections-table'
import type { WorldBandKind } from './projections-table'

/** Lat/lon-grid mesh generator. Emits a triangulated lat/lon strip suitable
 *  for the standard opaque tile pipeline once Phase 2 PR 2c wires ECEF vertex
 *  attributes.
 *
 *  @param widthSegments  longitudinal grid segments (≥ 32 per Phase 2 spec)
 *  @param heightSegments latitudinal grid segments  (≥ 16 per Phase 2 spec)
 *  @param band           projType-keyed world-band geometry
 *
 *  Returns interleaved `[lon, lat]` vertex pairs + triangle indices. Vertex
 *  ordering is row-major: row y=0 is the SOUTH edge of the band; row
 *  y=heightSegments is the NORTH edge. */
export function generateEarthSurfaceFillMesh(
  widthSegments: number,
  heightSegments: number,
  band: WorldBandKind,
): { vertices: Float32Array; indices: Uint32Array } {
  if (widthSegments < 32 || heightSegments < 16) {
    throw new Error(
      `earth-surface-fill: density below the Phase 2 spec minimum 32x16 ` +
      `(got ${widthSegments}x${heightSegments}); sphere projections will ` +
      `under-tessellate and the bg quad will look planar`,
    )
  }
  const [latMin, latMax] = bandLatRange(band)
  const cols = widthSegments + 1
  const rows = heightSegments + 1
  const vertices = new Float32Array(cols * rows * 2)
  for (let y = 0; y < rows; y++) {
    const lat = latMin + ((latMax - latMin) * y) / heightSegments
    for (let x = 0; x < cols; x++) {
      const lon = -180 + (360 * x) / widthSegments
      const i = (y * cols + x) * 2
      vertices[i] = lon
      vertices[i + 1] = lat
    }
  }
  // Triangle indices. Two triangles per grid cell:
  //   (x, y) - (x+1, y) - (x, y+1)
  //   (x+1, y) - (x+1, y+1) - (x, y+1)
  const indices = new Uint32Array(widthSegments * heightSegments * 6)
  let off = 0
  for (let y = 0; y < heightSegments; y++) {
    for (let x = 0; x < widthSegments; x++) {
      const a = y * cols + x
      const b = a + 1
      const c = a + cols
      const d = c + 1
      indices[off++] = a
      indices[off++] = b
      indices[off++] = c
      indices[off++] = b
      indices[off++] = d
      indices[off++] = c
    }
  }
  return { vertices, indices }
}

function bandLatRange(band: WorldBandKind): [number, number] {
  switch (band) {
    case 'mercator-clamped':
      return [-MERCATOR_LAT_LIMIT, MERCATOR_LAT_LIMIT]
    case 'sphere-full':
      // Source-honest at the poles. Phase 2 plan accepts a degenerate sliver
      // at lat=±90 where all longitudes collapse to a single ECEF point;
      // the ECEF VS handles the convergence without artifacts.
      return [-90, 90]
    case 'natural-earth':
      // NE's valid latitude extent is ±90 but the projection clips a small
      // band near the poles. PR 2c's oval-clip work decides the exact value;
      // for the scaffolding generator we ship the full ±90 band and let the
      // VS / clip mask handle the oval boundary.
      return [-90, 90]
  }
}
