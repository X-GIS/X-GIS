// ═══ Bucket 3: direct-layer points pass ═══
//
// Relocated VERBATIM from RenderLoop.render. Renders pointRenderer.layers
// (GeoJSON sources routed through pointRenderer.addLayer in rebuildLayers).
// Tile-points are NOT here — they draw inline in the opaque bucket via
// VTR.render's pointRenderer parameter. Loads the opaque depth so
// billboards on the back of a globe / pitched surface are occluded by
// front-facing polygons (points depth-test but don't depth-write). Gated
// off when no direct-layer points or in ?debug=overdraw. Mechanical
// changes only: `this.host.X` → `host.X`, `encoder` → `ctx.encoder`.

import type { FrameContext } from '../frame-context'
import { unwrapProjection } from '../projection-token'
import type { SceneView } from '../scene-view'
import { requireRhiFrame, type RenderPass, type PointsPassHost } from './pass'

class PointsPass implements RenderPass {
  readonly label = 'points'

  shouldRun(scene: SceneView): boolean {
    return scene.hasPoints && !scene.overdraw
  }

  execute(ctx: FrameContext, _scene: SceneView, host: PointsPassHost): void {
    // F3b: RHI origination + the renderer's RHI entry (#1057 renderRhi) —
    // descriptor-equivalent on WebGPU, executable on WebGL2 after the flip.
    const { enc, colorView, stencilView, sceneResolveView } = requireRhiFrame(ctx, 'points')
    ctx.passScope('points', () => {
      const ptPass = enc.beginRenderPass({
        colorAttachments: [
          {
            view: colorView,
            resolveTarget: ctx.useResolve ? sceneResolveView : undefined,
            loadOp: 'load',
            storeOp: 'store',
          },
        ],
        depthStencilAttachment: {
          view: stencilView,
          // Load the depth the last opaque sub-pass stored above so
          // billboards on the back side of a globe / pitched surface
          // are correctly occluded by the front-facing opaque
          // polygons. Translucent points still skip depth WRITES
          // (their pipeline disables depthWriteEnabled), so a halo
          // doesn't block other markers — but they DO depth-test.
          depthClearValue: 1.0,
          depthLoadOp: 'load',
          depthStoreOp: 'discard',
          stencilClearValue: 0,
          stencilLoadOp: 'clear',
          stencilStoreOp: 'discard',
        },
      })
      // Re-evaluate zoom-interpolated point sizes against the
      // current camera before drawing. No-op for layers without
      // zoomSizeStops; internally skipped when zoom is unchanged.
      // #2324 — the frame clock (ctx.elapsedMs), not performance.now(): a
      // time-interpolated size must animate from the same clock every other
      // time-interpolated property reads, not one that starts at navigation.
      host.pointRenderer!.updateDynamicSizes(host.camera.zoom, ctx.elapsedMs)
      const { projType, centerLon, centerLat } = unwrapProjection(ctx.projection)
      host.pointRenderer!.renderRhi(
        ptPass,
        host.camera,
        projType,
        centerLon,
        centerLat,
        ctx.scene.w,
        ctx.scene.h,
        ctx.scene.dpr,
      )
      ptPass.end()
    })
  }
}

/** Stateless singleton — the direct-layer points pass. */
export const pointsPass: RenderPass = new PointsPass()
