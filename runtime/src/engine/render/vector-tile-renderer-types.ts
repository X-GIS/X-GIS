// ═══ Vector Tile Renderer — Types ═══
// Top-level type/interface declarations extracted verbatim from
// vector-tile-renderer.ts. Behaviour-preserving structural split only;
// no logic or symbol renames. `LayerDrawPhase` remains part of the
// public surface and is re-exported from vector-tile-renderer.ts.

import type { RhiBindGroup } from './rhi/rhi'

/** Layer draw phase — replaces the prior `translucentLines: boolean` flag.
 *  'all' draws fill + stroke in one pass (opaque default).
 *  'fills'/'strokes' split across a main pass and an offscreen MAX-blend
 *  pass so translucent strokes don't accumulate alpha across overlapping
 *  geometry. 'fills' + 'strokes' together == 'all'. */
export type LayerDrawPhase = 'all' | 'fills' | 'strokes' | 'oit-fill'

export interface GPUTile {
  vertexBuffer: GPUBuffer
  /** Phase 6a.2 (iter-208) — polygon vertex byte offset into
   *  `vertexBuffer`. Pre-Phase-6 `vertexBuffer` was a per-tile
   *  `acquireBuffer` slice (offset always 0); starting Phase 6a.2
   *  `vertexBuffer` points at the shared `polyVertexArena.buffer`
   *  and this field carries the per-tile offset for
   *  `pass.setVertexBuffer(0, vertexBuffer, polyVertexOffset, polyVertexByteLength)`.
   *  Eviction calls `polyVertexArena.free(polyVertexOffset,
   *  polyVertexByteLength)` instead of `releaseBuffer(vertexBuffer)`. */
  polyVertexOffset: number
  /** Phase 6a.2 — aligned byte length of the polygon vertex slice.
   *  Together with `polyVertexOffset` defines the arena sub-range. */
  polyVertexByteLength: number
  indexBuffer: GPUBuffer
  /** Phase 6a.3 (iter-209) — polygon index byte offset into
   *  `indexBuffer`. Mirror of `polyVertexOffset` for the index
   *  arena. `pass.setIndexBuffer(indexBuffer, 'uint32',
   *  polyIndexOffset, polyIndexByteLength)`. */
  polyIndexOffset: number
  /** Phase 6a.3 — aligned byte length of polygon index slice. */
  polyIndexByteLength: number
  indexCount: number
  /** Per-vertex z (world metres) for extruded polygons. When non-null,
   *  the fill path binds the `*Extruded` pipeline and feeds this as
   *  vertex buffer slot 1; vertex bit 15 of x is unused on this code
   *  path (z carries the bottom-vs-top distinction directly). Null on
   *  flat polygon tiles. */
  zBuffer: GPUBuffer | null
  /** Phase 6a.4 (iter-210) — z-buffer byte offset into the shared
   *  z-arena. 0 when `zBuffer` is null (no extruded data). */
  zBufferOffset: number
  /** Phase 6a.4 — aligned byte length of z-buffer slice. */
  zBufferByteLength: number
  /** Whether THIS slice carries per-feature extruded geometry (walls + roof
   *  in the unified stride-14 buffer from `generateWallMeshExtrudedECEF`).
   *  Post-Phase-2-PR-2c.2 the parallel `zBuffer` was retired to an always-null
   *  sentinel, so the draw path must read THIS flag (not `zBuffer != null`) to
   *  pick the extruded pipeline / skip a heightless fallback slice. */
  extruded: boolean
  lineVertexBuffer: GPUBuffer | null
  lineIndexBuffer: GPUBuffer | null
  lineIndexCount: number
  outlineIndexBuffer: GPUBuffer | null
  outlineIndexCount: number
  // SDF line segment buffers for polygon outlines and line features
  outlineSegmentBuffer: GPUBuffer | null
  outlineSegmentCount: number
  // §4 seam: the layer bind group is built via the RHI (LineRenderer.create-
  // LayerBindGroup) → RhiBindGroup. The segment BUFFER above stays a raw
  // GPUBuffer (owned + destroyed by GpuTileStore's retire queue — flips with
  // the VTR/GPUArena cluster).
  outlineSegmentBindGroup: RhiBindGroup | null
  lineSegmentBuffer: GPUBuffer | null
  lineSegmentCount: number
  lineSegmentBindGroup: RhiBindGroup | null
  tileWest: number
  tileSouth: number
  tileWidth: number
  tileHeight: number
  tileZoom: number
  /** PR 2f per-tile quantized-position dequant step (metres) =
   *  `2*dequantHalf/0xFFFFFFFF`. Written into the per-tile uniform's
   *  `tile_dequant_scale`; the polygon VS decodes each ECEF RTC axis as
   *  `q = f32(hi)*65536 + f32(lo); axis = q*scale - half`. */
  dequantScale: number
  /** PR 2f per-tile symmetric residual half-range (metres). Written into
   *  the per-tile uniform's `tile_dequant_half`. */
  dequantHalf: number
  lastUsedFrame: number
  /** Timestamp (performance.now) at upload. Available for diagnostics
   *  and future tile-fade implementations. */
  uploadTimeMs: number
  /** Per-tile feat_data buffer for MVT/PMTiles data-driven paint
   *  expressions (e.g. OFM Bright landuse `class` match). Each tile's
   *  featId space is local; the polygon vertex stride-8 `f32 fid`
   *  indexes into this buffer's `featureCount × fieldCount` floats.
   *  Built from `data.featureProps` when the renderer has captured a
   *  variant requiring feature data (`latestVariantFields.length > 0`).
   *  Null for tiles without per-feature data (GeoJSON path, or MVT
   *  slices whose consumer shows don't author data-driven paint). */
  featureDataBuffer: GPUBuffer | null
  /** Bind group pairing this tile's `featureDataBuffer` with the shared
   *  `uniformRing`. Used in place of the source-level `tileBgFeature`
   *  when present. Null when `featureDataBuffer` is null. */
  featureBindGroup: GPUBindGroup | null
  /** iter-226 — Strictly-monotonic per-tile upload counter, stamped
   *  by `doUploadTile` / `doUploadTileAsync` from a VTR-wide counter
   *  (`_tileUploadEpoch`). Used as the per-tile component of the
   *  RenderBundle cache key: when a tile is re-uploaded (same key,
   *  new `featureBindGroup` ref), its epoch bumps and any cached
   *  bundle that referenced this tile must re-encode. Strictly more
   *  precise than the iter-220 `_gpuCacheCount` signal, which
   *  changed on every upload/eviction anywhere in the cache (over-
   *  invalidates). */
  uploadEpoch: number
}
