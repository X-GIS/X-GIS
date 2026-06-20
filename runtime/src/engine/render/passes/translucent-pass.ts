// ═══ Bucket 2: translucent offscreen + composite pass ═══
//
// Relocated VERBATIM from RenderLoop.render. For each translucent-stroke
// show (in declaration order): render its strokes into the LineRenderer's
// offscreen MAX-blend target, then composite that target onto the main
// colour at the show's resolved opacity. Runs after the entire opaque
// bucket so translucent strokes always paint on top. Gated off when no
// translucent shows or in ?debug=overdraw. Mechanical changes only:
// `this.host.X` → `host.X`, `encoder` → `ctx.encoder`.

import { DEBUG_OVERDRAW } from '../../debug-flags'
import type { FrameContext } from '../frame-context'
import type { SceneView } from '../scene-view'
import type { RenderPass, TranslucentPassHost } from './pass'

class TranslucentPass implements RenderPass {
  readonly label = 'translucent'

  shouldRun(scene: SceneView): boolean { return scene.hasTranslucent && !DEBUG_OVERDRAW }

  execute(ctx: FrameContext, scene: SceneView, host: TranslucentPassHost): void {
    const encoder = ctx.encoder
    for (let li = 0; li < scene.translucent.length; li++) {
      const cs = scene.translucent[li]
      const isLastTranslucent = li === scene.translucent.length - 1
      const resolveHere =
        ctx.useResolve && isLastTranslucent && scene.resolveOwner === 'composite'

      ctx.passScope(`translucent-off[${li}]`, () => {
        const offPass = host.lineRenderer!.beginTranslucentPass(encoder)
        cs.vtEntry.renderer.render!(
          offPass, host.camera, ctx.projType, ctx.centerLon, ctx.centerLat, ctx.w, ctx.h,
          cs.show, cs.fp, cs.lp, host.renderer.uniformBuffer, cs.bgl,
          cs.fpF, cs.lpF,
          null, 'strokes',
          ctx.dpr,
          cs.fpG, cs.fpGF,
          true, // translucentBucket — offscreen pass has no depth
          cs.resolvedShow,
        )
        offPass.end()
      })

      ctx.passScope(`translucent-comp[${li}]`, () => {
        const compPass = encoder.beginRenderPass({
          colorAttachments: [{
            view: ctx.colorView,
            resolveTarget: resolveHere ? ctx.screenView : undefined,
            loadOp: 'load',
            storeOp: 'store',
          }],
        })
        // Composite opacity reads the Phase 4b ResolvedShow
        // snapshot: zoom × time already collapsed by the bucket
        // scheduler. Was `cs.show.opacity` — equivalent value,
        // narrower type (the snapshot is readonly, so a future
        // refactor that mutates `cs.show.opacity` mid-frame
        // can't accidentally drift this composite's input).
        host.lineRenderer!.composite(compPass, cs.resolvedShow.opacity)
        compPass.end()
      })
    }
  }
}

/** Stateless singleton — the translucent offscreen+composite pass. */
export const translucentPass: RenderPass = new TranslucentPass()
