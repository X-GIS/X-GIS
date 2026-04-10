import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { optimize } from '../ir/optimize'
import { emitCommands } from '../ir/emit-commands'

function compileScene(source: string) {
  const tokens = new Lexer(source).tokenize()
  const ast = new Parser(tokens).parse()
  const scene = lower(ast)
  return emitCommands(optimize(scene, ast))
}

/** Mirrors the interpolateZoom function from renderer.ts */
function interpolateZoom(stops: { zoom: number; value: number }[], zoom: number): number {
  if (stops.length === 0) return 1.0
  if (zoom <= stops[0].zoom) return stops[0].value
  if (zoom >= stops[stops.length - 1].zoom) return stops[stops.length - 1].value
  for (let i = 0; i < stops.length - 1; i++) {
    if (zoom >= stops[i].zoom && zoom <= stops[i + 1].zoom) {
      const t = (zoom - stops[i].zoom) / (stops[i + 1].zoom - stops[i].zoom)
      return stops[i].value + t * (stops[i + 1].value - stops[i].value)
    }
  }
  return stops[stops.length - 1].value
}

describe('Zoom interpolation pipeline', () => {
  it('carries zoom stops through the full pipeline', () => {
    const commands = compileScene(`
      source data { type: geojson, url: "x.geojson" }
      layer tracks {
        source: data
        | z8:opacity-40 z16:opacity-100
      }
    `)

    const show = commands.shows[0]
    expect(show.zoomOpacityStops).not.toBeNull()
    expect(show.zoomOpacityStops).toHaveLength(2)
    expect(show.zoomOpacityStops![0]).toEqual({ zoom: 8, value: 0.4 })
    expect(show.zoomOpacityStops![1]).toEqual({ zoom: 16, value: 1.0 })
  })

  it('carries size zoom stops', () => {
    const commands = compileScene(`
      source data { type: geojson, url: "x.geojson" }
      layer tracks {
        source: data
        | z8:size-4 z14:size-12
      }
    `)

    const show = commands.shows[0]
    expect(show.zoomSizeStops).toHaveLength(2)
    expect(show.zoomSizeStops![0]).toEqual({ zoom: 8, value: 4 })
    expect(show.zoomSizeStops![1]).toEqual({ zoom: 14, value: 12 })
  })

  it('preserves constant size through pipeline', () => {
    const commands = compileScene(`
      source data { type: geojson, url: "x.geojson" }
      layer tracks {
        source: data
        | size-12
      }
    `)
    expect(commands.shows[0].size).toBe(12)
  })
})

describe('Zoom interpolation math', () => {
  const stops = [
    { zoom: 8, value: 0.4 },
    { zoom: 12, value: 0.7 },
    { zoom: 16, value: 1.0 },
  ]

  it('returns first stop for zoom below range', () => {
    expect(interpolateZoom(stops, 4)).toBe(0.4)
    expect(interpolateZoom(stops, 8)).toBe(0.4)
  })

  it('returns last stop for zoom above range', () => {
    expect(interpolateZoom(stops, 16)).toBe(1.0)
    expect(interpolateZoom(stops, 20)).toBe(1.0)
  })

  it('interpolates between stops', () => {
    expect(interpolateZoom(stops, 10)).toBeCloseTo(0.55) // midpoint of 0.4 and 0.7
    expect(interpolateZoom(stops, 12)).toBeCloseTo(0.7)
    expect(interpolateZoom(stops, 14)).toBeCloseTo(0.85) // midpoint of 0.7 and 1.0
  })

  it('handles single stop', () => {
    expect(interpolateZoom([{ zoom: 10, value: 0.5 }], 5)).toBe(0.5)
    expect(interpolateZoom([{ zoom: 10, value: 0.5 }], 15)).toBe(0.5)
  })

  it('handles empty stops', () => {
    expect(interpolateZoom([], 10)).toBe(1.0)
  })
})
