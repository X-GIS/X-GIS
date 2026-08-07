// ═══ renderGraticuleOverlay routes the immediate arm to its RHI sibling (#1046 Inc-E2) ═══
//
// The graticule is the one legacy-layer draw the chain DOES carry content for:
// the opaque pass calls renderGraticuleOverlay in its last sub-pass, and the
// native body unwraps a WebGPU pass — on an immediate device (WebGL2) that
// unwrap fails loud and kills the whole chain frame the moment the grid is
// enabled (arch review F4). The fork must route to renderGraticuleOverlayRhi —
// the twin's own graticule entry (#1062) — handing the pass BY IDENTITY plus
// the canvas-derived (w, h, dpr) the native body computes for itself. The F3
// fail-loud unwrap is the booby trap: a routing mutant on a foreign pass
// throws the named error instead of passing silently.

import { describe, it, expect, vi } from 'vitest'
import { MapRendererContent } from './renderer'
import type { RhiRenderPass } from '@xgis/rhi'

const foreignPass = { __gl2Pass: true } as unknown as RhiRenderPass
const CAMERA = { __cam: true } as never

function makeRenderer(executionModel: 'immediate' | 'deferred', enabled = true) {
  const r = Object.create(MapRendererContent.prototype) as MapRendererContent
  ;(r as unknown as { ctx: unknown }).ctx = {
    rhi: { caps: { executionModel } },
    canvas: { width: 800, height: 600, clientWidth: 400 },
  }
  ;(r as unknown as { _graticule: unknown })._graticule = { isEnabled: () => enabled }
  const rhiSibling = vi.spyOn(r, 'renderGraticuleOverlayRhi').mockImplementation(() => {})
  return { r, rhiSibling }
}

describe('renderGraticuleOverlay — immediate-arm routing (#1046 Inc-E2)', () => {
  it('immediate + enabled ⇒ delegates to the RHI sibling: pass BY IDENTITY, canvas (w, h, dpr)', () => {
    const { r, rhiSibling } = makeRenderer('immediate')
    expect(() => r.renderGraticuleOverlay(foreignPass, CAMERA, 3, 127, 37)).not.toThrow()
    expect(rhiSibling).toHaveBeenCalledTimes(1)
    // Projection args forwarded verbatim; w/h are the canvas physical size and
    // dpr = width / clientWidth (800 / 400) — the same derivation the native
    // body feeds getECEFFrameView, so the sibling reconstructs the SAME frame.
    expect(rhiSibling.mock.calls[0]).toEqual([foreignPass, CAMERA, 3, 127, 37, 800, 600, 2])
    expect(rhiSibling.mock.calls[0]![0]).toBe(foreignPass)
  })

  it('immediate + disabled ⇒ no-op (the guard precedes the fork)', () => {
    const { r, rhiSibling } = makeRenderer('immediate', false)
    expect(() => r.renderGraticuleOverlay(foreignPass, CAMERA)).not.toThrow()
    expect(rhiSibling).not.toHaveBeenCalled()
  })

  it('deferred ⇒ the NATIVE body is entered (the F3 booby trap fires on the foreign pass)', () => {
    const { r, rhiSibling } = makeRenderer('deferred')
    expect(() => r.renderGraticuleOverlay(foreignPass, CAMERA)).toThrow(
      /native-bodied terminal|not a WebGPU pass/,
    )
    expect(rhiSibling).not.toHaveBeenCalled()
  })
})
