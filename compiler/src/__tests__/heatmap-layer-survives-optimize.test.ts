// Pin: heatmap layers must survive the dead-layer-elim pass.
//
// Mapbox heatmap layers carry no fill / stroke / label — they paint via
// the runtime's HeatmapRenderer (the 3-pass density pipeline). The dead-
// layer-elim "nothing to draw" heuristic would otherwise drop the node
// before it reaches emitCommands, so the runtime's HeatmapRenderer gets
// ZERO layers and nothing renders (the base map draws, no density blob).
// Mirror of raster-layer-survives-optimize — same class of bug, same fix
// (a guard in isDeadLayer that keeps the node alive).
//
// Symptom this gates against: a `heatmap` layer rendering nothing —
// caught by §5 real-GPU review when the demo showed only the base map.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle, Lexer, Parser, lower, emitCommands } from '../index'
import { optimize } from '../ir/optimize'

describe('heatmap layers survive IR optimize', () => {
  it('a heatmap layer reaches emitCommands with isHeatmap (not dropped)', () => {
    const style = {
      version: 8,
      sources: { quakes: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [{
        id: 'quake-heat',
        type: 'heatmap',
        source: 'quakes',
        paint: { 'heatmap-radius': 30, 'heatmap-intensity': 2, 'heatmap-opacity': 0.9 },
      }],
    }
    const xgis = convertMapboxStyle(style as never)
    let ir = lower(new Parser(new Lexer(xgis).tokenize()).parse())
    ir = optimize(ir)
    const cmds = emitCommands(ir)
    const heat = cmds.shows.filter((s) => s.isHeatmap)
    expect(heat.length, 'heatmap ShowCommand survives optimize (was dropped by dead-layer-elim)').toBeGreaterThan(0)
    expect(heat[0]!.heatmapRadius).toBe(30)
    expect(heat[0]!.heatmapIntensity).toBe(2)
  })

  it('a fill layer with truly no paint is STILL dropped (guard is heatmap-scoped)', () => {
    // Regression guard: the heatmap exemption must not resurrect the
    // generic no-paint elimination it mirrors.
    const xgis = 'source s { type: geojson url: "x.geojson" }\nlayer empty { source: s }\n'
    let ir = lower(new Parser(new Lexer(xgis).tokenize()).parse())
    ir = optimize(ir)
    const cmds = emitCommands(ir)
    expect(cmds.shows.some((s) => s.layerName === 'empty')).toBe(false)
  })
})
