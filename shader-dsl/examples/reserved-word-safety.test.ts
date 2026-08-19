// ═══ shader-dsl examples — generated-identifier reserved-word gate (#1861) ═══
//
// Two production plugins INVENT identifiers: `mangle` renames the authored
// vocabulary from a bijective base-52 pool, and `aliasTypes` names each hot type
// from the same sequence. Neither can be allowed to hand out a spelling the
// target language owns — `let as = …` / `alias as = vec2<f32>;` are what Tint
// rejected, from a `RESERVED` list that had WGSL's keywords but not its separate
// reserved-word list, and from an `occupied` set derived only from the words the
// emitted text happened to contain.
//
// Asserted on the RENAME MAPS, not on the text: both plugins report every name
// they generated, so this covers each one BY CONSTRUCTION instead of by a regex
// that has to guess at declaration positions — and it is target-agnostic, which
// matters because the two languages reserve different words. What it cannot
// prove is that RESERVED_WORDS is COMPLETE; the independent authority for that
// is _emit-obfuscate-gate.spec.ts, which compiles both pipelines on real Tint
// (WGSL) and ANGLE (GLSL).
//
// Both pipelines run because they reach different depths in the name pool:
// inline() lifts every helper body into the entry points, so one scope needs far
// more names — which is how `as` (the ~70th) became reachable at all.

import { describe, it, expect } from 'vitest'
import { examples } from './index.js'
import { emitModule, emitGlslModule } from '../src/index.js'
import { inline, obfuscate } from '../src/emit-prod.js'
import { RESERVED_WORDS } from '../src/core/reserved-words.js'

type Emit = (plugins: ReturnType<typeof obfuscate>) => string

const targets: {
  readonly label: string
  readonly emit: (ex: (typeof examples)[number]) => Emit
}[] = [
  {
    label: 'WGSL',
    emit: (ex) => (plugins) => emitModule(ex.module, { parens: 'minimal', plugins }),
  },
  {
    label: 'GLSL vertex',
    emit: (ex) => (plugins) => emitGlslModule(ex.module, 'vertex', { parens: 'minimal', plugins }),
  },
  {
    label: 'GLSL fragment',
    emit: (ex) => (plugins) =>
      emitGlslModule(ex.module, 'fragment', { parens: 'minimal', plugins }),
  },
]

const pipelines: {
  readonly label: string
  readonly build: (r: Map<string, string>) => ReturnType<typeof obfuscate>
}[] = [
  { label: 'obfuscate()', build: (r) => obfuscate({ renames: r }) },
  { label: '[inline(), …obfuscate()]', build: (r) => [inline(), ...obfuscate({ renames: r })] },
]

describe('generated identifiers never spell a reserved word', () => {
  for (const { label: target, emit } of targets) {
    for (const { label: pipeline, build } of pipelines) {
      it(`${target} · ${pipeline}`, () => {
        let generated = 0
        for (const ex of examples) {
          if (target !== 'WGSL' && !ex.renderable) continue // compute-only: no GLSL stages
          const renames = new Map<string, string>()
          emit(ex)(build(renames))
          for (const [from, to] of renames) {
            generated++
            expect(
              RESERVED_WORDS.has(to),
              `${ex.id}: '${from}' was renamed to the reserved word '${to}'`,
            ).toBe(false)
          }
        }
        // Non-vacuity: an emit path that stopped renaming would pass silently.
        expect(generated).toBeGreaterThan(100)
      })
    }
  }
})
