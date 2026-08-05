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

import { DEBUG_OVERDRAW } from '../../debug-flags'
import { unwrapWebGpuPass } from '@xgis/rhi-webgpu'
import type { FrameContext } from '../frame-context'
import type { SceneView } from '../scene-view'
import { requireRhiFrame, type RenderPass, type OverdrawComposePassHost } from './pass'

class OverdrawComposePass implements RenderPass {
  readonly label = 'overdraw-compose'

  // Gated on the build-time debug flag; execute() also guards the
  // accumulator texture (only present when DEBUG_OVERDRAW provisioned it).
  shouldRun(): boolean {
    return DEBUG_OVERDRAW
  }

  execute(ctx: FrameContext, _scene: SceneView, host: OverdrawComposePassHost): void {
    if (!ctx.rt.overdrawAccumTexture) return
    const { enc, screenView } = requireRhiFrame(ctx, 'overdraw-compose')
    // This body is still raw WebGPU (P6): `unwrapWebGpuPass` below throws by
    // design on a foreign wrapper, and `ctx.device` is the fail-loud stub on
    // WebGL2 — so on an immediate device the pass CRASHES the frame rather than
    // declining it, and `map.ts` halts the loop after three such frames. The
    // accumulator guard above does not prevent it: the texture is provisioned on
    // `debugOverdraw` alone, with no backend condition (render-targets.ts), so a
    // WebGL2 device allocates one and walks straight in.
    //
    // Skipping matches the forced-WebGL2 twin exactly — it has no accumulator
    // and no compose, so `?debug=overdraw` there renders an ordinary map on a
    // transparent clear. The fourth and last interim executionModel fork
    // (execution-model-confinement.test.ts); it dies with this body's move onto
    // a Material, like the other three (#1046 Inc-F2d).
    if (ctx.rhi.caps.executionModel === 'immediate') return
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
