// ═══ Graphics pass (#797 Phase 1) ═══
//
// Draws the host DRAWING API's retained geo-anchored icon batches
// (map.graphics.add). Runs LAST — after the label pass resolved MSAA —
// compositing single-sample onto the already-resolved swapchain (ctx.screenView),
// the same placement strategy as the heatmap + overdraw-compose passes. This
// sidesteps the MSAA resolve-ownership hazard entirely: icons need no MSAA (raster
// edges are texture-alpha; there is no SDF host path yet), and drawing last gives
// the correct "host annotations on top" semantic.
//
// GATED OFF when no retained batch exists (scene.hasGraphics === false) or in
// ?debug=overdraw — a map with no host batches renders byte-identically (no pass).
//
// The retained pack is at add()/update(), NEVER here — this pass only writes the
// per-copy frame uniform + issues one instanced draw(6, N) per world copy per
// batch, so it is O(COPIES) in cost, independent of icon count (the #797 P1
// N-independence gate).

import { DEBUG_OVERDRAW } from '../../debug-flags'
import type { FrameContext } from '@xgis/rhi-webgpu'
import { unwrapProjection } from '@xgis/engine'
import { wrapWebGpuPass } from '@xgis/rhi-webgpu'
import type { SceneView } from '../scene-view'
import type { RenderPass, GraphicsPassHost } from './pass'

class GraphicsPass implements RenderPass {
  readonly label = 'graphics'

  shouldRun(scene: SceneView): boolean {
    return scene.hasGraphics && !DEBUG_OVERDRAW
  }

  execute(ctx: FrameContext, _scene: SceneView, host: GraphicsPassHost): void {
    const { projType, centerLon, centerLat } = unwrapProjection(ctx.projection)
    const frame = host.camera.getViewForProjection(projType, ctx.w, ctx.h, ctx.dpr)
    ctx.passScope('graphics-icons', () => {
      const pass = ctx.encoder.beginRenderPass({
        colorAttachments: [{ view: ctx.screenView, loadOp: 'load', storeOp: 'store' }],
      })
      host.graphics.renderRetained(
        wrapWebGpuPass(pass),
        frame,
        host.camera,
        projType,
        centerLon,
        centerLat,
        ctx.w,
        ctx.h,
        ctx.dpr,
      )
      pass.end()
    })
  }
}

/** Stateless singleton — the retained host-drawing icon pass. */
export const graphicsPass: RenderPass = new GraphicsPass()
