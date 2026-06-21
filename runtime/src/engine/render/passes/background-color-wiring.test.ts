// background-color: whole-viewport clear wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: background-color is
// marked `supported` in compiler/.../paint... + the background capability
// table (capabilities/background.ts), but the only runtime tests were
// STRUCTURAL/pure: setBackgroundFill-lifecycle.test.ts source-greps map.ts,
// and background-pass-clear-value.test.ts asserts the PURE helper
// `backgroundClearValue(projType, bg, overdraw)` in isolation. Neither
// proves the actual WIRE: that BackgroundPass.execute threads the owning
// map's `_backgroundColor` into the colour-attachment `clearValue` it hands
// to `encoder.beginRenderPass`. If that one line regressed to a constant,
// the pure-helper test would still pass and the break would ship silently
// (the heatmap-class data-path bug).
//
// This drives the REAL `backgroundPass.execute` against a fake FrameContext
// + host (no GPU, no WebGPU stub needed — execute only calls
// `ctx.encoder.beginRenderPass(...)` then `pass.end()`), intercepting
// beginRenderPass to read the clearValue actually requested. On a flat
// (mercator, projType 0) frame the style background-color fills the whole
// viewport, so clearValue must equal `_backgroundColor` exactly.
//
// Fail-before: in background-pass.ts replace the resolved `bg` argument to
// `backgroundClearValue` with a constant (e.g. `[0, 0, 0, 1]`) — the helper
// still works, the structural/pure tests still pass, but the clear no longer
// reflects the host's background-color, and THIS test goes red.

import { describe, it, expect } from 'vitest'
import { backgroundPass } from './background-pass'
import type { BackgroundPassHost } from './pass'
import type { FrameContext } from '../frame-context'

// A deliberately non-trivial, asymmetric colour so each channel is its own
// witness — no channel can be satisfied by a constant or by another channel.
const BG: [number, number, number, number] = [0.13, 0.57, 0.42, 0.8]

interface CapturedClear {
  r: number
  g: number
  b: number
  a: number
}

/** Drive the real backgroundPass.execute with a fake flat-frame context and
 *  the given host background-color, capturing the clearValue the pass asks
 *  `encoder.beginRenderPass` for. */
function capturedClearValue(
  bg: [number, number, number, number] | null,
  projType: number,
): CapturedClear {
  let captured: CapturedClear | undefined

  const encoder = {
    beginRenderPass: (desc: {
      colorAttachments: Array<{ clearValue: CapturedClear }>
    }) => {
      captured = desc.colorAttachments[0]!.clearValue
      return { end: () => {} } as unknown as GPURenderPassEncoder
    },
  } as unknown as GPUCommandEncoder

  const ctx = {
    encoder,
    colorView: {} as GPUTextureView,
    // colorShape/opacityShape are null below, so the resolve branches never
    // read camera.zoom / elapsedMs — a bare stub camera is sufficient.
    camera: { zoom: 5 } as unknown as FrameContext['camera'],
    projType,
    elapsedMs: 0,
    // passScope just brackets validation/perf-marks — invoke the body.
    passScope: (_label: string, fn: () => void) => fn(),
  } as unknown as FrameContext

  const host = {
    _backgroundColor: bg,
    _backgroundColorShape: null,
    _backgroundOpacityShape: null,
  } as unknown as BackgroundPassHost

  backgroundPass.execute(ctx, undefined as never, host as never)

  if (!captured) throw new Error('backgroundPass.execute did not begin a render pass')
  return captured
}

describe('background-color → clear-value wiring (GPU-free)', () => {
  it('flat (mercator) clear equals the host background-color exactly', () => {
    const c = capturedClearValue(BG, 0)
    // Break the wire (pass a constant to backgroundClearValue) → these fail.
    expect(c.r).toBeCloseTo(BG[0], 6)
    expect(c.g).toBeCloseTo(BG[1], 6)
    expect(c.b).toBeCloseTo(BG[2], 6)
    expect(c.a).toBeCloseTo(BG[3], 6)
  })

  it('the clear tracks a DIFFERENT background-color (non-vacuous)', () => {
    // A second, distinct colour: if the wire were a constant, one of these
    // two cases would mismatch. Both passing means the clear genuinely
    // follows the prop.
    const other: [number, number, number, number] = [0.91, 0.22, 0.04, 1]
    const c = capturedClearValue(other, 0)
    expect(c.r).toBeCloseTo(other[0], 6)
    expect(c.g).toBeCloseTo(other[1], 6)
    expect(c.b).toBeCloseTo(other[2], 6)
    expect(c.a).toBeCloseTo(other[3], 6)
  })
})
