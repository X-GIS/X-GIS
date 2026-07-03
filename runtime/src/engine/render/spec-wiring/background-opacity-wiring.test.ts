// background-opacity: clear-alpha wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: background-opacity is
// marked `supported` in the background capability table (capabilities/
// background.ts) for both constant and zoom-interp variants, with the note
// "WS-1 — opacity: interpolate(zoom, …) resolves per frame and multiplies
// into the background clear alpha". That behavioural contract — the per-frame
// resolved opacity MULTIPLYING into the whole-viewport clear alpha — rested on
// structural/compile evidence, not a render-wiring test, so a break would ship
// silently (heatmap-class regression).
//
// The runtime contract (background-pass.ts BackgroundPass.execute): for a flat
// projection (worldBand !== 'sphere-full'), the clear value handed to
// encoder.beginRenderPass() is the style background-color, and when a
// `_backgroundOpacityShape` is present its per-frame resolveNumberShape() value
// MULTIPLIES into that clear colour's alpha (bg[3] * a). The disc/globe path
// is pure-black space and never multiplies opacity, so this test pins the flat
// (mercator, projType 0) path.
//
// This drives the REAL `backgroundPass.execute` (the exported singleton) with
// a minimal hand-rolled FrameContext + BackgroundPassHost. No GPU: the only
// device interaction the pass makes is `encoder.beginRenderPass({ colorAttachments:
// [{ clearValue }] })`, which a fake encoder intercepts to read clearValue.a.
//
// Non-vacuous: base background alpha is 0.8 and the zoom-interp opacity shape
// resolves to 0.5 at zoom 5 (0→0.25 .. 10→0.75, linear midpoint), so the
// asserted clear alpha is 0.8 * 0.5 = 0.4 — a value that depends on BOTH the
// base alpha and the resolved opacity. The control (no opacity shape) keeps the
// base 0.8, proving the assertion moves with the wire.
//
// Fail-before: change `bg[3] * a` to `bg[3] * 1` (drop the opacity factor) in
// background-pass.ts and the shaped-case assertion fails (alpha stays 0.8, not
// 0.4) — the wiring that makes background-opacity actually reach the clear
// alpha is gone, caught before any render.

import { describe, it, expect } from 'vitest'
import type { PropertyShape } from '@xgis/compiler'
import { backgroundPass } from '@xgis/map'
import type { FrameContext } from '@xgis/engine'
import { makeProjectionToken } from '@xgis/engine'
import type { BackgroundPassHost } from '@xgis/map'
import type { SceneView } from '@xgis/map'

/** A zoom-interpolated number shape: linear 0→0.25 .. 10→0.75. At zoom 5 the
 *  linear midpoint resolves to 0.5. */
const OPACITY_SHAPE: PropertyShape<number> = {
  kind: 'zoom-interpolated',
  stops: [
    { zoom: 0, value: 0.25 },
    { zoom: 10, value: 0.75 },
  ],
}

const BASE_BG: [number, number, number, number] = [1, 1, 1, 0.8]
const ZOOM = 5

/** Drive the real backgroundPass.execute on the flat (mercator, projType 0)
 *  path with the given opacity shape and return the clear alpha the pass hands
 *  to beginRenderPass. */
function capturedClearAlpha(opacityShape: PropertyShape<number> | null): number {
  let clearAlpha = Number.NaN

  const fakeEncoder = {
    beginRenderPass(desc: {
      colorAttachments: { clearValue?: { r: number; g: number; b: number; a: number } }[]
    }): { end: () => void } {
      const cv = desc.colorAttachments[0]?.clearValue
      if (cv) clearAlpha = cv.a
      return { end(): void {} }
    },
  }

  const ctx = {
    projection: makeProjectionToken(0, 0, 0), // mercator → flat, worldBand !== 'sphere-full'
    camera: { zoom: ZOOM },
    elapsedMs: 0,
    colorView: {} as GPUTextureView,
    encoder: fakeEncoder,
    passScope: (_label: string, fn: () => void): void => {
      fn()
    },
  } as unknown as FrameContext

  const host = {
    _backgroundColor: BASE_BG,
    _backgroundColorShape: null,
    _backgroundOpacityShape: opacityShape,
  } as unknown as BackgroundPassHost

  backgroundPass.execute(
    ctx,
    {} as unknown as SceneView,
    host as unknown as Parameters<typeof backgroundPass.execute>[2],
  )
  return clearAlpha
}

describe('background-opacity clear-alpha wiring (GPU-free)', () => {
  it('clear alpha = base alpha × resolved opacity (0.8 × 0.5 = 0.4)', () => {
    expect(capturedClearAlpha(OPACITY_SHAPE)).toBeCloseTo(0.4, 6)
  })

  it('clear alpha = base alpha unchanged when no opacity shape (0.8)', () => {
    expect(capturedClearAlpha(null)).toBeCloseTo(0.8, 6)
  })
})
