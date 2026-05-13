// ═══ fold-trivial-stops ═══
//
// IR optimisation pass: a `zoom-interpolated` value whose every stop
// holds the SAME payload is functionally indistinguishable from a
// constant. Fold it.
//
// Why bother:
//
//   - **Per-frame cost.** `resolveNumberShape` does a binary search
//     + interpolation on every animated paint property of every show
//     command, every frame. A trivial-stops shape that's been folded
//     to `constant` short-circuits to a single field read.
//
//   - **Stable IR for downstream.** Once folded to `constant`, the
//     per-frame clone-decision skips the allocation, and the
//     bucket-scheduler's classifier emits fewer animated paths.
//
//   - **Spec-equivalent.** Mapbox's interpolate evaluator returns
//     the same value either way; folding is a pure optimisation
//     with no observable behaviour change.
//
// What this pass touches:
//
//   - `RenderNode.fill` / `.stroke.color` (ColorValue)
//   - `RenderNode.stroke.width` (StrokeWidthValue)
//   - `RenderNode.opacity` (PropertyShape<number>)
//   - `RenderNode.size` (SizeValue)
//   - `RenderNode.label.size` / `.color` zoom-stop overrides
//
// What it does NOT touch:
//
//   - `time-interpolated` shapes — even when every stop is equal,
//     they may still produce a non-constant value via loop+ease
//     timing semantics; the cost saving doesn't justify the
//     dispatch-correctness risk.
//   - `data-driven` / `per-feature` — the value depends on feature
//     properties, not zoom; folding makes no sense.
//   - `zoom-time` — composite; would need both halves trivial.
//     Rare in real styles; defer until measured.

import type { IRPass } from '../pass-manager'
import type {
  Scene, RenderNode,
  ColorValue, StrokeValue, StrokeWidthValue, OpacityValue, SizeValue,
} from '../render-node'

/** Numeric tolerance for "the stops carry the same value". Real-world
 *  inputs from Mapbox JSON come in as exact decimals — `[[2, 1.5],
 *  [10, 1.5]]` — so a strict `===` would suffice; the epsilon is
 *  insurance against authoring tooling that round-trips floats. */
const NUMBER_EPS = 1e-9

function numbersEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < NUMBER_EPS
}

function rgbaEqual(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number],
): boolean {
  return numbersEqual(a[0], b[0]) && numbersEqual(a[1], b[1])
    && numbersEqual(a[2], b[2]) && numbersEqual(a[3], b[3])
}

function foldNumberShape(shape: OpacityValue): OpacityValue {
  if (shape.kind !== 'zoom-interpolated') return shape
  if (shape.stops.length === 0) return shape
  const first = shape.stops[0]!.value
  for (let i = 1; i < shape.stops.length; i++) {
    if (!numbersEqual(shape.stops[i]!.value, first)) return shape
  }
  return { kind: 'constant', value: first }
}

function foldColor(value: ColorValue): ColorValue {
  if (value.kind !== 'zoom-interpolated') return value
  if (value.stops.length === 0) return value
  const first = value.stops[0]!.value
  for (let i = 1; i < value.stops.length; i++) {
    if (!rgbaEqual(value.stops[i]!.value, first)) return value
  }
  return { kind: 'constant', rgba: first as [number, number, number, number] }
}

function foldStrokeWidth(value: StrokeWidthValue): StrokeWidthValue {
  if (value.kind !== 'zoom-interpolated') return value
  if (value.stops.length === 0) return value
  const first = value.stops[0]!.value
  for (let i = 1; i < value.stops.length; i++) {
    if (!numbersEqual(value.stops[i]!.value, first)) return value
  }
  return { kind: 'constant', value: first }
}

function foldSize(value: SizeValue): SizeValue {
  if (value.kind !== 'zoom-interpolated') return value
  if (value.stops.length === 0) return value
  const first = value.stops[0]!.value
  for (let i = 1; i < value.stops.length; i++) {
    if (!numbersEqual(value.stops[i]!.value, first)) return value
  }
  return { kind: 'constant', value: first }
}

function foldStroke(stroke: StrokeValue): StrokeValue {
  const color = foldColor(stroke.color)
  const width = foldStrokeWidth(stroke.width)
  if (color === stroke.color && width === stroke.width) return stroke
  return { ...stroke, color, width }
}

/** Build a new RenderNode with trivial-stops folded. Returns the same
 *  object reference when nothing changed so downstream identity
 *  checks (and the manager's no-op detection) stay cheap. */
function foldRenderNode(node: RenderNode): RenderNode {
  const fill = foldColor(node.fill)
  const stroke = foldStroke(node.stroke)
  const opacity = foldNumberShape(node.opacity)
  const size = foldSize(node.size)

  if (
    fill === node.fill && stroke === node.stroke
    && opacity === node.opacity && size === node.size
  ) return node

  return { ...node, fill, stroke, opacity, size }
}

/** PassManager-compatible entry. Pure transform. */
export const foldTrivialStopsPass: IRPass = {
  name: 'fold-trivial-stops',
  // Folds the IR a layer ↑ from `merge-layers` — that pass may
  // synthesize zoom stops on the merged compound, so we run after
  // it so any merge-introduced trivial-stops also get folded.
  dependencies: ['merge-layers'],
  run(scene: Scene): Scene {
    const folded = scene.renderNodes.map(foldRenderNode)
    // Reuse the input scene reference when nothing folded — keeps the
    // pass cheap for already-canonical IR (real-world styles where
    // authors didn't write redundant stops).
    const changed = folded.some((n, i) => n !== scene.renderNodes[i])
    return changed ? { ...scene, renderNodes: folded } : scene
  },
}
