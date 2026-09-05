// ═══ Scene-upscale pass — the scene→screen SEAM (#1429 INC-2) ═══
//
// Runs ONLY while the adaptive ladder holds the scene target below native
// (`scene.sceneScaled`): samples the resolved scene colour (`ctx.scene`-sized,
// single-sample) through the SceneUpscaleDraper's filtering sampler and
// writes the native screen attachment (`ctx.screen`-sized) with a fullscreen
// triangle — so past notch 2 the world blurs but the overlay that draws after
// this pass (labels, graphics) stays readable. At scale 1 this pass does not
// exist at runtime: shouldRun is false, no scene pair is allocated, and the
// frame is byte-identical to the pre-split frame (the design's constructive
// no-op property, pinned by the scale-1 gate).
//
// THE THIRD ROLE (pass-order.ts SEAM_PASSES): this pass reads BOTH target
// geometries — the scene as its sample source, the screen as its write
// target — which is exactly what disqualifies it from either half of the
// scene/overlay partition. Under MSAA it ALSO resolves to the swapchain:
// every later screen writer (labels/heatmap/graphics) is content-gated, so
// the seam is the one UNCONDITIONAL writer a scaled frame has — without its
// resolve, a label-less style would present a never-written swapchain
// (review CRITICAL-1; the pre-split deriveResolveOwner resolved without
// conditions). A label pass that does run re-resolves and wins.
// Runs on EVERY backend since #1046 Inc-F3a. It used to be declared twin-missing:
// canvas instead (design §7) — each backend internally consistent.

import type { FrameContext } from '../frame-context'
import type { SceneView } from '../scene-view'
import { SceneUpscaleDraper } from '../material/scene-upscale-material'
import { requireRhiFrame, type RenderPass, type SceneUpscalePassHost } from './pass'

class SceneUpscalePass implements RenderPass {
  readonly label = 'scene-upscale'

  // One draper per host map (module-level singleton pass — the WeakMap keeps
  // per-map GPU state off the shared instance, the LabelPass precedent), and
  // per (format, sampleCount): the Material bakes both, and setQuality can
  // change the sample count between frames.
  private readonly _drapers = new WeakMap<
    SceneUpscalePassHost,
    { draper: SceneUpscaleDraper; format: string; sampleCount: number }
  >()

  shouldRun(scene: SceneView): boolean {
    return scene.sceneScaled
  }

  execute(ctx: FrameContext, _scene: SceneView, host: SceneUpscalePassHost): void {
    const src = ctx.rhiSceneColorSampleView
    const dst = ctx.rhiColorViewScreen
    // The seam exists only BETWEEN two different geometries. shouldRun gates
    // on scene.sceneScaled, which derives from exactly this inequality, so a
    // frame that reaches here with equal ctx.scene/ctx.screen sizes — or
    // without the scaled-pair bridges the loop populates alongside them — is
    // a wiring bug to fail loud on, not a state to render through.
    if (!src || !dst || (ctx.scene.w === ctx.screen.w && ctx.scene.h === ctx.screen.h))
      throw new Error(
        '[X-GIS] scene-upscale: seam invoked without a scaled scene pair (#1429 INC-2)',
      )
    const { enc, screenView } = requireRhiFrame(ctx, 'scene-upscale')
    let entry = this._drapers.get(host)
    if (!entry || entry.format !== host.ctx.format || entry.sampleCount !== ctx.sampleCount) {
      // Release before replacing (#2337) — same contract as `oit-pass.ts:68`. The draper
      // owns a Material AND a sampler, and this pass is the one the adaptive ladder
      // re-enters most: every notch that changes the scene scale can land here.
      entry?.draper.destroy()
      entry = {
        draper: new SceneUpscaleDraper(host.ctx.rhi, host.ctx.format, ctx.sampleCount),
        format: host.ctx.format,
        sampleCount: ctx.sampleCount,
      }
      this._drapers.set(host, entry)
    }
    const draper = entry.draper
    ctx.passScope('scene-upscale', () => {
      const pass = enc.beginRenderPass({
        colorAttachments: [
          {
            view: dst,
            // Fresh screen-side attachment each scaled frame; the triangle
            // overwrites every pixel, clear just guarantees no stale samples.
            clearValue: [0, 0, 0, 0],
            loadOp: 'clear',
            storeOp: 'store',
            // The seam ALSO resolves to the swapchain (review CRITICAL-1):
            // every later screen writer — labels, heatmap, graphics — is
            // content-gated, so on a scaled MSAA frame with none of them the
            // swapchain would otherwise have ZERO writers (the pre-split
            // deriveResolveOwner resolved unconditionally; the seam restores
            // that guarantee). A later label pass loads the stored screenMsaa
            // and re-resolves — legal, and its newer content wins.
            resolveTarget: ctx.useResolve ? screenView : undefined,
          },
        ],
      })
      draper.draw(pass, src)
      pass.end()
    })
    // e2e observability (the `__xgisVtrFillRhiDraws` pattern): each scaled
    // frame draws the seam exactly once — the scaled-frame gate reads this.
    const g = globalThis as { __xgisSceneUpscaleDraws?: number }
    g.__xgisSceneUpscaleDraws = (g.__xgisSceneUpscaleDraws ?? 0) + 1
  }
}

/** Stateless singleton — the scene→screen upscale seam. */
export const sceneUpscalePass: RenderPass = new SceneUpscalePass()
