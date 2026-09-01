// ═══ line-gradient ramp evaluation — extracted from line.ts (#1003 LOC ceiling) ═══
//
// Mapbox `line-gradient` (#2117) is a colour ramp sampled at `["line-progress"]`, the
// 0..1 fraction along the line. X-GIS evaluates the AUTHORED STOPS analytically in the
// fragment shader instead of baking a 256-texel LUT the way Mapbox/MapLibre (and our own
// heatmap path) do, because the line pipeline has no per-LAYER texture lane to hang a LUT
// on: group(1)'s bind group is built ONCE PER TILE SEGMENT BUFFER
// (line-renderer.ts createLayerBindGroup), while the per-layer style rides a DYNAMIC
// OFFSET into the LineLayer uniform ring. A per-layer ramp texture would therefore need a
// bind group per (tile × layer). The uniform lane the dash array already uses is the
// mechanism that exists — and evaluating the stops directly is strictly more faithful than
// a 256-texel resample, at the cost of a fixed stop budget (see LINE_GRADIENT_MAX_STOPS).
//
// Emitted into the caller's ambient scope (the If/Loop/Var free functions route to the
// innermost open scope), so this is a plain TS emitter, not a shader `fn` — a `fn` cannot
// take a uniform array as a parameter.

import { f32, u32, clamp, max, select, If, Loop, Var } from '@xgis/shader-dsl'
import type { Node, ReadonlyNode } from '@xgis/shader-dsl'

/** Ramp stops the `LineLayer` uniform carries — `gradient_color: array<vec4f, 8>` plus
 *  `gradient_pos: array<vec4f, 2>` (4 positions per vec4). The converter warns + drops a
 *  longer ramp rather than resampling colours the author placed exactly. */
export const LINE_GRADIENT_MAX_STOPS = 8

/**
 * Emit the piecewise-linear ramp lookup for `t` and return the resulting colour.
 *
 * `colorAt(i)` reads stop `i`'s straight-alpha RGBA; `posVec(v)` reads the v-th packed
 * position vec4 (stop `i`'s position is component `i % 4` of vec `i / 4`) — mirroring how
 * the dash loop reads `dash_array`.
 *
 * Stops are ascending by construction (both the converter and the IR extractor reject a
 * descending ramp), so the LAST stop whose position is ≤ t wins: that yields the correct
 * piecewise-linear blend in the interior, clamps to stop 0 below the first position, and
 * clamps to the final colour above the last — Mapbox's clamped-endpoint semantics.
 */
export function lineGradientRampColor(
  t: ReadonlyNode<'f32'>,
  count: ReadonlyNode<'u32'>,
  colorAt: (i: ReadonlyNode<'u32'>) => ReadonlyNode<'vec4<f32>'>,
  posVec: (v: ReadonlyNode<'u32'>) => ReadonlyNode<'vec4<f32>'>,
): Node<'vec4<f32>'> {
  /** Stop `i`'s position, unpacked from the 4-per-vec4 position array. */
  const posAt = (i: ReadonlyNode<'u32'>): Node<'f32'> => {
    const v = posVec(i.div(4))
    const sub = i.mod(4)
    const p = f32(0)
    If(sub.eq(0), () => {
      p.assign(v.x)
    })
      .elif(sub.eq(1), () => {
        p.assign(v.y)
      })
      .elif(sub.eq(2), () => {
        p.assign(v.z)
      })
      .else(() => {
        p.assign(v.w)
      })
    return p
  }

  const out = Var('line_grad_rgba', colorAt(u32(0)))
  Loop(
    u32(0),
    (i) => i.lt(count),
    (i) => {
      const pi = posAt(i)
      If(t.ge(pi), () => {
        // Interpolate toward the NEXT stop; the last stop pairs with itself (span 0),
        // which holds its colour for every t beyond it.
        const last = count.sub(u32(1))
        const j = select(i.lt(last), i.add(u32(1)), last)
        const pj = posAt(j)
        const span = pj.sub(pi)
        const f = select(span.gt(1e-6), clamp(t.sub(pi).div(max(span, f32(1e-6))), 0, 1), f32(0))
        const a = colorAt(i)
        const b = colorAt(j)
        out.assign(a.add(b.sub(a).mul(f)))
      })
    },
  )
  return out
}
