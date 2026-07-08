// ═══ X-GIS RenderLoop — content-blind RenderNode contract (P2-carve Step 4) ═══
//
// The engine scheduler (render-loop.ts) drives a frame as a FLAT, frozen-order
// list of RenderNodes — NOT a DAG (the prior-art ruling: the pass order is a
// fixed linear chain, so a scheduler graph buys nothing). A RenderNode is a
// CONTENT object: @xgis/map builds + registers it (render/passes/pass-chain.ts),
// and the engine treats it opaquely. The engine knows only `shouldRun` (the
// per-frame gate the inline `if (...)` used) and `execute` (emit GPU commands);
// it never names a concrete pass and never reaches the owning map.
//
// This INVERTS the former `RenderPass` / `PassHost` back-edge: each pass used to
// be handed a `Pick<XGISMap>` host BY the engine render loop, so the engine
// type-referenced XGISMap through the pass dispatch. Now the content node
// CAPTURES its own map host at registration and the engine only iterates the
// registered `RenderNode[]`. After the Step-5 package move (passes → @xgis/map)
// the engine keeps only this contract + the scheduler, so the §8.5 Gate-6
// ratchet (engine must not import @xgis/map) holds by construction — not as a
// regex bolt-on.

import type { FrameContext } from '@xgis/rhi-webgpu'
import type { SceneView } from './scene-view'

/** One stage of the fixed render-pass chain, implemented + registered by
 *  content. The engine holds these as an ordered `RenderNode[]` and, each
 *  frame, runs `execute` for every node whose `shouldRun` returns true —
 *  reproducing the former hardcoded pass sequence exactly. */
export interface RenderNode {
  /** Stable name (matches the old passScope label family). */
  readonly label: string
  /** Whether this node emits anything this frame — the gate the inline
   *  `if (...)` block used. MUST be pure (no side effects): the scheduler
   *  calls it for every node every frame, including the unconditional ones. */
  shouldRun(scene: SceneView): boolean
  /** Emit the node's GPU commands into `ctx.encoder`. The node reaches its
   *  renderers / camera / map state through the content host it captured at
   *  registration — the engine never supplies it. */
  execute(ctx: FrameContext, scene: SceneView): void
}
