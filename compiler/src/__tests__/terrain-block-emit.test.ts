// #2095 (T2 terrain track Phase 2, docs/plans/2026-08-24-terrain-track.md §Phase 2) — the
// top-level Mapbox/MapLibre `terrain` block must PARSE, CONVERT, and warn precisely
// instead of being silently dropped into the generic "Top-level style fields ignored"
// warning. Converter-only: this phase renders nothing new (no displacement) — see
// docs/plans/2026-08-24-terrain-track.md Phase 5.
//
// FAIL-BEFORE (TB0): before this phase, `convertMapboxStyle` never reads `style.terrain`
// at all — it only appears, grouped with fog/lights/sky/…, in the generic top-level gap
// warning. No `terrain { … }` block is ever emitted. Captured red in
// t2p2-evidence/tb0-fail-before.txt.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle, type StyleCoverage } from '../convert/mapbox-to-xgis'
import { Lexer, Parser, lower } from '..'
import { lowerTerrainBlock } from '../ir/terrain-block'
import { withPragma } from './_pragma'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

function convert(style: unknown): { code: string; warnings: string[] } {
  const coverage: StyleCoverage = { sources: [], layers: [], warnings: [] }
  const code = convertMapboxStyle(style as never, { coverage })
  return { code, warnings: coverage.warnings }
}

/** The emitted `terrain { … }` block, verbatim, or null if absent. */
function terrainBlock(code: string): string | null {
  const lines = code.split('\n')
  const start = lines.indexOf('terrain {')
  if (start < 0) return null
  const end = lines.indexOf('}', start)
  return lines.slice(start, end + 1).join('\n')
}

/** Parse + find the (single) TerrainStatement in a `.xgis` program, or undefined. */
function parseTerrainStatement(src: string) {
  const ast = new Parser(new Lexer(withPragma(src)).tokenize()).parse()
  return ast.body.find((s) => s.kind === 'TerrainStatement')
}

// The T2 Phase 2 fail-before witness (docs/plans/2026-08-24-terrain-track.md §Phase 2,
// verbatim): {"terrain": {"source": "dem", "exaggeration": 1.5}}.
const witnessStyle = {
  version: 8,
  sources: { dem: { type: 'raster-dem', tiles: ['https://d/{z}/{x}/{y}.png'] } },
  terrain: { source: 'dem', exaggeration: 1.5 },
  layers: [{ id: 'h', type: 'hillshade', source: 'dem' }],
}

describe('#2095 TB1 — the converter EMITS a terrain block instead of dropping it', () => {
  it('the witness style emits a terrain block with source + exaggeration', () => {
    const { code } = convert(witnessStyle)
    const block = terrainBlock(code)
    expect(block, `no terrain block in:\n${code}`).not.toBeNull()
    expect(block).toContain('source: dem')
    expect(block).toContain('exaggeration: 1.5')
  })

  it('the interim warning names the property, the reason, and an alternative (ADR-0012 §1)', () => {
    const { warnings } = convert(witnessStyle)
    const w = warnings.filter((s) => s.includes('terrain'))
    expect(w.length).toBeGreaterThan(0)
    const msg = w.join(' ')
    // property
    expect(msg).toContain('terrain')
    // reason
    expect(msg.toLowerCase()).toContain('displace')
    // alternative
    expect(msg.toLowerCase()).toContain('hillshade')
  })

  it('the generic top-level gap warning no longer lists terrain', () => {
    const { warnings } = convert(witnessStyle)
    const generic = warnings.filter((s) => s.startsWith('Top-level style fields ignored'))
    for (const g of generic) expect(g).not.toMatch(/\bterrain\b/)
  })

  it('a style with no terrain field emits nothing and warns nothing terrain-related', () => {
    const { code, warnings } = convert({
      version: 8,
      sources: {},
      layers: [],
    })
    expect(terrainBlock(code)).toBeNull()
    expect(warnings.some((s) => s.toLowerCase().includes('terrain'))).toBe(false)
  })
})

describe('#2095 TB2 — exaggeration is CONSTANT-ONLY (day-one decision, matches hillshade-exaggeration)', () => {
  it('a non-constant (zoom-expression) exaggeration warns precisely and drops', () => {
    const { code, warnings } = convert({
      version: 8,
      sources: { dem: { type: 'raster-dem', tiles: ['https://d/{z}/{x}/{y}.png'] } },
      terrain: { source: 'dem', exaggeration: ['interpolate', ['linear'], ['zoom'], 5, 1, 10, 3] },
      layers: [],
    })
    const block = terrainBlock(code)
    expect(block).not.toBeNull()
    expect(block).toContain('source: dem')
    expect(block).not.toContain('exaggeration')
    const w = warnings.filter((s) => s.includes('exaggeration'))
    expect(w.length).toBe(1)
    expect(w[0]).toContain('non-constant')
  })

  it('exaggeration: 1 (the spec default) is suppressed — byte-identical to omitting it', () => {
    const withDefault = convert({
      version: 8,
      sources: { dem: { type: 'raster-dem', tiles: ['https://d/{z}/{x}/{y}.png'] } },
      terrain: { source: 'dem', exaggeration: 1 },
      layers: [],
    })
    const withoutField = convert({
      version: 8,
      sources: { dem: { type: 'raster-dem', tiles: ['https://d/{z}/{x}/{y}.png'] } },
      terrain: { source: 'dem' },
      layers: [],
    })
    expect(withDefault.code).toBe(withoutField.code)
  })
})

describe('#2095 TB3 — malformed terrain blocks warn and emit nothing', () => {
  it('terrain as a non-object warns and emits no block', () => {
    const { code, warnings } = convert({ version: 8, sources: {}, terrain: 'oops', layers: [] })
    expect(terrainBlock(code)).toBeNull()
    expect(warnings.some((s) => s.includes('terrain') && s.includes('object'))).toBe(true)
  })

  it('terrain missing source warns and emits no block', () => {
    const { code, warnings } = convert({
      version: 8,
      sources: {},
      terrain: { exaggeration: 2 },
      layers: [],
    })
    expect(terrainBlock(code)).toBeNull()
    expect(warnings.some((s) => s.includes('terrain') && s.includes('source'))).toBe(true)
  })

  it('terrain.source gets sanitizeId treatment, matching a layer source reference', () => {
    const { code } = convert({
      version: 8,
      sources: { '1-dem': { type: 'raster-dem', tiles: ['https://d/{z}/{x}/{y}.png'] } },
      terrain: { source: '1-dem' },
      layers: [],
    })
    const block = terrainBlock(code)
    expect(block).toContain('source: _1_dem')
  })
})

describe('#2095 TB4 — GRAMMAR: the .xgis parser accepts terrain{} as a soft keyword (zero new tokens)', () => {
  it('terrain { source: dem, exaggeration: 1.5 } parses to a TerrainStatement', () => {
    const stmt = parseTerrainStatement('terrain {\n  source: dem\n  exaggeration: 1.5\n}\n')
    expect(stmt?.kind).toBe('TerrainStatement')
  })

  it('REGRESSION: "terrain" stays usable as an ordinary source/layer name (no reserved token)', () => {
    // Verbatim shape of playground/src/examples/hillshade-terrarium.xgis +
    // hillshade-multidir.xgis — both name their raster-dem source "terrain" and
    // reference it via `source: terrain`. A reserved `terrain` keyword would break
    // both; the soft-keyword design (matched by value only at statement-start,
    // looked up only when immediately followed by `{`) must not.
    const src = `
source terrain {
  type: "raster-dem"
  url: "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
  encoding: terrarium
}

layer relief {
  source: terrain
  | hillshade-exaggeration-0.6
}
`
    expect(() => new Parser(new Lexer(withPragma(src)).tokenize()).parse()).not.toThrow()
    const ast = new Parser(new Lexer(withPragma(src)).tokenize()).parse()
    const src1 = ast.body.find((s) => s.kind === 'SourceStatement')
    expect(src1 && 'name' in src1 ? src1.name : undefined).toBe('terrain')
  })

  it('the two real playground examples that name a source "terrain" still parse verbatim', () => {
    for (const file of ['hillshade-terrarium.xgis', 'hillshade-multidir.xgis']) {
      const path = join(HERE, '..', '..', '..', 'playground', 'src', 'examples', file)
      const raw = readFileSync(path, 'utf8')
      expect(() => new Parser(new Lexer(raw).tokenize()).parse(), file).not.toThrow()
    }
  })

  it('lower() does not throw on a program containing only a TerrainStatement (no consumer wired — Phase 2 renders nothing new)', () => {
    const ast = new Parser(
      new Lexer(withPragma('terrain {\n  source: dem\n}\n')).tokenize(),
    ).parse()
    expect(() => lower(ast)).not.toThrow()
    const scene = lower(ast)
    expect(scene.sources).toEqual([])
    expect(scene.renderNodes).toEqual([])
  })
})

describe('#2095 TB5 — the new ir/terrain-block.ts lowering module (leaf, silent, pure)', () => {
  it('CAUSE: lowerTerrainBlock reads source + exaggeration off the parsed properties', () => {
    const stmt = parseTerrainStatement('terrain {\n  source: dem\n  exaggeration: 1.5\n}\n')
    expect(stmt?.kind).toBe('TerrainStatement')
    const props = stmt && 'properties' in stmt ? stmt.properties : []
    expect(lowerTerrainBlock(props)).toEqual({ source: 'dem', exaggeration: 1.5 })
  })

  it('exaggeration is optional — a block with only source lowers without it', () => {
    const stmt = parseTerrainStatement('terrain {\n  source: dem\n}\n')
    const props = stmt && 'properties' in stmt ? stmt.properties : []
    expect(lowerTerrainBlock(props)).toEqual({ source: 'dem' })
  })

  it('a missing source lowers to undefined — silent, matching lowerSourceCluster (author-facing diagnostics live in the converter, not here)', () => {
    expect(lowerTerrainBlock([])).toBeUndefined()
  })
})

describe('#2095 TB6 — EFFECT: the CONVERTER output re-parses and re-lowers to the same values (round-trip)', () => {
  it('the emitted terrain block, re-parsed through Lexer+Parser, lowers back to {source, exaggeration}', () => {
    const { code } = convert(witnessStyle)
    const ast = new Parser(new Lexer(code).tokenize()).parse()
    const stmt = ast.body.find((s) => s.kind === 'TerrainStatement')
    expect(stmt?.kind).toBe('TerrainStatement')
    const props = stmt && 'properties' in stmt ? stmt.properties : []
    expect(lowerTerrainBlock(props)).toEqual({ source: 'dem', exaggeration: 1.5 })
  })
})

describe('#2095 TB7 — byte-identity: none of the committed fixture styles author terrain', () => {
  // grep-proven separately (t2p2-evidence/); this is the same claim as an executable
  // assertion so it cannot silently go stale.
  const FIXTURES = [
    'maplibre-demotiles',
    'openfreemap-bright',
    'openfreemap-liberty',
    'openfreemap-positron',
  ] as const
  for (const name of FIXTURES) {
    it(`${name}.json does not declare style.terrain`, () => {
      const style = JSON.parse(readFileSync(join(HERE, 'fixtures', `${name}.json`), 'utf8')) as {
        terrain?: unknown
      }
      expect(style.terrain).toBeUndefined()
    })
  }
})

// TB8 (#2110 review) — the dead-source drop pass and the terrain emit are two passes that
// disagreed. The drop builds its liveness set from LAYER `source` fields only and runs
// BEFORE the terrain block is emitted, so a raster-dem declared for terrain and used by no
// layer — the ordinary shape, since terrain needs no hillshade layer — was deleted while
// `terrain { source: <that id> }` was still written out. The emitted .xgis then named a
// source that did not exist, and the notes block carried two warnings contradicting each
// other. None of TB1-TB7 could see it: every one of them declares a layer over the same
// dem, which keeps the source live for the wrong reason.
describe('TB8 — a source referenced ONLY by terrain stays alive', () => {
  const styleWithTerrainOnlyDem = {
    version: 8,
    sources: {
      dem: { type: 'raster-dem', tiles: ['https://x/{z}/{x}/{y}.png'], encoding: 'terrarium' },
      base: { type: 'vector', tiles: ['https://y/{z}/{x}/{y}.pbf'] },
    },
    terrain: { source: 'dem', exaggeration: 1.5 },
    layers: [{ id: 'l', type: 'line', source: 'base', 'source-layer': 'road' }],
  }

  it('emits the source block the terrain block names', () => {
    const { code } = convert(styleWithTerrainOnlyDem)
    expect(code).toContain('terrain {')
    expect(code, 'terrain names a source the drop pass deleted').toMatch(/source dem\s*\{/)
  })

  it('does not claim the source is unreferenced', () => {
    const { warnings } = convert(styleWithTerrainOnlyDem)
    const dropped = warnings.filter((w) => w.includes('never referenced by any layer'))
    expect(dropped, `contradicts the terrain emit: ${dropped.join(' | ')}`).toEqual([])
  })

  it('still drops a dem that NOTHING references — the pass keeps its teeth', () => {
    // The negative control. Without it, "keep every raster-dem" would pass the two above.
    const { code, warnings } = convert({
      ...styleWithTerrainOnlyDem,
      terrain: { source: 'base', exaggeration: 1 },
    })
    expect(code).not.toMatch(/source dem\s*\{/)
    expect(warnings.some((w) => w.includes('never referenced by any layer'))).toBe(true)
  })

  it('lowers the emitted program — a dangling source would not resolve', () => {
    const { code } = convert(styleWithTerrainOnlyDem)
    const ast = new Parser(new Lexer(withPragma(code)).tokenize()).parse()
    expect(() => lower(ast)).not.toThrow()
  })
})
