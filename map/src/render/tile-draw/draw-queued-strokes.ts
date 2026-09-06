import type { VectorTileRenderer } from '../vector-tile-renderer'
import type { GPUTile } from '../vector-tile-renderer-types'
import type { ShaderVariantInfo } from '../renderer-types'
import type { TileDrawPass } from './types'

/** #2508 step 3 — the deferred stroke pass: every stroke draw queued by the
 *  per-tile loop, emitted once the layer's fills have all written depth.
 *  A pure consumer of the queue — writes no state the caller reads back. */
export function drawQueuedStrokes(
  vtr: VectorTileRenderer,
  pass: TileDrawPass,
  strokeQueueTiles: readonly GPUTile[],
  strokeQueueSlots: readonly number[],
  strokeQueueTileOff: readonly number[],
  lineLayerOffset: number,
  lineLayerOffsetGap: number,
  lineVariant: ShaderVariantInfo | null | undefined,
  sliceLayer: string,
  translucentLines: boolean,
): void {
  // Second pass: emit every queued stroke draw now that all fills
  // for this layer have written depth. Outline + line-feature
  // drawSegments calls run against the layer's complete depth
  // buffer; with DEPTH_READ_ONLY they don't disturb later layers'
  // depth tests, but their occlusion against THIS layer's own
  // 3D geometry is now correct regardless of tile iteration order.
  if (strokeQueueTiles.length > 0 && vtr.lineRenderer && !vtr._skipStrokeDrawForBundle) {
    // `_skipStrokeDrawForBundle` gates these two drawSegments call sites.
    // When set true by the bundle replay path, both calls are skipped —
    // the cached bundle's executeBundles already replays the stroke
    // draws. strokeQueue side effects (push from per-tile loop) remain
    // populated for any non-bundle path or stats.
    const currentLineTileBg2 = vtr._bindGroups.baseGroup()!
    // #2042 INC-4c — one split resolve per stroke emit: the show/frame
    // CONTENT is already frame-stamped (syncs are idempotent per frame);
    // this re-derives the show offset + the three-range bind group for the
    // deferred pass. Translucent (MAX-blend) and pattern strokes keep the
    // legacy bind — the split layout carries no sprite bindings and the
    // max material never split-routes.
    let strokeSplitBg: GPUBindGroup | null = null
    let strokeSplitShowOff = 0
    if (
      vtr._fillRhi?.split &&
      vtr._splitBind &&
      sliceLayer !== '' &&
      !translucentLines &&
      !vtr._linePatternActiveForShow
    ) {
      strokeSplitShowOff = vtr._splitBind.syncShow(
        vtr.frameBlock.buffer,
        sliceLayer,
        vtr.currentPickId & 0xffff,
        vtr.currentFrameId,
      )
      vtr._splitBind.syncFrame(vtr.frameBlock.buffer, vtr.currentFrameId)
      strokeSplitBg = vtr._splitBind.bindGroup()
    }
    // line-gap-width double-draw: when the second offset slot was
    // written, iterate the strokeQueue with each offset. Single-line
    // (default) draws once. The second pass uses the SAME segment
    // data — only the layer-slot uniform's offset_m differs.
    const offsets = vtr._strokeOffsetsScratch
    offsets.length = 0
    offsets.push(lineLayerOffset)
    if (lineLayerOffsetGap >= 0) offsets.push(lineLayerOffsetGap)
    for (const lo of offsets) {
      for (let i = 0; i < strokeQueueTiles.length; i++) {
        const cached = strokeQueueTiles[i]!
        const slotOffset = strokeQueueSlots[i]!
        const sTileOff = strokeQueueTileOff[i]!
        const strokeSplit =
          strokeSplitBg && sTileOff >= 0 ? { tileOff: sTileOff, showOff: strokeSplitShowOff } : null
        const strokeTileBg = strokeSplit ? strokeSplitBg! : currentLineTileBg2
        if (cached.outlineSegmentCount > 0 && cached.outlineSegmentBindGroup) {
          vtr.lineRenderer.drawSegments(
            pass,
            strokeTileBg,
            cached.outlineSegmentBindGroup,
            cached.outlineSegmentCount,
            slotOffset,
            lo,
            translucentLines,
            vtr._linePatternActiveForShow,
            lineVariant,
            strokeSplit,
          )
        }
        if (cached.lineSegmentCount > 0 && cached.lineSegmentBindGroup) {
          vtr.lineRenderer.drawSegments(
            pass,
            strokeTileBg,
            cached.lineSegmentBindGroup,
            cached.lineSegmentCount,
            slotOffset,
            lo,
            translucentLines,
            vtr._linePatternActiveForShow,
            lineVariant,
            strokeSplit,
          )
        }
      }
    }
  }
}
