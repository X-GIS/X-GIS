// ═══ SceneBuilder ↔ parser parity gate (#1194, design §2.4) ═══
//
// For each paired example the builder program must be STRUCTURALLY IDENTICAL
// to the parsed .xgis text (line numbers masked — the builder has no source
// lines; toEqual's undefined-key semantics matches the defined-key rule), AND
// the two must lower+emit to byte-equal SceneCommands (the second gate that
// catches any masking mistake from the other side). The .xgis texts are the
// ACTUAL gallery files, fs-read — the same bytes the gallery serves — so a
// gallery edit that breaks its builder twin fails here first.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Lexer, Parser, lower, optimize, emitCommands } from '..'
import {
  SceneBuilder,
  call,
  compare,
  field,
  ident,
  interpolateZoom,
  matchOn,
  type SceneProgram,
} from './scene-builder'
import type * as AST from '../parser/ast'

const EXAMPLES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'playground',
  'src',
  'examples',
)

const parseExample = (file: string): AST.Program =>
  new Parser(new Lexer(readFileSync(join(EXAMPLES, file), 'utf8')).tokenize()).parse()

/** Deep-copy with every `line` value normalised to 0 — the ONLY masked field
 *  (design §2.4). Everything else must match exactly. */
function maskLines<T>(node: T): T {
  if (Array.isArray(node)) return node.map(maskLines) as T
  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node)) out[k] = k === 'line' ? 0 : maskLines(v)
    return out as T
  }
  return node
}

const commandsBytes = (p: AST.Program): string => JSON.stringify(emitCommands(optimize(lower(p))))

function assertPair(file: string, scene: SceneProgram): void {
  const parsed = parseExample(file)
  expect(maskLines(scene.program)).toEqual(maskLines(parsed))
  expect(commandsBytes(scene.program)).toBe(commandsBytes(parsed))
}

describe('SceneBuilder ↔ parser parity (#1194)', () => {
  it('minimal.xgis', () => {
    const scene = new SceneBuilder()
      .source('world', { type: ident('geojson'), url: 'ne_110m_countries.geojson' })
      .layer('countries', (l) =>
        l.source('world').util('fill-stone-200', 'stroke-stone-400', 'stroke-1'),
      )
      .build()
    assertPair('minimal.xgis', scene)
  })

  it('zoom.xgis (zoom-interpolated opacity binding)', () => {
    const scene = new SceneBuilder()
      .source('world', { type: ident('geojson'), url: 'countries.geojson' })
      .layer('countries', (l) =>
        l
          .source('world')
          .util('fill-purple-400', 'stroke-purple-200', 'stroke-1')
          .util({ name: 'opacity', binding: interpolateZoom([2, 30], [5, 60], [8, 90]) }),
      )
      .build()
    assertPair('zoom.xgis', scene)
  })

  it('continent-match.xgis (match block with default arm)', () => {
    const scene = new SceneBuilder()
      .source('countries', { type: ident('geojson'), url: 'ne_110m_countries.geojson' })
      .layer('continents', (l) =>
        l.source('countries').util(
          {
            name: 'fill',
            binding: matchOn('CONTINENT', {
              Africa: 'amber-600',
              Asia: 'rose-500',
              Europe: 'sky-500',
              'North America': 'emerald-500',
              'South America': 'lime-500',
              Oceania: 'violet-500',
              Antarctica: 'slate-300',
              _: '#9ca3af',
            }),
          },
          'stroke-slate-700',
          'stroke-0.5',
          'opacity-90',
        ),
      )
      .build()
    assertPair('continent-match.xgis', scene)
  })

  // ── A2 pairs: filters, presets, keyframes, symbols, fn-call bindings ──

  it('filter-gdp.xgis (preset + style: reference + filter exprs + style properties)', () => {
    const scene = new SceneBuilder()
      .preset('dark_base', ['fill-slate-900', 'stroke-slate-700', 'stroke-0.5'])
      .source('countries', { type: ident('geojson'), url: 'ne_110m_countries.geojson' })
      .layer('all', (l) => l.source('countries').style('dark_base'))
      .layer('wealthy', (l) =>
        l
          .source('countries')
          .filter(compare(field('GDP_MD_EST'), '>', 1000000))
          .styleProp('fill', 'emerald-600')
          .styleProp('stroke', 'emerald-400')
          .styleProp('stroke-width', 1)
          .styleProp('opacity', 0.9),
      )
      .layer('top_economies', (l) =>
        l
          .source('countries')
          .filter(compare(field('GDP_MD_EST'), '>', 5000000))
          .styleProp('fill', 'yellow-500')
          .styleProp('stroke', 'yellow-300')
          .styleProp('stroke-width', 2),
      )
      .build()
    assertPair('filter-gdp.xgis', scene)
  })

  it('custom-symbol.xgis (symbol path defs + string-equality filters)', () => {
    const scene = new SceneBuilder()
      .symbol('arrow', { path: 'M 0 -1 L 0.4 0.4 L 0 0.1 L -0.4 0.4 Z' })
      .symbol('flag', {
        path: 'M -0.15 -1 L -0.15 1 L -0.05 1 L -0.05 -1 Z M -0.05 -1 L 0.8 -0.5 L -0.05 0 Z',
      })
      .source('land', { type: ident('geojson'), url: 'ne_110m_land.geojson' })
      .source('cities', { type: ident('geojson'), url: 'ne_110m_populated_places.geojson' })
      .layer('ground', (l) =>
        l.source('land').util('fill-slate-800', 'stroke-slate-700', 'stroke-0.5'),
      )
      .layer('capitals', (l) =>
        l
          .source('cities')
          .filter(compare(field('featurecla'), '==', 'Admin-0 capital'))
          .util('shape-arrow', 'fill-emerald-400', 'stroke-emerald-600', 'stroke-1', 'size-16'),
      )
      .layer('others', (l) =>
        l
          .source('cities')
          .filter(compare(field('featurecla'), '!=', 'Admin-0 capital'))
          .util('shape-flag', 'fill-sky-300', 'stroke-sky-500', 'stroke-0.5', 'size-10'),
      )
      .build()
    assertPair('custom-symbol.xgis', scene)
  })

  it('animation-pulse.xgis (keyframes + animation utility family)', () => {
    const scene = new SceneBuilder()
      .keyframes('pulse', {
        0: ['opacity-100'],
        50: ['opacity-30'],
        100: ['opacity-100'],
      })
      .source('land', { type: ident('geojson'), url: 'ne_110m_land.geojson' })
      .source('coast', { type: ident('geojson'), url: 'ne_110m_coastline.geojson' })
      .layer('land_fill', (l) => l.source('land').util('fill-slate-800'))
      .layer('pulsing_coast', (l) =>
        l
          .source('coast')
          .util('stroke-amber-300', 'stroke-3')
          .util(
            'animation-pulse',
            'animation-duration-1500',
            'animation-ease-in-out',
            'animation-infinite',
          ),
      )
      .build()
    assertPair('animation-pulse.xgis', scene)
  })

  it('categorical.xgis (fn-call utility binding)', () => {
    const scene = new SceneBuilder()
      .source('world', { type: ident('geojson'), url: 'countries.geojson' })
      .layer('countries', (l) =>
        l
          .source('world')
          .util(
            { name: 'fill', binding: call('categorical', ident('name')) },
            'stroke-slate-700',
            'stroke-1',
            'opacity-95',
          ),
      )
      .build()
    assertPair('categorical.xgis', scene)
  })
})

// The builder must uphold invariants the parser normally guarantees (design
// C6) — these are the keyframes ones: percent range, modifier ban, sorted
// frames.
describe('SceneBuilder parser-invariant upholding (design C6)', () => {
  it('rejects out-of-range keyframe percents', () => {
    expect(() => new SceneBuilder().keyframes('bad', { 120: ['opacity-0'] })).toThrow(/0\.\.100/)
  })

  it('rejects modifiers inside keyframes', () => {
    expect(() =>
      new SceneBuilder().keyframes('bad', { 50: [{ name: 'opacity-30', modifier: 'hover' }] }),
    ).toThrow(/[Mm]odifiers are not allowed/)
  })

  it('sorts keyframes by percent (non-integer keys keep JS insertion order)', () => {
    const scene = new SceneBuilder()
      .keyframes('k', { 99.5: ['opacity-0'], 0.5: ['opacity-100'] })
      .build()
    const kf = scene.program.body[0] as AST.KeyframesStatement
    expect(kf.frames.map((f) => f.percent)).toEqual([0.5, 99.5])
  })
})
