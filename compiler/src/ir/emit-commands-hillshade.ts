// ═══ IR → commands — hillshade paint bundle emit (#777 Phase II) ═══
//
// The `paintShapes.hillshade` presence test + fold, factored out of
// emit-commands.ts to keep that file under its LOC ceiling (mirrors INC-1's
// paint-hillshade.ts / lower-bindings-hillshade.ts split). emitShow() calls
// hasHillshadePaint() to gate the optional bundle and emitHillshadeShapes() to
// fold the node's flat hillshade fields into the typed HillshadeShapes.

import type { RenderNode } from './render-node'
import type { HillshadeShapes } from './property-types'

/** True iff the node authored ANY hillshade axis — the presence signal for
 *  the optional `paintShapes.hillshade` bundle. A default-only hillshade
 *  layer (byte-minimal, no authored axis) carries no bundle; the runtime
 *  falls back to `defaultHillshadeShapes()` for a raster-dem draw. */
export function hasHillshadePaint(node: RenderNode): boolean {
  return (
    node.hillshadeDirection !== undefined ||
    node.hillshadeAltitude !== undefined ||
    node.hillshadeAnchorMap !== undefined ||
    node.hillshadeExaggeration !== undefined ||
    node.hillshadeShadow !== undefined ||
    node.hillshadeHighlight !== undefined ||
    node.hillshadeAccent !== undefined ||
    node.hillshadeMethod !== undefined ||
    node.hillshadeResamplingNearest !== undefined
  )
}

/** Fold the node's flat hillshade fields into the typed HillshadeShapes
 *  bundle, seeding the spec default for every unauthored axis. Mirror of the
 *  raster block in emitShow(). */
export function emitHillshadeShapes(node: RenderNode): HillshadeShapes {
  return {
    direction: { kind: 'constant', value: node.hillshadeDirection ?? 335 },
    altitude: { kind: 'constant', value: node.hillshadeAltitude ?? 45 },
    anchorMap: node.hillshadeAnchorMap ?? false,
    exaggeration: { kind: 'constant', value: node.hillshadeExaggeration ?? 0.5 },
    shadow: { kind: 'constant', value: node.hillshadeShadow ?? [0, 0, 0, 1] },
    highlight: { kind: 'constant', value: node.hillshadeHighlight ?? [1, 1, 1, 1] },
    accent: { kind: 'constant', value: node.hillshadeAccent ?? [0, 0, 0, 1] },
    method: node.hillshadeMethod ?? 'standard',
    resamplingNearest: node.hillshadeResamplingNearest ?? false,
  }
}
