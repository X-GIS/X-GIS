// ═══ X-GIS RenderLoop — RenderPass interface ═══
//
// The render path is a fixed linear chain of passes (compute → opaque →
// OIT → translucent → points → labels → overdraw-compose), bracketed by
// the renderer's beginFrame/endFrame. Each phase of the engine redesign
// lifts one inline passScope block out of RenderLoop.render into a
// RenderPass: a stateless object that reads the per-frame FrameContext +
// SceneView + the owning map (via the RenderLoopHost view) and emits its
// GPU commands. Behaviour is byte-identical to the inline block — the
// pass owns the SAME encoder calls, only relocated.
//
// Passes are stateless singletons (no per-frame allocation). `shouldRun`
// is the gate the inline `if (...)` used; `execute` is the block body.

import type { FrameContext } from '../frame-context'
import type { SceneView } from '../scene-view'
import type { RenderLoopHost } from '../../render-loop'

/** The owning-map view a pass reaches its renderers / stages / camera
 *  through. Same typed Pick the RenderLoop uses. */
export type PassHost = RenderLoopHost

/** One stage of the fixed render-pass chain. */
export interface RenderPass {
  /** Stable name (matches the old passScope label family). */
  readonly label: string
  /** Whether this pass emits anything this frame — the gate the inline
   *  `if (...)` block used. */
  shouldRun(scene: SceneView): boolean
  /** Emit the pass's GPU commands into `ctx.encoder`. */
  execute(ctx: FrameContext, scene: SceneView, host: PassHost): void
}
