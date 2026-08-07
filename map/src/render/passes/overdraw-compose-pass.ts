// ═══ Debug overdraw-compose pass ═══
//
// Only active in ?debug=overdraw: reads the r16float fragment-count
// accumulator and writes a colormapped RGBA to the swapchain. Runs as the
// LAST pass of the frame so it owns the swapchain attachment. Originates
// through the RHI frame shell (#1046 Inc-3a — the 12th and final pass off
// the native encoder); the colormap pipeline + bind group stay native behind
// ONE boundary unwrap (the VTR idiom) — gap-blocked debt that retires when
// the compose moves onto a Material, not re-wrapped per draw. ?debug=overdraw
// pins the adaptive scale to 1 (render-loop fork), so screen === scene here
// and the swapchain target needs no seam awareness.

import { unwrapWebGpuPass } from '@xgis/rhi-webgpu'
import type { FrameContext } from '../frame-context'
import type { SceneView } from '../scene-view'
import { requireRhiFrame, type RenderPass, type OverdrawComposePassHost } from './pass'

class OverdrawComposePass implements RenderPass {
  readonly label = 'overdraw-compose'

  // Gated on the FRAME's overdraw truth (FrameContext.overdraw), not the raw
  // URL flag — the mode cannot run on an immediate device, where this body's
  // raw-WebGPU unwrap would throw. execute() also guards the accumulator
  // texture, which is only provisioned when that same truth is on.
  shouldRun(scene: SceneView): boolean {
    return scene.overdraw
  }

  execute(ctx: FrameContext, _scene: SceneView, host: OverdrawComposePassHost): void {
    if (!ctx.rt.overdrawAccumTexture) return
    const { enc, screenView } = requireRhiFrame(ctx, 'overdraw-compose')
    ctx.passScope('overdraw-compose', () => {
      const pipeline = host.renderer.ensureOverdrawCompose()
      const rhiPass = enc.beginRenderPass({
        colorAttachments: [
          {
            view: screenView,
            clearValue: [0, 0, 0, 1],
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      })
      const compPass = unwrapWebGpuPass(rhiPass)
      const bg = host.ctx.device.createBindGroup({
        layout: host.renderer.overdrawComposeBindGroupLayout,
        entries: [
          {
            binding: 0,
            // The RT's P6-scoped native accessor — this bind group is raw
            // until the compose moves onto a Material (see file header).
            resource: ctx.rt.overdrawViewNative!,
          },
        ],
      })
      compPass.setPipeline(pipeline)
      compPass.setBindGroup(0, bg)
      compPass.draw(3)
      rhiPass.end()
    })
  }
}

/** Stateless singleton — the debug overdraw-compose pass. */
export const overdrawComposePass: RenderPass = new OverdrawComposePass()
