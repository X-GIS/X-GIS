// ═══ Heatmap pass (Phase R) — per-layer accum → blur → compose ═══
//
// Runs AFTER the label pass (the MSAA resolve-owner), compositing onto the
// resolved swapchain — same placement strategy as the overdraw-compose pass,
// which avoids the MSAA resolve-ownership hazard. The whole 3-pass GPU
// pipeline per direct-layer heatmap layer (ACCUM splat → separable Gaussian
// BLUR ping-pong → COMPOSE through the layer's colour-ramp LUT) lives behind
// HeatmapRenderer.renderChainRhi (#1046 F3b Inc-2c), which shares every
// draper/shader/target with the forced-WebGL2 twin's renderRhi (#1060) — one
// implementation, two frame shapes, so the backends cannot drift.
//
// GATED OFF when no direct-layer heatmap exists (scene.hasHeatmap === false)
// or in ?debug=overdraw — so a style with no heatmap allocates no targets and
// renders byte-identically. The density targets are lazily ensured inside
// renderChainRhi (NOT per-frame allocated — HeatmapTargets tracks size).

import { DEBUG_OVERDRAW } from '../../debug-flags'
import type { FrameContext } from '../frame-context'
import { unwrapProjection } from '../projection-token'
import type { SceneView } from '../scene-view'
import { requireRhiFrame, type RenderPass, type HeatmapPassHost } from './pass'

class HeatmapPass implements RenderPass {
  readonly label = 'heatmap'

  shouldRun(scene: SceneView): boolean {
    return scene.hasHeatmap && !DEBUG_OVERDRAW
  }

  execute(ctx: FrameContext, _scene: SceneView, host: HeatmapPassHost): void {
    const hr = host.heatmapRenderer
    if (!hr || !hr.hasLayers()) return
    // The r16float density accumulation blends into a float target, which is a
    // feature-DETECTED capability on WebGL2 (EXT_color_buffer_float +
    // EXT_float_blend). HeatmapRenderer states that its CALLER performs this
    // gate; the forced-WebGL2 twin is such a caller and this pass was not, so a
    // device without the extensions walked straight in (#1046 Inc-F2c). It goes
    // here rather than in `shouldRun`, which is handed no FrameContext and so
    // cannot see the device.
    if (!ctx.rhi.caps.floatBlendTargets) return
    // F3b: RHI origination — descriptor-equivalent on WebGPU, executable on
    // WebGL2 after the flip. The seam hands over the frame encoder + the
    // resolved swapchain view; the renderer owns every pass it opens.
    const { enc, screenView } = requireRhiFrame(ctx, 'heatmap')
    const { projType, centerLon, centerLat } = unwrapProjection(ctx.projection)
    ctx.passScope('heatmap', () => {
      hr.renderChainRhi(
        enc,
        screenView,
        host.heatmapTargets,
        ctx.camera,
        projType,
        centerLon,
        centerLat,
        ctx.scene.w,
        ctx.scene.h,
        ctx.scene.dpr,
      )
    })
  }
}

/** Stateless singleton — the heatmap pass. */
export const heatmapPass: RenderPass = new HeatmapPass()
