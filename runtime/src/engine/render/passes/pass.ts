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
import type {
  BackgroundPassHost,
  OpaquePassHost,
  OitPassHost,
  TranslucentPassHost,
  PointsPassHost,
  LabelPassHost,
  OverdrawComposePassHost,
} from './pass-hosts'
// Re-export the per-pass role views so each concrete pass imports its role
// alongside RenderPass from this one module (single import line per pass).
export type {
  BackgroundPassHost,
  OpaquePassHost,
  OitPassHost,
  TranslucentPassHost,
  PointsPassHost,
  LabelPassHost,
  OverdrawComposePassHost,
} from './pass-hosts'

/** The owning-map view a pass reaches its renderers / stages / camera
 *  through — the COMPOSITION (intersection) of every per-pass role view.
 *  Each concrete pass narrows its `execute` host param to its own role
 *  (e.g. BackgroundPassHost); the generic `RenderPass.execute` declares
 *  the composed PassHost so the RenderLoop can drive any pass uniformly.
 *  Same member set the loop hands in — a pure TYPE re-grouping. */
export type PassHost =
  & BackgroundPassHost
  & OpaquePassHost
  & OitPassHost
  & TranslucentPassHost
  & PointsPassHost
  & LabelPassHost
  & OverdrawComposePassHost

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
