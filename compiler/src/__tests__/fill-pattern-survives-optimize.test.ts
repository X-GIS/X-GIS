// Pin: fill-pattern-only layers must survive the dead-layer-elim pass.
//
// A Mapbox `fill-pattern` layer with NO `fill-color` lowers to a RenderNode whose
// `fill` is `kind: 'none'` (the visual cue is the sprite atlas, not a colour). The
// dead-layer-elim "nothing to draw" heuristic would otherwise drop the node before
// emitCommands, so `show.fillPattern` never reaches the runtime → the lazy IconStage
// sprite-atlas gate (label-pass.ts) never trips → the UV never resolves → the layer
// renders as a solid fallback or nothing. Mirror of raster/heatmap-layer-survives —
// same class of bug, same fix (a guard in isDeadLayer keyed on fillPattern/linePattern).
//
// Symptom this gates against: OFM Liberty's `landcover_wetland` / `road_area_pattern`
// (pattern-only, no fill-color) silently rendering nothing.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle, Lexer, Parser, lower, emitCommands } from '../index'
import { optimize } from '../ir/optimize'

function compileOptimized(xgis: string) {
  const ir = optimize(lower(new Parser(new Lexer(xgis).tokenize()).parse()))
  return emitCommands(ir)
}

describe('fill-pattern-only layers survive IR optimize', () => {
  it('a direct .xgis fill-pattern-<name> layer reaches emitCommands with fillPattern', () => {
    const cmds = compileOptimized(
      'source s { type: geojson, url: "x.geojson" }\nlayer pat { source: s | fill-pattern-pat }\n',
    )
    const pat = cmds.shows.filter((s) => s.fillPattern != null)
    expect(
      pat.length,
      'fill-pattern ShowCommand survives optimize (was dropped by dead-layer-elim)',
    ).toBe(1)
    expect(pat[0]!.fillPattern).toBe('pat')
  })

  it('a Mapbox fill-pattern layer with no fill-color survives the converter path', () => {
    const style = {
      version: 8,
      sprite: '/sprite',
      sources: { poly: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        { id: 'wetland', type: 'fill', source: 'poly', paint: { 'fill-pattern': 'wetland_bg' } },
      ],
    }
    const cmds = compileOptimized(convertMapboxStyle(style as never))
    expect(cmds.shows.some((s) => s.fillPattern === 'wetland_bg')).toBe(true)
  })

  it('a fill layer with truly no paint is STILL dropped (guard is pattern-scoped)', () => {
    const cmds = compileOptimized(
      'source s { type: geojson, url: "x.geojson" }\nlayer empty { source: s }\n',
    )
    expect(cmds.shows.some((s) => s.layerName === 'empty')).toBe(false)
  })
})
