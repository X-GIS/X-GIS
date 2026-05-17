// ═══ dead-layer-elim ═══
//
// Drops RenderNodes that can never produce a visible pixel. The
// bucket scheduler already does per-frame visibility checks (zoom
// range, opacity threshold) but it still touches every node every
// frame to make those decisions. This pass removes the nodes
// outright, so the scheduler's hot loop walks fewer entries.
//
// What it eliminates:
//
//   - `visible: false` — explicitly hidden by the author. The
//     scheduler's check is `if (show.visible === false) continue`
//     — dropping these here saves the check + skipped iteration.
//
//   - `minzoom >= maxzoom` — the zoom range is empty. No camera
//     zoom satisfies both `cameraZoom >= minzoom` and `cameraZoom
//     < maxzoom` simultaneously, so the layer can never draw.
//     Caught by the scheduler per-frame; cheap to catch once here.
//
//   - **Statically transparent paint.** A layer whose `fill` is
//     `kind: 'none'`, `stroke` is `kind: 'none'`, AND has no
//     `label` text — there's nothing to draw. Different from
//     `opacity: 0` which we LEAVE alone because animations can
//     bring it visible (the scheduler's runtime threshold handles
//     that case correctly).
//
// What it does NOT eliminate:
//
//   - Layers with `opacity: { kind: 'constant', value: 0 }` —
//     might be the base for a `keyframes` animation that brings it
//     visible. Conservative: let the scheduler's per-frame
//     `composedOpa < 0.005` check filter at render time.
//   - Layers with extreme `minzoom`/`maxzoom` values that the
//     CAMERA happens not to reach — the layer might still render
//     in a different camera state. Not dead, just out of view.

import type { IRPass } from '../pass-manager'
import type { Scene, RenderNode } from '../render-node'

function isDeadLayer(node: RenderNode, rasterSources: Set<string>): boolean {
  // Explicit author intent.
  if (node.visible === false) return true

  // Empty zoom range — minzoom MUST be strictly less than maxzoom
  // for ANY camera zoom to satisfy the scheduler's `cameraZoom >=
  // minzoom && cameraZoom < maxzoom` band. Equal bounds is empty
  // (inclusive lower, exclusive upper). minzoom > maxzoom is
  // obviously empty.
  if (node.minzoom !== undefined && node.maxzoom !== undefined
      && node.minzoom >= node.maxzoom) {
    return true
  }

  // Raster (and raster-dem) layers draw via texture sampling — they
  // declare no fill / stroke / label, so the "nothing to draw" check
  // below would falsely eliminate them. The runtime's RasterRenderer
  // activates whenever a ShowCommand points at a raster source; keep
  // the node so that ShowCommand survives. Symptom this guards
  // against: OFM Liberty's `natural_earth` shaded-relief raster
  // silently dropped, leaving the base map without ne2_shaded.
  if (rasterSources.has(node.sourceRef)) return false

  // Nothing to draw. A layer must declare at least ONE of: a fill
  // colour, a stroke (colour or width), a label, or procedural
  // geometry. If every visual surface is `none` / absent, no
  // fragment can ever survive.
  const hasFill = node.fill.kind !== 'none'
  const hasStrokeColour = node.stroke.color.kind !== 'none'
  // strokeWidth's `kind: 'constant'` with px=0 isn't fully "dead"
  // (the renderer still inserts a stencil write) but the user's
  // intent is "no stroke" — pair it with hasStrokeColour for the
  // full check. We require strokeWidth>0 AND colour to render a stroke.
  const hasStrokeWidth = node.stroke.width.kind !== 'constant'
    || node.stroke.width.value > 0
  const hasStroke = hasStrokeColour && hasStrokeWidth
  const hasLabel = node.label !== undefined
  const hasProcedural = node.geometry !== null
  if (!hasFill && !hasStroke && !hasLabel && !hasProcedural) return true

  return false
}

/** PassManager-compatible entry. Filters the renderNodes array. */
export const deadLayerElimPass: IRPass = {
  name: 'dead-layer-elim',
  // After merge-layers because the merge pass produces compound
  // nodes whose paint surfaces are the UNION of the inputs — a
  // pre-merge `none` slot can become `match()` driven after merge.
  // After fold-trivial-stops and fold-trivial-case so PassManager
  // has a deterministic order; the folds may convert a
  // `data-driven` match into `constant`, which doesn't change
  // dead-elim's decisions (it only looks at `kind`s, not values)
  // but the deterministic order keeps trace replays stable.
  dependencies: ['merge-layers', 'fold-trivial-stops', 'fold-trivial-case'],
  run(scene: Scene): Scene {
    const rasterSources = new Set(
      scene.sources
        .filter(s => s.type === 'raster' || s.type === 'raster-dem')
        .map(s => s.name),
    )
    const live = scene.renderNodes.filter(n => !isDeadLayer(n, rasterSources))
    if (live.length === scene.renderNodes.length) return scene
    return { ...scene, renderNodes: live }
  },
}
