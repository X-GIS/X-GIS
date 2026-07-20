// ═══ SceneBuilder ↔ parser parity gate (#1194, design §2.4) ═══
//
// For each paired example the builder program must be STRUCTURALLY IDENTICAL
// to the parsed .xgis text (line numbers masked — the builder has no source
// lines; toEqual's undefined-key semantics matches the defined-key rule), AND
// the two must lower+emit to byte-equal SceneCommands (the second gate that
// catches any masking mistake from the other side). The .xgis texts are the
// ACTUAL gallery files, fs-read — the same bytes the gallery serves — so a
// gallery edit that breaks its builder twin fails here first.
//
// The twins themselves live in ./twin-corpus.ts — the SINGLE authority the
// gallery (`?runscene=1`, future JS tab) and this gate both consume (A3a).
// This file iterates that registry; it defines no twin of its own, so a twin
// edit and its gate can never drift apart.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Lexer, Parser, lower, optimize, emitCommands, SceneBuilder } from '..'
import type * as AST from '../parser/ast'
import { SCENE_BUILDER_TWINS } from './twin-corpus'

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

describe('SceneBuilder ↔ parser parity (#1194)', () => {
  const entries = Object.entries(SCENE_BUILDER_TWINS)

  it('registry is non-empty', () => {
    expect(entries.length).toBeGreaterThanOrEqual(7)
  })

  it.each(entries)('%s ≡ its paired example', (_id, twin) => {
    const parsed = parseExample(twin.example)
    const scene = twin.build()
    expect(maskLines(scene.program)).toEqual(maskLines(parsed))
    expect(commandsBytes(scene.program)).toBe(commandsBytes(parsed))
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
