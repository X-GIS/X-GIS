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

import type { ColorValue, SizeValue } from './render-node'
import type { PropertyShape, RGBA } from './property-types'

/** CPU-side stand-in for a `@color` / `@stroke` stage block (#1538). The
 *  real colour is computed on the GPU from the authored vec4; this only
 *  carries the facts the CPU side routes on — the paint EXISTS and is
 *  opaque. White is arbitrary and never sampled: any consumer that would
 *  show it is superseded by the variant expression. */
const STAGE_CPU_PLACEHOLDER: RGBA = [1, 1, 1, 1]

/** Convert a ColorValue to a PropertyShape<RGBA>. `kind: 'none'`
 *  collapses to `null` (caller treats it as "layer has no fill /
 *  stroke colour"). `kind: 'conditional'` folds to the fallback —
 *  the IR's conditional-color branching is a per-layer override
 *  that the renderer doesn't wire through per-frame evaluation. */
export function colorValueToShape(v: ColorValue): PropertyShape<RGBA> | null {
  switch (v.kind) {
    case 'none':
      return null
    case 'constant':
      return { kind: 'constant', value: v.rgba }
    case 'zoom-interpolated':
      return { kind: 'zoom-interpolated', stops: v.stops, base: v.base }
    case 'time-interpolated':
      return {
        kind: 'time-interpolated',
        stops: v.stops,
        loop: v.loop,
        easing: v.easing,
        delayMs: v.delayMs,
      }
    case 'data-driven':
      return { kind: 'data-driven', expr: v.expr }
    case 'stage':
      // A stage block (#1538) resolves ENTIRELY on the GPU — the authored
      // vec4 goes straight into the variant colour slot, so there is no
      // per-frame CPU colour to report. But the CPU shape is not just a
      // colour: the runtime reads its ALPHA to decide bucketing and whether
      // the paint exists at all. Returning `null` (the `none` answer) made
      // the layer render blank even though the variant carried the
      // expression — caught by the §5 gate. So: an OPAQUE placeholder,
      // which states the true facts the CPU side needs ("this layer has a
      // fill, and it is opaque") while the GPU owns the actual channels.
      return { kind: 'constant', value: STAGE_CPU_PLACEHOLDER }
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
    case 'none':
      return null
    case 'constant':
      return { kind: 'constant', value: v.value }
    case 'zoom-interpolated':
      return { kind: 'zoom-interpolated', stops: v.stops, base: v.base }
    case 'time-interpolated':
      return {
        kind: 'time-interpolated',
        stops: v.stops,
        loop: v.loop,
        easing: v.easing,
        delayMs: v.delayMs,
      }
    case 'data-driven':
      return { kind: 'data-driven', expr: v.expr }
  }
}
