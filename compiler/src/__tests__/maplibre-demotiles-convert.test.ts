// Regression: the official MapLibre demo style at
// https://demotiles.maplibre.org/style.json — the canonical
// "does X support MapLibre styles?" smoke target — must convert
// to a fully parseable + lowerable xgis source.
//
// Shape of interest (snapshotted in fixtures/maplibre-demotiles.json):
//   • version: 8, MapLibre name, glyphs URL
//   • vector source `maplibre` → TileJSON manifest URL
//   • geojson source `crimea` with inline `data` as a single Feature
//     (not a FeatureCollection — the converter has to accept this
//      because the Mapbox Style Spec allows it)
//   • background layer (#D8F2FF) + 3 fill/line layers on `countries`
//     + 1 fill on `crimea`. Three symbol layers are skipped with
//     warnings (text rendering is not in scope here).
//
// The fixture is a byte snapshot pulled from the upstream demo on
// 2026-05-11. If the upstream style changes shape and we have to
// re-pull, the converter should still produce parseable xgis — any
// new keys that aren't supported should surface as warnings, not
// hard errors.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, 'fixtures', 'maplibre-demotiles.json')

describe('MapLibre demo style → xgis full pipeline', () => {
  // Mute the layer-skip warnings (symbol layers etc.) so the test
  // output stays focused on real failures.
  let warnSpy: ReturnType<typeof vi.spyOn>
  let logSpy: ReturnType<typeof vi.spyOn>
  beforeAll(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })
  afterAll(() => {
    warnSpy.mockRestore()
    logSpy.mockRestore()
  })

  it('converts and lexes + parses + lowers without throwing', () => {
    const json = JSON.parse(readFileSync(FIXTURE, 'utf8'))
    const inlineGeoJSON = new Map<string, unknown>()
    const xgis = convertMapboxStyle(json, { inlineGeoJSON })
    expect(xgis.length).toBeGreaterThan(0)

    let err: Error | null = null
    try {
      const tokens = new Lexer(xgis).tokenize()
      const ast = new Parser(tokens).parse()
      lower(ast)
    } catch (e) { err = e as Error }

    if (err) {
      const m = /line (\d+)/.exec(err.message)
      const lineNum = m ? parseInt(m[1]!, 10) : -1
      if (lineNum > 0) {
        const lines = xgis.split('\n')
        const ctx = lines
          .slice(Math.max(0, lineNum - 3), lineNum + 2)
          .map((l, i) => `  ${Math.max(1, lineNum - 2) + i}: ${l}`)
          .join('\n')
        // eslint-disable-next-line no-console
        console.error(`\n--- xgis context near error ---\n${ctx}\n--- end ---\n`)
      }
    }
    expect(err, err?.message).toBeNull()
  })

  it('emits the expected sources, background, and surviving layers', () => {
    const json = JSON.parse(readFileSync(FIXTURE, 'utf8'))
    const inlineGeoJSON = new Map<string, unknown>()
    const xgis = convertMapboxStyle(json, { inlineGeoJSON })

    // Vector source → tilejson (the URL has no .pmtiles extension).
    expect(xgis).toContain('source maplibre {')
    expect(xgis).toContain('type: tilejson')
    expect(xgis).toContain('url: "https://demotiles.maplibre.org/tiles/tiles.json"')

    // GeoJSON source with inline data captured via the collector.
    expect(xgis).toContain('source crimea {')
    expect(xgis).toContain('type: geojson')
    expect(inlineGeoJSON.has('crimea')).toBe(true)

    // Background fill (#D8F2FF → lowercased by colorToXgis).
    expect(xgis.toLowerCase()).toContain('background { fill: #d8f2ff }')

    // Country fill / boundary layers survive conversion. countries-fill
    // is a multi-colour match split by expand-color-match into N
    // sublayers named `countries_fill__c0`, `..._c1`, ..., `..._cd`
    // (the trailing default arm) — one per unique colour in the
    // Mapbox match expression.
    expect(xgis).toContain('layer countries_fill__c0 {')
    expect(xgis).toContain('layer countries_fill__cd {')
    expect(xgis).toContain('layer countries_boundary {')
    expect(xgis).toContain('layer crimea_fill {')
  })
})
