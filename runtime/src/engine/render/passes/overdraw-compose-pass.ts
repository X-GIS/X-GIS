// ═══ Debug overdraw-compose pass ═══
//
// Relocated VERBATIM from RenderLoop.render. Only active in ?debug=overdraw:
// reads the r16float fragment-count accumulator and writes a colormapped
// RGBA to the swapchain. Runs as the LAST pass of the frame so it owns the
// swapchain attachment. Mechanical changes only: `this.host.X` → `host.X`,
// `encoder` → `ctx.encoder`.

import { DEBUG_OVERDRAW } from '../../debug-flags'
import type { FrameContext } from '@xgis/engine'
import type { SceneView } from '../scene-view'
import type { RenderPass, OverdrawComposePassHost } from './pass'

class OverdrawComposePass implements RenderPass {
  readonly label = 'overdraw-compose'

  // Gated on the build-time debug flag; execute() also guards the
  // accumulator texture (only present when DEBUG_OVERDRAW provisioned it).
  shouldRun(): boolean { return DEBUG_OVERDRAW }

  execute(ctx: FrameContext, _scene: SceneView, host: OverdrawComposePassHost): void {
    if (!ctx.rt.overdrawAccumTexture) return
    const encoder = ctx.encoder
    ctx.passScope('overdraw-compose', () => {
      const pipeline = host.renderer.ensureOverdrawCompose()
      const compPass = encoder.beginRenderPass({
        colorAttachments: [{
          view: ctx.screenView,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear', storeOp: 'store',
        }],
      })
      const bg = host.ctx.device.createBindGroup({
        layout: host.renderer.overdrawComposeBindGroupLayout,
        entries: [{
          binding: 0,
          resource: ctx.rt.overdrawView!,
        }],
      })
      compPass.setPipeline(pipeline)
      compPass.setBindGroup(0, bg)
      compPass.draw(3)
      compPass.end()
    })
  }
}

/** Stateless singleton — the debug overdraw-compose pass. */
export const overdrawComposePass: RenderPass = new OverdrawComposePass()
