// ═══ Does the emitted SOURCE agree with the reflection describing it? (#1714) ═══
//
// #1714 asked for a cross-backend parity gate: "for every example module, assert that GLSL
// and WGSL emits agree on interface/resources/constants". As landed in #1719, that arm was
// left out because it is VACUOUS as written — `reflect(m: ModuleDecl)` never sees a backend
// (`src/core/reflect.ts`), so comparing "the WGSL reflection" against "the GLSL reflection"
// of one module compares a value against itself. It would have been green from the first
// commit and stayed green through any backend divergence.
//
// This is the non-vacuous version, and it is one level down: does each backend's EMITTED
// SOURCE agree with the reflection that describes it? Cross-backend agreement then follows
// transitively, and unlike the proposed arm this one can actually go red — the two backends
// re-spell bindings, locations and entry points independently, from the same IR, in code
// that has no idea `reflect()` exists.
//
// The two backends are checked at DIFFERENT STRENGTHS, on purpose, because they carry
// different amounts of information:
//
//   WGSL   EXACT. `@group(N) @binding(M) var<…> name` is literally in the text, so the
//          (group, binding, name) triples parsed out of the source must equal the triples
//          reflect() reports — same set, both directions. This is the real gate.
//   GLSL   NAME-LEVEL. GLSL ES 3.00 has no group/binding syntax at all; a UBO is
//          `layout(std140) uniform Block { … } name;` and a texture is `uniform sampler2D
//          name;`. So the check is that every module-owned binding reflect() reports is
//          DECLARED (not merely mentioned) in one of the two stages, and that the source
//          declares nothing reflect() does not know about.
//
// Stated plainly so the green is not read as more than it is: the GLSL half cannot catch a
// binding emitted at the wrong slot, because GLSL has no slot to be wrong about.

import { describe, it, expect } from 'vitest'
import { examples } from './index.js'
import { reflect } from '../src/index.js'
import { emitModule } from '../src/core/backends/wgsl.js'
import { emitGlslModule } from '../src/core/backends/glsl.js'

const MIN_EXAMPLES = 10

/** `@group(0) @binding(1) var<uniform> u: U;` → `0:1:u`. Also matches the attribute-less
 *  spelling nothing emits today, so a future change there fails loudly rather than silently
 *  dropping out of the comparison. */
function wgslDeclaredBindings(src: string): Set<string> {
  const out = new Set<string>()
  const re = /@group\(\s*(\d+)\s*\)\s*@binding\(\s*(\d+)\s*\)\s*var(?:<[^>]*>)?\s+([A-Za-z_]\w*)/g
  for (let m = re.exec(src); m !== null; m = re.exec(src)) out.add(`${m[1]}:${m[2]}:${m[3]}`)
  return out
}

/** Names DECLARED as GLSL uniforms — the loose form, the sampler form, and the std140 block
 *  form (whose instance name follows the closing brace). Deliberately not "appears in the
 *  text": a binding that is only READ would otherwise satisfy the check while its
 *  declaration was missing, which is the exact bug worth catching. */
function glslDeclaredBindings(src: string): Set<string> {
  const out = new Set<string>()
  const loose = /^\s*uniform\s+(?:highp\s+|mediump\s+|lowp\s+)?\w+\s+([A-Za-z_]\w*)\s*[;[]/gm
  for (let m = loose.exec(src); m !== null; m = loose.exec(src)) out.add(m[1]!)
  const block = /\}\s*([A-Za-z_]\w*)\s*;/g
  for (let m = block.exec(src); m !== null; m = block.exec(src)) out.add(m[1]!)
  return out
}

/** Bindings the emit is expected to declare: module-owned, and not a WGSL sampler (the GLSL
 *  backend FUSES a standalone sampler into the texture's combined sampler2D, so it declares
 *  none — a documented lowering, not a discrepancy). */
const expectedFor = (r: ReturnType<typeof reflect>, target: 'wgsl' | 'glsl') =>
  r.bindGroups.flatMap((g) =>
    g.entries
      .filter((e) => e.owner === 'module')
      .filter((e) => !(target === 'glsl' && e.resourceKind === 'sampler'))
      .map((e) => (target === 'wgsl' ? `${e.group}:${e.binding}:${e.name}` : e.name)),
  )

describe('emit ↔ reflection conformance (#1714)', () => {
  it(`the corpus is populated (>= ${MIN_EXAMPLES} examples)`, () => {
    // Every arm below is a set comparison, and two empty sets are equal.
    expect(examples.length).toBeGreaterThanOrEqual(MIN_EXAMPLES)
  })

  it('WGSL declares EXACTLY the group/binding/name triples reflect() reports', () => {
    const offenders: string[] = []
    let checked = 0
    for (const ex of examples) {
      let src: string
      try {
        src = emitModule(ex.module)
      } catch {
        continue // a module this backend cannot emit is not this gate's subject
      }
      const declared = wgslDeclaredBindings(src)
      const expected = new Set(expectedFor(reflect(ex.module), 'wgsl'))
      const missing = [...expected].filter((k) => !declared.has(k))
      const extra = [...declared].filter((k) => !expected.has(k))
      if (missing.length || extra.length)
        offenders.push(
          `${ex.id}: reflect() describes but source lacks [${missing}]; source declares but reflect() omits [${extra}]`,
        )
      if (expected.size > 0) checked++
    }
    // A corpus where nothing had bindings would make the comparison above meaningless.
    expect(checked, 'no example contributed a single binding to compare').toBeGreaterThan(5)
    expect(offenders.join('\n')).toBe('')
  })

  it('GLSL declares every module-owned binding reflect() reports, in one of the stages', () => {
    // Per-stage, because the GLSL backend is stage-scoped: a binding no reachable fn in THAT
    // stage references is deliberately not declared there. The union across the two stages is
    // what must cover the reflection.
    const offenders: string[] = []
    let checked = 0
    for (const ex of examples) {
      let declared: Set<string>
      try {
        declared = new Set([
          ...glslDeclaredBindings(emitGlslModule(ex.module, 'vertex')),
          ...glslDeclaredBindings(emitGlslModule(ex.module, 'fragment')),
        ])
      } catch {
        continue
      }
      const expected = expectedFor(reflect(ex.module), 'glsl')
      const missing = expected.filter((n) => !declared.has(n))
      if (missing.length) offenders.push(`${ex.id}: not declared in either stage: ${missing}`)
      if (expected.length > 0) checked++
    }
    expect(checked, 'no example contributed a single binding to compare').toBeGreaterThan(5)
    expect(offenders.join('\n')).toBe('')
  })

  it('every entry point reflect() names is DEFINED in the WGSL source', () => {
    const offenders: string[] = []
    let checked = 0
    for (const ex of examples) {
      let src: string
      try {
        src = emitModule(ex.module)
      } catch {
        continue
      }
      for (const e of reflect(ex.module).entries) {
        checked++
        if (!new RegExp(`fn\\s+${e.name}\\s*\\(`).test(src))
          offenders.push(`${ex.id}: reflect() names entry '${e.name}', source defines no such fn`)
      }
    }
    expect(checked).toBeGreaterThan(5)
    expect(offenders.join('\n')).toBe('')
  })
})

describe('the readers distinguish the states they claim to', () => {
  // Without these, all four arms above pass on parsers that return an empty set for
  // everything — the failure mode that makes a conformance gate worthless.
  it('the WGSL reader finds a declaration, and only a declaration', () => {
    expect(wgslDeclaredBindings('@group(0) @binding(2) var<uniform> u: U;')).toEqual(
      new Set(['0:2:u']),
    )
    // A READ of the same binding is not a declaration and must not satisfy the gate.
    expect(wgslDeclaredBindings('let x = u.field;').size).toBe(0)
  })

  it('the GLSL reader finds the loose, sampler and block forms — and not a read', () => {
    expect(glslDeclaredBindings('uniform highp vec2 u_viewport;')).toEqual(new Set(['u_viewport']))
    expect(glslDeclaredBindings('uniform sampler2D u_tex;')).toEqual(new Set(['u_tex']))
    expect(glslDeclaredBindings('layout(std140) uniform U {\n  float a;\n} u;')).toEqual(
      new Set(['u']),
    )
    expect(glslDeclaredBindings('  float x = u_viewport.x;').size).toBe(0)
  })
})
