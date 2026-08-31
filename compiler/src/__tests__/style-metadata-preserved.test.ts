// Root `metadata` is preserved into the converted xgis as a comment — the same
// channel root `name` already uses — and the TWO coverage rows that spell that
// word are bound to what the converter actually did.
//
// Why a binding is needed: `metadata` is the one row name that appears twice in
// the coverage table for the SAME concept (arbitrary author data that does not
// affect rendering), at two nesting levels — `top-level` and `layer-common`.
// Nothing tied either row to the converter, and they drifted apart: one said
// `unsupported` "silent drop", the other said `na` for the same silent drop.
// (Other duplicated names — `sky`, `image`, `raster`, `zoom` — are genuinely
// different concepts sharing a spelling, so this binding is deliberately scoped
// to `metadata` rather than applied to every duplicate name.)
//
// The rule both rows now answer to, measured in ONE conversion run:
//   carried into the emitted source  ⇒ 'supported'   (a comment is the whole of
//                                                     the xgis form this
//                                                     non-rendering data has)
//   dropped                          ⇒ 'unsupported' (converter drops it)
//
// Nothing here reads a row's own literal back: every status is compared against
// a boolean produced by running the converter over a real style.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'
import { MAPBOX_COVERAGE } from '../convert/spec-coverage'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, 'fixtures', 'maplibre-demotiles.json')

// The MapLibre demo style's OWN root metadata — a MapTiler licence pointer plus
// an OpenMapTiles schema version. Real author data, not a synthetic one-key
// object, so "preserved" means preserved as styles actually carry it.
const ROOT_MARKERS = ['maptiler:copyright', 'openmaptiles:version', '3.x']
// The fixture carries no LAYER metadata, so the layer half of the binding tags
// one layer with the shape the spec allows. The root half stays the fixture's.
const LAYER_MARKER = 'xgis-layer-metadata-probe'

function convertFixture(): string {
  const style = JSON.parse(readFileSync(FIXTURE, 'utf8'))
  style.layers[0].metadata = { 'xgis:probe': LAYER_MARKER }
  return convertMapboxStyle(style, { inlineGeoJSON: new Map<string, unknown>() })
}

function rowIn(sectionId: string): { status: string; note?: string } {
  const section = MAPBOX_COVERAGE.find((s) => s.id === sectionId)
  expect(section, `no coverage section '${sectionId}'`).toBeDefined()
  const row = section!.entries.find((e) => e.name === 'metadata')
  expect(row, `no 'metadata' row in section '${sectionId}'`).toBeDefined()
  return row!
}

describe('style metadata — preserved as a comment, and both rows bound to that', () => {
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

  it('root metadata survives the conversion inside a block comment', () => {
    const xgis = convertFixture()
    const blockComments = [...xgis.matchAll(/\/\*[\s\S]*?\*\//g)].map((m) => m[0])
    for (const marker of ROOT_MARKERS) {
      expect(xgis, `root metadata "${marker}" was dropped by the converter`).toContain(marker)
      expect(
        blockComments.some((c) => c.includes(marker)),
        `root metadata "${marker}" reached the output but not inside a /* comment */`,
      ).toBe(true)
    }
  })

  it('the preserved metadata is inert — the output still lexes, parses and lowers', () => {
    const xgis = convertFixture()
    expect(() => lower(new Parser(new Lexer(xgis).tokenize()).parse())).not.toThrow()
  })

  it('both metadata rows match what the converter did at their own level', () => {
    const xgis = convertFixture()
    const rootCarried = ROOT_MARKERS.every((m) => xgis.includes(m))
    const layerCarried = xgis.includes(LAYER_MARKER)
    const expected = (carried: boolean) => (carried ? 'supported' : 'unsupported')

    expect(
      rowIn('top-level').status,
      `converter ${rootCarried ? 'CARRIES' : 'DROPS'} root metadata — the top-level row must say '${expected(rootCarried)}'`,
    ).toBe(expected(rootCarried))
    expect(
      rowIn('layer-common').status,
      `converter ${layerCarried ? 'CARRIES' : 'DROPS'} layer metadata — the layer-common row must say '${expected(layerCarried)}'`,
    ).toBe(expected(layerCarried))
  })

  it('the table still carries exactly the two metadata rows this binding covers', () => {
    // Premise pin: if a row is deleted or a third appears, the binding above
    // would silently stop covering it.
    const found = MAPBOX_COVERAGE.flatMap((s) =>
      s.entries.filter((e) => e.name === 'metadata').map(() => s.id),
    )
    expect(found).toEqual(['top-level', 'layer-common'])
  })
})
