// ═══════════════════════════════════════════════════════════════════
// RenderNode → PropertyShape conversion
// ═══════════════════════════════════════════════════════════════════
//
// `OpacityValue` and `StrokeWidthValue` are now `PropertyShape<number>`
// aliases — emit-commands passes them through directly. The shims that
// remain handle the per-domain unions whose `kind: 'none'` (Color /
// Size) or `kind: 'conditional'` (Color) variants don't exist on
// PropertyShape; those collapse to `null` or fold to a fallback during
// conversion.

import type {
  ColorValue, SizeValue,
} from './render-node'
import type { PropertyShape, RGBA } from './property-types'

/** Convert a ColorValue to a PropertyShape<RGBA>. `kind: 'none'`
 *  collapses to `null` (caller treats it as "layer has no fill /
 *  stroke colour"). `kind: 'conditional'` folds to the fallback —
 *  the IR's conditional-color branching is a per-layer override
 *  that the renderer doesn't wire through per-frame evaluation. */
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
      return colorValueToShape(v.fallback)
  }
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
