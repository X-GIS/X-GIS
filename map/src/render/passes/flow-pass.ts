// ═══ Flow-field advection pass (#1333) ═══
//
// One IBFV advection step per rendered frame, into the coverage's own grid-space ping-pong
// pair. The coverage drape samples the result, so this pass is a PRODUCER and runs BEFORE the
// consumer — between `background` and `opaque`, where the coverage draws
// (opaque-pass.ts:283).
//
// THAT PLACEMENT IS THE DESIGN, not a scheduling detail. The heatmap pass is a COMPOSITOR and
// therefore runs last; scheduling this one there too would hand the drape LAST frame's
// advection every frame — the animation would still run, one frame stale, which is invisible in
// isolation and wrong under scrubbing. (docs/plans/2026-07-27-grid-vector-field-flow-
// visualization.md §5.1 records why the first draft had it in the heatmap slot.)
//
// It touches NO swapchain attachment — it renders only into its own pair — so it neither claims
// `resolveTarget` nor participates in the colour-clear ownership contract that
// `passes/AGENTS.md` assigns to bucket 0.
//
// GATED on `scene.hasFlow`, which is false for every scalar coverage (S-102 bathymetry) and for
// a map with no coverage at all — so those allocate nothing and render byte-identically. NOT
// gated on the flat/globe arm the coverage draw carries: the consumer that will need that arm
// is the drape (design §6), and the gate belongs with it rather than guessed at here.
//
// The GPU work lives in FlowRenderer (targets + pipeline + the backend fork), exactly as the
// coverage draw lives in CoverageRenderer: this file is the SCHEDULING decision and nothing
// else, so where the step runs stays reviewable on its own.

import type { FrameContext } from '../frame-context'
import type { SceneView } from '../scene-view'
import type { RenderPass, FlowPassHost } from './pass'

class FlowPass implements RenderPass {
  readonly label = 'flow'

  shouldRun(scene: SceneView): boolean {
    return scene.hasFlow
  }

  execute(ctx: FrameContext, _scene: SceneView, host: FlowPassHost): void {
    const flow = host.flowRenderer
    const field = host.coverageRenderer?.activeFlowField() ?? null
    if (!flow) return
    // BEFORE the early return, not after it: what the arrow draw binds is whatever this last
    // declared, so a frame with no field has to say so or the draw keeps the evicted region's
    // (now destroyed) textures bound. See `FlowRenderer.setArrowField`.
    flow.setArrowField(field)
    if (!field) return
    ctx.passScope('flow', () => {
      const frame = { elapsedMs: ctx.elapsedMs, encoder: ctx.rhiEncoder }
      // #1419 — the arrow step, only when an advected batch is resident: it allocates the
      // ping-pong and its pipeline on first use, so a scene with only the static catalogue
      // field must never reach it. It runs HERE, before the graphics pass draws the arrows,
      // because the draw binds the state this writes.
      if (host.graphics.hasAdvectedArrows()) flow.stepArrows(frame, field)
      // The trail step only when a VISIBLE drape samples its image: under the arrows portrayal
      // the regions are resident-but-hidden, and advecting a full-screen image nobody draws is
      // a per-frame cost with no picture attached.
      if (host.coverageRenderer?.hasDrapedFlowField() === true) flow.step(frame, field)
    })
  }
}

export const flowPass: RenderPass = new FlowPass()
