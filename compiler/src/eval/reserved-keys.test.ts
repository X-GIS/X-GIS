// Guard test: every production source file under runtime/src and
// compiler/src that injects evaluator props MUST use the named
// constants from ./reserved-keys, not literal '$zoom'/'$featureId'/
// '$geometryType'. A literal slipping back in re-introduces the
// PR #102 cross-boundary typo class.
//
// Why a grep test instead of an ESLint rule? The repo doesn't run
// ESLint in CI and adding it is a separate (larger) change. A
// targeted vitest assertion gives us the same teeth with zero new
// tooling.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CAMERA_ZOOM_KEY, FEATURE_ID_KEY, GEOMETRY_TYPE_KEY, makeEvalProps,
} from './reserved-keys'
import { evaluate } from './evaluator'
import type { Identifier } from '../parser/ast'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const RESERVED_LITERALS = [
  CAMERA_ZOOM_KEY,    // '$zoom'
  FEATURE_ID_KEY,     // '$featureId'
  GEOMETRY_TYPE_KEY,  // '$geometryType'
] as const

// Allowlist: places where the literal IS legitimate.
//   - reserved-keys.ts itself: the definition of the constants.
//   - reserved-keys.test.ts: this file documents the literals.
//   - evaluator.ts comments / runtime docs: explanatory references.
//   - converter / lowerer: writes the literal as part of an AST node
//     (`get("$featureId")`) when lowering Mapbox `["id"]` etc.
//   - feature-id-filter.test.ts / geometry-type-filter.test.ts: the
//     test bodies emit the literal directly to mimic the runtime
//     injection.
const ALLOWED_FILES = new Set([
  'compiler/src/eval/reserved-keys.ts',
  'compiler/src/eval/reserved-keys.test.ts',
])
// File paths where the literal is intentional:
//   - converter / lower paths that EMIT the AST node
//     `get("$featureId")` as their PAYLOAD (the literal is data,
//     not a typo).
//   - tests that mimic runtime prop-injection by hand to exercise
//     the evaluator's contract — using the named constant here
//     would be circular (the test must literally hardcode what the
//     constant resolves to).
const LITERAL_OK_FILES = new Set([
  'compiler/src/convert/exprs.ts',
  'compiler/src/convert/exprs.test.ts',
  'compiler/src/ir/lower.ts',
  'compiler/src/__tests__/evaluator-roundtrip.test.ts',
  'compiler/src/__tests__/mapbox-spec-conformance.test.ts',
  'runtime/src/data/eval/feature-id-filter.test.ts',
  'runtime/src/data/eval/geometry-type-filter.test.ts',
])

/** Strip `// line` and /* block ​*​/ comments so the literal scan only
 *  sees actual code. Naïve but correct for our purposes — none of
 *  the searched literals legitimately appear inside string templates
 *  in production code. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/[^:]\/\/.*$/gm, '')
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const p = join(dir, entry.name)
    if (entry.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(p)
  }
  return out
}

describe('reserved keys — no literal `$zoom` / `$featureId` / `$geometryType` outside the constants module', () => {
  it('all evaluator-prop injection sites import from reserved-keys', () => {
    const offenders: string[] = []
    const compilerSrc = join(ROOT, 'compiler/src')
    const runtimeSrc = join(ROOT, 'runtime/src')
    const allFiles = [...walk(compilerSrc), ...walk(runtimeSrc)]
    for (const abs of allFiles) {
      const rel = abs.replace(`${ROOT}/`, '')
      if (ALLOWED_FILES.has(rel)) continue
      const text = stripComments(readFileSync(abs, 'utf8'))
      for (const key of RESERVED_LITERALS) {
        // Look for the literal as a property-key in an object literal:
        //   bag.$zoom = …
        //   { $zoom: … }
        //   { '$zoom': … }
        //   props['$zoom']
        const escapedKey = key.replace('$', '\\$')
        const propAssign = new RegExp(`\\b\\w+\\.${escapedKey}\\b`)
        const objLitPlain = new RegExp(`[,{]\\s*${escapedKey}\\s*:`)
        const objLitQuoted = new RegExp(`['"]${escapedKey}['"]\\s*:`)
        const subscript = new RegExp(`\\[\\s*['"]${escapedKey}['"]\\s*\\]`)
        const matches: string[] = []
        if (propAssign.test(text)) matches.push('property-assignment')
        if (objLitPlain.test(text)) matches.push('object-literal-bare')
        if (objLitQuoted.test(text)) matches.push('object-literal-quoted')
        if (subscript.test(text)) matches.push('bracket-subscript')
        if (matches.length > 0 && !LITERAL_OK_FILES.has(rel)) {
          offenders.push(`${rel}: literal "${key}" via ${matches.join(', ')}`)
        }
      }
    }
    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `Found literal reserved-key usages — import CAMERA_ZOOM_KEY / FEATURE_ID_KEY / GEOMETRY_TYPE_KEY from @xgis/compiler instead:\n${offenders.join('\n')}`,
    ).toEqual([])
  })

  it('the constants have the expected sigil string values', () => {
    // Hardcoded to catch accidental drift (e.g. someone changes the
    // string in reserved-keys.ts thinking it's free-form). Lockstep
    // with evaluator.ts:38 (`if (expr.name === 'zoom') return props[CAMERA_ZOOM_KEY]`).
    expect(CAMERA_ZOOM_KEY).toBe('$zoom')
    expect(FEATURE_ID_KEY).toBe('$featureId')
    expect(GEOMETRY_TYPE_KEY).toBe('$geometryType')
  })

  it('makeEvalProps wires camera zoom to the evaluator\'s `zoom` identifier', () => {
    // The PR #102 invariant in test form: regardless of how the
    // worker / runtime constructs the props bag, the evaluator's
    // built-in `zoom` identifier MUST resolve to the value passed
    // as cameraZoom. If a future refactor renames CAMERA_ZOOM_KEY
    // or the evaluator's lookup, this test goes red — preventing
    // the silent fallback to null → 0 → "default 1 px" that bit us
    // on every OFM Bright road.
    const ast: Identifier = { kind: 'Identifier', name: 'zoom' }
    const propsAt14 = makeEvalProps({ cameraZoom: 14 })
    expect(evaluate(ast, propsAt14)).toBe(14)
    const propsAt0 = makeEvalProps({})
    expect(evaluate(ast, propsAt0)).toBeNull()
  })
})
