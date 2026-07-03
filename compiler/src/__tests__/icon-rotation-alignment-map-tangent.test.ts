// Pin iter 506: icon-rotation-alignment="map" under symbol-
// placement="line" now propagates compiler → ShowCommand.label
// .iconRotationAlignment, with the runtime adding the per-segment
// tangent to def.iconRotate at dispatch time. OFM road_oneway /
// road_oneway_opposite render arrows along the road direction.

import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { optimize } from '../ir/optimize'
import { emitCommands } from '../ir/emit-commands'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function compileToShows(style: unknown): ReturnType<typeof emitCommands>['shows'] {
  const xgis = convertMapboxStyle(style as Parameters<typeof convertMapboxStyle>[0])
  const tokens = new Lexer(xgis).tokenize()
  const ast = new Parser(tokens).parse()
  const scene = lower(ast)
  return emitCommands(optimize(scene, ast)).shows
}

function symbol(layout: Record<string, unknown>, paint?: Record<string, unknown>): unknown {
  return {
    version: 8,
    sources: { o: { type: 'vector', tiles: ['http://x/{z}/{x}/{y}.pbf'] } },
    layers: [
      {
        id: 'q',
        type: 'symbol',
        source: 'o',
        'source-layer': 't',
        layout: { 'icon-image': 'pin', ...layout },
        ...(paint ? { paint } : {}),
      },
    ],
  }
}

describe('icon-rotation-alignment=map — compile-time propagation', () => {
  it('"map" + symbol-placement=line → label.iconRotationAlignment="map"', () => {
    const shows = compileToShows(
      symbol({
        'icon-image': 'oneway',
        'icon-rotation-alignment': 'map',
        'symbol-placement': 'line',
      }),
    )
    expect((shows[0]!.label as { iconRotationAlignment?: string }).iconRotationAlignment).toBe(
      'map',
    )
  })

  it('"viewport" → iconRotationAlignment undefined (matches X-GIS default render)', () => {
    const shows = compileToShows(
      symbol({
        'icon-image': 'shield',
        'icon-rotation-alignment': 'viewport',
      }),
    )
    expect(
      (shows[0]!.label as { iconRotationAlignment?: string }).iconRotationAlignment,
    ).toBeUndefined()
  })

  it('"auto" → iconRotationAlignment undefined (point-default = viewport)', () => {
    const shows = compileToShows(
      symbol({
        'icon-image': 'shield',
        'icon-rotation-alignment': 'auto',
      }),
    )
    expect(
      (shows[0]!.label as { iconRotationAlignment?: string }).iconRotationAlignment,
    ).toBeUndefined()
  })

  it('absent → iconRotationAlignment undefined (Mapbox default = "auto")', () => {
    const shows = compileToShows(symbol({ 'icon-image': 'shield' }))
    expect(
      (shows[0]!.label as { iconRotationAlignment?: string }).iconRotationAlignment,
    ).toBeUndefined()
  })

  it('OFM road_oneway shape: icon-rotate=90 + rot-align=map + placement=line', () => {
    // Verify the FULL combination converts. Runtime adds tangent
    // to iconRotate, so:
    //   East-west road (tangent=0) → final = 90 + 0 = 90 (arrow points up
    //                                                     for arrow sprite
    //                                                     designed pointing
    //                                                     right at 0)
    //   North-south road (tangent=90) → final = 90 + 90 = 180 (arrow flipped)
    // The compiler-side just propagates the inputs.
    const style = {
      version: 8,
      sources: { o: { type: 'vector', tiles: ['http://x/{z}/{x}/{y}.pbf'] } },
      layers: [
        {
          id: 'road_oneway',
          type: 'symbol',
          source: 'o',
          'source-layer': 'transportation',
          minzoom: 15,
          layout: {
            'icon-image': 'oneway',
            'icon-rotate': 90,
            'icon-rotation-alignment': 'map',
            'symbol-placement': 'line',
            'symbol-spacing': 75,
          },
          paint: { 'icon-opacity': 0.5 },
        },
      ],
    }
    const shows = compileToShows(style)
    const s = shows.find((x) => x.layerName === 'road_oneway')!
    expect(s).toBeDefined()
    expect(s.label!.iconImage).toBe('oneway')
    expect(s.label!.iconRotate).toBe(90)
    expect(s.label!.iconOpacity).toBe(0.5)
    expect(s.label!.placement).toBe('line')
    expect(s.label!.spacing).toBe(75)
    expect((s.label as { iconRotationAlignment?: string }).iconRotationAlignment).toBe('map')
  })

  it('"map" does NOT trigger the ignored-property warning anymore (iter 506)', () => {
    // Iter 494 suppressed viewport/auto; iter 506 suppressed "map"
    // since the runtime now handles it.
    const xgis = convertMapboxStyle(
      symbol({
        'icon-image': 'arrow',
        'icon-rotation-alignment': 'map',
        'symbol-placement': 'line',
      }) as Parameters<typeof convertMapboxStyle>[0],
    )
    // The utility `label-icon-rotation-alignment-map` legitimately
    // appears in the xgis output. We only want to confirm the
    // warning string is absent.
    expect(xgis).not.toContain('ignored properties (Batch 1d/1e+): icon-rotation-alignment')
  })
})
