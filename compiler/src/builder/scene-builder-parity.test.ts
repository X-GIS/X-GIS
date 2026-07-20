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
import { SceneBuilder, ident, interpolateZoom, matchOn, type SceneProgram } from './scene-builder'
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
})
