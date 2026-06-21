import { describe, expect, it } from 'vitest'
import {
  packLineLayerUniform,
  LINE_UNIFORM_SIZE,
} from './line-renderer'

// line-blur wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: `line-blur` is marked
// `supported` (constant) in the line capability table (runtime line.ts) and the
// paint-line spec-coverage, but the only runtime coverage was the WGSL-compile
// smoke + an AA-reserve assertion that runs with the DEFAULT blur (0) — that
// assertion (`buf[F32_AA_WIDTH] ≈ 1.0` in line-renderer.test.ts) would still
// pass if the blur threading were dropped entirely, so it is vacuous for the
// blur prop.
//
// The runtime contract is the line-renderer consumer at line-pattern.ts:
//   buf[5] = 1.0 + Math.max(0, blurPx)
// i.e. slot 5 = aa_width_px = the MapLibre-native 1.0 px AA reserve PLUS the
// Mapbox `paint.line-blur` value (CSS px). The line VS reads aa_width_px and
// derives blur_px = max(0, aa_width_px - 1) to feather the edge.
//
// This drives the REAL packLineLayerUniform (the pure pack the renderer's
// addLayer calls — no GPU) and asserts the EXACT slot the blur prop controls:
//   • blur=0  → aa_width_px (slot 5) = 1.0  (reserve only)
//   • blur=3  → aa_width_px (slot 5) = 4.0  (reserve + blur)
// The DELTA between the two cases is the wire; asserting it is non-vacuous —
// it depends on the prop, not a constant.
//
// Fail-before: replace `buf[5] = 1.0 + Math.max(0, blurPx)` with `buf[5] = 1.0`
// (drop the blur threading) and the blur=3 assertion fails — the field stops
// being "supported", and this test says so before any render runs.

// LineLayerUniform layout (matches WGSL struct): aa_width_px is f32 slot 5.
const F32_AA_WIDTH = 5

// packLineLayerUniform positional tail (mirrors the renderer's addLayer call):
// (strokeColor, strokeWidthPx, opacity, mppAtCenter, cap, join, miterLimit,
//  dash, patterns, offsetPx, viewportHeight, blurPx, dpr, ...)
const COLOR: [number, number, number, number] = [1, 0, 0, 1]
const WIDTH = 4
const OPACITY = 1
const MPP = 1000

function packWithBlur(blurPx: number): Float32Array {
  return packLineLayerUniform(
    COLOR, WIDTH, OPACITY, MPP,
    undefined, undefined, undefined, // cap / join / miterLimit → spec defaults
    null, [], 0, 1,                  // dash / patterns / offsetPx / viewportHeight
    blurPx,                          // ← line-blur
  )
}

describe('line-blur wiring (GPU-free)', () => {
  it('produces a buffer of exactly LINE_UNIFORM_SIZE bytes', () => {
    expect(packWithBlur(0).byteLength).toBe(LINE_UNIFORM_SIZE)
  })

  it('blur=0 leaves aa_width_px (slot 5) at the 1.0 px AA reserve only', () => {
    const buf = packWithBlur(0)
    expect(buf[F32_AA_WIDTH]).toBeCloseTo(1.0, 6)
  })

  it('line-blur threads into aa_width_px (slot 5) as reserve + blur', () => {
    // Drop `buf[5] = 1.0 + Math.max(0, blurPx)` (write a constant 1.0 instead)
    // and this assertion fails — the blur prop no longer reaches the GPU uniform.
    const buf = packWithBlur(3)
    expect(buf[F32_AA_WIDTH]).toBeCloseTo(4.0, 6)
  })

  it('aa_width_px tracks the blur value (non-vacuous: delta == blur)', () => {
    const base = packWithBlur(0)[F32_AA_WIDTH]
    const blurred = packWithBlur(2.5)[F32_AA_WIDTH]
    // The slot-5 increase must equal the requested blur, not a fixed constant.
    expect(blurred - base).toBeCloseTo(2.5, 6)
  })

  it('negative blur is clamped to 0 (no negative AA reserve)', () => {
    expect(packWithBlur(-5)[F32_AA_WIDTH]).toBeCloseTo(1.0, 6)
  })
})
