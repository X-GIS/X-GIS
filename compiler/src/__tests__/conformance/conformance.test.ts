// ═══ X-GIS language conformance corpus runner (#1073 slice 1) ═══
//
// The normative grammar spec (docs/spec/xgis-language.md) is kept honest by a
// fixture corpus: every construct has a `valid/*.xgis` file that must parse
// clean, and every rejection has an `invalid/*.xgis` file that must be
// rejected for the documented reason. This runner is the executable half.
//
// Fixture frontmatter (test262-style, in leading `//` comment lines that the
// lexer strips, so they never perturb the parse):
//
//   // @case valid | invalid          (required)
//   // @construct <name>              (documents the covered construct)
//   // @desc <one line>               (human description → the test title)
//   // @expect-code <X-GIS00NN>       (invalid: pin a stable diagnostic code)
//   // @expect-message <fragment>     (invalid: pin a stable message fragment)
//
// Expectation policy (post-#1065 unified diagnostics):
//   - pin a CODE where one exists — the pragma gate (X-GIS0008 / X-GIS0009)
//     and the generic parser syntax error (X-GIS0010) all ride the structured
//     `ParseError.diagnostic.code`;
//   - else pin a stable lexer message fragment (the lexer stayed outside
//     #1065: "Unterminated string" / "Invalid color literal" / …);
//   - never pin full parser message strings — wording is not a contract
//     (see docs/spec/xgis-language.md §4.1).

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Lexer } from '../../lexer/lexer'
import { Parser } from '../../parser/parser'
import { ParseError } from '../../diagnostics/diagnostic'

const HERE = dirname(fileURLToPath(import.meta.url))
const VALID_DIR = join(HERE, 'valid')
const INVALID_DIR = join(HERE, 'invalid')

interface Frontmatter {
  case?: string
  construct?: string
  desc?: string
  code?: string // @expect-code
  message?: string // @expect-message
}

/** Extract the leading `// @key value` frontmatter. Scans only the leading
 *  comment/blank block and stops at the first content line, so a body that
 *  happens to contain `@` is never mistaken for a directive. */
function readFrontmatter(text: string): Frontmatter {
  const fm: Frontmatter = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    if (!line.startsWith('//')) break
    const m = /^\/\/\s*@([\w-]+)\s+(.*)$/.exec(line)
    if (!m) continue
    const value = m[2].trim()
    if (m[1] === 'case') fm.case = value
    else if (m[1] === 'construct') fm.construct = value
    else if (m[1] === 'desc') fm.desc = value
    else if (m[1] === 'expect-code') fm.code = value
    else if (m[1] === 'expect-message') fm.message = value
  }
  return fm
}

function parseSource(src: string): void {
  new Parser(new Lexer(src).tokenize()).parse()
}

function loadDir(dir: string): { file: string; text: string; fm: Frontmatter }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.xgis'))
    .sort()
    .map((file) => {
      const text = readFileSync(join(dir, file), 'utf8')
      return { file, text, fm: readFrontmatter(text) }
    })
}

describe('conformance corpus — valid fixtures parse green', () => {
  const cases = loadDir(VALID_DIR)

  it('the valid corpus is non-empty', () => {
    expect(cases.length).toBeGreaterThan(0)
  })

  for (const { file, text, fm } of cases) {
    it(`${file} — ${fm.construct ?? '?'}`, () => {
      expect(fm.case, `${file}: must declare '// @case valid'`).toBe('valid')
      let err: Error | null = null
      try {
        parseSource(text)
      } catch (e) {
        err = e as Error
      }
      expect(err, err?.message).toBeNull()
    })
  }
})

describe('conformance corpus — invalid fixtures are rejected', () => {
  const cases = loadDir(INVALID_DIR)

  it('the invalid corpus is non-empty', () => {
    expect(cases.length).toBeGreaterThan(0)
  })

  for (const { file, text, fm } of cases) {
    it(`${file} — ${fm.construct ?? '?'}`, () => {
      expect(fm.case, `${file}: must declare '// @case invalid'`).toBe('invalid')
      let err: Error | null = null
      try {
        parseSource(text)
      } catch (e) {
        err = e as Error
      }
      expect(err, `${file}: expected REJECTION but the source parsed clean`).not.toBeNull()
      if (fm.code) {
        // The stable pin is the structured diagnostic (#1065). The pragma
        // codes also appear in the message text; X-GIS0010 is structured-only.
        const structured = err instanceof ParseError ? err.diagnostic.code : undefined
        const matches = structured === fm.code || err!.message.includes(fm.code)
        expect(
          matches,
          `${file}: expected diagnostic code ${fm.code}, got ` +
            `${structured ?? '(unstructured)'}: ${err!.message}`,
        ).toBe(true)
      } else if (fm.message) {
        expect(err!.message, `${file}: expected message fragment "${fm.message}"`).toContain(
          fm.message,
        )
      }
      // else: rejection alone is the contract (§4.1) — no message pin.
    })
  }
})
