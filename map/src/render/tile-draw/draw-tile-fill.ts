import type { VectorTileRenderer } from '../vector-tile-renderer'
import type { GPUTile } from '../vector-tile-renderer-types'
import type { RhiPipelineHandle } from '@xgis/engine'
import type { TileBindGroup, TileDrawPass, TileSplitBind } from './types'
import { isOverdrawActive } from '../../debug-flags'

/** #2508 step 3 — one tile's polygon fill draw.
 *
 *  Reads the slot the pack step produced and emits the draw; the only state it
 *  writes is the stroke queue, which the deferred stroke pass drains later.
 *
 *  `drawFills` is per CALL, not per tile, so a caller could hoist the guard out
 *  of the loop. It stays inside deliberately: the body is byte-preserved from the
 *  class so the token-identity witness can compare it, and the cost of not
 *  hoisting is one call per tile that returns immediately.
 *
 *  **Returns `true` when the caller must abandon the rest of this tile's
 *  iteration** (`continue`). That was a bare `continue` inside the loop before
 *  the lift — the extraction is what forced it to be stated: an extruded or OIT
 *  fill with no extruded pipeline queues its strokes here and then skips both the
 *  fill draw and the tile's `markDrawn` fold, so the tile stays un-marked and a
 *  later dispatch may still draw it. */
export function drawTileFill(
  vtr: VectorTileRenderer,
  pass: TileDrawPass,
  cached: GPUTile,
  key: number,
  slotOffset: number,
  currentTileBg: TileBindGroup | null,
  splitBind: TileSplitBind | null,
  fillPipeline: RhiPipelineHandle,
  fillPipelineExtruded: RhiPipelineHandle | null,
  drawFills: boolean,
  drawStrokes: boolean,
  isOitFill: boolean,
  strokeQueueTiles: GPUTile[],
  strokeQueueSlots: number[],
  strokeQueueTileOff: number[],
): boolean {
  // Polygon fills — skipped in 'strokes' phase (offscreen line-only RT).
  // ALSO skipped when render() flagged this layer as having an
  // effectively-invisible fill (no shader variant + zero alpha). Common
  // case: multi_layer's `borders | stroke-* opacity-80` gets routed
  // into the opaque bucket as fillPhase='fills' but declared no fill —
  // the fragment shader was rasterising every covered pixel just to
  // write α=0. Skipping the whole draw saves ~2-3 ms of GPU per frame
  // on multi_layer-class scenes. Data-driven `fill match(...)` is NOT
  // skipped (variant pipeline computes color in shader, cached uniform
  // alpha may be zero even when the draw is meaningful).
  if (drawFills && cached.indexCount > 0 && !vtr._skipFillDraw) {
    // Pipeline selection — two paths, one of them phase-split:
    //  * per-feature extrude: vs_main_ecef_extruded + the slice zBuffer. In
    //    the 'oit-fill' phase the SAME pipeline draws into the shell pass's
    //    offscreen target, through the Material's shell variants (#1253);
    //    every other phase is the opaque / #1080 front-shell draw.
    //  * uniform / ground: the pre-selected `fillPipeline`.
    // 'oit-fill' no longer selects the weighted-blended OIT MRT pipeline —
    // the shell pass has ONE colour attachment, not the accum/revealage
    // pair — but `extrudedOITPipeline` stays wired (setOITPipeline) as the
    // opt-in volumetric alternative.
    const wantsExtrude = vtr.currentExtrudeMode === 'per-feature' && fillPipelineExtruded !== null
    const useExtrudedPipe = wantsExtrude && cached.extruded
    // DIAG: log per-tile drawIndexed for the current trace if armed.
    // Granular enough to verify the cross-tile order claim
    // ("all tiles' 2D before any 3D") rather than just per-show
    // sequencing. Pipeline decision is computed below — if the
    // trace is armed we record the routing here for diagnosis.
    if (typeof window !== 'undefined') {
      const trace = (
        window as unknown as {
          __xgisDrawOrderTrace?: Array<{
            seq: number
            slice: string
            phase: string
            extrude: string
            tileKey?: number
            isFill?: boolean
            pipelineRoute?: 'oit' | 'extrude' | 'fill' | 'skip'
            hasZBuffer?: boolean
          }>
        }
      ).__xgisDrawOrderTrace
      if (trace) {
        // Pipeline route is determined a few lines below — but the
        // logic is mirrored here so we can record it before
        // dispatch. Skip path: the shell phase reached a tile with no
        // extruded slice, or a non-extruding show.
        const willSkip = (isOitFill || wantsExtrude) && !useExtrudedPipe
        const route: 'oit' | 'extrude' | 'fill' | 'skip' = willSkip
          ? 'skip'
          : useExtrudedPipe
            ? isOitFill
              ? 'oit'
              : 'extrude'
            : 'fill'
        trace.push({
          seq: trace.length,
          slice: vtr._drawStats.traceSlice() ?? '?',
          phase: vtr._drawStats.tracePhase() ?? '?',
          extrude: vtr.currentExtrudeMode === 'none' ? 'none' : 'feature',
          tileKey: key,
          isFill: true,
          pipelineRoute: route,
          hasZBuffer: cached.extruded,
        })
      }
    }
    // Extrude skip rule: when the show declares per-feature extrude but
    // THIS tile's slice was compiled without a zBuffer (e.g., a fallback
    // parent slice uploaded before the extrude show wired its per-feature
    // heights, or a parent tile whose worker compile predated the
    // per-feature config), falling through to `fillPipeline` would
    // render the polygons FLAT at z=0 — producing the user-visible
    // "tile-boundary building height mismatch" bug where a child
    // tile's 3D building meets a flat-projected fallback polygon.
    // The flat polygon depth-tests against the 3D one and wins or
    // loses unpredictably depending on pitch / camera angle. Skip
    // instead: showing no fallback building briefly is far less
    // visually broken than showing a flat one. Strokes still draw.
    //
    // #1253 — the SHELL phase ('oit-fill') answers to the same rule for a
    // harder reason: its pass carries the offscreen shell colour target,
    // which ONLY the extruded Material's shell variants are built for.
    // Falling through to `fillPipeline` there would attach a main-target
    // pipeline to the shell pass and trip "Attachment state of
    // RenderPipeline is not compatible with RenderPassEncoder" at submit,
    // so a shell-phase tile that cannot take the extruded path is skipped
    // outright. Visual cost: a translucent building's loading frames may
    // show no fallback ancestor until the primary tile arrives.
    if ((isOitFill || wantsExtrude) && !useExtrudedPipe) {
      // strokes for this tile still queue below (never in the shell phase,
      // where drawStrokes is false) — only the fill is being skipped here.
      if (drawStrokes) {
        strokeQueueTiles.push(cached)
        strokeQueueSlots.push(slotOffset)
        strokeQueueTileOff.push(splitBind ? splitBind.tileOff : -1)
      }
      return true
    }
    // Debug=overdraw: collapse the extruded path onto the
    // single overdraw pipeline supplied as `fillPipeline`. The
    // extruded variant targets its own format which
    // doesn't match the r16float accumulator attached to this pass.
    // (The shell phase never runs under overdraw — the pass is gated off
    // and the bucket scheduler keeps those fills in the opaque bucket.)
    const activePipe = isOverdrawActive(vtr.rhi.caps)
      ? fillPipeline
      : useExtrudedPipe
        ? fillPipelineExtruded!
        : fillPipeline
    // Bundle-compatible draw recording extracted to `recordTileFill`.
    // (The split-bind resolve happens once at tile-loop scope above —
    // extrude draws pass it through and recordFillDraw's !bindZBuffer
    // guard keeps them on the legacy bind.)
    // The 6 GPU commands below (setPipeline, setBindGroup,
    // setVertexBuffer ×1-2, setIndexBuffer, drawIndexed) are the EXACT
    // subset that GPURenderBundleEncoder accepts. Encapsulating them
    // lets the caller route through a bundle encoder without re-tracing
    // the conditionals.
    // Skip if feature bg not ready — never bind null (see note above).
    if (currentTileBg) {
      vtr.recordTileFill(
        pass,
        activePipe,
        currentTileBg,
        slotOffset,
        cached,
        /* bindZBuffer */ useExtrudedPipe,
        // #1080 — front-shell two-draw only for the solid per-feature extrude
        // draw (exclude the shell phase + debug-overdraw; recordFillDraw
        // no-ops otherwise). #1253 — in the shell phase the LAYER-WIDE form
        // replaces it: one shell draw here, one composite in the pass.
        /* translucentFrontShell */ useExtrudedPipe &&
          !isOitFill &&
          !isOverdrawActive(vtr.rhi.caps) &&
          vtr._extrudeTranslucentFrontShell,
        /* extrudeShell */ isOitFill && useExtrudedPipe,
        splitBind,
      )
    }
  }
  return false
}
