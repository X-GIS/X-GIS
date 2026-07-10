// #726 — a zoom-interpolated line-color must INTERPOLATE PER FRAME, not snap to
// the highest-zoom stop. The compiler lowering keeps the stops (pinned in
// compiler/src/__tests__/line-stroke-color-zoom-interp.test.ts), and the
// runtime consumes them via renderer.ts / resolved-show.ts →
// resolveColorShape(ps.line.stroke, camera.zoom, …).
//
// This test closes the ONE gap those two layers leave uncovered: neither
// exercises the FULL pipeline end to end. Here we drive Mapbox style → convert
// → lower → emit → resolveColorShape at an INTERMEDIATE zoom and assert the
// resolved colour is the true midpoint — the exact per-frame behaviour the
// pre-#726 "bake the last stop as a constant" placeholder destroyed. That bake
// left paintShapes.line.stroke a `{ kind: 'constant' }`, and resolveColorShape
// returns `null` for a constant (paint-shape-resolve.ts) — so there was no
// per-frame interpolation at all and every zoom rendered the final colour.
//
// Fail-before: revert lower-bindings-line.ts's stroke-colour arm to the
// last-stop bake (`acc.strokeColor = colorConstant(...hexToRgba(lastHex))`) and
// paintShapes.line.stroke becomes `{ kind: 'constant' }` → the `kind` assertion
// fails and resolveColorShape returns null at z=10 (no midpoint).

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle, Lexer, Parser, lower, emitCommands } from '@xgis/compiler'
import type { PropertyShape } from '@xgis/compiler'
import { resolveColorShape } from './paint-shape-resolve'

/** Convert a Mapbox `line-color` paint value through the real compiler
 *  pipeline and return the emitted `paintShapes.line.stroke` shape. */
function lowerStrokeShape(
  lineColor: unknown,
): PropertyShape<readonly [number, number, number, number]> | null {
  const style = {
    version: 8,
    sources: { s: { type: 'vector', url: 'https://example.com/t.json' } },
    layers: [
      {
        id: 'roads',
        type: 'line',
        source: 's',
        'source-layer': 'road',
        paint: { 'line-color': lineColor, 'line-width': 2 },
      },
    ],
  }
  const xgis = convertMapboxStyle(style as never)
  const cmds = emitCommands(lower(new Parser(new Lexer(xgis).tokenize()).parse()))
  const show = cmds.shows.find((s) => s.paintShapes.line.stroke !== null)
  return show?.paintShapes.line.stroke ?? null
}

describe('#726 — zoom-interpolated line-color interpolates per frame (compiler → resolveColorShape)', () => {
  it('linear interpolate(zoom, 5 #f00, 15 #00f) resolves the true midpoint at z=10', () => {
    const stroke = lowerStrokeShape([
      'interpolate',
      ['linear'],
      ['zoom'],
      5,
      '#ff0000',
      15,
      '#0000ff',
    ])
    expect(stroke, 'stroke shape emitted').toBeTruthy()
    expect(stroke!.kind).toBe('zoom-interpolated')

    // At / below the first stop → clamps to red. The first stop SURVIVES —
    // the pre-#726 bake erased it and showed blue at every zoom.
    const atLow = resolveColorShape(stroke!, 5, 0)
    expect(atLow, 'zoom-interpolated resolves per frame (not null)').toBeTruthy()
    expect(atLow!.value[0]).toBeCloseTo(1, 5) // R
    expect(atLow!.value[2]).toBeCloseTo(0, 5) // B

    // Midpoint zoom → half red, half blue. The last-stop constant bake would
    // give pure blue ([0,0,1]) here (and, being a constant, no per-frame
    // value at all — resolveColorShape returns null).
    const atMid = resolveColorShape(stroke!, 10, 0)
    expect(atMid, 'midpoint resolves').toBeTruthy()
    expect(atMid!.value[0]).toBeCloseTo(0.5, 5) // R
    expect(atMid!.value[1]).toBeCloseTo(0, 5) // G
    expect(atMid!.value[2]).toBeCloseTo(0.5, 5) // B
    expect(atMid!.value[3]).toBeCloseTo(1, 5) // A

    // At / above the last stop → clamps to blue.
    const atHigh = resolveColorShape(stroke!, 15, 0)
    expect(atHigh!.value[0]).toBeCloseTo(0, 5) // R
    expect(atHigh!.value[2]).toBeCloseTo(1, 5) // B
  })

  it('exponential base is APPLIED (not just carried) at runtime', () => {
    const stroke = lowerStrokeShape([
      'interpolate',
      ['exponential', 2],
      ['zoom'],
      5,
      '#ff0000',
      15,
      '#0000ff',
    ])
    expect(stroke!.kind).toBe('zoom-interpolated')

    // Closed-form exponential t at z=10: (2^(10-5) − 1) / (2^(15-5) − 1)
    //   = (32 − 1) / (1024 − 1) = 31/1023 ≈ 0.030303.
    const t = (Math.pow(2, 10 - 5) - 1) / (Math.pow(2, 15 - 5) - 1)
    const atMid = resolveColorShape(stroke!, 10, 0)
    expect(atMid).toBeTruthy()
    // R = 1 + t·(0 − 1) = 1 − t ; B = 0 + t·(1 − 0) = t. A LINEAR curve
    // (base 1) would give R = B = 0.5, so matching the exponential value
    // also proves the base was applied downstream, not silently dropped.
    expect(atMid!.value[0]).toBeCloseTo(1 - t, 5) // R ≈ 0.9697
    expect(atMid!.value[2]).toBeCloseTo(t, 5) // B ≈ 0.0303
    expect(atMid!.value[0]).toBeGreaterThan(0.9) // strongly non-linear toward the first stop
  })
})
