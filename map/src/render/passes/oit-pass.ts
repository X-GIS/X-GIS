// ═══ Bucket 1.5: OIT translucent-extrude pass ═══
//
// Relocated VERBATIM from RenderLoop.render. Renders every translucent
// extruded fill into the accum + revealage MRT pair (depth-load from the
// opaque pass, no depth write), then blends the recovered colour onto the
// resolved main colour with a fullscreen compose draw. Order-independent
// by construction — no back-to-front sort. Gated off when no OIT shows or
// in ?debug=overdraw. F3b Inc-2d: originates through the RHI frame shell;
// the fill targets ride the RT-side RHI accessors and the compose draws
// through the renderer entry (native pipeline until the OIT twin lands).

import { DEBUG_OVERDRAW } from '../../debug-flags'
import type { FrameContext } from '../frame-context'
import type { SceneView } from '../scene-view'
import { requireRhiFrame, type RenderPass, type OitPassHost } from './pass'

class OitPass implements RenderPass {
  readonly label = 'oit'

  shouldRun(scene: SceneView): boolean {
    return scene.hasOit && !DEBUG_OVERDRAW
  }

  execute(ctx: FrameContext, scene: SceneView, host: OitPassHost): void {
    // F3b: RHI origination (Inc-2d) — the fill targets ride the RT-side RHI
    // accessors (adapter-owned textures), the compose draws through the
    // narrowed renderer entry.
    const { enc, colorView, stencilView, sceneResolveView } = requireRhiFrame(ctx, 'oit')
    // Lazily allocate the OIT targets at the frame's size + sample count.
    // Gated by scene.hasOit (this pass only runs when set), so the default
    // path never allocates them. Mirrors the heatmap pass's ensureHeatmap.
    ctx.rt.ensureOit(ctx.scene.w, ctx.scene.h, ctx.sampleCount)
    ctx.passScope('oit-fill', () => {
      // OIT pass shares the opaque pass's MSAA depth-stencil
      // (depthLoadOp='load' so the opaque depth is what
      // translucent fragments test against). depthStoreOp='discard'
      // because no later pass needs the OIT-side depth. With
      // sample counts matched, translucent buildings hide
      // correctly behind opaque foreground walls — full
      // McGuire-Bavoil order independence applies only to
      // translucent-vs-translucent.
      const oitPass = enc.beginRenderPass({
        colorAttachments: [
          {
            view: ctx.rt.oitAccumView!,
            clearValue: [0, 0, 0, 0],
            loadOp: 'clear',
            storeOp: 'store',
          },
          {
            view: ctx.rt.oitRevealageView!,
            clearValue: [1, 0, 0, 0],
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
        // iter-193 — reverted iter-192's offscreenExtrudeDepth.
        // OIT path is unused by default (bucket-scheduler keeps
        // isOitExtrude=false) so this attachment never actually
        // executes; restored to the canonical opaque-depth load
        // for the future opt-in path.
        depthStencilAttachment: {
          view: stencilView,
          depthLoadOp: 'load',
          depthStoreOp: 'discard',
          stencilLoadOp: 'load',
          stencilStoreOp: 'discard',
        },
      })
      for (const cs of scene.oit) {
        // Draw via the content closure — the engine pass never touches a
        // GPURenderPipeline. phase='oit-fill', translucentBucket=false.
        cs.draw(oitPass, ctx, null, 'oit-fill', false)
      }
      oitPass.end()
    })

    ctx.passScope('oit-compose', () => {
      const compPass = enc.beginRenderPass({
        colorAttachments: [
          {
            view: colorView,
            resolveTarget:
              ctx.useResolve &&
              !scene.hasTranslucent &&
              !scene.hasPoints &&
              scene.resolveOwner === 'composite'
                ? sceneResolveView
                : undefined,
            loadOp: 'load',
            storeOp: 'store',
          },
        ],
      })
      // The fullscreen recover draw (pipeline + bind group + draw(3)) lives
      // behind the renderer entry — the pipeline is native until the OIT twin
      // lands, and the unwrap belongs in the adapter-importing layer, not
      // here. The `*Native` accessors are the RT's P6-scoped raw residue.
      host.renderer.drawOitCompose(
        compPass,
        ctx.rt.oitAccumViewNative!,
        ctx.rt.oitRevealageViewNative!,
      )
      compPass.end()
    })
  }
}

/** Stateless singleton — the OIT translucent-extrude pass. */
export const oitPass: RenderPass = new OitPass()
