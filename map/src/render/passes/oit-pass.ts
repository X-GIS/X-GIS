// ═══ Bucket 1.5: translucent-extrude SHELL pass (#1253) ═══
//
// The LAYER-WIDE form of #1080's front shell. For each translucent extruded
// layer, in declaration order:
//
//   1. SHELL — draw the layer's whole tile set into an offscreen colour target
//      with blending OFF, depth `less-equal` + depth WRITE, loading the OPAQUE
//      pass's depth-stencil attachment. Replace-on-write leaves exactly the
//      front-most extruded surface per pixel across EVERY tile, and the loaded
//      depth keeps the layer behind opaque foreground geometry (and behind the
//      globe's under-occluder sphere on the far hemisphere).
//   2. COMPOSITE — one fullscreen draw blends that target onto the scene colour
//      at the layer's resolved fill alpha.
//
// WHY, and what it replaces: #1080's two-draw (depth prepass then depth-equal
// colour) runs per DRAW, which is per TILE, so two features in different tiles
// overlapping on screen each blended their own front surface and the shared
// pixel came out twice as dark (#1253). Splitting shell from composite moves
// that resolution from "within one draw" to "within one layer", which is where
// MapLibre resolves it too. PER LAYER, not per bucket: two DIFFERENT
// translucent extrusion layers still blend over each other, exactly as two
// translucent layers should.
//
// The weighted-blended OIT scaffold this slot was originally built for
// (`fillPipelineExtrudedOIT`, `rt.oitAccum/oitRevealage`, `drawOitCompose`)
// stays wired but unrouted — it is the opt-in VOLUMETRIC alternative, and a
// different look by construction: it accumulates front AND back fragments, so
// overlapping surfaces get more opaque, which is the very artifact this pass
// exists to remove.
//
// F3b Inc-2d: originates through the RHI frame shell. The compositor is a
// Material draper built here (the SceneUpscalePass precedent) rather than a
// renderer-owned native pipeline, so its format and sample count are derived
// from the SCENE attachment it draws into.

import { isPickEnabled } from '@xgis/engine'
import type { FrameContext } from '../frame-context'
import type { SceneView } from '../scene-view'
import { extrudeFillAlpha } from '../bucket-scheduler'
import { ExtrudeShellComposeDraper } from '../material/extrude-shell-material'
import { requireRhiFrame, type RenderPass, type OitPassHost } from './pass'

class OitPass implements RenderPass {
  readonly label = 'oit'

  // One compositor per host map, per (format, sampleCount) — the Material bakes
  // both, and `setQuality` can change the sample count between frames. WeakMap
  // so this module-level singleton holds no per-map GPU state (the LabelPass /
  // SceneUpscalePass precedent).
  private readonly _drapers = new WeakMap<
    OitPassHost,
    { draper: ExtrudeShellComposeDraper; format: string; sampleCount: number }
  >()

  shouldRun(scene: SceneView): boolean {
    return scene.hasOit && !scene.overdraw
  }

  execute(ctx: FrameContext, scene: SceneView, host: OitPassHost): void {
    const { enc, colorView, stencilView, sceneResolveView } = requireRhiFrame(ctx, 'oit')
    // Lazily allocate the shell target at the frame's size + SCENE sample count
    // (the count the shared depth attachment forces). Gated by scene.hasOit —
    // this pass only runs when set — so a style with no translucent extrusion
    // allocates none of it, the same discipline `ensureOit` follows.
    ctx.rt.ensureExtrudeShell(ctx.scene.w, ctx.scene.h, ctx.sampleCount)
    let entry = this._drapers.get(host)
    if (!entry || entry.format !== host.ctx.format || entry.sampleCount !== ctx.sampleCount) {
      entry?.draper.destroy()
      entry = {
        draper: new ExtrudeShellComposeDraper(host.ctx.rhi, host.ctx.format, ctx.sampleCount),
        format: host.ctx.format,
        sampleCount: ctx.sampleCount,
      }
      this._drapers.set(host, entry)
    }
    const draper = entry.draper
    const pickOn = isPickEnabled() && ctx.rt.pickTexture !== null

    for (let li = 0; li < scene.oit.length; li++) {
      const cs = scene.oit[li]
      const isLastShell = li === scene.oit.length - 1

      ctx.passScope(`oit-shell[${li}]`, () => {
        const colorAttachments: Parameters<
          typeof enc.beginRenderPass
        >[0]['colorAttachments'][number][] = [
          {
            view: ctx.rt.extrudeShellView!,
            // Null at sampleCount 1, where the shell target IS the sampled
            // texture and a resolve target would be a validation error.
            resolveTarget: ctx.rt.extrudeShellResolveView ?? undefined,
            clearValue: [0, 0, 0, 0],
            loadOp: 'clear',
            storeOp: 'store',
          },
        ]
        // Picking survives the move out of the opaque bucket: the pick MRT is
        // attached here too (LOADing what the opaque sub-passes stored), and
        // the shell pipeline variants keep their pick write mask. `?picking=1`
        // forces SAMPLE_COUNT to 1 globally, so the pick attachment's single
        // sample always agrees with the shell target's here.
        if (pickOn)
          colorAttachments.push({ view: ctx.rt.pickView!, loadOp: 'load', storeOp: 'store' })
        const shellPass = enc.beginRenderPass({
          label: 'extrude-shell',
          colorAttachments,
          depthStencilAttachment: {
            view: stencilView,
            // LOAD the depth the last opaque sub-pass stored (it stores when
            // scene.hasOit) so translucent walls are occluded by opaque
            // geometry. The shell WRITES depth — that is what resolves the
            // front-most surface — and a later shell layer, or the points
            // bucket, reads it, so only the final consumer may discard.
            depthLoadOp: 'load',
            depthStoreOp: !isLastShell || scene.hasPoints ? 'store' : 'discard',
            // Stencil is per-sub-pass everywhere in this frame (each opaque
            // group clears + discards its own tile-coverage ids), so the shell
            // opens with a clean one for its own write/test variants.
            stencilClearValue: 0,
            stencilLoadOp: 'clear',
            stencilStoreOp: 'discard',
          },
        })
        // Draw via the content closure — the engine pass never touches a
        // pipeline handle. phase='oit-fill' (the shell fill), translucentBucket
        // =false (this pass HAS a depth attachment).
        cs.draw(shellPass, ctx, null, 'oit-fill', false)
        shellPass.end()
      })

      ctx.passScope(`oit-compose[${li}]`, () => {
        const compPass = enc.beginRenderPass({
          colorAttachments: [
            {
              view: colorView,
              resolveTarget:
                ctx.useResolve && isLastShell && scene.resolveOwner === 'oit'
                  ? sceneResolveView
                  : undefined,
              loadOp: 'load',
              storeOp: 'store',
            },
          ],
        })
        // The layer's fill alpha comes from the SAME authority the bucket
        // predicate used, so "is this layer translucent enough to route here"
        // and "how transparent do we composite it" cannot drift.
        draper.draw(
          compPass,
          ctx.rt.extrudeShellSampleView!,
          extrudeFillAlpha(cs.show, cs.resolvedShow),
          li,
        )
        compPass.end()
      })
    }
  }
}

/** Stateless singleton — the translucent-extrude shell + composite pass. */
export const oitPass: RenderPass = new OitPass()
