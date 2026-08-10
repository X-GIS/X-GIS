// ═══ stdlib self-hosting proof — the compile-side half (#1540) ═══
//
// The render gate (playground/e2e/_stdlib-shape-parity.spec.ts) proves the
// pixels match. This proves WHY, and pins the fact the render gate depends on:
// a symbolizer authored in `.xgis` and a built-in one reach the renderer
// through the SAME compiled shader — they differ only in DATA.
//
// That is the finding this milestone actually produced. #1540 was written
// expecting to port "self-contained fragment math" out of a built-in
// symbolizer, but there is none to port: every shape in the engine runs
// through one shared bezier path rasterizer (`sdf_shape`, map's point.ts) that
// reads segments from a storage buffer. A shape IS path data. So the two paths
// cannot diverge in shader code, and the assertions below say so directly
// rather than leaving it as prose.
//
// Reads the REAL files the playground serves, not inline copies — a divergence
// between this test's idea of the stdlib module and the one the render gate
// loads would make both green while proving nothing.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { optimize } from '../ir/optimize'
import { emitCommands } from '../ir/emit-commands'
import { resolveImports } from '../module/resolver'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const STDLIB = join(ROOT, 'playground', 'public', 'stdlib', 'shapes.xgis')
const EXAMPLES = join(ROOT, 'playground', 'src', 'examples')

const stdlibSource = readFileSync(STDLIB, 'utf8')
const readFile = (): string => stdlibSource

function compile(fixture: string) {
  const src = readFileSync(join(EXAMPLES, fixture), 'utf8')
  let ast = new Parser(new Lexer(src).tokenize()).parse()
  if (ast.body.some((s) => s.kind === 'ImportStatement')) {
    ast = resolveImports(ast, '', readFile) as typeof ast
  }
  const scene = lower(ast)
  return { scene, cmds: emitCommands(optimize(scene)) }
}

describe('a .xgis-authored symbolizer compiles to the same shader as the built-in (#1540)', () => {
  const stdlib = compile('fixture-stdlib-star.xgis')
  const builtin = compile('fixture-builtin-star.xgis')

  it('both fixtures compile clean', () => {
    for (const [name, r] of [
      ['stdlib', stdlib],
      ['builtin', builtin],
    ] as const) {
      const errors = (r.scene.diagnostics ?? []).filter((d) => d.severity === 'error')
      expect(errors, `${name} fixture: ${errors.map((e) => e.message).join(' | ')}`).toEqual([])
    }
  })

  it('they resolve to the SAME shader variant — the difference is data, not code', () => {
    const a = stdlib.cmds.shows[0]!
    const b = builtin.cmds.shows[0]!
    // The variant key is what selects a compiled pipeline. Equal keys mean the
    // two programs share one shader; a shape is selected by an id read from a
    // storage buffer, never by a shader recompile.
    expect(a.shaderVariant?.key).toBe(b.shaderVariant?.key)
  })

  it('they agree on every paint value, and differ ONLY in which shape is named', () => {
    const a = stdlib.cmds.shows[0]!
    const b = builtin.cmds.shows[0]!
    expect([a.fill, a.size]).toEqual([b.fill, b.size])
    // The one intended difference: the user symbol vs the built-in name.
    expect(a.shape).toBe('star5')
    expect(b.shape).toBe('star')
  })

  it('the authored symbol travels with the scene as path data', () => {
    // `symbol` definitions surface on SceneCommands.symbols; map registers them
    // via ShapeRegistry.addUserShape. This is the whole mechanism by which a
    // new symbolizer needs zero library TS edits.
    const names = (stdlib.cmds.symbols ?? []).map((s) => s.name)
    expect(names).toContain('star5')
    expect(names).toContain('star7')
    // The built-in fixture imports nothing, so it contributes no symbols —
    // which is what makes the parity comparison meaningful rather than two
    // views of the same registration.
    expect(builtin.cmds.symbols ?? []).toEqual([])
  })

  it('the authored star5 path is coordinate-identical to the built-in starPath(5, 1.0, 0.38)', () => {
    // Regenerates the built-in's own formula (map/src/text/sdf-shape.ts's
    // starPath) rather than pasting its output, so a change to the built-in
    // geometry breaks THIS test instead of silently un-pairing the render gate.
    const pts: string[] = []
    for (let i = 0; i < 10; i++) {
      const angle = -Math.PI / 2 + (Math.PI * i) / 5
      const r = i % 2 === 0 ? 1.0 : 0.38
      pts.push(
        `${i === 0 ? 'M' : 'L'} ${(Math.cos(angle) * r).toFixed(4)} ${(Math.sin(angle) * r).toFixed(4)}`,
      )
    }
    const expected = pts.join(' ') + ' Z'
    const star5 = (stdlib.cmds.symbols ?? []).find((s) => s.name === 'star5')
    expect(star5?.paths?.[0]).toBe(expected)
  })
})

describe('the extension path — a symbolizer with no built-in twin (#1540)', () => {
  it('star7 compiles and names a shape the engine does not ship', () => {
    const { scene, cmds } = compile('fixture-stdlib-star7.xgis')
    expect((scene.diagnostics ?? []).filter((d) => d.severity === 'error')).toEqual([])
    expect(cmds.shows[0]!.shape).toBe('star7')
    // Non-vacuity: it must not silently collapse to the 5-pointed geometry.
    const paths = Object.fromEntries((cmds.symbols ?? []).map((s) => [s.name, s.paths?.[0]]))
    expect(paths.star7).toBeTruthy()
    expect(paths.star7).not.toBe(paths.star5)
  })
})
