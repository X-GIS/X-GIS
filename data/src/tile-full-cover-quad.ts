// ═══ Full-cover tile quad — geometry ═══
//
// The pure geometry half of TileCatalog.createFullCoverTileData, extracted
// verbatim (no `this`, no module-mutable state, no side effects). What is left
// behind in the catalog is the cache write; what lives here is the quantized-
// ECEF quad construction — the part with the bug history (#449: a stride-5
// tile-local DSFUN quad the fill VS mis-decoded; then a missing tileOriginMerc
// that made the flat fill VS double-count the origin). Isolating it makes that
// layout directly assertable without a catalog + backend.

import {
  tileKeyUnpack,
  lonLatToMercF64,
  packECEFPolygonVertices,
  tileEcefCenterFromMerc,
} from '@xgis/compiler'

/** A synthesised full-cover quad, in the shape `cacheTileData` consumes. */
export interface FullCoverQuad {
  /** POLYGON_FILL_FORMAT vertices (stride 28 B / 7 floats). */
  vertices: Float32Array
  indices: Uint32Array
  dequant: { scale: number; half: number }
}

/** Build the quad that stands in for a tile the tiler marked full-cover
 *  (`TILE_FLAG_FULL_COVER`, no compact payload): four corners at the tile's
 *  own lon/lat bounds, all carrying `fullCoverFeatureId`. */
export function buildFullCoverQuad(key: number, fullCoverFeatureId: number): FullCoverQuad {
  const [tz, tx, ty] = tileKeyUnpack(key)
  const tn = Math.pow(2, tz)
  const tileWest = (tx / tn) * 360 - 180
  const tileEast = ((tx + 1) / tn) * 360 - 180
  const tileSouth = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (ty + 1)) / tn))) * 180) / Math.PI
  const tileNorth = (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / tn))) * 180) / Math.PI
  const fid = fullCoverFeatureId

  // Quantized-ECEF quad (POLYGON_FILL_FORMAT, stride 28 B) spanning the tile,
  // input as ABSOLUTE Mercator metres — the SAME layout the fill pipeline
  // binds and the fill VS decodes. Built via the canonical packer + anchor the
  // tiler uses (vector-tiler.ts). Earlier this emitted a stride-5 tile-local
  // DSFUN quad with no f32 tail, so the fill VS mis-decoded position and the
  // per-fragment clip_bounds discard was inert (over-zoom flood).
  const [swMx, swMy] = lonLatToMercF64(tileWest, tileSouth)
  const [seMx, seMy] = lonLatToMercF64(tileEast, tileSouth)
  const [neMx, neMy] = lonLatToMercF64(tileEast, tileNorth)
  const [nwMx, nwMy] = lonLatToMercF64(tileWest, tileNorth)

  const scratchPv = [
    swMx,
    swMy,
    fid, // corner 0 (SW)
    seMx,
    seMy,
    fid, // corner 1 (SE)
    neMx,
    neMy,
    fid, // corner 2 (NE)
    nwMx,
    nwMy,
    fid, // corner 3 (NW)
  ]
  // tileOriginMerc = [merc(tileWest), merc(tileSouth)] = [swMx, swMy] — MUST
  // match the renderer's per-tile `tile_origin_merc` uniform. The packer
  // stores the f32 tail as TILE-LOCAL Mercator (mx − tileOriginMerc); omitting
  // this arg defaulted it to [0,0], so the tail held ABSOLUTE Mercator and the
  // flat fill VS double-counted the origin → the full-cover quad rendered at
  // the wrong place (pure-ocean tiles showed the background color, #449).
  const quant = packECEFPolygonVertices(scratchPv, tileEcefCenterFromMerc(swMx, swMy), [swMx, swMy])

  return {
    vertices: quant.vertices,
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    dequant: { scale: quant.dequantScale, half: quant.dequantHalf },
  }
}
