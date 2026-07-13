// ═══ Shader-codegen SRP ratchet — compiler/blueprint/shared (co-located, #1005) ═══
//
// The original SRP ratchet (runtime/src/engine/shader-codegen-srp-ratchet.test.ts)
// walks runtime/compiler/blueprint/shared — but it lives in the RETIRING runtime/
// tree, so its compiler/blueprint/shared coverage evaporates the day runtime/ is
// deleted (#1005, the #996 rot class). This is the co-located successor for the
// NON-runtime residue; it rides the `test (compiler-blueprint)` CI leg.
//
//   Gate A — no hardcoded raw WGSL/GLSL shader string in compiler/blueprint/
//   shared (shaders are DSL-authored; the backend is a runtime decision). The
//   map/engine axis of the same rule is enforced separately by
//   map/src/raw-shader-string-ratchet.test.ts (#1006), and the runtime/ tree by
//   the original gate until it dies with the tree — this file deliberately does
//   NOT walk runtime/ or map/engine.
//
//   Gate B — @xgis/compiler emits NO shader code: it must stop at neutral
//   shader-dsl IR, never call the emit step (emitModule / emitExpr → a
//   backend-specific string). Allowlist shrinks only.
//
// Signal, strip, and allowlists are carried VERBATIM from the runtime original
// so the coverage transfer is 1:1 (double-coverage until runtime/ deletes is
// deliberate and harmless).

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { statSync } from 'node:fs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC_DIRS = ['compiler/src', 'blueprint/src', 'shared/src']

function walkTs(absDir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(absDir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.vite') continue
    const p = join(absDir, name)
    if (statSync(p).isDirectory()) out.push(...walkTs(p))
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts'))
      out.push(p)
  }
  return out
}
const rel = (abs: string): string => relative(ROOT, abs).split('\\').join('/')

// Strip block + line comments so a JSDoc/`//` mention of `@compute` or a
// backtick-inline-code comment citing `gl_Position` is NOT a false positive.
// The `[^:]` guard keeps `://` (URLs) intact.
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

const ALL_TS = SRC_DIRS.flatMap((d) => walkTs(join(ROOT, d)))

// ── Gate A: no hardcoded raw shader STRING (shaders are DSL-authored) ──
// A template literal whose body carries WGSL/GLSL entry-point/builtin source.
const RAW_SHADER_TEMPLATE =
  /`[^`]*?(@compute\b|@vertex\b|@fragment\b|fn\s+main\s*\(|gl_Position|gl_FragColor)[\s\S]*?`/

// Known violations (shrink only). EMPTY = no hardcoded raw shader anywhere.
const GATE_A_ALLOWLIST: string[] = [].sort()

describe('SRP ratchet (co-located): shaders are DSL-authored in compiler/blueprint/shared', () => {
  it('no .ts hardcodes a WGSL/GLSL shader as a template literal (allowlist shrinks only)', () => {
    const offenders = ALL_TS.filter((f) =>
      RAW_SHADER_TEMPLATE.test(stripComments(readFileSync(f, 'utf8'))),
    )
      .map(rel)
      .sort()
    expect(
      offenders,
      'A raw WGSL/GLSL template literal was hardcoded. Author it via @xgis/shader-dsl ' +
        '(module/fn + per-backend emit at runtime) — or, if FIXING an allowlisted entry, ' +
        'delete it from GATE_A_ALLOWLIST.',
    ).toEqual(GATE_A_ALLOWLIST)
  })
})

// ── Gate B: @xgis/compiler emits NO shader code (backend is a runtime decision) ──
const EMIT_CALL = /\bemit(Module|Expr)\s*\(/

const GATE_B_ALLOWLIST = [
  // test-only emit-shape oracle (`nodeToWgslString` → emitExpr); production
  // never calls it. May stay as a test oracle or move to a test file later.
  'compiler/src/codegen/node-to-wgsl.ts',
].sort()

describe('SRP ratchet (co-located): @xgis/compiler emits no shader code', () => {
  it('compiler/src calls no shader-dsl emitModule/emitExpr (allowlist shrinks only)', () => {
    const offenders = ALL_TS.filter(
      (f) =>
        rel(f).startsWith('compiler/src/') &&
        EMIT_CALL.test(stripComments(readFileSync(f, 'utf8'))),
    )
      .map(rel)
      .sort()
    expect(
      offenders,
      'The compiler emitted shader code (emitModule/emitExpr). It must produce neutral ' +
        'shader-dsl IR and let the runtime emit per backend — or delete a retired allowlist entry.',
    ).toEqual(GATE_B_ALLOWLIST)
  })

  it('the Gate-B allowlist is not stale (every entry still exists — #996 vacuity guard)', () => {
    for (const p of GATE_B_ALLOWLIST) {
      expect(
        (() => {
          try {
            statSync(join(ROOT, p))
            return true
          } catch {
            return false
          }
        })(),
        `${p} — allowlisted file moved/deleted; prune the entry`,
      ).toBe(true)
    }
  })
})
