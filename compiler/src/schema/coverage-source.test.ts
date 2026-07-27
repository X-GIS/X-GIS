// ═══ `coverage` source + LAYER paint — grammar + schema pin (#1158 A9 / INC-D) ═══
//
// Pins the `.xgis` syntax for an S-100 coverage source and the SOURCE_TYPES membership
// that makes it a BUILT-IN (auto-propagated to @xgis/map's BUILTIN_SOURCE_TYPES).
// Adding 'coverage' here does NOT trip the spec-coverage ↔ RUNTIME_CAPABILITIES drift
// gate — the Mapbox converter's spec-coverage table is a separate authority (A9).
// ramp/range are LAYER paint (INC-D — the raster-color / raster-color-range analogue),
// NOT source options; a `coverage` source is data-only, and the drawing layer carries
// the palette + window on its ShowCommand.

import { describe, it, expect } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { withPragma } from '../__tests__/_pragma'
import { SOURCE_TYPES, LANGUAGE_SCHEMA } from './language'
import { lower } from '../ir/lower'
import { emitCommands } from '../ir/emit-commands'

/** Lower + emit a `.xgis` program to its runtime commands (loads + shows). */
function compile(src: string) {
  return emitCommands(lower(new Parser(new Lexer(withPragma(src)).tokenize()).parse()))
}

describe('coverage source + layer: grammar + schema (A9 / INC-D)', () => {
  it('a coverage LAYER carries ramp/range onto its ShowCommand; the source is data-only', () => {
    const cmds = compile(
      'source bathy { type: coverage, url: "SEA_S102_2026.h5" }\n' +
        'layer depth { source: bathy, ramp: "bathymetry", range: [0, 40] }',
    )
    // Source = data-only: the LoadCommand has NO ramp/range (removed from the type).
    const load = cmds.loads.find((l) => l.name === 'bathy')!
    expect(load.type).toBe('coverage')
    expect((load as unknown as Record<string, unknown>).ramp).toBeUndefined()
    // Layer = paint: ramp/range ride the ShowCommand that draws the coverage source.
    const show = cmds.shows.find((s) => s.targetName === 'bathy')!
    expect(show.ramp).toBe('bathymetry')
    expect(show.range).toEqual([0, 40])
  })

  it('a malformed layer `range` fails LOUDLY (never a silent default recolour)', () => {
    expect(() =>
      compile('source b { type: coverage, url: "x.h5" }\nlayer d { source: b, range: [0] }'),
    ).toThrow(/'range' must be a two-number array/)
  })

  it("'coverage' is a grammar SOURCE_TYPE (→ built-in via BUILTIN_SOURCE_TYPES)", () => {
    expect(SOURCE_TYPES).toContain('coverage')
    // Mirror @xgis/map's derivation: BUILTIN_SOURCE_TYPES = SOURCE_TYPES + 'xgvt'.
    const builtin = new Set<string>([...SOURCE_TYPES, 'xgvt'])
    expect(builtin.has('coverage')).toBe(true)
    // An unknown type is NOT built-in → routes to the per-map custom-loader registry.
    expect(builtin.has('x-kr-admin')).toBe(false)
  })

  it('the LAYER construct advertises ramp/range paint; the SOURCE construct does not', () => {
    const layerKeys = LANGUAGE_SCHEMA.layer!.properties.map((p) => p.key)
    expect(layerKeys).toContain('ramp')
    expect(layerKeys).toContain('range')
    const sourceKeys = LANGUAGE_SCHEMA.source!.properties.map((p) => p.key)
    expect(sourceKeys).not.toContain('ramp')
    expect(sourceKeys).not.toContain('range')
    // `type` enum options still include coverage (the editor/palette single-authority).
    const typeProp = LANGUAGE_SCHEMA.source!.properties.find((p) => p.key === 'type')!
    expect(typeProp.options).toContain('coverage')
  })
})

describe('coverage layer: sounding LABELS reach the ShowCommand (#1366 INC-5)', () => {
  // A coverage layer carrying `label-[…]` has always compiled — `lowerLabelProps` is
  // source-type-blind — and the runtime then drew NOTHING, because a coverage source has
  // neither `features` nor a vector-tile entry for the label pass to walk. The renderer
  // now has a coverage arm; this pins the compiler half of that contract, so the label
  // def cannot quietly stop arriving.
  it('a label utility on a coverage layer lowers to a LabelDef with the band expression', () => {
    const cmds = compile(
      'source bathy { type: coverage, url: "cell.h5" }\n' +
        'layer soundings { source: bathy\n  | label-[round(.depth)] label-size-11 label-halo-1\n}',
    )
    const show = cmds.shows.find((s) => s.targetName === 'bathy')!
    expect(show.label).toBeDefined()
    expect(show.label!.size).toBe(11)
    expect(show.label!.halo?.width).toBe(1)
    // The text is an EXPRESSION over the band name, exactly as it would be over a
    // feature property — the band bag the runtime hands in is keyed by band name.
    expect(show.label!.text.kind).toBe('expr')
  })

  it('a ramp layer and a label layer over the SAME coverage stay independent shows', () => {
    // The shipped shape: one layer draws the colour ramp, a second prints the numerals.
    // Two shows on one source — the fill must not acquire a label, nor the labels a ramp.
    const cmds = compile(
      'source bathy { type: coverage, url: "cell.h5" }\n' +
        'layer depth { source: bathy, ramp: "bathymetry", range: [0, 30] }\n' +
        'layer soundings { source: bathy\n  | label-[.depth]\n}',
    )
    const shows = cmds.shows.filter((s) => s.targetName === 'bathy')
    expect(shows.length).toBe(2)
    const fill = shows.find((s) => s.ramp !== undefined)!
    const labels = shows.find((s) => s.label !== undefined)!
    expect(fill.label).toBeUndefined()
    expect(labels.ramp).toBeUndefined()
  })
})

describe('coverage source: hdf5/h5 are format-name aliases (canonicalise → coverage)', () => {
  // The exact mirror of `pmtiles`/`tilejson` under `vector`: a container name is a
  // first-class spelling of the render family, canonicalised to the role name at the
  // ONE lowering chokepoint so the IR + dead-layer-elim + runtime only see `coverage`.
  function lowerFirstSource(src: string) {
    const program = new Parser(new Lexer(withPragma(src)).tokenize()).parse()
    return lower(program).sources
  }
  it.each(['hdf5', 'h5'])('`type: %s` lowers to a coverage SourceDef (role name)', (alias) => {
    const [src] = lowerFirstSource(
      `source cur { type: ${alias}, url: "cbofs.h5" }\nlayer l { source: cur }`,
    )
    expect(src!.name).toBe('cur')
    expect(src!.type).toBe('coverage')
  })
  it('`hdf5`/`h5` are grammar SOURCE_TYPES (bare identifier parses → built-in)', () => {
    expect(SOURCE_TYPES).toContain('hdf5')
    expect(SOURCE_TYPES).toContain('h5')
    const builtin = new Set<string>([...SOURCE_TYPES, 'xgvt'])
    expect(builtin.has('hdf5')).toBe(true)
    expect(builtin.has('h5')).toBe(true)
  })
})
