// Regression: the OpenFreeMap Bright style — the preset on /convert
// and a representative real-world Mapbox v8 basemap — must convert
// to a fully parseable + lowerable xgis source.
//
// Original failure: clicking "Open in Playground" after converting
// produced an immediate compile error because `text-offset: [0, -0.2]`
// emitted `label-offset-y--0.2` (double-dash, malformed utility name).
// Fix: bracket-binding form for negatives in the converter +
// constant-binding extraction in the lower pass.
//
// The fixture is a snapshot of the live style at the time of the
// regression (~50 KB JSON). If the upstream style adds new keys we
// don't yet support, the converter should emit warnings (skipped
// here via console mute) but still produce parseable xgis.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, 'fixtures', 'openfreemap-bright.json')

describe('OpenFreeMap Bright → xgis full pipeline', () => {
  // The converter logs a lot of layer-skip warnings for icons/sprites
  // that aren't part of this regression. Mute them so the test output
  // stays focused on real failures.
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
    const xgis = convertMapboxStyle(json)
    expect(xgis.length).toBeGreaterThan(0)

    // The original bug: `--N` in the output broke the lexer at the
    // very first symbol layer with negative text-offset.
    expect(xgis).not.toMatch(/label-(offset-[xy]|rotate|letter-spacing)--/)

    let err: Error | null = null
    try {
      const tokens = new Lexer(xgis).tokenize()
      const ast = new Parser(tokens).parse()
      lower(ast)
    } catch (e) { err = e as Error }

    if (err) {
      // Surface a snippet of the xgis around the failure point so
      // future regressions are diagnosable from CI output.
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
})
