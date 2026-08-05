// ═══ ?debug=overdraw is a WHOLE-FRAME mode, gated once (#1046 Inc-F2d review F1/F2) ═══
//
// docs/architecture/render-graph-pass-scheduler.md states the invariant: overdraw
// is a whole-frame mode and its gates are CROSS-CUTTING, not independent per-pass
// booleans. Every pass that skips itself under overdraw does so for one reason —
// the colour target is an r16float accumulator, not the swapchain — so the pass
// gates and the TARGET ROUTING must answer from the same truth.
//
// They did not. The routing became device-aware (the mode cannot run on an
// immediate device: its compose is raw WebGPU and would throw every frame), while
// eleven pass-layer sites still read the raw `DEBUG_OVERDRAW` URL const. That
// half-gated frame is worse than either consistent state: targets routed as if
// the mode were OFF, passes skipping as if it were ON. On an immediate device
// under ?debug=overdraw the frame silently lost the translucent strokes and the
// hillshade that the forced-WebGL2 twin draws — with no error, on the exact path
// the twin's deletion makes the default.
//
// The truth now lives once on FrameContext.overdraw, mirrored to SceneView so the
// `shouldRun(scene)` gates can read it. This file pins the CONSEQUENCE — that the
// passes follow the frame rather than the URL — rather than the plumbing, because
// the plumbing can be rewired while the defect returns.

import { describe, it, expect } from 'vitest'
import { translucentPass } from './translucent-pass'
import { hillshadePass } from './hillshade-pass'
import { pointsPass } from './points-pass'
import { heatmapPass } from './heatmap-pass'
import { oitPass } from './oit-pass'
import { graphicsPass } from './graphics-pass'
import { overdrawComposePass } from './overdraw-compose-pass'
import type { SceneView } from '../scene-view'

/** A scene whose content is all present; only the frame's overdraw truth varies. */
function scene(overdraw: boolean): SceneView {
  return {
    overdraw,
    hasTranslucent: true,
    hasHillshade: true,
    hasPoints: true,
    hasHeatmap: true,
    hasOit: true,
    hasGraphics: true,
  } as unknown as SceneView
}

const CONTENT_PASSES = [
  ['translucent', translucentPass],
  ['hillshade', hillshadePass],
  ['points', pointsPass],
  ['heatmap', heatmapPass],
  ['oit', oitPass],
  ['graphics', graphicsPass],
] as const

describe('overdraw is one frame truth, not eleven flag reads (#1046 Inc-F2d)', () => {
  it('overdraw OFF for the frame ⇒ every content pass runs, whatever the URL said', () => {
    // The regression this exists for: on an immediate device the routing said
    // "no overdraw" while these gates still read the URL flag and skipped. The
    // twin draws translucent and hillshade there (render-loop.ts, no guard on
    // either), so the chain silently rendered LESS than the frame it replaces.
    for (const [name, pass] of CONTENT_PASSES) {
      expect(
        pass.shouldRun(scene(false)),
        `${name} skipped itself on a frame where overdraw is OFF — it is reading the URL flag ` +
          'instead of the frame truth, which drops content the twin draws',
      ).toBe(true)
    }
  })

  it('overdraw ON for the frame ⇒ every content pass steps aside for the accumulator', () => {
    // The other direction, so the case above cannot be satisfied by deleting the
    // gates outright: with the mode genuinely active the colour target IS the
    // r16float accumulator and these pipelines do not target it.
    for (const [name, pass] of CONTENT_PASSES) {
      expect(pass.shouldRun(scene(true)), `${name} must decline while the mode is active`).toBe(
        false,
      )
    }
  })

  it('the compose runs on exactly the frames the others stand down for', () => {
    // The complement, and the reason the split exists at all: the compose is the
    // ONLY writer of the swapchain while the mode is on. If it could decline
    // while the routing stayed on, nothing would write the swapchain and the
    // frame would go blank — which is precisely what gating the compose alone
    // (instead of the routing) produced.
    expect(overdrawComposePass.shouldRun(scene(true))).toBe(true)
    expect(overdrawComposePass.shouldRun(scene(false))).toBe(false)
  })
})
