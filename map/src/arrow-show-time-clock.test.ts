// #2324: a time-interpolated arrow `size-…` must resolve against the FRAME clock
// (host._elapsedMs), not performance.now() — the sibling of the point fork's
// baseSize (map.ts) that `baseArrowSize` mirrors. performance.now() at the first
// draw is already seconds past navigation, so a non-looping animation was born at
// its END value, and a looping one ran at a boot-dependent phase offset from every
// other time-interpolated property it is composed with.
//
// Drives the exported `addArrowShowLayer` end to end (a real compiled ShowCommand,
// the real resolver) and reads the packed size array the graphics manager receives —
// the arrow-show.test.ts idiom, so no GPU is involved.

import { describe, expect, it, afterEach, vi } from 'vitest'
import { Lexer, Parser, lower, emitCommands } from '@xgis/compiler'
import type { GeoJSONFeatureCollection } from '@xgis/data'
import { addArrowShowLayer, type ArrowShowHost } from './arrow-show'
import type { ShowCommand } from './render/renderer-types'

/** An arrow layer with NO `size-` clause, so `paintShapes.circle.size` is the only
 *  size authority (the compiler leaves it null; the caller installs the shape). */
function arrowShow(): ShowCommand {
  const src = `xgis 1
source stations { type: geojson }
layer arrows {
  source: stations
  | arrow bearing-[.dir]
}
`
  const cmds = emitCommands(lower(new Parser(new Lexer(src).tokenize()).parse()))
  const show = cmds.shows.find((s) => s.layerName === 'arrows')
  if (!show) throw new Error('no `arrows` show')
  return show as unknown as ShowCommand
}

/** A non-looping 10 → 20 size ramp over one second. */
function withTimeSize(show: ShowCommand): ShowCommand {
  ;(show as { paintShapes: { circle: { size: unknown } } }).paintShapes.circle.size = {
    kind: 'time-interpolated',
    stops: [
      { timeMs: 0, value: 10 },
      { timeMs: 1000, value: 20 },
    ],
    loop: false,
    easing: 'linear',
    delayMs: 0,
  }
  return show
}

const FC: GeoJSONFeatureCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-122.4, 37.8] },
      properties: { dir: 90 },
    },
  ],
} as unknown as GeoJSONFeatureCollection

function makeHost(elapsedMs: number): { host: ArrowShowHost; sizes: Float32Array[] } {
  const sizes: Float32Array[] = []
  const host = {
    graphics: {
      addCompiledArrowLayer: (
        _lons: Float64Array,
        _lats: Float64Array,
        _bearings: Float32Array,
        s: Float32Array,
      ) => void sizes.push(s),
    },
    camera: { zoom: 6, pitch: 0 },
    _elapsedMs: elapsedMs,
  } as unknown as ArrowShowHost
  return { host, sizes }
}

afterEach(() => vi.restoreAllMocks())

describe('arrow show — a time-interpolated size reads the FRAME clock (#2324)', () => {
  it('first rendered frame (frame clock 0): a non-looping 10→20 ramp starts at 10', () => {
    // performance.now() is seconds past navigation by the first draw; on that clock
    // the ramp is already clamped to its 20 end value before a single frame animates.
    vi.spyOn(performance, 'now').mockReturnValue(5000)
    const { host, sizes } = makeHost(0)
    addArrowShowLayer(host, withTimeSize(arrowShow()), FC)
    expect(sizes[0]![0]).toBe(10)
  })

  it('mid-animation (frame clock 500) resolves the ramp midpoint, 15', () => {
    // Distinguishes the frame clock from a hardcoded t=0: the resolver is live, and
    // the value it reports tracks host._elapsedMs rather than the wall clock.
    vi.spyOn(performance, 'now').mockReturnValue(5000)
    const { host, sizes } = makeHost(500)
    addArrowShowLayer(host, withTimeSize(arrowShow()), FC)
    expect(sizes[0]![0]).toBe(15)
  })

  it('CONTROL: a CONSTANT size is clock-independent', () => {
    vi.spyOn(performance, 'now').mockReturnValue(5000)
    const show = arrowShow()
    ;(show as { paintShapes: { circle: { size: unknown } } }).paintShapes.circle.size = {
      kind: 'constant',
      value: 44,
    }
    const { host, sizes } = makeHost(0)
    addArrowShowLayer(host, show, FC)
    expect(sizes[0]![0]).toBe(44)
  })
})
