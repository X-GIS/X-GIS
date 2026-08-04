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

import type { ColorValue, DataExpr, SizeValue } from './render-node'
import { rgbaToHex } from './render-node'
import type { PropertyShape, RGBA } from './property-types'
import { constFold } from './const-fold'

/** CPU-side stand-in for a `@color` / `@stroke` stage block (#1538) whose
 *  body reads feature data. The real colour is computed on the GPU from
 *  the authored vec4; this only carries the facts the CPU side routes on —
 *  the paint EXISTS and is opaque. White is arbitrary and never sampled:
 *  any consumer that would show it is superseded by the variant
 *  expression. A body with no feature/zoom/time deps skips this
 *  placeholder entirely — see `foldStageConstantRgba`. */
const STAGE_CPU_PLACEHOLDER: RGBA = [1, 1, 1, 1]

/** CPU-evaluate a `@color`/`@stroke` stage body (#1538) to a constant RGBA
 *  when it is compile-time CONSTANT (no `zoom`, no per-feature field reads —
 *  the same classifyExpr/constFold authority optimize.ts's optimizeColor
 *  already uses for `data-driven` paint values). Returns null for a
 *  data-driven body (the WebGL2/RHI GPU-only limitation this does NOT fix —
 *  caller keeps the placeholder) or a body whose fold result isn't a
 *  4-element finite-number array (X-GIS0020 rejects a non-vec4 return at
 *  lower time, but lower() doesn't halt on diagnostics, so a caller that
 *  compiles past errors could still reach here with e.g. a bare scalar).
 *  Never throws — constFold already absorbs evaluator throws internally. */
export function foldStageConstantRgba(expr: DataExpr): RGBA | null {
  const folded = constFold(expr.ast)
  if (folded === null || !Array.isArray(folded.value) || folded.value.length !== 4) return null
  const [r, g, b, a] = folded.value
  const isFiniteNumber = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
  if (!isFiniteNumber(r) || !isFiniteNumber(g) || !isFiniteNumber(b) || !isFiniteNumber(a)) {
    return null
  }
  // Clamp to 0-1 — mirrors the rgb()/rgba() CPU builtins' existing 0-255
  // clamp convention (evaluator-helpers.ts), so an out-of-range authored
  // constant can't corrupt rgbaToHex's fixed-width hex encoding downstream.
  const clamp01 = (n: number) => Math.max(0, Math.min(1, n))
  return [clamp01(r), clamp01(g), clamp01(b), clamp01(a)]
}

/** Opaque CPU stand-in for a data-driven stage-block colour (#1538) — see
 *  `stageColorHex`. Never sampled: the GPU expression owns every channel. */
const STAGE_CPU_PLACEHOLDER_HEX = '#ffffffff'

/** The hex `colorToHex` (emit-commands.ts) should report for a stage body
 *  (#1538): its real colour when compile-time-constant, else the opaque CPU
 *  placeholder — WebGL2/RHI never compiles that GPU variant and always
 *  paints whichever hex is reported here, so `null` rendered nothing. */
export function stageColorHex(expr: DataExpr): string {
  const rgba = foldStageConstantRgba(expr)
  return rgba ? rgbaToHex(rgba) : STAGE_CPU_PLACEHOLDER_HEX
}

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
    case 'stage': {
      // A stage block (#1538) resolves ENTIRELY on the GPU — for a
      // data-driven body there is no per-frame CPU colour to report. But
      // the CPU shape is not just a colour: the runtime reads its ALPHA to
      // decide bucketing and whether the paint exists at all. Returning
      // `null` (the `none` answer) made the layer render blank even though
      // the variant carried the expression — caught by the §5 gate. So: an
      // OPAQUE placeholder, which states the true facts the CPU side needs
      // ("this layer has a fill, and it is opaque") while the GPU owns the
      // actual channels. A compile-time-constant body (no feature/zoom/time
      // deps) instead reports its REAL colour via foldStageConstantRgba —
      // needed because the WebGL2/RHI fill path never compiles a GPU
      // variant and always paints this CPU-reported colour.
      const rgba = foldStageConstantRgba(v.expr)
      return { kind: 'constant', value: rgba ?? STAGE_CPU_PLACEHOLDER }
    }
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
