// line-gradient (#2117) — the RAMP UPLOAD half: `packLineLayerUniform` writes the ramp
// into the LineLayer uniform lane the shader reads. Slot indices come from `reflect()`
// (the SoT), never literals, so this cannot drift from the WGSL struct.
//
// Fail-before: with line-pattern.ts reverted, `S.gradient_count` is undefined, the
// packer writes nothing, and every assertion below reports a ZERO ramp — a message that
// names the RAMP UPLOAD, not the line geometry.

import { describe, it, expect } from 'vitest'
import {
  packLineLayerUniform,
  lineUniformSize,
  LINE_GRADIENT_MAX_STOPS,
  type LineGradientStop,
} from './line-renderer'
import { lineLayerUniformSlots, lineLayerUniformStride } from './line-uniform-slots'
import { convertMapboxStyle } from '@xgis/compiler'

const RED: [number, number, number, number] = [1, 0, 0, 1]
const BLUE_TO_RED: LineGradientStop[] = [
  { offset: 0, rgba: [0, 0, 1, 1] },
  { offset: 1, rgba: [1, 0, 0, 1] },
]

/** packLineLayerUniform's full positional prefix up to `roundLimit`. */
function pack(gradient: LineGradientStop[] | null, opacity = 1, widthPx = 4) {
  return packLineLayerUniform(
    RED,
    widthPx,
    opacity,
    1000,
    0,
    0,
    2,
    null,
    [],
    0,
    1,
    0,
    1,
    0,
    0,
    0,
    gradient,
  )
}

describe('packLineLayerUniform — line-gradient ramp lane', () => {
  it('no gradient → gradient_count 0 and a zeroed ramp (byte-identical default)', () => {
    const S = lineLayerUniformSlots().slot
    const buf = pack(null)
    const u32 = new Uint32Array(buf.buffer, buf.byteOffset, buf.length)
    expect(u32[S.gradient_count]).toBe(0)
    for (let i = 0; i < LINE_GRADIENT_MAX_STOPS * 4; i++) expect(buf[S.gradient_color + i]).toBe(0)
    for (let i = 0; i < LINE_GRADIENT_MAX_STOPS; i++) expect(buf[S.gradient_pos + i]).toBe(0)
  })

  it('two-stop ramp writes count, per-stop RGBA and per-stop position', () => {
    const S = lineLayerUniformSlots().slot
    const buf = pack(BLUE_TO_RED)
    const u32 = new Uint32Array(buf.buffer, buf.byteOffset, buf.length)
    expect(u32[S.gradient_count]).toBe(2)
    expect(Array.from(buf.subarray(S.gradient_color, S.gradient_color + 8))).toEqual([
      0, 0, 1, 1, 1, 0, 0, 1,
    ])
    expect(buf[S.gradient_pos]).toBe(0)
    expect(buf[S.gradient_pos + 1]).toBe(1)
  })

  it('stop alpha rides the SAME opacity × sub-pixel-width scaling as the solid colour', () => {
    const S = lineLayerUniformSlots().slot
    // width 0.5 px → widthAlphaScale 0.5; opacity 0.5 → total 0.25.
    const buf = pack([{ offset: 0, rgba: [1, 1, 1, 1] }, ...BLUE_TO_RED.slice(1)], 0.5, 0.5)
    expect(buf[S.color + 3]).toBeCloseTo(1 * 0.5 * 0.5, 6)
    expect(buf[S.gradient_color + 3]).toBeCloseTo(1 * 0.5 * 0.5, 6)
    // RGB is NOT scaled — only the alpha budget is shared.
    expect(buf[S.gradient_color]).toBe(1)
  })

  it('a one-stop ramp is not a ramp — count stays 0 so the solid colour stands', () => {
    const S = lineLayerUniformSlots().slot
    const buf = pack([{ offset: 0, rgba: [0, 1, 0, 1] }])
    expect(new Uint32Array(buf.buffer, buf.byteOffset, buf.length)[S.gradient_count]).toBe(0)
  })

  it('a longer ramp is clipped to the uniform budget, never overrunning the struct', () => {
    const S = lineLayerUniformSlots().slot
    const many: LineGradientStop[] = []
    for (let i = 0; i < 12; i++) many.push({ offset: i / 11, rgba: [i / 11, 0, 0, 1] })
    const buf = pack(many)
    const u32 = new Uint32Array(buf.buffer, buf.byteOffset, buf.length)
    expect(u32[S.gradient_count]).toBe(LINE_GRADIENT_MAX_STOPS)
    expect(buf[S.gradient_pos + LINE_GRADIENT_MAX_STOPS - 1]).toBeCloseTo(7 / 11, 6)
    // The last written slot must still be inside the reflected struct.
    expect((S.gradient_pos + LINE_GRADIENT_MAX_STOPS) * 4).toBeLessThanOrEqual(lineUniformSize())
  })

  it('the ramp fits the ring stride the renderer allocates', () => {
    // Growing LineLayer past 256 B is expected to re-align the ring automatically
    // (line-renderer.ts documents exactly this); assert it actually did.
    expect(lineUniformSize()).toBeGreaterThan(256)
    expect(lineLayerUniformStride()).toBe(512)
    expect(lineUniformSize()).toBeLessThanOrEqual(lineLayerUniformStride())
  })

  // ── The converter's warn threshold vs THIS uniform's capacity ──
  //
  // The two are separate constants in separate packages (the compiler cannot import the
  // map), and a drift between them is silent and one-directional: a converter cap ABOVE
  // the uniform's capacity emits stops the packer then drops, losing colours the author
  // wrote with no diagnostic anywhere. Tying them by BEHAVIOUR through the converter's
  // public entry point keeps one checkable pair without exporting a private constant.
  function convertRamp(n: number): string[] {
    const stops: unknown[] = ['interpolate', ['linear'], ['line-progress']]
    for (let i = 0; i < n; i++) stops.push(i / (n - 1), '#112233')
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(
      {
        version: 8,
        sources: { g: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
        layers: [{ id: 'route', type: 'line', source: 'g', paint: { 'line-gradient': stops } }],
      } as never,
      { coverage },
    )
    return coverage.warnings.filter((w) => w.includes('line-gradient'))
  }

  it('the converter emits exactly as many stops as this uniform carries', () => {
    expect(convertRamp(LINE_GRADIENT_MAX_STOPS), 'at the cap: no warning').toEqual([])
    const over = convertRamp(LINE_GRADIENT_MAX_STOPS + 1)
    expect(over.length, 'one past the cap: warns').toBe(1)
    expect(over[0], 'the warning quotes THIS capacity').toContain(
      `the line layer uniform carries ${LINE_GRADIENT_MAX_STOPS}`,
    )
  })

  it('a stale ramp does not leak into the next solid-stroke layer (scratch is reused)', () => {
    const S = lineLayerUniformSlots().slot
    pack(BLUE_TO_RED)
    const buf = pack(null)
    expect(new Uint32Array(buf.buffer, buf.byteOffset, buf.length)[S.gradient_count]).toBe(0)
    expect(buf[S.gradient_color]).toBe(0)
    expect(buf[S.gradient_pos + 1]).toBe(0)
  })
})
