// ═══════════════════════════════════════════════════════════════════
// RenderNode → PropertyShape conversion (Plan Step 1)
// ═══════════════════════════════════════════════════════════════════
//
// Maps each existing RenderNode discriminated union (ColorValue,
// OpacityValue, StrokeWidthValue, SizeValue) to the unified
// PropertyShape<T>. This is the conversion layer that lets
// emit-commands populate ShowCommand.paintShapes WITHOUT changing
// the RenderNode IR's shape.
//
// Each helper handles every variant of its input union and produces
// a PropertyShape with the equivalent semantics. Exhaustiveness is
// enforced — the switch over `kind` covers every variant the input
// union declares, and TypeScript will flag a new variant if added.

import type {
  ColorValue, OpacityValue, StrokeWidthValue, SizeValue,
} from './render-node'
import type { PropertyShape, RGBA } from './property-types'

/** Convert a ColorValue to a PropertyShape<RGBA>. `kind: 'none'`
 *  collapses to `null` (caller treats it as "layer has no fill /
 *  stroke colour"). `kind: 'conditional'` flattens to the fallback
 *  for now — the IR's conditional-color branching is a per-layer
 *  override that the renderer doesn't yet wire through per-frame
 *  evaluation; a future revision can add a dedicated PropertyShape
 *  variant if conditional colors need per-frame switching. */
export function colorValueToShape(v: ColorValue): PropertyShape<RGBA> | null {
  switch (v.kind) {
    case 'none': return null
    case 'constant': return { kind: 'Static', value: v.rgba as RGBA }
    case 'zoom-interpolated':
      return { kind: 'ZoomOnly', stops: v.stops as ReadonlyArray<{ zoom: number; value: RGBA }> as never, base: v.base }
    case 'time-interpolated':
      return {
        kind: 'TimeOnly',
        stops: v.stops as ReadonlyArray<{ timeMs: number; value: RGBA }> as never,
        loop: v.loop, easing: v.easing, delayMs: v.delayMs,
      }
    case 'data-driven':
      return { kind: 'FeatureOnly', expr: v.expr }
    case 'conditional':
      // Phase 1: fold to fallback. A future variant can carry the
      // full branch list when the renderer learns to evaluate it.
      return colorValueToShape(v.fallback)
  }
}

/** Convert an OpacityValue to a PropertyShape<number>. */
export function opacityValueToShape(v: OpacityValue): PropertyShape<number> {
  switch (v.kind) {
    case 'constant': return { kind: 'Static', value: v.value }
    case 'zoom-interpolated':
      return { kind: 'ZoomOnly', stops: v.stops, base: v.base }
    case 'time-interpolated':
      return {
        kind: 'TimeOnly',
        stops: v.stops, loop: v.loop, easing: v.easing, delayMs: v.delayMs,
      }
    case 'zoom-time':
      return {
        kind: 'ZoomTime',
        zoomStops: v.zoomStops, timeStops: v.timeStops,
        loop: v.loop, easing: v.easing, delayMs: v.delayMs,
      }
    case 'data-driven':
      return { kind: 'FeatureOnly', expr: v.expr }
  }
}

/** Convert a StrokeWidthValue to a PropertyShape<number>.
 *
 *  StrokeWidthValue only carries the SPATIAL dependency (constant /
 *  zoom-stops / per-feature). Time stops for stroke width live on the
 *  parent StrokeValue as `timeWidthStops` (see render-node.ts:478) —
 *  emit-commands composes them with the spatial shape when populating
 *  PaintShapes.strokeWidth (see ShowCommand path). This helper only
 *  handles the spatial half; time composition is the caller's job. */
export function strokeWidthValueToShape(v: StrokeWidthValue): PropertyShape<number> {
  switch (v.kind) {
    case 'constant': return { kind: 'Static', value: v.px }
    case 'zoom-stops':
      return { kind: 'ZoomOnly', stops: v.stops, base: v.base }
    case 'per-feature':
      return { kind: 'FeatureOnly', expr: v.expr }
  }
}

/** Convert a SizeValue to a PropertyShape<number>. `kind: 'none'`
 *  collapses to `null` (caller treats it as "layer doesn't author
 *  point / symbol size"). */
export function sizeValueToShape(v: SizeValue): PropertyShape<number> | null {
  switch (v.kind) {
    case 'none': return null
    case 'constant': return { kind: 'Static', value: v.value }
    case 'zoom-interpolated':
      return { kind: 'ZoomOnly', stops: v.stops, base: v.base }
    case 'time-interpolated':
      return {
        kind: 'TimeOnly',
        stops: v.stops, loop: v.loop, easing: v.easing, delayMs: v.delayMs,
      }
    case 'data-driven':
      return { kind: 'FeatureOnly', expr: v.expr }
  }
}
