// ═══ shader-dsl examples — emit goldens (#763 V3) ═══
//
// Byte-equal drift gate over EVERY example module's emitted WGSL (and, for the
// renderable ones, both GLSL ES 3.00 stages) — the same per-commit pinning the
// polygon composer gets from polygon-variant-diff.test.ts, extended to the whole
// public example surface. This is what turns "emitModule(...).length > 50" into a
// real assertion: any emitter/optimizer/example change that perturbs a single byte
// of shipped output shows up as a reviewed golden diff, not a silent drift.
//
// Re-bake protocol (intentional emit changes): re-run with the env flag set —
//   bun run bake:goldens        (from shader-dsl/ — #844)
//   (equivalently: UPDATE_EMIT_GOLDENS=1 npx vitest run shader-dsl/examples/emit-goldens.test.ts)
// — then commit the refreshed __emit-goldens__/ alongside the emitter change.
//
// CRLF note: goldens are committed text; git autocrlf checks them out with CRLF on
// Windows while the emitters only ever produce LF — normalise before comparing
// (masks line-ending noise only; the emitters have no CRLF code path).

import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { examples } from './index.ts'
import { emitModule, emitGlslModule } from '../src/index.ts'

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), '__emit-goldens__')
const UPDATE = process.env.UPDATE_EMIT_GOLDENS === '1'

const lf = (s: string): string => s.replace(/\r\n/g, '\n')

function checkGolden(file: string, emitted: string): void {
  const path = join(GOLDEN_DIR, file)
  if (UPDATE) {
    mkdirSync(GOLDEN_DIR, { recursive: true })
    writeFileSync(path, emitted)
    return
  }
  expect(
    existsSync(path),
    `${file}: golden missing — bake with \`bun run bake:goldens\` (shader-dsl/)`,
  ).toBe(true)
  expect(
    lf(emitted),
    `${file}: emit drifted from the committed golden — if intentional, re-bake with \`bun run bake:goldens\` (shader-dsl/) and commit the diff`,
  ).toBe(lf(readFileSync(path, 'utf8')))
}

describe('shader-dsl examples — emit goldens', () => {
  it('covers every registered example (registry growth forces a bake, not a skip)', () => {
    expect(examples.length).toBeGreaterThanOrEqual(10)
  })

  for (const ex of examples) {
    it(`${ex.id}: WGSL emit is byte-stable`, () => {
      checkGolden(`${ex.id}.wgsl`, emitModule(ex.module))
    })
  }

  for (const ex of examples.filter((e) => e.renderable)) {
    it(`${ex.id}: GLSL ES 3.00 emits (vertex + fragment) are byte-stable`, () => {
      checkGolden(`${ex.id}.vertex.glsl`, emitGlslModule(ex.module, 'vertex'))
      checkGolden(`${ex.id}.fragment.glsl`, emitGlslModule(ex.module, 'fragment'))
    })
  }
})
