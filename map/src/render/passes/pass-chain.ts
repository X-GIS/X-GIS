// ═══ X-GIS render-pass chain — content-side RenderNode registration ═══
//
// CONTENT half of the P2-carve Step-4 inversion. The engine render loop
// (render-loop.ts) iterates a content-registered `RenderNode[]`; this module
// is where @xgis/map BUILDS that ordered list. Each pass singleton is still a
// `RenderPass` (it reads its `Pick<XGISMap>` role host — content typing that
// moves intra-package in Step 5); `adapt` wraps one into a content-blind
// `RenderNode` by capturing the owning map and supplying it as the host the
// engine no longer hands in.
//
// ORDER IS THE BYTE-FROZEN PASS SEQUENCE — DO NOT REORDER. It reproduces the
// former hardcoded dispatch in render-loop.ts exactly:
//   background → opaque → oit → translucent → points → label → heatmap →
//   overdraw-compose → graphics (#797 P1, appended — inert unless host batches)
// background / opaque / label keep `shouldRun()===true` (unconditional); the
// rest carry their original predicate. The OIT node is registered at its
// historical slot but is RUNTIME-DEAD — `oitPass.shouldRun` is immutably false
// (the dead OIT path: isOitExtrude=false ⇒ scene.hasOit=false ∀ states), so it
// never executes. That folds OIT out of the live path here (the deferred Step-0
// removal) WITHOUT a premature subsystem delete: the pipeline/compose/target
// scaffold stays, it is simply never wired live.

import type { XGISMap } from '../../map'
import type { RenderNode } from '../render-node'
import type { RenderPass } from './pass'
import { backgroundPass } from './background-pass'
import { opaquePass } from './opaque-pass'
import { oitPass } from './oit-pass'
import { translucentPass } from './translucent-pass'
import { pointsPass } from './points-pass'
import { labelPass } from './label-pass'
import { heatmapPass } from './heatmap-pass'
import { overdrawComposePass } from './overdraw-compose-pass'
import { graphicsPass } from './graphics-pass'

/** Wrap a `RenderPass` singleton (which still takes a `Pick<XGISMap>` host as
 *  its third `execute` arg) into a content-blind `RenderNode` that captures the
 *  owning map. Byte-identical: `pass.execute(ctx, scene, map)` is exactly the
 *  former `pass.execute(ctx, scene, this.host)` where `this.host === map`. */
function adapt(pass: RenderPass, map: XGISMap): RenderNode {
  return {
    label: pass.label,
    shouldRun: (scene) => pass.shouldRun(scene),
    execute: (ctx, scene) => pass.execute(ctx, scene, map),
  }
}

/** Build the frozen-order render-pass chain for `map`. Called once by the map
 *  constructor (after `new RenderLoop`) to register the chain the engine loop
 *  iterates. The nodes only DEREFERENCE map members at render time, so building
 *  the chain before `run()` populates renderer / ctx / stages is safe. */
export function buildRenderNodes(map: XGISMap): RenderNode[] {
  return [
    adapt(backgroundPass, map),
    adapt(opaquePass, map),
    adapt(oitPass, map),
    adapt(translucentPass, map),
    adapt(pointsPass, map),
    adapt(labelPass, map),
    adapt(heatmapPass, map),
    adapt(overdrawComposePass, map),
    // #797 P1 — retained host-drawing icons composite LAST (single-sample onto the
    // resolved swapchain), so they read on top of every layer. Gated by
    // scene.hasGraphics → inert (no pass) when no host batch exists.
    adapt(graphicsPass, map),
  ]
}
