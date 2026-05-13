// ═══════════════════════════════════════════════════════════════════
// RenderNode → PropertyShape conversion (Plan Step 1)
// ═══════════════════════════════════════════════════════════════════
//
// Temporary migration shim. PropertyShape<T> kind names match the
// legacy RenderNode unions one-to-one, so once those unions become
// `type OpacityValue = PropertyShape<number>` (Step 1b) the
// conversion is trivially the identity and these helpers can be
// removed. Until Step 1b lands, the helpers normalise the few
// remaining field-name differences (rgba/px/value, per-feature →
// data-driven, zoom-stops → zoom-interpolated, conditional →
// data-driven via case-AST flattening).

import type {
  ColorValue, OpacityValue, StrokeWidthValue, SizeValue,
} from './render-node'
import type { PropertyShape, RGBA } from './property-types'

/** Convert a ColorValue to a PropertyShape<RGBA>. `kind: 'none'`
 *  collapses to `null` (caller treats it as "layer has no fill /
 *  stroke colour"). `kind: 'conditional'` folds to the fallback for
 *  now — the IR's conditional-color branching is a per-layer
 *  override that the renderer doesn't yet wire through per-frame
 *  evaluation. */
export function colorValueToShape(v: ColorValue): PropertyShape<RGBA> | null {
  switch (v.kind) {
    case 'none': return null
    case 'constant': return { kind: 'constant', value: v.rgba as RGBA }
    case 'zoom-interpolated':
      return { kind: 'zoom-interpolated', stops: v.stops as ReadonlyArray<{ zoom: number; value: RGBA }> as never, base: v.base }
    case 'time-interpolated':
      return {
        kind: 'time-interpolated',
        stops: v.stops as ReadonlyArray<{ timeMs: number; value: RGBA }> as never,
        loop: v.loop, easing: v.easing, delayMs: v.delayMs,
      }
    case 'data-driven':
      return { kind: 'data-driven', expr: v.expr }
    case 'conditional':
      // Phase 1: fold to fallback. A future revision can carry the
      // full branch list as a single data-driven AST.
      return colorValueToShape(v.fallback)
  }
}

/** Convert an OpacityValue to a PropertyShape<number>. */
export function opacityValueToShape(v: OpacityValue): PropertyShape<number> {
  switch (v.kind) {
    case 'constant': return { kind: 'constant', value: v.value }
    case 'zoom-interpolated':
      return { kind: 'zoom-interpolated', stops: v.stops, base: v.base }
    case 'time-interpolated':
      return {
        kind: 'time-interpolated',
        stops: v.stops, loop: v.loop, easing: v.easing, delayMs: v.delayMs,
      }
    case 'zoom-time':
      return {
        kind: 'zoom-time',
        zoomStops: v.zoomStops, timeStops: v.timeStops,
        loop: v.loop, easing: v.easing, delayMs: v.delayMs,
      }
    case 'data-driven':
      return { kind: 'data-driven', expr: v.expr }
  }
}

/** Convert a StrokeWidthValue to a PropertyShape<number>.
 *
 *  StrokeWidthValue is now an alias of `PropertyShape<number>` (post
 *  kinds + field rename); the helper survives as identity for callsite
 *  compatibility. Time stops for stroke width live on the parent
 *  StrokeValue as `timeWidthStops` (see render-node.ts) — emit-commands
 *  composes them with the spatial shape when populating
 *  PaintShapes.strokeWidth. This helper only forwards the spatial
 *  half; time composition is the caller's job. */
export function strokeWidthValueToShape(v: StrokeWidthValue): PropertyShape<number> {
  return v
}

/** Convert a SizeValue to a PropertyShape<number>. `kind: 'none'`
 *  collapses to `null` (caller treats it as "layer doesn't author
 *  point / symbol size"). The optional `unit` field is dropped —
 *  unit handling is the renderer's responsibility, not part of
 *  evaluation. */
export function sizeValueToShape(v: SizeValue): PropertyShape<number> | null {
  switch (v.kind) {
    case 'none': return null
    case 'constant': return { kind: 'constant', value: v.value }
    case 'zoom-interpolated':
      return { kind: 'zoom-interpolated', stops: v.stops, base: v.base }
    case 'time-interpolated':
      return {
        kind: 'time-interpolated',
        stops: v.stops, loop: v.loop, easing: v.easing, delayMs: v.delayMs,
      }
    case 'data-driven':
      return { kind: 'data-driven', expr: v.expr }
  }
}
