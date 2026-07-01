// ═══ Bucket 2: translucent offscreen + composite pass ═══
//
// Relocated VERBATIM from RenderLoop.render. For each translucent-stroke
// show (in declaration order): render its strokes into the LineRenderer's
// offscreen MAX-blend target, then composite that target onto the main
// colour at the show's resolved opacity. Runs after the entire opaque
// bucket so translucent strokes always paint on top. Gated off when no
// translucent shows or in ?debug=overdraw. Mechanical changes only:
// `this.host.X` → `host.X`, `encoder` → `ctx.encoder`.

import { DEBUG_OVERDRAW } from '@xgis/map'
import type { FrameContext } from '@xgis/engine'
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
        // Draw via the content closure — the engine pass never touches a
        // GPURenderPipeline. phase='strokes'; translucentBucket=true (the
        // offscreen MAX-blend pass has no depth attachment).
        cs.draw(offPass, ctx, host.renderer.uniformBuffer, null, 'strokes', true)
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
