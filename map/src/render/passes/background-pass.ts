// ═══ Bucket 0: background / coverage pass ═══
//
// Runs FIRST in the chain (before opaque) and owns the colour-target
// clear. This is the redesign's "every pixel has a defined source"
// coverage layer (docs/redesign/VISION.md §4, §5 gap #1): before any
// geometry draws, ONE pass decides what fills the whole viewport, so the
// region OUTSIDE the world band (low-zoom letterbox, the sky above a
// pitched horizon, the area around a shrunk disc) is never an accidental
// black void.
//
// Per-projection coverage (`backgroundClearValue`):
//   • Flat / cylindrical (mercator 0 / equirect 1 / natural_earth 2 /
//     oblique_mercator 6 — worldBand ≠ 'sphere-full') → the style
//     `background-color`. The whole viewport is the background; the
//     inside-band synthetic earth-surface redraws the same colour on top
//     (seamless). This DELIBERATELY reverses the iter-196 black-outside-
//     world MapLibre-parity convention for CORE/SHOWCASE (VISION §1).
//   • Disc / globe (orthographic 3 / azimuthal 4 / stereographic 5 /
//     globe 7 — worldBand 'sphere-full') → defined pure-black space. The
//     atmosphere limb-glow is a separate, deferred pass (VISION §2.3).
//   • ?debug=overdraw → the r16float accumulator clears to 0.
//   • Flat projection with no `background` block → defined black.
//
// Depth / stencil / pick clears STAY with the opaque first sub-pass (they
// are bucket-1 concerns). This pass is never the LAST colour writer, so it
// never claims `resolveTarget` — the resolveOwner chain (opaque /
// composite / points) and the label pass own the MSAA resolve unchanged.

import { DEBUG_OVERDRAW } from '../../debug-flags'
import { worldBandForProjType } from '@xgis/geo'
import { resolveColorShape, resolveNumberShape } from '../paint-shape-resolve'
import type { FrameContext } from '../frame-context'
import { unwrapProjection } from '@xgis/engine'
import type { SceneView } from '../scene-view'
import type { RenderPass, BackgroundPassHost } from './pass'

/** RGBA in straight-alpha unit floats (0..1), as `XGISMap._backgroundColor`
 *  stores it. */
type Rgba = readonly [number, number, number, number]

/** Pure, fully-unit-testable: pick the whole-viewport clear colour for a
 *  frame from the resolved projection kind + style background. Kept a free
 *  function (not inline) so its branches are gated by behaviour, not by a
 *  brittle source-text regex. */
export function backgroundClearValue(
  projType: number,
  bg: Rgba | null,
  overdraw: boolean,
): { r: number; g: number; b: number; a: number } {
  // Overdraw accumulator must start at 0 — an a:1 clear would bias every
  // pixel with one synthetic background fragment before any real draw.
  if (overdraw) return { r: 0, g: 0, b: 0, a: 0 }
  // Disc / globe: pure-black space (atmosphere is a separate deferred pass).
  if (worldBandForProjType(projType) === 'sphere-full') return { r: 0, g: 0, b: 0, a: 1 }
  // Flat / cylindrical: the style background fills the whole viewport.
  if (bg) return { r: bg[0], g: bg[1], b: bg[2], a: bg[3] }
  // Flat with no `background` block declared → defined black.
  return { r: 0, g: 0, b: 0, a: 1 }
}

class BackgroundPass implements RenderPass {
  readonly label = 'background'

  // Always runs — the colour target must be cleared every frame even with
  // no layers, exactly as the opaque first sub-pass did before.
  shouldRun(): boolean {
    return true
  }

  execute(ctx: FrameContext, _scene: SceneView, host: BackgroundPassHost): void {
    // WS-1 — resolve a zoom-interpolated background-color / -opacity to
    // this frame's RGBA before picking the clear colour. `backgroundClearValue`
    // stays a pure function: it receives the already-resolved RGBA. Constant
    // backgrounds skip the resolve (shape === null) and pass `_backgroundColor`
    // through unchanged.
    const colorShape = host._backgroundColorShape
    let bg = host._backgroundColor
    if (colorShape) {
      const resolved = resolveColorShape(colorShape, ctx.camera.zoom, ctx.elapsedMs)
      if (resolved)
        bg = [resolved.value[0], resolved.value[1], resolved.value[2], resolved.value[3]]
    }
    const opacityShape = host._backgroundOpacityShape
    if (opacityShape && bg) {
      const a = resolveNumberShape(opacityShape, ctx.camera.zoom, ctx.elapsedMs).value
      bg = [bg[0], bg[1], bg[2], bg[3] * a]
    }
    const clearValue = backgroundClearValue(
      unwrapProjection(ctx.projection).projType,
      bg,
      DEBUG_OVERDRAW,
    )
    ctx.passScope('background', () => {
      const pass = ctx.encoder.beginRenderPass({
        colorAttachments: [
          {
            view: ctx.colorView,
            // Never the last colour writer → no resolveTarget.
            clearValue,
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      })
      pass.end()
    })
  }
}

/** Stateless singleton — the background / coverage clear pass. */
export const backgroundPass: RenderPass = new BackgroundPass()
