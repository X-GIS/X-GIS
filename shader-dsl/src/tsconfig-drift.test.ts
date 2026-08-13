// ═══ #1681 B1 — the package tsconfig is SELF-CONTAINED, and has not drifted ═══
//
// Two invariants, one gate.
//
// (1) SELF-CONTAINMENT. Every `extends` inside shader-dsl/ must resolve to a path
//     INSIDE shader-dsl/. The package is vendored out of this repo by a source-copying
//     script into a production consumer's project; a chain that reaches the monorepo
//     root (`../tsconfig.base.json`) makes the copied directory uncompilable, and the
//     failure is at config-load time, before a single .ts file is read.
//
// (2) NO DRIFT. Self-containment costs a COPY of the root baseline
//     (shader-dsl/tsconfig.base.json), which is a second authority — exactly the
//     failure mode CLAUDE.md §12 warns about. So the copy is pinned to the root: for
//     every option the ROOT sets, the package copy must set the same value, with the
//     single allowance that a strictness BOOLEAN may be stronger (true where the root
//     is false/absent) but never weaker. A drift fails NAMING the option and both
//     values, because "these two files differ" is not an actionable message.
//
// Scanner sanity: a reader that silently returned `{}` would make every comparison
// vacuous, so the gate independently proves the JSONC reader recovers known witnesses
// from a commented config, and that the compared key set is non-trivially large.

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url)) // shader-dsl/src
const PKG_DIR = resolve(HERE, '..') // shader-dsl
const REPO_ROOT = resolve(PKG_DIR, '..')

const ROOT_BASE = resolve(REPO_ROOT, 'tsconfig.base.json')
const PKG_BASE = resolve(PKG_DIR, 'tsconfig.base.json')

/** Every tsconfig this package owns. Listed explicitly (not globbed) so ADDING one
 *  without adding it here is visible in review — and the existence assertion below
 *  turns a MOVED file into a red gate rather than a vacuously-green skipped entry
 *  (§12: a path-keyed allowlist needs a companion "every key still resolves"). */
const PACKAGE_TSCONFIGS = [
  'tsconfig.json',
  'tsconfig.tests.json',
  'tsconfig.base.json',
  'examples/tsconfig.json',
]

/** Strip JSONC comments. String-aware: a `//` inside a string literal (e.g. a URL in
 *  `$schema`) must survive, and an escaped quote must not end the string. */
function stripJsonComments(text: string): string {
  let out = ''
  let inString = false
  let inLine = false
  let inBlock = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    const next = text[i + 1]
    if (inLine) {
      if (c === '\n') {
        inLine = false
        out += c
      }
      continue
    }
    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false
        i++
      }
      continue
    }
    if (inString) {
      out += c
      if (c === '\\') {
        // copy the escaped char verbatim so `\"` cannot close the string
        if (next !== undefined) {
          out += next
          i++
        }
      } else if (c === '"') {
        inString = false
      }
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      continue
    }
    if (c === '/' && next === '/') {
      inLine = true
      i++
      continue
    }
    if (c === '/' && next === '*') {
      inBlock = true
      i++
      continue
    }
    out += c
  }
  return out
}

type Tsconfig = {
  extends?: string
  compilerOptions?: Record<string, unknown>
  include?: string[]
  exclude?: string[]
}

function readTsconfig(path: string): Tsconfig {
  return JSON.parse(stripJsonComments(readFileSync(path, 'utf8'))) as Tsconfig
}

/** Options whose value must MATCH exactly — they change what the compiler accepts or
 *  emits, so "stronger" is not a meaningful relation on them. */
const VALUE_OPTIONS = new Set([
  'target',
  'module',
  'moduleResolution',
  'lib',
  'declaration',
  'sourceMap',
  'outDir',
  'rootDir',
  'types',
  'jsx',
  'useDefineForClassFields',
])

/** Boolean flags where `true` is STRICTER. The package copy may turn one on that the
 *  root leaves off; it may never turn one off that the root has on. `skipLibCheck` is
 *  deliberately NOT here — `true` is looser, so it is compared as a value option. */
const STRICTNESS_BOOLEANS = new Set([
  'strict',
  'noUnusedLocals',
  'noUnusedParameters',
  'noImplicitOverride',
  'exactOptionalPropertyTypes',
  'noUncheckedIndexedAccess',
  'noImplicitReturns',
  'noFallthroughCasesInSwitch',
  'noPropertyAccessFromIndexSignature',
  'verbatimModuleSyntax',
  'isolatedModules',
  'allowUnreachableCode',
])

describe('#1681 B1 — shader-dsl tsconfig self-containment + baseline drift', () => {
  it('every tsconfig this package owns exists at the listed path', () => {
    const missing = PACKAGE_TSCONFIGS.filter((p) => !existsSync(resolve(PKG_DIR, p)))
    expect(missing, `listed package tsconfig(s) not found: ${missing.join(', ')}`).toEqual([])
    expect(PACKAGE_TSCONFIGS.length).toBeGreaterThanOrEqual(4)
  })

  it('no tsconfig in the package extends outside shader-dsl/', () => {
    const escapes: string[] = []
    for (const rel of PACKAGE_TSCONFIGS) {
      const file = resolve(PKG_DIR, rel)
      const ext = readTsconfig(file).extends
      if (ext === undefined) continue
      // A bare package specifier (`@tsconfig/…`) would be a dependency, not a path —
      // this package has none, so treat anything non-relative as an escape too.
      if (!ext.startsWith('.')) {
        escapes.push(`${rel} extends non-relative '${ext}'`)
        continue
      }
      const target = resolve(dirname(file), ext)
      const inside = relative(PKG_DIR, target)
      if (inside.startsWith('..') || isAbsolute(inside))
        escapes.push(`${rel} extends '${ext}' → ${target} (outside the package)`)
    }
    expect(
      escapes,
      `a vendored copy of shader-dsl/ cannot compile — extends chain(s) leave the package:\n  ${escapes.join('\n  ')}`,
    ).toEqual([])
  })

  it('the package baseline is at least as strict as the repo root baseline', () => {
    const root = readTsconfig(ROOT_BASE).compilerOptions ?? {}
    const pkg = readTsconfig(PKG_BASE).compilerOptions ?? {}

    // Scanner sanity — a reader that returned {} (or a stripper that ate the file)
    // would make every comparison below vacuously true over an EMPTY key set.
    const rootKeys = Object.keys(root)
    expect(
      rootKeys.length,
      `read 0 compilerOptions from ${ROOT_BASE} — the JSONC reader is broken, not the config`,
    ).toBeGreaterThanOrEqual(10)
    expect(root['strict'], 'the repo baseline no longer sets `strict` — re-derive this gate').toBe(
      true,
    )
    expect(typeof root['target']).toBe('string')

    const drift: string[] = []
    for (const key of rootKeys) {
      const want = root[key]
      const got = pkg[key]
      if (STRICTNESS_BOOLEANS.has(key)) {
        if (want === true && got !== true)
          drift.push(`${key}: root=true, package=${JSON.stringify(got)} (weaker — must be true)`)
        continue
      }
      if (JSON.stringify(got) !== JSON.stringify(want))
        drift.push(`${key}: root=${JSON.stringify(want)}, package=${JSON.stringify(got)}`)
    }
    expect(
      drift,
      `shader-dsl/tsconfig.base.json has drifted from ${relative(REPO_ROOT, ROOT_BASE)}:\n  ${drift.join('\n  ')}`,
    ).toEqual([])

    // …and the load-bearing options the two files exist to agree on are actually
    // COMPARED, not merely absent from both.
    const loadBearing = [...VALUE_OPTIONS, ...STRICTNESS_BOOLEANS].filter((k) => k in root)
    expect(
      loadBearing.length,
      'no load-bearing option was compared — the option lists no longer intersect the baseline',
    ).toBeGreaterThanOrEqual(6)
    for (const key of loadBearing)
      expect(
        pkg,
        `load-bearing option '${key}' is set in the root baseline but not the package copy`,
      ).toHaveProperty(key)
  })

  it('the JSONC reader recovers known witnesses from a COMMENTED config', () => {
    // tsconfig.json carries both a leading `//` block and a trailing one; if the
    // stripper were broken this parse throws, and if it were over-eager these
    // witnesses would be gone. Without this arm a silently-empty reader would green
    // every assertion above.
    const cfg = readTsconfig(resolve(PKG_DIR, 'tsconfig.json'))
    expect(cfg.compilerOptions?.['composite']).toBe(true)
    expect(cfg.compilerOptions?.['outDir']).toBe('./dist')
    expect(cfg.include).toEqual(['src/**/*.ts'])
    expect(cfg.exclude).toEqual(['src/**/*.test.ts'])
    expect(cfg.extends).toBe('./tsconfig.base.json')
    // a `//` sequence inside a string must survive the stripper
    expect(JSON.parse(stripJsonComments('{"a":"http://x"} // trailing'))).toEqual({
      a: 'http://x',
    })
    expect(JSON.parse(stripJsonComments('{"a":"q\\"//not-a-comment"}'))).toEqual({
      a: 'q"//not-a-comment',
    })
  })
})
