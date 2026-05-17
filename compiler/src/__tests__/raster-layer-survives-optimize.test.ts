// Pin: raster layers must survive the dead-layer-elim pass.
//
// Mapbox raster layers carry no fill / stroke / label — they paint via
// the runtime's RasterRenderer sampling tile textures. The dead-layer-
// elim pass's "nothing to draw" heuristic would otherwise drop them
// before they reach emitCommands, and the runtime would never receive
// a ShowCommand with `targetName === <raster-source>`.
//
// Symptom this gates against: OFM Liberty's `natural_earth` shaded-
// relief raster silently absent at low zoom; user-visible as the
// missing hillshade underlay across world / continental views.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle, Lexer, Parser, lower, emitCommands } from '../index'
import { optimize } from '../ir/optimize'
import fs from 'node:fs'
import path from 'node:path'

function referencedRasterSourceNames(stylePath: string): string[] {
  // Only raster sources that at least one layer references — orphan
  // sources (declared but unused) don't need a ShowCommand.
  const style = JSON.parse(fs.readFileSync(stylePath, 'utf-8')) as {
    sources: Record<string, { type?: string }>
    layers: Array<{ source?: string; type?: string }>
  }
  const rasterIds = new Set(
    Object.entries(style.sources)
      .filter(([, s]) => s.type === 'raster' || s.type === 'raster-dem')
      .map(([id]) => id),
  )
  const referenced = new Set<string>()
  for (const layer of style.layers) {
    if (layer.source && rasterIds.has(layer.source)) referenced.add(layer.source)
  }
  return [...referenced]
}

describe('raster layers survive IR optimize', () => {
  it('OFM Liberty natural_earth → ShowCommand(targetName=ne2_shaded)', () => {
    const stylePath = path.resolve('compiler/src/__tests__/fixtures/openfreemap-liberty.json')
    const style = JSON.parse(fs.readFileSync(stylePath, 'utf-8'))
    const xgis = convertMapboxStyle(style)
    let ir = lower(new Parser(new Lexer(xgis).tokenize()).parse())
    ir = optimize(ir)
    const cmds = emitCommands(ir)
    const ne2Shows = cmds.shows.filter(s => s.targetName === 'ne2_shaded')
    expect(ne2Shows.length).toBeGreaterThan(0)
    expect(ne2Shows[0]!.layerName).toBe('natural_earth')
  })

  it.each([
    'openfreemap-bright.json',
    'openfreemap-liberty.json',
    'openfreemap-positron.json',
  ])('every raster source in %s receives at least one ShowCommand', (fixture) => {
    const stylePath = path.resolve('compiler/src/__tests__/fixtures', fixture)
    const rasterSources = referencedRasterSourceNames(stylePath)
    if (rasterSources.length === 0) return
    const style = JSON.parse(fs.readFileSync(stylePath, 'utf-8'))
    const xgis = convertMapboxStyle(style)
    let ir = lower(new Parser(new Lexer(xgis).tokenize()).parse())
    ir = optimize(ir)
    const cmds = emitCommands(ir)
    for (const srcName of rasterSources) {
      const matching = cmds.shows.filter(s => s.targetName === srcName)
      expect(matching.length, `${fixture}: ShowCommand for raster source "${srcName}"`).toBeGreaterThan(0)
    }
  })
})
