import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { resolveImports, type FileReader } from '../module/resolver'
import { lower } from '../ir/lower'
import type * as AST from '../parser/ast'

function parse(source: string): AST.Program {
  const tokens = new Lexer(source).tokenize()
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
})

describe('Module resolution', () => {
  const mockFiles: Record<string, string> = {
    './styles.xgs': `
      preset military_track {
        | fill-green-500 stroke-black stroke-1
        | opacity-[interpolate(zoom, 8, 40, 14, 100)]
      }

      preset alert_effect {
        | fill-red-500 stroke-red-300 stroke-2
      }
    `,
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
    const presets = resolved.body.filter(s => s.kind === 'PresetStatement')
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
    const presets = resolved.body.filter(s => s.kind === 'PresetStatement')
    expect(presets.map(p => (p as AST.PresetStatement).name).sort())
      .toEqual(['alert_effect', 'military_track'])
  })

  it('splice form auto-detects Mapbox style.json and runs the converter', () => {
    const mapboxFiles: Record<string, string> = {
      './bright.json': JSON.stringify({
        version: 8,
        sources: { om: { type: 'vector', url: 'a.pmtiles' } },
        layers: [
          { id: 'bg', type: 'background', paint: { 'background-color': '#fff' } },
          { id: 'water', type: 'fill', source: 'om', 'source-layer': 'water',
            paint: { 'fill-color': '#a0c8ff' } },
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
    const sources = resolved.body.filter(s => s.kind === 'SourceStatement')
    const layers = resolved.body.filter(s => s.kind === 'LayerStatement')
    const bg = resolved.body.filter(s => s.kind === 'BackgroundStatement')
    expect(sources.length).toBeGreaterThanOrEqual(2)  // om + local
    expect(layers.length).toBeGreaterThanOrEqual(2)   // water + overlay
    expect(bg.length).toBeGreaterThanOrEqual(1)        // bg
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
    const presets = resolved.body.filter(s => s.kind === 'PresetStatement')
    expect(presets).toHaveLength(1)
  })
})
