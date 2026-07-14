import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import {
  resolveImports,
  resolveImportsAsync,
  ImportResolutionError,
  type FileReader,
  type AsyncFileReader,
} from '../module/resolver'
import { lower } from '../ir/lower'
import type * as AST from '../parser/ast'
import { withPragma } from './_pragma'
import { XGIS_LANGUAGE_MAJOR } from '../language-version'

function parse(source: string): AST.Program {
  const tokens = new Lexer(withPragma(source)).tokenize()
  return new Parser(tokens).parse()
}

describe('Import parsing', () => {
  it('parses import statement', () => {
    const ast = parse(`import { alert_style, base_style } from "./styles.xgs"`)
    expect(ast.body).toHaveLength(1)
    const stmt = ast.body[0] as AST.ImportStatement
    expect(stmt.kind).toBe('ImportStatement')
    expect(stmt.names).toEqual(['alert_style', 'base_style'])
    expect(stmt.path).toBe('./styles.xgs')
  })

  it('parses `import * as ns from "..."` (namespaced splice) — #1071', () => {
    const ast = parse(`import * as base from "./base.xgis"`)
    expect(ast.body).toHaveLength(1)
    const stmt = ast.body[0] as AST.ImportStatement
    expect(stmt.kind).toBe('ImportStatement')
    expect(stmt.namespace).toBe('base')
    expect(stmt.names).toEqual([])
    expect(stmt.path).toBe('./base.xgis')
  })
})

describe('Module resolution', () => {
  const mockFiles: Record<string, string> = {
    // An imported .xgis "file" — resolveImports parses it, so it carries the
    // version pragma like any real file (#1064).
    './styles.xgs': withPragma(`
      preset military_track {
        | fill-green-500 stroke-black stroke-1
        | opacity-[interpolate(zoom, 8, 40, 14, 100)]
      }

      preset alert_effect {
        | fill-red-500 stroke-red-300 stroke-2
      }
    `),
  }

  const mockReader: FileReader = (path) => mockFiles[path] ?? null

  it('resolves imported presets', () => {
    const ast = parse(`
      import { military_track } from "./styles.xgs"

      source data { type: geojson, url: "tracks.geojson" }
      layer tracks {
        source: data
        | apply-military_track
      }
    `)

    const resolved = resolveImports(ast, './', mockReader)

    // Should have: preset + source + layer (import removed)
    expect(resolved.body).toHaveLength(3)
    expect(resolved.body[0].kind).toBe('PresetStatement')
    expect((resolved.body[0] as AST.PresetStatement).name).toBe('military_track')

    // Verify it compiles to correct IR
    const scene = lower(resolved)
    expect(scene.renderNodes).toHaveLength(1)
    const node = scene.renderNodes[0]
    // military_track preset has fill-green-500
    expect(node.fill.kind).toBe('constant')
  })

  it('imports only named symbols', () => {
    const ast = parse(`
      import { alert_effect } from "./styles.xgs"

      source data { type: geojson, url: "x.geojson" }
      layer x { source: data | apply-alert_effect }
    `)

    const resolved = resolveImports(ast, './', mockReader)

    // Only alert_effect imported, not military_track
    const presets = resolved.body.filter((s) => s.kind === 'PresetStatement')
    expect(presets).toHaveLength(1)
    expect((presets[0] as AST.PresetStatement).name).toBe('alert_effect')
  })

  it('throws on missing file', () => {
    const ast = parse(`import { x } from "./nonexistent.xgs"`)
    expect(() => resolveImports(ast, './', mockReader)).toThrow('Could not read file')
  })

  it('splice form: `import "path"` (no names) prepends every statement', () => {
    const ast = parse(`
      import "./styles.xgs"

      source data { type: geojson, url: "x.geojson" }
      layer x { source: data | fill-red-500 }
    `)
    const stmt = ast.body[0] as AST.ImportStatement
    expect(stmt.kind).toBe('ImportStatement')
    expect(stmt.names).toEqual([])

    const resolved = resolveImports(ast, './', mockReader)
    // Both presets from styles.xgs land + the source + the layer.
    const presets = resolved.body.filter((s) => s.kind === 'PresetStatement')
    expect(presets.map((p) => (p as AST.PresetStatement).name).sort()).toEqual([
      'alert_effect',
      'military_track',
    ])
  })

  it('splice form auto-detects Mapbox style.json and runs the converter', () => {
    const mapboxFiles: Record<string, string> = {
      './bright.json': JSON.stringify({
        version: 8,
        sources: { om: { type: 'vector', url: 'a.pmtiles' } },
        layers: [
          { id: 'bg', type: 'background', paint: { 'background-color': '#fff' } },
          {
            id: 'water',
            type: 'fill',
            source: 'om',
            'source-layer': 'water',
            paint: { 'fill-color': '#a0c8ff' },
          },
        ],
      }),
    }
    const reader: FileReader = (p) => mapboxFiles[p] ?? null

    const ast = parse(`
      import "./bright.json"

      source local { type: geojson, url: "user.geojson" }
      layer overlay { source: local | fill-red-500 }
    `)
    const resolved = resolveImports(ast, './', reader)
    // Converted Mapbox layers + user statements all in one program.
    const sources = resolved.body.filter((s) => s.kind === 'SourceStatement')
    const layers = resolved.body.filter((s) => s.kind === 'LayerStatement')
    const bg = resolved.body.filter((s) => s.kind === 'BackgroundStatement')
    expect(sources.length).toBeGreaterThanOrEqual(2) // om + local
    expect(layers.length).toBeGreaterThanOrEqual(2) // water + overlay
    expect(bg.length).toBeGreaterThanOrEqual(1) // bg
  })

  it('splice form captures inline Mapbox-style GeoJSON `source.data` into options.inlineGeoJSON', () => {
    // The user-visible bug: a Mapbox style with an inline GeoJSON
    // FeatureCollection silently dropped its features at import time
    // because the converter emitted the data as a comment only and the
    // host had to call setSourceData() manually. With the collector
    // option threaded through, the runtime importer captures the data
    // and auto-pushes it after run().
    const inlineFC = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [127, 37] },
          properties: { name: 'seoul' },
        },
      ],
    }
    const mapboxFiles: Record<string, string> = {
      './annotated.json': JSON.stringify({
        version: 8,
        sources: {
          base: { type: 'vector', url: 'a.pmtiles' },
          'my-pins': { type: 'geojson', data: inlineFC },
        },
        layers: [],
      }),
    }
    const reader: FileReader = (p) => mapboxFiles[p] ?? null

    const ast = parse(`import "./annotated.json"`)
    const inlineGeoJSON = new Map<string, unknown>()
    resolveImports(ast, './', reader, { inlineGeoJSON })

    // Sanitised key matches what the converter emits as the source name
    // — runtime looks up this exact id in rawDatasets to seed.
    // Source string round-trips through JSON.stringify in the mock
    // reader and JSON.parse inside the resolver, so identity isn't
    // preserved — deep-equal is the right check.
    expect(inlineGeoJSON.size).toBe(1)
    expect(inlineGeoJSON.get('my_pins')).toStrictEqual(inlineFC)
  })

  it('deduplicates imports from same file', () => {
    const ast = parse(`
      import { military_track } from "./styles.xgs"
      import { alert_effect } from "./styles.xgs"

      source data { type: geojson, url: "x.geojson" }
      layer x { source: data | fill-red-500 }
    `)

    // Should not throw or duplicate — second import from same file is skipped
    const resolved = resolveImports(ast, './', mockReader)
    // First import brings military_track, second import is skipped (same file)
    const presets = resolved.body.filter((s) => s.kind === 'PresetStatement')
    expect(presets).toHaveLength(1)
  })
})

// ═══ #1071 — recursion, namespacing, collision diagnostics ═══
describe('Recursive module resolution (#1071)', () => {
  const presetNames = (p: AST.Program): string[] =>
    p.body.filter((s) => s.kind === 'PresetStatement').map((s) => (s as AST.PresetStatement).name)

  it('recursively resolves nested imports (A imports B imports C) transitively', () => {
    // Fail-before: v1 dropped nested ImportStatements in splice form, so c_deep
    // (and b_mid's transitive chain) never arrived — only a_top did.
    const files: Record<string, string> = {
      './a.xgis': withPragma(`import "./b.xgis"\npreset a_top { | fill-red-500 }`),
      './b.xgis': withPragma(`import "./c.xgis"\npreset b_mid { | fill-green-500 }`),
      './c.xgis': withPragma(`preset c_deep { | fill-blue-500 }`),
    }
    const reader: FileReader = (p) => files[p] ?? null
    const resolved = resolveImports(parse(`import "./a.xgis"`), './', reader)
    // Dependency order: the deepest import lands first.
    expect(presetNames(resolved)).toEqual(['c_deep', 'b_mid', 'a_top'])
  })

  it('detects an import cycle (A -> B -> A) and names the full chain', () => {
    // Fail-before: v1 never recursed, so it never revisited a file and could not
    // see a cycle — it returned normally.
    const files: Record<string, string> = {
      './a.xgis': withPragma(`import "./b.xgis"\npreset a_p { | fill-red-500 }`),
      './b.xgis': withPragma(`import "./a.xgis"\npreset b_p { | fill-green-500 }`),
    }
    const reader: FileReader = (p) => files[p] ?? null
    let err: unknown
    try {
      resolveImports(parse(`import "./a.xgis"`), './', reader)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ImportResolutionError)
    const detail = (err as ImportResolutionError).detail
    expect(detail.code).toBe('IMPORT_CYCLE')
    if (detail.code === 'IMPORT_CYCLE') {
      expect(detail.chain).toEqual(['./a.xgis', './b.xgis', './a.xgis'])
    }
    expect((err as Error).message).toContain('./a.xgis -> ./b.xgis -> ./a.xgis')
  })

  it('errors on a duplicate top-level name from two files, naming both origins', () => {
    // Fail-before: v1 prepended imported statements with zero duplicate detection.
    const files: Record<string, string> = {
      './x.xgis': withPragma(`preset danger { | fill-red-500 }`),
      './y.xgis': withPragma(`preset danger { | fill-orange-500 }`),
    }
    const reader: FileReader = (p) => files[p] ?? null
    let err: unknown
    try {
      resolveImports(parse(`import "./x.xgis"\nimport "./y.xgis"`), './', reader)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ImportResolutionError)
    const detail = (err as ImportResolutionError).detail
    expect(detail.code).toBe('NAME_COLLISION')
    if (detail.code === 'NAME_COLLISION') {
      expect(detail.name).toBe('danger')
      expect(detail.origins.sort()).toEqual(['./x.xgis', './y.xgis'])
    }
    const msg = (err as Error).message
    expect(msg).toContain('danger')
    expect(msg).toContain('./x.xgis')
    expect(msg).toContain('./y.xgis')
  })

  it('resolves a diamond (A imports B,C; B,C import D) — D once, not a collision', () => {
    // Fail-before: v1 dropped the nested D import under both B and C, so d_shared
    // was absent (0), not deduplicated (1).
    const files: Record<string, string> = {
      './a.xgis': withPragma(`import "./b.xgis"\nimport "./c.xgis"\npreset a_p { | fill-red-500 }`),
      './b.xgis': withPragma(`import "./d.xgis"\npreset b_p { | fill-green-500 }`),
      './c.xgis': withPragma(`import "./d.xgis"\npreset c_p { | fill-blue-500 }`),
      './d.xgis': withPragma(`preset d_shared { | fill-amber-500 }`),
    }
    const reader: FileReader = (p) => files[p] ?? null
    const resolved = resolveImports(parse(`import "./a.xgis"`), './', reader)
    const shared = presetNames(resolved).filter((n) => n === 'd_shared')
    expect(shared).toHaveLength(1) // resolved once via the memo, no double-splice, no collision
  })

  it('`import * as ns from` binds and qualifies block-level names + internal refs', () => {
    // Fail-before: v1's parser rejected `import *`; there was no namespacing at all.
    const files: Record<string, string> = {
      './base.xgis': withPragma(`
        source world { type: geojson, url: "world.geojson" }
        preset track { | fill-green-500 }
        keyframes pulse { 0%: opacity-100  100%: opacity-100 }
        layer roads {
          source: world
          | apply-track animation-pulse
        }
      `),
    }
    const reader: FileReader = (p) => files[p] ?? null
    const resolved = resolveImports(parse(`import * as base from "./base.xgis"`), './', reader)

    const find = (kind: AST.Statement['kind']) => resolved.body.find((s) => s.kind === kind)
    // Definitions renamed under the namespace.
    expect((find('SourceStatement') as AST.SourceStatement).name).toBe('base.world')
    expect((find('PresetStatement') as AST.PresetStatement).name).toBe('base.track')
    expect((find('KeyframesStatement') as AST.KeyframesStatement).name).toBe('base.pulse')
    const layer = find('LayerStatement') as AST.LayerStatement
    expect(layer.name).toBe('base.roads')
    // Internal `source:` reference rewritten to the namespaced source.
    const srcProp = layer.properties.find((p) => p.name === 'source')
    expect(srcProp?.value.kind).toBe('Identifier')
    expect((srcProp?.value as AST.Identifier).name).toBe('base.world')
    // apply- / animation- references rewritten to the namespaced targets.
    const utilNames = layer.utilities.flatMap((l) => l.items.map((i) => i.name))
    expect(utilNames).toContain('apply-base.track')
    expect(utilNames).toContain('animation-base.pulse')
    // The rewritten module still lowers (stays wired): the preset expands, the
    // source resolves, and one render node is produced.
    const scene = lower(resolved)
    expect(scene.renderNodes).toHaveLength(1)
    expect(scene.sources.some((s) => s.name === 'base.world')).toBe(true)
  })

  it('accepts pragma-carrying fragments at depth and strips the pragma when splicing', () => {
    // Fail-before: v1 dropped the nested import, so inner_p never arrived.
    // Each fragment opens with a LITERAL `xgis <major>` pragma, like a real file;
    // the pragma is consumed at parse and must never enter the spliced host body
    // (a spliced pragma mid-program would hard-error).
    const files: Record<string, string> = {
      './outer.xgis': `xgis ${XGIS_LANGUAGE_MAJOR}\nimport "./inner.xgis"\npreset outer_p { | fill-red-500 }`,
      './inner.xgis': `xgis ${XGIS_LANGUAGE_MAJOR}\npreset inner_p { | fill-green-500 }`,
    }
    const reader: FileReader = (p) => files[p] ?? null
    const resolved = resolveImports(parse(`import "./outer.xgis"`), './', reader)
    expect(presetNames(resolved)).toEqual(['inner_p', 'outer_p'])
    // No pragma leaked in as a statement — the pragma has no statement kind.
    expect(resolved.body.every((s) => s.kind !== 'ImportStatement')).toBe(true)
  })

  it('reports a missing imported file with its path and importer', () => {
    // Fail-before: v1 dropped the nested import, so `./missing.xgis` was never
    // read and the failure went unreported.
    const files: Record<string, string> = {
      './base.xgis': withPragma(`import "./missing.xgis"\npreset base_p { | fill-red-500 }`),
    }
    const reader: FileReader = (p) => files[p] ?? null
    let err: unknown
    try {
      resolveImports(parse(`import "./base.xgis"`), './', reader)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ImportResolutionError)
    const detail = (err as ImportResolutionError).detail
    expect(detail.code).toBe('MISSING_FILE')
    if (detail.code === 'MISSING_FILE') {
      expect(detail.path).toBe('./missing.xgis')
      expect(detail.importer).toBe('./base.xgis')
    }
    const msg = (err as Error).message
    expect(msg).toContain('Could not read file')
    expect(msg).toContain('./missing.xgis')
    expect(msg).toContain('./base.xgis')
  })

  it('resolveImportsAsync resolves nested imports transitively (sync/async parity)', async () => {
    const files: Record<string, string> = {
      './a.xgis': withPragma(`import "./b.xgis"\npreset a_p { | fill-red-500 }`),
      './b.xgis': withPragma(`preset b_p { | fill-green-500 }`),
    }
    const reader: AsyncFileReader = async (p) => files[p] ?? null
    const resolved = await resolveImportsAsync(parse(`import "./a.xgis"`), './', reader)
    expect(presetNames(resolved)).toEqual(['b_p', 'a_p'])
  })
})
