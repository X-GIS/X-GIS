// ═══ Bucket 1: opaque pass ═══
//
// Relocated VERBATIM from RenderLoop.render's opaque bucket loop. Emits
// one or more same-source sub-passes: the first clears the colour target
// and owns the raster + canvas-2D background + legacy MapRenderer draws;
// each sub-pass renders its group's vector-tile shows in two phases (2D
// ground fills, then 3D extruded fills) so cross-tile depth ordering is
// correct at high pitch regardless of declaration order. Depth persists
// across sub-passes (and into OIT / points) so later groups occlude
// against earlier ones.
//
// Mechanical changes only: `this.host.X` → `host.X`, `encoder` →
// `ctx.encoder`. All loop-local state stays inside execute(); behaviour is
// byte-identical to the inline block.

import { DEBUG_OVERDRAW } from '../../debug-flags'
import { isPickEnabled } from '../../gpu/gpu'
import { resolveNumberShape } from '../paint-shape-resolve'
import type { FrameContext } from '../frame-context'
import type { SceneView } from '../scene-view'
import type { RenderPass, OpaquePassHost } from './pass'

class OpaquePass implements RenderPass {
  readonly label = 'opaque'

  // Always emits at least the synthetic first sub-pass (raster + canvas
  // background + screen clear), even with no opaque vector layers.
  shouldRun(): boolean { return true }

  execute(ctx: FrameContext, scene: SceneView, host: OpaquePassHost): void {
    const encoder = ctx.encoder
    // ── Bucket 1: opaque ──
    // Always emit at least one pass so raster + canvas background
    // can run even if there are no vector layers to draw. The first
    // pass clears the color target; subsequent opaque sub-passes
    // load.
    const opaqueCount = Math.max(1, scene.opaqueGroups.length)
    for (let gi = 0; gi < opaqueCount; gi++) {
      const group = scene.opaqueGroups[gi]
      const isFirst = gi === 0
      const isLastOpaque = gi === opaqueCount - 1
      // Only the LAST opaque sub-pass can claim resolveTarget, and
      // only if no translucent/points pass runs after it.
      const resolveHere =
        ctx.useResolve && isLastOpaque && scene.resolveOwner === 'opaque'
      // Depth must persist across opaque sub-passes so group N's
      // polygons are correctly occluded by group N-1's (e.g. roads
      // rendered after buildings must respect building depth in a
      // pitched / globe view), and across into the points bucket for
      // the same reason. Only the final consumer can discard. Tile-
      // based mobile GPUs pay a write-back when we store, but the
      // result was visibly wrong without it.
      // OIT pass needs the opaque depth to occlude translucent
      // fragments behind opaque foreground walls; bucket 3 (points)
      // also reads it. Either consumer requires the LAST opaque
      // sub-pass to STORE depth instead of discarding.
      const persistDepth = !isLastOpaque || scene.hasPoints || scene.hasOit

      ctx.passScope(isFirst ? 'opaque-main' : `opaque[${gi}]`, () => {
        // Time EVERY opaque sub-pass. The timer pre-allocates a
        // QuerySet wide enough for MAX_SUBPASSES sub-passes, with
        // sub-pass 0 carrying the inside-passes breakdown (bg/raster/
        // legacy/vt) and sub-passes 1..N each contributing one
        // (begin..end) duration that aggregates into the `vt` ring.
        // Demos like osm_style split opaque rendering across multiple
        // groups; single-pass timing missed everything past the first.
        const tsWrites = host.gpuTimer?.passWrites() || undefined
        // Build color attachments. When picking is enabled, add a
        // second RG32Uint attachment at location 1 — every pipeline
        // in the main passes has a matching second fragment output
        // that writes `vec2<u32>(feature_id, instance_id)`. The first
        // sub-pass clears the pick texture to (0, 0) = "no feature";
        // subsequent sub-passes load so earlier-group IDs persist
        // where later groups didn't draw.
        const colorAttachments: GPURenderPassColorAttachment[] = [{
          view: ctx.colorView,
          resolveTarget: resolveHere ? ctx.screenView : undefined,
          // The colour target is cleared by the background pass (bucket 0,
          // render/passes/background-pass.ts) which now owns the
          // whole-viewport clear — the coverage seam from VISION §5 gap #1.
          // Every opaque sub-pass therefore LOADs the colour it left. The
          // inside-band style `background-color` is still painted by the
          // synthetic earth-surface ShowCommand through this same pipeline;
          // the outside-band region is whatever the background pass cleared.
          // (Depth / stencil / pick are still cleared by THIS first
          // sub-pass below — they are bucket-1 concerns, not coverage.)
          loadOp: 'load',
          storeOp: 'store',
        }]
        if (isPickEnabled() && ctx.rt.pickTexture) {
          colorAttachments.push({
            view: ctx.rt.pickView!,
            clearValue: isFirst ? { r: 0, g: 0, b: 0, a: 0 } : undefined,
            loadOp: isFirst ? 'clear' : 'load',
            storeOp: 'store',
          })
        }
        const subPass = encoder.beginRenderPass({
          colorAttachments,
          depthStencilAttachment: {
            view: ctx.rt.stencilView!,
            depthClearValue: 1.0,
            // First sub-pass clears depth; subsequent ones load the
            // depth their predecessor stored.
            depthLoadOp: isFirst ? 'clear' : 'load',
            depthStoreOp: persistDepth ? 'store' : 'discard',
            // Stencil IS still per-sub-pass — each opaque group uses
            // unique IDs for its own polygon coverage and they don't
            // need to survive across groups.
            stencilClearValue: 0,
            stencilLoadOp: 'clear',
            stencilStoreOp: 'discard',
          },
          timestampWrites: tsWrites,
        })

        // First opaque pass owns raster + canvas-2D background
        // content. These are always the back-most layers in the
        // current architecture. Phase 2 PR 2c.3 retired the
        // BackgroundRenderer call site — the style background fill
        // is now dispatched via the synthetic earth-surface
        // ShowCommand prepended to commands.shows in XGISMap.run().
        if (isFirst) {
          host.gpuTimer?.mark(subPass, 'after_bg')
          // Per-frame raster-opacity resolve. resolveNumberShape
          // honours constant / zoom-interpolated / time-interpolated
          // / zoom-time shapes — same code that drives every other
          // layer's opacity, just driving the global raster
          // renderer's uniform.
          if (host._rasterShow) {
            const z = host.camera.zoom
            const ms = host._elapsedMs
            const rs = host._rasterShow.paintShapes.raster
            host.rasterRenderer.setOpacity(
              resolveNumberShape(host._rasterShow.paintShapes.common.opacity, z, ms).value,
            )
            // raster-* colour adjustments — resolved through the same
            // PropertyShape path as opacity (constant today; zoom/time
            // shapes resolve transparently if ever plumbed).
            host.rasterRenderer.setColorAdjust(
              resolveNumberShape(rs.hueRotate, z, ms).value,
              resolveNumberShape(rs.brightnessMin, z, ms).value,
              resolveNumberShape(rs.brightnessMax, z, ms).value,
              resolveNumberShape(rs.saturation, z, ms).value,
              resolveNumberShape(rs.contrast, z, ms).value,
            )
            host.rasterRenderer.setResampling(rs.resamplingNearest)
          } else {
            host.rasterRenderer.setOpacity(1)
            host.rasterRenderer.setColorAdjust(0, 0, 1, 0, 0)
            host.rasterRenderer.setResampling(false)
          }
          host.rasterRenderer.render(subPass, host.camera, ctx.projType, ctx.centerLon, ctx.centerLat, ctx.w, ctx.h, ctx.dpr)
          host.gpuTimer?.mark(subPass, 'after_raster')
          host.renderer.renderToPass(subPass, host.camera, ctx.projType, ctx.centerLon, ctx.centerLat, host._elapsedMs)
          host.gpuTimer?.mark(subPass, 'after_legacy')
        }

        // Render the group's vector tile shows (if any). Two-phase
        // within the same sub-pass:
        //   Phase 1: 2D ground shows (extrude.kind === 'none' or
        //            absent) — depth-disabled fill, painter's order
        //            decided by GPU command order.
        //   Phase 2: 3D extruded shows (extrude.kind !== 'none')
        //            — depth-write enabled, cross-tile occlusion
        //            resolves via depth-test against a depth
        //            attachment that's CLEAN at the start of phase 2
        //            (phase 1 didn't write depth). This is the
        //            architectural separation 3D rendering needs:
        //            RT-painted ground is conceptually a backdrop
        //            for the 3D world, and mixing them in arbitrary
        //            declaration order breaks cross-tile depth
        //            ordering at high pitch (back-tile buildings
        //            poking through closer-tile buildings) when a
        //            ground show happens to land between two
        //            extruded shows in the same group. Two-phase
        //            ordering within the group enforces the
        //            invariant regardless of declaration order.
        //
        // In a points-only demo (no opaque vector tile layers at
        // all) `group` is undefined and the synthetic first pass
        // exists only to clear the canvas + draw raster + draw
        // legacy MapRenderer layers. We MUST still call
        // subPass.end() in that case, otherwise the pass stays
        // open and bucket 3 (or any subsequent encoder operation)
        // trips a "RenderPassEncoder is open" validation error.
        if (group) {
          const isExtruded = (cs: typeof group.shows[number]): boolean => {
            const ex = (cs.show as { extrude?: { kind?: string } }).extrude
            return !!ex && ex.kind !== undefined && ex.kind !== 'none'
          }
          // Debug=overdraw: collapse every fill variant onto the
          // single fill debug pipeline whose bgl matches the show's.
          // VTR's setPipeline calls use it uniformly — fallback /
          // ground / extruded variants all output the same constant
          // fragment count. Line pipeline is unused inside VTR's
          // debug path (strokes route through LineRenderer which is
          // gated off too), but we still pass a non-null override
          // for completeness.
          const drawShow = (cs: typeof group.shows[number]) => {
            const debugFp = DEBUG_OVERDRAW
              ? (cs.bgl === host.renderer.featureBindGroupLayout
                  ? host.renderer.fillPipelineOverdrawFeature!
                  : host.renderer.fillPipelineOverdraw!)
              : null
            const debugLp = DEBUG_OVERDRAW ? host.renderer.linePipelineOverdraw! : null
            const fp = debugFp ?? cs.fp
            const lp = debugLp ?? cs.lp
            const fpF = debugFp ?? cs.fpF
            const lpF = debugLp ?? cs.lpF
            const fpG = debugFp ?? cs.fpG
            const fpGF = debugFp ?? cs.fpGF
            cs.vtEntry.renderer.render!(
              subPass, host.camera, ctx.projType, ctx.centerLon, ctx.centerLat, ctx.w, ctx.h,
              cs.show, fp, lp, host.renderer.uniformBuffer, cs.bgl,
              fpF, lpF,
              DEBUG_OVERDRAW ? null : host.pointRenderer,
              cs.fillPhase,
              ctx.dpr,
              fpG, fpGF,
              false, cs.resolvedShow,
            )
          }
          for (let si = 0; si < group.shows.length; si++) {
            if (!isExtruded(group.shows[si])) drawShow(group.shows[si])
          }
          for (let si = 0; si < group.shows.length; si++) {
            if (isExtruded(group.shows[si])) drawShow(group.shows[si])
          }
        }

        subPass.end()
      })
    }
  }
}

/** Stateless singleton — the opaque bucket pass. */
export const opaquePass: RenderPass = new OpaquePass()
