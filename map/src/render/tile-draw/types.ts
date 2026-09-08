// ═══ The types `renderTileKeys()`'s lifted blocks pass between themselves (#2508) ═══
//
// All three are DERIVED from the producer that mints the value, never restated.
// That is not style: #991's raw-WebGPU ratchet counts native `GPU*` tokens PER
// FILE, so writing `GPUBindGroup` here while the class still writes it too would
// be a spread rather than a move — the case #2537 kept `guardAndUnwrapPass` home
// over. Deriving costs no token at all, and each alias follows its seam when #991
// moves it to an RHI handle.

import type { VectorTileRenderer } from '../vector-tile-renderer'
import type { BindGroupRegistry } from '../bind-group-registry'
import type { UniformSplitBind } from '../uniform-split-bind'

/** The render pass (or bundle encoder) `renderTileKeys` was handed. */
export type TileDrawPass = Parameters<VectorTileRenderer['renderTileKeys']>[1]

/** The bind group a tile draw binds — whatever the registry's base group is. */
export type TileBindGroup = NonNullable<ReturnType<BindGroupRegistry['baseGroup']>>

/** #2042 INC-4c — the three-range split bind for ONE tile: the bind group plus
 *  the tile's and the show's byte offsets into the arena. Non-null only on the
 *  split-bind path; the legacy ring bind passes `null` and uses `slotOffset`. */
export interface TileSplitBind {
  bg: NonNullable<ReturnType<UniformSplitBind['bindGroup']>>
  tileOff: number
  showOff: number
}

/** The bind-group LAYOUT a fill draw is recorded against. */
export type TileBindGroupLayout = NonNullable<ReturnType<BindGroupRegistry['baseLayout']>>

/** What `packTileUniforms` reads that is fixed for the whole `renderTileKeys`
 *  call: the caller's projection centre, the layout and clip inputs, and the
 *  camera trig hoisted out of the tile loop. Built once per call; the per-TILE
 *  inputs stay explicit arguments. */
export interface TilePackCtx {
  readonly projCenterLon: number
  readonly projCenterLat: number
  readonly fillBindGroupLayout: TileBindGroupLayout
  readonly visibleKeysForClip: number[] | null
  readonly sliceLayer: string
  readonly R: number
  readonly camSin: number
  readonly camCos: number
  readonly camSinLon: number
  readonly camCosLon: number
}

/** What `packTileUniforms` PRODUCES for the tile's fill and stroke draws.
 *
 *  ONE instance per `renderTileKeys` call, reused across the tile loop rather
 *  than allocated per tile — the file's own idiom (`_strokeQueueTiles` and its
 *  two siblings are hoisted for exactly this reason) and this is the innermost
 *  draw dispatch. `renderTileKeys` never re-enters itself (see its docblock), so
 *  a single instance is sound. */
export interface TilePackOut {
  slotOffset: number
  currentTileBg: TileBindGroup | null
  splitBind: TileSplitBind | null
  /** Per CALL, not per tile: the #2042 INC-5 walk-skip latch — once one tile has
   *  packed and synced the show/frame lanes, every later arena-resident tile can
   *  skip the whole pack. */
  packedOnce: boolean
}
