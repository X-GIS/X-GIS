// ═══ Heatmap pass (Phase R) ═══
//
// Runs AFTER the label pass (the MSAA resolve-owner), compositing onto the
// resolved swapchain — same placement strategy as the overdraw-compose pass,
// which avoids the MSAA resolve-ownership hazard. Renders every direct-layer
// (GeoJSON-source) heatmap layer as a 3-pass GPU pipeline:
//   1. ACCUM   — clear the r16float density target, additively splat each
//                point's Gaussian (HeatmapRenderer.drawLayerAccum).
//   2. BLUR    — separable Gaussian: horizontal accum→blur, then vertical
//                blur→accum (the blurred density lands back in accum).
//   3. COMPOSE — sample blurred density, map through the layer's colour-ramp
//                LUT × intensity × opacity, alpha-blend over the swapchain.
//
// Each heatmap LAYER is processed independently (its own radius / weight /
// ramp / intensity), so the accum target is cleared per layer.
//
// GATED OFF when no direct-layer heatmap exists (scene.hasHeatmap === false)
// or in ?debug=overdraw — so a style with no heatmap allocates no targets and
// renders byte-identically. The density targets are lazily ensured here (NOT
// per-frame allocated — RenderTargets.ensureHeatmap tracks size + reuses).

import { DEBUG_OVERDRAW } from '@xgis/map'
import type { FrameContext } from '@xgis/engine'
import { unwrapProjection } from '@xgis/engine'
import type { SceneView } from '../scene-view'
import type { RenderPass, HeatmapPassHost } from './pass'

class HeatmapPass implements RenderPass {
  readonly label = 'heatmap'

  shouldRun(scene: SceneView): boolean { return scene.hasHeatmap && !DEBUG_OVERDRAW }

  execute(ctx: FrameContext, _scene: SceneView, host: HeatmapPassHost): void {
    const hr = host.heatmapRenderer
    if (!hr || !hr.hasLayers()) return
    const encoder = ctx.encoder
    ctx.passScope('heatmap', () => {
      // Lazily (re)allocate the density targets at canvas size. No-op when
      // unchanged; never allocates in the default no-heatmap path.
      ctx.rt.ensureHeatmap(ctx.w, ctx.h)
      const accumView = ctx.rt.heatmapAccumView
      const blurView = ctx.rt.heatmapBlurView
      if (!accumView || !blurView) return

      const blurPipeline = host.renderer.ensureHeatmapBlur()
      const composePipeline = host.renderer.ensureHeatmapCompose()
      const blurLayout = host.renderer.heatmapBlurBindGroupLayout
      const composeLayout = host.renderer.heatmapComposeBindGroupLayout
      const { h: blurDirH, v: blurDirV } = hr.getBlurDirBuffers()
      const rampSampler = hr.getRampSampler()

      // Write the shared accum frame uniform once.
      const { projType, centerLon, centerLat } = unwrapProjection(ctx.projection)
      hr.updateFrameUniform(ctx.camera, projType, centerLon, centerLat, ctx.w, ctx.h, ctx.dpr)

      const layers = hr.getLayers()
      for (let li = 0; li < layers.length; li++) {
        const layer = layers[li]

        // ── Pass 1: ACCUM ── clear accum, additively splat this layer.
        {
          const accumPass = encoder.beginRenderPass({
            colorAttachments: [{
              view: accumView,
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
              loadOp: 'clear', storeOp: 'store',
            }],
          })
          hr.drawLayerAccum(accumPass, li)
          accumPass.end()
        }

        // ── Pass 2a: BLUR horizontal (accum → blur) ──
        {
          const bg = host.ctx.device.createBindGroup({
            layout: blurLayout,
            entries: [
              { binding: 0, resource: accumView },
              { binding: 1, resource: { buffer: blurDirH } },
            ],
          })
          const bp = encoder.beginRenderPass({
            colorAttachments: [{ view: blurView, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
          })
          bp.setPipeline(blurPipeline)
          bp.setBindGroup(0, bg)
          bp.draw(3)
          bp.end()
        }

        // ── Pass 2b: BLUR vertical (blur → accum) ──
        {
          const bg = host.ctx.device.createBindGroup({
            layout: blurLayout,
            entries: [
              { binding: 0, resource: blurView },
              { binding: 1, resource: { buffer: blurDirV } },
            ],
          })
          const bp = encoder.beginRenderPass({
            colorAttachments: [{ view: accumView, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
          })
          bp.setPipeline(blurPipeline)
          bp.setBindGroup(0, bg)
          bp.draw(3)
          bp.end()
        }

        // ── Pass 3: COMPOSE ── sample blurred density, alpha-blend onto the
        // RESOLVED swapchain (ctx.screenView). This pass runs LAST (after the
        // label pass resolved MSAA), single-sample, exactly like overdraw-
        // compose — so it never has to share the MSAA attachment. Each layer
        // binds its OWN params buffer (intensity/opacity) + ramp LUT.
        {
          const bg = host.ctx.device.createBindGroup({
            layout: composeLayout,
            entries: [
              { binding: 0, resource: accumView },
              { binding: 1, resource: layer.rampTexture.createView() },
              { binding: 2, resource: rampSampler },
              { binding: 3, resource: { buffer: layer.paramsBuf } },
            ],
          })
          const cp = encoder.beginRenderPass({
            colorAttachments: [{
              view: ctx.screenView,
              loadOp: 'load', storeOp: 'store',
            }],
          })
          cp.setPipeline(composePipeline)
          cp.setBindGroup(0, bg)
          cp.draw(3)
          cp.end()
        }
      }
    })
  }
}

/** Stateless singleton — the heatmap pass. */
export const heatmapPass: RenderPass = new HeatmapPass()
