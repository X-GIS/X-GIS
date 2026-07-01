// ═══ Bucket 1.5: OIT translucent-extrude pass ═══
//
// Relocated VERBATIM from RenderLoop.render. Renders every translucent
// extruded fill into the accum + revealage MRT pair (depth-load from the
// opaque pass, no depth write), then blends the recovered colour onto the
// resolved main colour with a fullscreen compose draw. Order-independent
// by construction — no back-to-front sort. Gated off when no OIT shows or
// in ?debug=overdraw. Mechanical changes only: `this.host.X` → `host.X`,
// `encoder` → `ctx.encoder`.

import { DEBUG_OVERDRAW } from '../../debug-flags'
import type { FrameContext } from '@xgis/engine'
import type { SceneView } from '../scene-view'
import type { RenderPass, OitPassHost } from './pass'

class OitPass implements RenderPass {
  readonly label = 'oit'

  shouldRun(scene: SceneView): boolean { return scene.hasOit && !DEBUG_OVERDRAW }

  execute(ctx: FrameContext, scene: SceneView, host: OitPassHost): void {
    const encoder = ctx.encoder
    // Lazily allocate the OIT targets at the frame's size + sample count.
    // Gated by scene.hasOit (this pass only runs when set), so the default
    // path never allocates them. Mirrors the heatmap pass's ensureHeatmap.
    ctx.rt.ensureOit(ctx.w, ctx.h, ctx.sampleCount)
    ctx.passScope('oit-fill', () => {
      // OIT pass shares the opaque pass's MSAA depth-stencil
      // (depthLoadOp='load' so the opaque depth is what
      // translucent fragments test against). depthStoreOp='discard'
      // because no later pass needs the OIT-side depth. With
      // sample counts matched, translucent buildings hide
      // correctly behind opaque foreground walls — full
      // McGuire-Bavoil order independence applies only to
      // translucent-vs-translucent.
      const oitPass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: ctx.rt.oitAccumView!,
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: 'clear', storeOp: 'store',
          },
          {
            view: ctx.rt.oitRevealageView!,
            clearValue: { r: 1, g: 0, b: 0, a: 0 },
            loadOp: 'clear', storeOp: 'store',
          },
        ],
        // iter-193 — reverted iter-192's offscreenExtrudeDepth.
        // OIT path is unused by default (bucket-scheduler keeps
        // isOitExtrude=false) so this attachment never actually
        // executes; restored to the canonical opaque-depth load
        // for the future opt-in path.
        depthStencilAttachment: {
          view: ctx.rt.stencilView!,
          depthLoadOp: 'load', depthStoreOp: 'discard',
          stencilLoadOp: 'load', stencilStoreOp: 'discard',
        },
      })
      for (const cs of scene.oit) {
        // Draw via the content closure — the engine pass never touches a
        // GPURenderPipeline. phase='oit-fill', translucentBucket=false.
        cs.draw(oitPass, ctx, host.renderer.uniformBuffer, null, 'oit-fill', false)
      }
      oitPass.end()
    })

    ctx.passScope('oit-compose', () => {
      const compPass = encoder.beginRenderPass({
        colorAttachments: [{
          view: ctx.colorView,
          resolveTarget: ctx.useResolve && !scene.hasTranslucent && !scene.hasPoints && scene.resolveOwner === 'composite' ? ctx.screenView : undefined,
          loadOp: 'load', storeOp: 'store',
        }],
      })
      // Lazy-build the bind group when texture views change.
      const bg = host.ctx.device.createBindGroup({
        layout: host.renderer.oitComposeBindGroupLayout,
        entries: [
          { binding: 0, resource: ctx.rt.oitAccumView! },
          { binding: 1, resource: ctx.rt.oitRevealageView! },
        ],
      })
      compPass.setPipeline(host.renderer.oitComposePipeline)
      compPass.setBindGroup(0, bg)
      compPass.draw(3) // oversized triangle — vs_full covers fullscreen with 3 verts
      compPass.end()
    })
  }
}

/** Stateless singleton — the OIT translucent-extrude pass. */
export const oitPass: RenderPass = new OitPass()
