// Mapbox v3 `imports` → the xgis `import "<url>"` statement (#2471).
//
// The converter used to name `imports` in the lumped
// `Top-level style fields ignored: …` warning and drop it. For a v3 Standard
// style that is the whole basemap: the emit keeps the author's few overlay
// layers and loses the map under them, described in the same sentence as
// `models` and `font-faces`.
//
// Nothing had to be built to fix it. `resolveImportsAsync`
// (module/resolver.ts:249) already fetches a URL, and `parseModuleSource`
// (:365) already runs `convertMapboxStyle` on whatever comes back that
// `looksLikeMapboxStyle`. The converter simply never emitted the statement
// that reaches them. These tests pin BOTH halves — the emit, and the fact that
// the emit actually resolves through that wire — because an emit that merely
// looks right is the failure mode a converter-only assertion cannot see.
//
// The forms that stay out (`mapbox://`, `config`, inline `data`) get their own
// arms, and each has a CONTROL beside it: an assertion that a form is declined
// carries no information unless something proves the converter does not decline
// everything.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle, type StyleCoverage } from './mapbox-to-xgis'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { resolveImportsAsync } from '../module/resolver'
import type * as AST from '../parser/ast'

function convert(style: Record<string, unknown>): { src: string; warnings: string[] } {
  const coverage: StyleCoverage = { sources: [], layers: [], warnings: [] }
  const src = convertMapboxStyle(style as never, { coverage })
  return { src, warnings: coverage.warnings }
}

/** A minimal well-formed Mapbox style — the thing an import points AT. */
function baseStyle(layerId: string): Record<string, unknown> {
  return {
    version: 8,
    name: 'base',
    sources: { basemap: { type: 'vector', url: 'https://example.invalid/base.json' } },
    layers: [{ id: layerId, type: 'fill', source: 'basemap', 'source-layer': 'land' }],
  }
}

/** A root style that imports `url` and declares one overlay layer of its own. */
function rootStyle(imports: unknown[]): Record<string, unknown> {
  return {
    version: 8,
    name: 'root',
    imports,
    sources: { pts: { type: 'vector', url: 'https://example.invalid/pts.json' } },
    layers: [{ id: 'overlay', type: 'fill', source: 'pts', 'source-layer': 'x' }],
  }
}

/** The import paths the emitted source declares, in emit order. */
function importPaths(src: string): string[] {
  return [...src.matchAll(/^import\s+"([^"]*)"/gm)].map((m) => m[1]!)
}

describe('#2471 — `imports` lowers to an xgis import statement', () => {
  // THE CONTROL for every emit assertion below: a style with no `imports`
  // must emit no import statement. Without it, a converter that emitted
  // `import ""` unconditionally would satisfy all of them.
  it('a style with no `imports` emits no import statement', () => {
    const { src } = convert(baseStyle('land'))
    expect(importPaths(src)).toEqual([])
  })

  it('a plain-URL import is emitted as `import "<url>"`', () => {
    const { src } = convert(rootStyle([{ id: 'basemap', url: './base.json' }]))
    expect(importPaths(src)).toEqual(['./base.json'])
  })

  it('leaves the lumped "fields ignored" warning — both directions', () => {
    // `models` keeps the lump alive so "imports is not in it" is asserted
    // against a lump that still exists, not against its absence. Without
    // that, deleting the whole lumped warning would pass this test.
    const style = rootStyle([{ id: 'basemap', url: './base.json' }])
    style.models = { a: 'b' }
    const { warnings } = convert(style)
    const lump = warnings.find((w) => w.startsWith('Top-level style fields ignored:'))
    expect(lump, `the lump must still exist for models: ${JSON.stringify(warnings)}`).toBeDefined()
    expect(lump).toContain('models')
    expect(lump, `"imports" must have left the lump: ${lump}`).not.toContain('imports')
  })

  it('emits the import BEFORE the style’s own sources and layers', () => {
    // Not cosmetic. `resolveImportsAsync` splices each import’s statements at
    // the import’s own line, so emit position IS draw order: the imported
    // basemap has to land under the root style’s overlay, which is Mapbox’s
    // default placement when no slots are used.
    const { src } = convert(rootStyle([{ id: 'basemap', url: './base.json' }]))
    const importAt = src.indexOf('import "./base.json"')
    const sourceAt = src.search(/^source\s/m)
    const layerAt = src.search(/^layer\s/m)
    expect(importAt).toBeGreaterThanOrEqual(0)
    expect(sourceAt).toBeGreaterThanOrEqual(0)
    expect(layerAt).toBeGreaterThanOrEqual(0)
    expect(importAt).toBeLessThan(sourceAt)
    expect(importAt).toBeLessThan(layerAt)
  })

  it('emits several imports in declaration order', () => {
    const { src } = convert(
      rootStyle([
        { id: 'a', url: './a.json' },
        { id: 'b', url: './b.json' },
      ]),
    )
    expect(importPaths(src)).toEqual(['./a.json', './b.json'])
  })
})

describe('#2471 — the forms that stay out, each with a control', () => {
  it('a `mapbox://` url emits NO import and warns, naming the token requirement', () => {
    const { src, warnings } = convert(
      rootStyle([{ id: 'basemap', url: 'mapbox://styles/mapbox/standard' }]),
    )
    expect(importPaths(src)).toEqual([])
    const w = warnings.filter((s) => s.includes('mapbox://styles/mapbox/standard'))
    expect(w, `expected a precise mapbox:// warning, got ${JSON.stringify(warnings)}`).toHaveLength(
      1,
    )
    expect(w[0]).toMatch(/access token|Mapbox API/i)
  })

  it('an inline `data` import emits NO import and warns that there is nothing to fetch', () => {
    const { src, warnings } = convert(rootStyle([{ id: 'basemap', data: baseStyle('land') }]))
    expect(importPaths(src)).toEqual([])
    expect(warnings.some((s) => s.includes('"data"'))).toBe(true)
  })

  it('`config` still imports, but warns that the options are dropped', () => {
    // The control half of this one is the assertion that the import STILL
    // happens: a `config` handled by declining the whole import would lose
    // the basemap, which is the bug this issue exists to fix.
    const { src, warnings } = convert(
      rootStyle([
        { id: 'basemap', url: './base.json', config: { showPointOfInterestLabels: false } },
      ]),
    )
    expect(importPaths(src)).toEqual(['./base.json'])
    const w = warnings.filter((s) => s.includes('config'))
    expect(w, `expected a config warning, got ${JSON.stringify(warnings)}`).toHaveLength(1)
    expect(w[0]).toContain('basemap')
  })

  it('a malformed `imports` (not an array) warns instead of being described as imports', () => {
    const style = rootStyle([])
    style.imports = { id: 'basemap', url: './base.json' }
    const { src, warnings } = convert(style)
    expect(importPaths(src)).toEqual([])
    expect(warnings.some((s) => s.includes('malformed') && s.includes('imports'))).toBe(true)
  })

  it('a url that would break out of the string literal is rejected, and does not also claim to resolve', () => {
    // The emitted path sits inside a double-quoted xgis literal, so a `"` in it
    // would terminate the statement early and corrupt everything after. The
    // second half is the ordering this pins: `config` warns "the import itself
    // still resolves", which must not be said about an entry that was rejected.
    const { src, warnings } = convert(
      rootStyle([{ id: 'basemap', url: './a".json', config: { x: 1 } }]),
    )
    expect(importPaths(src)).toEqual([])
    expect(warnings.some((s) => s.includes('quote or newline'))).toBe(true)
    expect(warnings.some((s) => s.includes('still resolves'))).toBe(false)
  })

  it('an entry with neither `url` nor `data` warns rather than emitting an empty import', () => {
    const { src, warnings } = convert(rootStyle([{ id: 'basemap' }]))
    expect(importPaths(src)).toEqual([])
    expect(warnings.some((s) => s.includes('basemap'))).toBe(true)
  })
})

// The half a converter-only test cannot see: whether the statement the emit
// produces actually reaches the resolver and brings the basemap back. This is
// the assertion that proves the wire is connected rather than that the string
// looks right.
describe('#2471 — the emitted import resolves through resolveImportsAsync', () => {
  function parse(src: string): AST.Program {
    return new Parser(new Lexer(src).tokenize()).parse()
  }

  function layerNames(program: AST.Program): string[] {
    return program.body.filter((s) => s.kind === 'LayerStatement').map((s) => s.name)
  }

  it('splices the imported style’s layers UNDER the root style’s own', async () => {
    const { src } = convert(rootStyle([{ id: 'basemap', url: './base.json' }]))
    const files: Record<string, string> = { './base.json': JSON.stringify(baseStyle('land')) }
    const resolved = await resolveImportsAsync(parse(src), '', async (p) => files[p] ?? null)

    const names = layerNames(resolved)
    expect(names, `expected both layers, got ${JSON.stringify(names)}`).toContain('land')
    expect(names).toContain('overlay')
    expect(
      names.indexOf('land'),
      'the imported basemap must be spliced BEFORE the root overlay',
    ).toBeLessThan(names.indexOf('overlay'))
  })

  it('recurses — an imported style that itself imports resolves both levels', async () => {
    // `parseModuleSource` runs `convertMapboxStyle` on any fetched file that
    // `looksLikeMapboxStyle`, so the MIDDLE style's own `imports` only resolve
    // if the converter emits an import statement there too. That makes this a
    // test of the converter, not just of the pre-existing resolver recursion.
    const middle = rootStyle([{ id: 'deep', url: './deep.json' }])
    middle.name = 'middle'
    ;(middle.layers as Record<string, unknown>[])[0]!.id = 'middle-layer'

    const { src } = convert(rootStyle([{ id: 'basemap', url: './middle.json' }]))
    const files: Record<string, string> = {
      './middle.json': JSON.stringify(middle),
      './deep.json': JSON.stringify(baseStyle('deep-layer')),
    }
    const resolved = await resolveImportsAsync(parse(src), '', async (p) => files[p] ?? null)

    // NOT `deep-layer` / `middle-layer`: the converter sanitizes a layer id
    // into a legal xgis identifier, so a hyphen becomes `_`. Guessed wrong
    // first, and the ORDER — the thing this test is actually about — was right
    // in that same run.
    const names = layerNames(resolved)
    expect(names, `expected all three levels, got ${JSON.stringify(names)}`).toEqual([
      'deep_layer',
      'middle_layer',
      'overlay',
    ])
  })
})
