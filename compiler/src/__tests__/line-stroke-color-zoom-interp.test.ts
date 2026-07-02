// #726 — zoom-interpolated line/stroke COLOUR must survive lowering as a real
// `zoom-interpolated` ColorValue, not collapse to the highest-zoom stop.
//
// Pre-fix, lower-bindings-line's stroke arm baked `interpolate(zoom, …)` colour
// stops to a CONSTANT of the last stop ("gives the right appearance at typical
// viewing zoom") — so a line-color `interpolate` snapped to its final colour at
// EVERY zoom, while fill (and stroke WIDTH) already had the per-frame path. The
// runtime side is fully wired (emit-commands → colorValueToShape(node.stroke
// .color) → ShowCommand.paintShapes.line.stroke → renderer/resolved-show
// resolveColorShape per frame), so lowering is the only place the information
// could die — pin it here.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle, Lexer, Parser, lower, emitCommands } from '../index'

interface LineStrokeShape {
  layerName: string
  paintShapes?: {
    line?: { stroke?: { kind: string; stops?: Array<{ zoom: number; value: [number, number, number, number] }>; base?: number } }
  }
}

function pipeline(style: unknown): LineStrokeShape[] {
  const xgis = convertMapboxStyle(style as never)
  const cmds = emitCommands(lower(new Parser(new Lexer(xgis).tokenize()).parse()))
  return cmds.shows as unknown as LineStrokeShape[]
}

const style = (lineColor: unknown) => ({
  version: 8,
  sources: { s: { type: 'vector', url: 'https://example.com/t.json' } },
  layers: [{
    id: 'roads', type: 'line', source: 's', 'source-layer': 'road',
    paint: { 'line-color': lineColor, 'line-width': 2 },
  }],
})

describe('#726 — zoom-interpolated line-color lowers to a zoom-interpolated stroke shape', () => {
  it('linear interpolate(zoom) keeps EVERY stop (not the last-stop constant bake)', () => {
    const shows = pipeline(style(['interpolate', ['linear'], ['zoom'], 5, '#ff0000', 15, '#0000ff']))
    const road = shows.find((s) => s.paintShapes?.line?.stroke)
    expect(road, 'a line show with a stroke shape').toBeTruthy()
    const stroke = road!.paintShapes!.line!.stroke!
    expect(stroke.kind).toBe('zoom-interpolated')
    expect(stroke.stops?.map((st) => st.zoom)).toEqual([5, 15])
    // First stop is red — the pre-fix bake would have erased it (blue-only).
    expect(stroke.stops?.[0]?.value.slice(0, 3)).toEqual([1, 0, 0])
    expect(stroke.stops?.[1]?.value.slice(0, 3)).toEqual([0, 0, 1])
  })

  it('exponential base survives onto the shape', () => {
    const shows = pipeline(style(['interpolate', ['exponential', 1.6], ['zoom'], 5, '#ff0000', 15, '#0000ff']))
    const stroke = shows.find((s) => s.paintShapes?.line?.stroke)!.paintShapes!.line!.stroke!
    expect(stroke.kind).toBe('zoom-interpolated')
    expect(stroke.base).toBeCloseTo(1.6, 6)
  })

  // NB: OFM Bright itself declares NO `interpolate(zoom, …)` line-color (checked
  // 2026-07-03 — 0 layers), so the production-style fixture cannot pin this path;
  // the synthetic style above is the coverage.
})
