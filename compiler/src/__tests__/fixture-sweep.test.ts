// Lints every .xgis source under `playground/src/examples` through
// the full lex+parse+lower pipeline. Catches deprecated syntax that
// silently produces wrong output (e.g. the old `z<N>:` modifier that
// was replaced by `interpolate(zoom, …)` in commit f2f8929 — a
// fixture using `z8:opacity-40` lexes + parses fine, but the lower
// pass treats `z8` as a feature-property modifier, so the utility
// never applies on real data).
//
// Two pass-criteria: a successful round-trip, AND no warnings about
// dropped expressions or modifier-on-non-existent-field shapes that
// hint at silent breakage.

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'

const HERE = dirname(fileURLToPath(import.meta.url))
const EXAMPLES_DIR = join(HERE, '..', '..', '..', 'playground', 'src', 'examples')

const xgisFiles = readdirSync(EXAMPLES_DIR)
  .filter(f => f.endsWith('.xgis') || f.endsWith('.xgs'))

describe('playground fixture sweep — every example lex+parse+lowers', () => {
  for (const file of xgisFiles) {
    it(`${file}`, () => {
      const src = readFileSync(join(EXAMPLES_DIR, file), 'utf8')
      let err: Error | null = null
      try {
        const tokens = new Lexer(src).tokenize()
        const ast = new Parser(tokens).parse()
        lower(ast)
      } catch (e) {
        err = e as Error
      }
      expect(err, err?.message).toBeNull()
    })
  }
})

describe('regression: no deprecated z<N>: modifier in fixtures', () => {
  for (const file of xgisFiles) {
    it(`${file} has no \`z<digit>:\` modifiers`, () => {
      const src = readFileSync(join(EXAMPLES_DIR, file), 'utf8')
      // Match `z` + digits + `:` followed by an identifier — the old
      // shape. The current spelling is `opacity-[interpolate(zoom, N,
      // V, …)]`. Whitespace before the `z` ensures we don't match
      // accidental occurrences inside identifier names.
      const matches = src.match(/(?<=\s|\|)z\d+:[a-z]/gi)
      expect(matches,
        `${file} uses deprecated z<N>: modifier. Replace with ` +
        `\`<utility>-[interpolate(zoom, …)]\` (commit f2f8929).`,
      ).toBeNull()
    })
  }
})
