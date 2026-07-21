// ═══ IR → commands — hillshade paint bundle emit (#777 Phase II) ═══
//
// The `paintShapes.hillshade` presence test + fold, factored out of
// emit-commands.ts to keep that file under its LOC ceiling (mirrors INC-1's
// paint-hillshade.ts / lower-bindings-hillshade.ts split). emitShow() calls
// hasHillshadePaint() to gate the optional bundle and emitHillshadeShapes() to
// fold the node's flat hillshade fields into the typed HillshadeShapes.

import type { RenderNode } from './render-node'
import type { HillshadeExtraSourceShape, HillshadeShapes } from './property-types'

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
    node.hillshadeResamplingNearest !== undefined ||
    node.hillshadeExtraSources !== undefined
  )
}

/** Fold the node's flat hillshade fields into the typed HillshadeShapes
 *  bundle, seeding the spec default for every unauthored axis. Mirror of the
 *  raster block in emitShow(). Extra multidirectional sources resolve a
 *  missing axis from source 1 (MapLibre pads short arrays by repeating the
 *  last element; with sparse per-axis utilities that collapses to source 1). */
export function emitHillshadeShapes(node: RenderNode): HillshadeShapes {
  const shadow1 = node.hillshadeShadow ?? ([0, 0, 0, 1] as [number, number, number, number])
  const highlight1 = node.hillshadeHighlight ?? ([1, 1, 1, 1] as [number, number, number, number])
  const extraSources: HillshadeExtraSourceShape[] = (node.hillshadeExtraSources ?? [])
    .filter((s): s is NonNullable<typeof s> => s !== undefined && s !== null)
    .map((s) => ({
      direction: s.direction ?? node.hillshadeDirection ?? 335,
      altitude: s.altitude ?? node.hillshadeAltitude ?? 45,
      shadow: s.shadow ?? shadow1,
      highlight: s.highlight ?? highlight1,
    }))
  return {
    direction: { kind: 'constant', value: node.hillshadeDirection ?? 335 },
    altitude: { kind: 'constant', value: node.hillshadeAltitude ?? 45 },
    anchorMap: node.hillshadeAnchorMap ?? false,
    exaggeration: { kind: 'constant', value: node.hillshadeExaggeration ?? 0.5 },
    shadow: { kind: 'constant', value: shadow1 },
    highlight: { kind: 'constant', value: highlight1 },
    accent: { kind: 'constant', value: node.hillshadeAccent ?? [0, 0, 0, 1] },
    method: node.hillshadeMethod ?? 'standard',
    resamplingNearest: node.hillshadeResamplingNearest ?? false,
    extraSources,
  }
}
