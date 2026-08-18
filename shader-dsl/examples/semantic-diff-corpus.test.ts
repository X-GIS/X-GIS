// ═══ semanticDiff over the whole example corpus — the mangle invariant at scale ═══
//
// src/core/semantic-diff.test.ts pins the comparator's rules on one hand-built module.
// This proves the property those rules exist for, over every shipped example:
//
//   • MANGLE INVARIANCE — renaming every internal identifier changes nothing
//     semanticDiff reports. `obfuscate()`'s only IR-stage plugin is `mangle` (the rest
//     transform text), so this is the assertion behind #1715's "the production emit is
//     the dev emit, optimized".
//   • NON-VACUITY — two DIFFERENT examples must differ. Without this arm a comparator
//     that returned four empty arrays unconditionally would pass the invariant above
//     on all 36 examples and read as a strong green.
//   • DECLARED-TRANSFORM CLASSIFICATION (#1806) — for the one prod plugin that DOES
//     change what the comparator reports (inline), declaring it must explain the whole
//     dev↔inlined diff on every example, so a consumer's parity gate budgets zero for
//     an intentional pipeline.
//
// The independent authority above this is _emit-obfuscate-gate.spec.ts, which draws
// the plain and obfuscated emits on real Tint + ANGLE and compares the pixels.

import { describe, it, expect } from 'vitest'
import { examples } from './index.ts'
import { isSemanticallyEqual, semanticDiff } from '../src/index.ts'
import { mangleModule } from '../src/core/passes/mangle.ts'
import { inlineLinearAll } from '../src/core/passes/inline-linear.ts'
import { inline } from '../src/emit-prod.ts'

// Registry-growth guard, mirroring emit-goldens.test.ts: a shrinking registry must not
// silently reduce the sweep to nothing.
const MIN_EXAMPLES = 10

describe('semanticDiff over the example corpus', () => {
  it(`the registry is populated (>= ${MIN_EXAMPLES} examples)`, () => {
    expect(examples.length).toBeGreaterThanOrEqual(MIN_EXAMPLES)
  })

  it('mangling every example changes nothing semanticDiff reports', () => {
    const offenders: string[] = []
    let renamed = 0
    for (const ex of examples) {
      const { module: mangled, renames } = mangleModule(ex.module)
      if (renames.size > 0) renamed++
      const d = semanticDiff(ex.module, mangled)
      if (!isSemanticallyEqual(d))
        offenders.push(
          `${ex.id}:\n` +
            (['interface', 'resources', 'constants', 'controlFlow'] as const)
              .filter((k) => d[k].length > 0)
              .map((k) => `  ${k}: ${d[k].slice(0, 4).join(' | ')}`)
              .join('\n'),
        )
    }
    expect(offenders.join('\n\n')).toBe('')
    // mangleModule returns the module UNCHANGED when nothing is renameable, and bails
    // to identity on a `raw` body — so the sweep above is only meaningful for the
    // examples it actually renamed. Most of the corpus declares helpers.
    expect(renamed).toBeGreaterThanOrEqual(Math.ceil(examples.length / 2))
  })

  it('declaring inline() explains the dev↔inlined diff on every example (#1806)', () => {
    const offenders: string[] = []
    let rewritten = 0
    let explained = 0
    for (const ex of examples) {
      const prod = inlineLinearAll(ex.module)
      if (prod !== ex.module) rewritten++
      const d = semanticDiff(ex.module, prod, { transforms: [inline()] })
      explained += d.explained.length
      if (!isSemanticallyEqual(d)) offenders.push(ex.id)
    }
    expect(offenders).toEqual([])
    // inlineLinearAll returns the module UNCHANGED when nothing is inlinable (or a
    // `raw` body bails it out) — the sweep only carries information where it fired.
    expect(rewritten).toBeGreaterThan(0)
    expect(explained).toBeGreaterThan(0)
  })

  it('two DIFFERENT examples always differ (the sweep above is not vacuously green)', () => {
    const same: string[] = []
    for (let i = 1; i < examples.length; i++) {
      const a = examples[i - 1]!
      const b = examples[i]!
      if (isSemanticallyEqual(semanticDiff(a.module, b.module))) same.push(`${a.id} ≡ ${b.id}`)
    }
    expect(same).toEqual([])
  })
})
