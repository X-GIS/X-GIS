// ═══ AST → IR Lowering: KEYFRAME → time-stop expansion sub-pass ═══
// Pure module-level extraction of the keyframe time-stop expansion from
// `lowerLayer` (lower.ts). Expands a referenced `keyframes` block into the
// six per-property time-stop arrays at the layer's animation duration.
// Same idiom as lower.ts' `applyStyleProperties` / `foldLabelKnobs` and the
// label sub-pass — a stateless function, explicit params in, fragment out.
// NOT a context class.
//
// DO-NOT-SPLIT #2 (lower.ts decomposition): the CALL must stay AFTER the
// utility loop (so `animationName` / `animationDurationMs` are set) and
// BEFORE the opacity/fill/stroke/size promotion block (which reads the six
// arrays). Same position as the inline block had.

import type * as AST from '../parser/ast'
import { resolveColor } from '../tokens/colors'
import type { RGBA } from './property-types'
import { type TimeStop, hexToRgba } from './render-node'

/** The six per-property time-stop arrays produced by a keyframe expansion. */
export interface KeyframeTimeStops {
  opacityTimeStops: TimeStop<number>[]
  fillTimeStops: TimeStop<RGBA>[]
  strokeColorTimeStops: TimeStop<RGBA>[]
  strokeWidthTimeStops: TimeStop<number>[]
  sizeTimeStops: TimeStop<number>[]
  dashOffsetTimeStops: TimeStop<number>[]
}

/**
 * Expand a referenced `keyframes` block into the six per-property time-stop
 * arrays at the layer's animation duration; throw if the reference is unknown.
 *
 * PR 1 covered opacity. PR 3 covers fill, stroke color, stroke width, point
 * size, and stroke dash-offset — the five properties that already have
 * concrete per-layer uniform slots. PR 5 will add transforms, PR 6 filters.
 *
 * Returns six EMPTY arrays when `animationName` is null. Reads ONLY the five
 * inputs; nothing is written back. The promotion block destructures the
 * result and runs unchanged.
 *
 * @param animationName       referenced keyframes name (null = no animation)
 * @param animationDurationMs duration in ms; scales each frame's percent
 * @param keyframesMap        the program's keyframes symbol table
 * @param stmtName            layer name (for the unknown-keyframes throw)
 * @param stmtLine            layer statement line (for the throw)
 */
export function expandKeyframeTimeStops(
  animationName: string | null,
  animationDurationMs: number,
  keyframesMap: Map<string, AST.KeyframesStatement>,
  stmtName: string,
  stmtLine: number,
): KeyframeTimeStops {
  const opacityTimeStops: TimeStop<number>[] = []
  const fillTimeStops: TimeStop<RGBA>[] = []
  const strokeColorTimeStops: TimeStop<RGBA>[] = []
  const strokeWidthTimeStops: TimeStop<number>[] = []
  const sizeTimeStops: TimeStop<number>[] = []
  const dashOffsetTimeStops: TimeStop<number>[] = []
  if (animationName) {
    const kf = keyframesMap.get(animationName)
    if (!kf) {
      throw new Error(
        `Unknown keyframes reference: animation-${animationName} ` +
          `(layer '${stmtName}' at line ${stmtLine})`,
      )
    }
    for (const frame of kf.frames) {
      const timeMs = (frame.percent / 100) * animationDurationMs
      for (const item of frame.utilities) {
        const uname = item.name
        // ── opacity ──
        if (uname.startsWith('opacity-')) {
          const num = parseFloat(uname.slice('opacity-'.length))
          if (!isNaN(num)) {
            opacityTimeStops.push({
              timeMs,
              value: num / 100,
            })
          }
          continue
        }
        // ── dash-offset (meters) ──
        // Must come before the generic `stroke-` branch because
        // `stroke-dashoffset-N` shares the prefix.
        if (uname.startsWith('stroke-dashoffset-')) {
          const num = parseFloat(uname.slice('stroke-dashoffset-'.length))
          if (!isNaN(num)) dashOffsetTimeStops.push({ timeMs, value: num })
          continue
        }
        // ── fill color ──
        if (uname.startsWith('fill-')) {
          const hex = resolveColor(uname.slice('fill-'.length))
          if (hex) fillTimeStops.push({ timeMs, value: hexToRgba(hex) })
          continue
        }
        // ── stroke: either color or width ──
        // The existing static lowering treats `stroke-<number>` as
        // width and `stroke-<colorname>` as color. Mirror that here.
        if (uname.startsWith('stroke-')) {
          const rest = uname.slice('stroke-'.length)
          const num = parseFloat(rest)
          if (!isNaN(num) && rest === String(num)) {
            strokeWidthTimeStops.push({ timeMs, value: num })
          } else {
            const hex = resolveColor(rest)
            if (hex) strokeColorTimeStops.push({ timeMs, value: hexToRgba(hex) })
          }
          continue
        }
        // ── point size ──
        if (uname.startsWith('size-')) {
          const sizeStr = uname.slice('size-'.length)
          const unitMatch = sizeStr.match(/^([\d.]+)(px|m|km|nm|deg)?$/)
          if (unitMatch) {
            const num = parseFloat(unitMatch[1])
            if (!isNaN(num)) sizeTimeStops.push({ timeMs, value: num })
          }
          continue
        }
        // Unknown keyframe utilities are silently ignored. Future PRs
        // extend this loop (transforms, filters, etc.).
      }
    }
  }

  return {
    opacityTimeStops,
    fillTimeStops,
    strokeColorTimeStops,
    strokeWidthTimeStops,
    sizeTimeStops,
    dashOffsetTimeStops,
  }
}
