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
// scene/overlay partition. It claims NO resolveTarget: the label pass stays
// the frame's last colour writer and keeps the MSAA resolve it always owned.
// Twin-missing BY DESIGN (RHI_TWIN_MISSING): the WebGL2 twin scales its
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
    const { enc } = requireRhiFrame(ctx, 'scene-upscale')
    let entry = this._drapers.get(host)
    if (!entry || entry.format !== host.ctx.format || entry.sampleCount !== ctx.sampleCount) {
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
            // NO resolveTarget — labels still own the frame's final resolve.
          },
        ],
      })
      draper.draw(pass, src)
      pass.end()
    })
  }
}

/** Stateless singleton — the scene→screen upscale seam. */
export const sceneUpscalePass: RenderPass = new SceneUpscalePass()
