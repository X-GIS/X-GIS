// ═══ Arch ratchet — shader-codegen Single-Responsibility (decided 2026-06-30) ═══
//
// Locks the module-responsibility decision recorded in
// docs/architecture/package-responsibilities.md (rulings f, i) and
// docs/architecture/render-graph-pass-scheduler.md (§6.5, §8.5 Rule B):
//
//   • The WebGPU-vs-WebGL2 backend is chosen at RUNTIME (device init), so the
//     compiler cannot know the target → it emits NO shader code, only neutral
//     @xgis/shader-dsl IR.  @xgis/shader-dsl is the SOLE shader-code generator
//     (IR → WGSL/GLSL), run at runtime once the backend is known.
//   • NO shader is hardcoded as a WGSL/GLSL string literal anywhere; every
//     shader is authored via the DSL. (@xgis/shader-dsl's own backend writers
//     are NOT scanned here — they ARE the emit layer, and they live in a
//     separate package outside SRC_DIRS.)
//
// RATCHET semantics: `offenders` must EQUAL the allowlist (not merely be a
// subset). A NEW violation fails (don't add it — author via the DSL). FIXING an
// allowlisted violation ALSO fails until you delete its allowlist entry — so the
// allowlist can only shrink, never grow. Empty allowlist = the decision is fully
// realised. Each entry names the milestone that retires it.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SRC_DIRS = ['runtime/src', 'compiler/src', 'blueprint/src', 'shared/src']

function walkTs(absDir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(absDir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.vite') continue
    const p = join(absDir, name)
    if (statSync(p).isDirectory()) out.push(...walkTs(p))
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) out.push(p)
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
// (M4 DONE — the legacy ComputeDispatcher.generateShader() raw `@compute` template
// was dead production code, only exercised by a test; deleted.)
const GATE_A_ALLOWLIST: string[] = [].sort()

describe('SRP ratchet: shaders are DSL-authored — no hardcoded raw shader strings', () => {
  it('no .ts hardcodes a WGSL/GLSL shader as a template literal (allowlist shrinks only)', () => {
    const offenders = ALL_TS
      .filter((f) => RAW_SHADER_TEMPLATE.test(stripComments(readFileSync(f, 'utf8'))))
      .map(rel)
      .sort()
    expect(
      offenders,
      'A shader is hardcoded as a string. Author it via @xgis/shader-dsl instead, ' +
        'or — if FIXING an allowlisted entry — delete it from GATE_A_ALLOWLIST.',
    ).toEqual(GATE_A_ALLOWLIST)
  })
})

// ── Gate B: @xgis/compiler emits NO shader code (ruling i — runtime backend) ──
// The compiler must stop at neutral shader-dsl IR; it must not call the emit
// step (emitModule / emitExpr → a backend-specific string).
const EMIT_CALL = /\bemit(Module|Expr)\s*\(/

const GATE_B_ALLOWLIST = [
  // M3 DONE — compute-gen.ts no longer calls emitModule(); it returns the shader-dsl
  // module(...) IR and the runtime emits WGSL/GLSL per the live backend (ruling i).
  // test-only emit-shape oracle (`nodeToWgslString` → emitExpr); production
  // never calls it. May stay as a test oracle or move to a test file later.
  'compiler/src/codegen/node-to-wgsl.ts',
].sort()

describe('SRP ratchet: @xgis/compiler emits no shader code (backend is a runtime decision)', () => {
  it('compiler/src calls no shader-dsl emitModule/emitExpr (allowlist shrinks only)', () => {
    const offenders = ALL_TS
      .filter((f) => rel(f).startsWith('compiler/src/') && EMIT_CALL.test(stripComments(readFileSync(f, 'utf8'))))
      .map(rel)
      .sort()
    expect(
      offenders,
      'The compiler emitted shader code (emitModule/emitExpr). It must produce neutral ' +
        'shader-dsl IR and let the runtime emit per backend — or delete a retired allowlist entry.',
    ).toEqual(GATE_B_ALLOWLIST)
  })
})
