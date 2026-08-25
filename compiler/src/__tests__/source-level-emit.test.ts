// #1983 (ADR-0012 Phase B1) — SOURCE-level `tileSize` / `maxzoom` / `minzoom` must be
// EMITTED into the xgis source block for the source types whose runtime consumes them,
// instead of being warned away.
//
// The gap this closes: OFM Liberty's `ne2_shaded` declares `tileSize: 256` and
// `maxzoom: 6`, the xgis grammar has parsed all three properties since #1874
// (ir/lower.ts `lowerSource` → emit-commands.ts `LoadCommand` → SourceDef), and the
// runtime honours them (`rasterCoverZoom(zoom, tileSize, sourceMaxzoom)`) — but the
// converter dropped them with a warning, so the ONE path that produces real-world
// styles never used the plumbing that exists for it.
//
// Per-type emit matrix (asserted below): raster + raster-dem emit, because those are
// the two arms that reach `rasterCoverZoom` (RasterRenderer.setTileSize /
// setSourceMaxzoom, HillshadeRenderer.setParams). vector / tilejson / pmtiles /
// geojson keep the warning — the grammar would parse the property on their blocks too,
// but nothing downstream reads it, and emitting an inert line is the same silent gap
// wearing a different hat.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { convertMapboxStyle, type StyleCoverage } from '../convert/mapbox-to-xgis'
import { Lexer, Parser, lower, optimize, emitCommands } from '..'

const HERE = dirname(fileURLToPath(import.meta.url))

function convert(style: unknown): { code: string; warnings: string[] } {
  const coverage: StyleCoverage = { sources: [], layers: [], warnings: [] }
  const code = convertMapboxStyle(style as never, { coverage })
  return { code, warnings: coverage.warnings }
}

/** The emitted `source <id> { … }` block, verbatim (including braces). Line-scanned
 *  rather than regex-matched: tile URL templates carry literal `{z}/{x}/{y}` braces,
 *  so a `\{[^}]*\}` match stops inside the url string. */
function sourceBlock(code: string, id: string): string {
  const lines = code.split('\n')
  const start = lines.indexOf(`source ${id} {`)
  expect(start, `no source block for "${id}" in:\n${code}`).toBeGreaterThanOrEqual(0)
  const end = lines.indexOf('}', start)
  return lines.slice(start, end + 1).join('\n')
}

const rasterStyle = (extra: Record<string, unknown>) => ({
  version: 8,
  sources: {
    relief: { type: 'raster', tiles: ['https://x/{z}/{x}/{y}.png'], ...extra },
  },
  layers: [{ id: 'r', type: 'raster', source: 'relief' }],
})

describe('#1983 W1 — raster source: declared tileSize + maxzoom reach the xgis block', () => {
  it('emits `tileSize: 256` and `maxzoom: 6`, and warns about neither', () => {
    const { code, warnings } = convert(rasterStyle({ tileSize: 256, maxzoom: 6 }))
    const block = sourceBlock(code, 'relief')
    expect(block).toContain('tileSize: 256')
    expect(block).toContain('maxzoom: 6')
    // The two warnings this issue exists to remove.
    expect(warnings.filter((w) => /minzoom|maxzoom|tileSize/.test(w))).toEqual([])
  })

  it('emits maxzoom alone, and tileSize alone', () => {
    expect(sourceBlock(convert(rasterStyle({ maxzoom: 6 })).code, 'relief')).toContain('maxzoom: 6')
    expect(sourceBlock(convert(rasterStyle({ tileSize: 512 })).code, 'relief')).toContain(
      'tileSize: 512',
    )
  })
})

describe('#1983 W2 — raster-dem source: same three properties, DEM props untouched', () => {
  const demStyle = (extra: Record<string, unknown>) => ({
    version: 8,
    sources: {
      terrain: {
        type: 'raster-dem',
        tiles: ['https://dem/{z}/{x}/{y}.png'],
        encoding: 'terrarium',
        ...extra,
      },
    },
    layers: [{ id: 'h', type: 'hillshade', source: 'terrain' }],
  })

  it('emits `tileSize: 512` + `maxzoom: 12` on the raster-dem block', () => {
    const { code, warnings } = convert(demStyle({ tileSize: 512, maxzoom: 12 }))
    const block = sourceBlock(code, 'terrain')
    expect(block).toContain('type: raster-dem')
    expect(block).toContain('tileSize: 512')
    expect(block).toContain('maxzoom: 12')
    expect(warnings.filter((w) => /minzoom|maxzoom|tileSize/.test(w))).toEqual([])
  })

  it('leaves the pre-existing raster-dem diagnostics exactly as they were', () => {
    const { code, warnings } = convert(demStyle({ tileSize: 512, maxzoom: 12 }))
    // encoding is still surfaced as a warning (it has never been emitted — out of
    // scope here, and the hillshade decode reads it off the LoadCommand, not the
    // source block).
    expect(warnings.some((w) => w.includes('non-default encoding="terrarium"'))).toBe(true)
    expect(warnings.some((w) => w.includes('rendering not yet supported'))).toBe(true)
    expect(code).toContain('// NOTE: raster-dem rendering (hillshade / 3D terrain)')
  })
})

describe('#1983 W3 — exotic tileSize is CLAMPED to the nearest supported size + warned', () => {
  // Decision (documented on the emit site): the runtime accepts 256 | 512 only
  // (RasterRenderer.setTileSize / HillshadeRenderer.setParams both ignore anything
  // else), so emitting 1024 verbatim would be silently discarded and the source would
  // fall back to the renderer default — TWO cover-zoom levels from the declared truth
  // instead of one. Clamp in log space (the bias is log2(512/tileSize)) and say so.
  it('1024 → emits 512 with a clamp warning', () => {
    const { code, warnings } = convert(rasterStyle({ tileSize: 1024 }))
    expect(sourceBlock(code, 'relief')).toContain('tileSize: 512')
    expect(warnings.some((w) => w.includes('tileSize: 1024') && w.includes('clamped to 512'))).toBe(
      true,
    )
  })

  it('128 → emits 256 with a clamp warning (the other side of the midpoint)', () => {
    const { code, warnings } = convert(rasterStyle({ tileSize: 128 }))
    expect(sourceBlock(code, 'relief')).toContain('tileSize: 256')
    expect(warnings.some((w) => w.includes('clamped to 256'))).toBe(true)
  })

  it('a non-positive tileSize is dropped, not clamped', () => {
    const { code, warnings } = convert(rasterStyle({ tileSize: 0 }))
    expect(sourceBlock(code, 'relief')).not.toContain('tileSize')
    expect(warnings.some((w) => w.includes('tileSize must be a positive number'))).toBe(true)
  })
})

describe('#1983 W4 — the emitted block survives the whole compile pipeline', () => {
  it('convert → Lexer → Parser → lower → emitCommands carries tileSize + maxzoom', () => {
    const { code } = convert(rasterStyle({ tileSize: 256, maxzoom: 6 }))
    const cmds = emitCommands(optimize(lower(new Parser(new Lexer(code).tokenize()).parse())))
    const load = cmds.loads.find((l) => l.name === 'relief')
    expect(load?.type).toBe('raster')
    expect(load?.tileSize).toBe(256)
    expect(load?.maxzoom).toBe(6)
    expect(load?.minzoom).toBeUndefined()
  })

  it('carries an emitted minzoom too (emit-only — no tile-selector consumer yet)', () => {
    const { code, warnings } = convert(rasterStyle({ minzoom: 3, maxzoom: 6 }))
    const cmds = emitCommands(optimize(lower(new Parser(new Lexer(code).tokenize()).parse())))
    const load = cmds.loads.find((l) => l.name === 'relief')
    expect(load?.minzoom).toBe(3)
    expect(load?.maxzoom).toBe(6)
    // The gap that REMAINS is named precisely: minzoom reaches the IR but the tile
    // selector clamps on maxzoom only, so it still does not gate the fetch.
    expect(warnings.some((w) => w.includes('minzoom: 3') && w.includes('no source-minzoom'))).toBe(
      true,
    )
    expect(warnings.some((w) => w.includes('maxzoom') && w.includes('not emitted'))).toBe(false)
  })
})

describe('#1983 W5 — types whose runtime does NOT consume them keep the warning', () => {
  it('a vector source still warns and emits no zoom/tileSize line', () => {
    const { code, warnings } = convert({
      version: 8,
      sources: { v: { type: 'vector', url: 'https://x/v.pmtiles', minzoom: 0, maxzoom: 14 } },
      layers: [{ id: 'l', type: 'line', source: 'v', 'source-layer': 'roads' }],
    })
    const block = sourceBlock(code, 'v')
    expect(block).not.toContain('maxzoom')
    expect(block).not.toContain('minzoom')
    expect(
      warnings.some(
        (w) => w.includes('"v"') && w.includes('minzoom=0') && w.includes('maxzoom=14'),
      ),
    ).toBe(true)
  })

  it('a geojson source with tileSize still warns and emits nothing extra', () => {
    const { code, warnings } = convert({
      version: 8,
      sources: { g: { type: 'geojson', data: 'https://x/f.geojson', tileSize: 256 } },
      layers: [{ id: 'l', type: 'circle', source: 'g' }],
    })
    expect(sourceBlock(code, 'g')).not.toContain('tileSize')
    expect(warnings.some((w) => w.includes('"g"') && w.includes('tileSize: 256'))).toBe(true)
  })
})

describe('#1983 W6 — regression guards', () => {
  it('a raster source declaring NONE of the three emits exactly the pre-fix block', () => {
    const { code, warnings } = convert(rasterStyle({}))
    expect(sourceBlock(code, 'relief')).toBe(
      'source relief {\n  type: raster\n  url: "https://x/{z}/{x}/{y}.png"\n}',
    )
    expect(warnings).toEqual([])
  })

  it('OFM Liberty: both ne2_shaded warnings are gone, every other warning is unchanged', () => {
    const style = readFileSync(join(HERE, 'fixtures', 'openfreemap-liberty.json'), 'utf8')
    const { code, warnings } = convert(JSON.parse(style))
    // The two that motivated the issue.
    expect(warnings.filter((w) => w.includes('ne2_shaded'))).toEqual([])
    // ...and the source block now carries what the Mapbox JSON declared.
    const block = sourceBlock(code, 'ne2_shaded')
    expect(block).toContain('tileSize: 256')
    expect(block).toContain('maxzoom: 6')
    // Warning COUNT for the other entries is unchanged: 8 before, 8 - 2 = 6 after.
    expect(warnings).toHaveLength(6)
  })
})
