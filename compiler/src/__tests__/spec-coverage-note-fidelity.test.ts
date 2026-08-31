// ═══ spec-coverage row FIDELITY — bind a note to a falsifiable fact ═══
//
// #2174. `spec-coverage-drift.test.ts:244` skips every non-`supported`
// row (`if (e.status !== 'supported') continue`) and
// `spec-coverage-notes.test.ts:30-31` checks a `partial` /
// `unsupported` note for existence and for being ≥ 20 characters. That
// is the ENTIRE gate on those rows: a note may assert anything about
// the engine — including a false blocker — and CI stays silent. Three
// of the claims a note makes are mechanically checkable against the
// tree it describes, and this file checks them (for EVERY row, not
// just the `partial` / `unsupported` ones — a `supported` row's
// citation rots exactly as quietly):
//
//   1. CITATION RESOLUTION — a `source: 'file.ts:NNN'` must name a file
//      that exists, and NNN must be inside it.
//   2. SPEC-DEFAULT FIDELITY — a note that quotes a spec default
//      ("viewport (default)", "linear (spec default)", "the spec
//      default is `true`") must agree with the pinned oracle for the
//      property the row names.
//   3. SYMBOL EXISTENCE — a lowerCamelCase identifier named in a note
//      or a `source` must exist somewhere in compiler/src + map/src.
//
// Status/emit agreement (a row marked `unsupported` whose converter
// demonstrably emits a utility for the property, and the converse) is
// the fourth and largest rule; it is deliberately NOT here — it needs
// to drive the converter, not read text, and it is its own PR.
//
// Why lowerCamelCase for rule 3 and nothing looser: a rule that fires
// on "an identifier" fires on prose. Measured over this corpus, the
// lowerCamelCase shape (first char lowercase, at least one internal
// capital) matched 249 tokens across every note + source string and
// every single one was a real code identifier — no proper noun
// (MapLibre, WebGPU, OpenFreeMap, GDAL) has that shape, and neither
// does any English word. PascalCase and backtick-delimited spans were
// both tried and both drag prose in. The trade is recall: a
// snake_case shader symbol (`fs_fill`, `vs_main`) or an external
// project's identifier is not checked here.

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { flattenCoverage } from '../convert/spec-coverage'
import { spec } from '../spec/oracle'

const HERE = dirname(fileURLToPath(import.meta.url))
/** compiler/src/__tests__ → compiler/src → compiler → repo root. */
const ROOT = join(HERE, '..', '..', '..')
const DESCRIPTOR_DIR = join(ROOT, 'compiler', 'src', 'convert', 'spec-coverage')

/** Trees a coverage citation is allowed to point into. Measured: these
 *  two resolve all 93 numeric citations and every identifier the notes
 *  name — a wider walk buys nothing and costs seconds. */
const SOURCE_ROOTS = ['compiler/src', 'map/src']
/** `spec-coverage` is skipped BY NAME on purpose: the descriptor files
 *  ARE the prose under test, so leaving them in the corpus would let a
 *  note's invented identifier vouch for itself. */
const SKIP_DIRS = new Set(['node_modules', 'dist', '__snapshots__', 'spec-coverage'])
const SOURCE_EXT = /\.(ts|tsx|wgsl|glsl)$/

/** Repo-relative path → line count, plus every identifier token that
 *  appears anywhere in those files. One walk serves rules 1 and 3. */
function readSourceTree(): { lines: Map<string, number>; identifiers: Set<string> } {
  const lines = new Map<string, number>()
  const identifiers = new Set<string>()
  const walk = (rel: string): void => {
    for (const e of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(`${rel}/${e.name}`)
        continue
      }
      if (!SOURCE_EXT.test(e.name)) continue
      const path = `${rel}/${e.name}`
      const text = readFileSync(join(ROOT, path), 'utf8')
      lines.set(path, text.split('\n').length)
      for (const tok of text.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []) identifiers.add(tok)
    }
  }
  for (const r of SOURCE_ROOTS) walk(r)
  return { lines, identifiers }
}
const TREE = readSourceTree()

/** Row name → `descriptor.ts:NN` where it is declared. Message-only, so
 *  a failure is a worklist rather than a name to go hunting for. */
function declarationSites(): Map<string, string> {
  const sites = new Map<string, string>()
  for (const file of readdirSync(DESCRIPTOR_DIR)) {
    if (!file.endsWith('.ts')) continue
    const text = readFileSync(join(DESCRIPTOR_DIR, file), 'utf8')
    for (const m of text.matchAll(/name:\s*(['"])(.*?)\1/g)) {
      if (sites.has(m[2]!)) continue
      sites.set(m[2]!, `${file}:${text.slice(0, m.index).split('\n').length}`)
    }
  }
  return sites
}
const SITES = declarationSites()
const at = (name: string): string => SITES.get(name) ?? '(declaration not located)'

/** `layer-converters/line.ts` and a bare `paint.ts` both appear in the
 *  corpus. Prefer the converter dir, then the rest of the compiler,
 *  then map — the order the citations were written in. */
function resolveCitedFile(name: string): string | undefined {
  const suffix = `/${name.replace(/^\.\//, '')}`
  const hits = [...TREE.lines.keys()].filter((p) => p.endsWith(suffix))
  return (
    hits.find((p) => p.startsWith('compiler/src/convert/')) ??
    hits.find((p) => p.startsWith('compiler/src/')) ??
    hits[0]
  )
}

const CITATION = /([A-Za-z0-9_./-]+\.ts):(\d+)/g
const CAMEL_IDENTIFIER = /\b[a-z][a-z0-9]*(?:[A-Z][A-Za-z0-9]*)+\b/g
/** "viewport (default)", "`false` (default)", "linear (spec default)". */
const PARENTHESISED_DEFAULT = /`?([A-Za-z0-9_.+-]+)`?\s+\((?:spec\s+)?default\)/g
/** "Mapbox's spec default is `true`". Backticks required — without them
 *  the phrase runs on into prose and the captured value is a guess. */
const PROSE_SPEC_DEFAULT = /\bspec default is `([^`]+)`/g

/** Every `default` the pinned spec carries for this property name,
 *  across every `paint_*` / `layout_*` block. `resampling` lives in
 *  three blocks and agrees in all three; measured, NO property name in
 *  the spec has conflicting defaults, so disagreement here means the
 *  spec changed shape and the row can no longer be adjudicated. */
function specDefaultsFor(property: string): unknown[] {
  const out: unknown[] = []
  for (const [block, props] of Object.entries(spec as Record<string, unknown>)) {
    if (!/^(paint|layout)_/.test(block) || typeof props !== 'object' || props === null) continue
    const p = (props as Record<string, { default?: unknown }>)[property]
    if (p && 'default' in p) out.push(p.default)
  }
  return out
}
const render = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v))

// ─────────────────────────────────────────────────────────────────────
// Rule 1b ratchet. First run on #2174's branch: 55 of the 93 numeric
// citations named a line past the end of the file they cite. Two —
// the `in` and `zoom` rows, the witnesses the issue measured — are
// corrected in this PR; the remaining 53 are ALL fallout of the
// god-file splits, and break down as:
//
//   layers.ts:NNN      40   layers.ts is 86 lines (was 1500+ before
//                           the layer-converters/* + layers-symbol.ts
//                           extraction)
//   paint.ts:NNN       11   paint.ts is 56 lines (was 300+ before the
//                           paint-fill / paint-line / paint-* split)
//   expressions.ts:NNN  2   filters.ts rows, 302-line file
//
// Re-pointing one is not a text edit: it is a per-row judgement about
// where that property's emit now lives — the same work as rule 4 — and
// a citation invented to satisfy this gate would be worse than the
// stale one it replaced. So it is a follow-up and NOT an allowlist:
// there is no per-row skip, the failure message prints the whole list
// as a worklist, and this pin may only go DOWN. The test fails if the
// count RISES and also if it FALLS (lower the pin), so the number here
// is always the measured truth rather than a high-water mark nobody
// re-read.
//
// "Lines" here is `split('\n').length`, so a trailing newline counts as
// one — one MORE than `wc -l`. Deliberate: a gate must not fire on a
// counting convention, only on a citation that is genuinely off the end.
// ─────────────────────────────────────────────────────────────────────
const CITATION_ROT_RATCHET = 53

describe('spec-coverage row fidelity', () => {
  it('every `file.ts:NNN` citation names a file that exists in the tree', () => {
    const unresolved: string[] = []
    for (const e of flattenCoverage()) {
      if (!e.source) continue
      for (const m of e.source.matchAll(CITATION)) {
        if (resolveCitedFile(m[1]!) === undefined)
          unresolved.push(`${at(e.name)} — "${e.name}" cites \`${m[1]}\`, which is not in the tree`)
      }
    }
    expect(unresolved, unresolved.join('\n')).toEqual([])
  })

  it('cited line numbers land inside the file they name (rot ratchet)', () => {
    const rotted: string[] = []
    for (const e of flattenCoverage()) {
      if (!e.source) continue
      for (const m of e.source.matchAll(CITATION)) {
        const path = resolveCitedFile(m[1]!)
        if (path === undefined) continue // covered by the test above
        const length = TREE.lines.get(path)!
        if (Number(m[2]) > length)
          rotted.push(
            `${at(e.name)} — "${e.name}" cites ${m[1]}:${m[2]}, but ${path} has ${length} lines`,
          )
      }
    }
    const listing = rotted.join('\n')
    expect(
      rotted.length,
      `citation rot GREW to ${rotted.length} (pinned ${CITATION_ROT_RATCHET}). A citation must point at a line that exists:\n${listing}`,
    ).toBeLessThanOrEqual(CITATION_ROT_RATCHET)
    expect(
      rotted.length,
      `citation rot fell to ${rotted.length} — lower CITATION_ROT_RATCHET to ${rotted.length}.`,
    ).toBe(CITATION_ROT_RATCHET)
  })

  it('a note quoting a spec default agrees with the pinned oracle', () => {
    const wrong: string[] = []
    for (const e of flattenCoverage()) {
      if (!e.note) continue
      const defaults = specDefaultsFor(e.name)
      // Not a spec property (expression ops, `resampling`-style aliases,
      // structural keys), or the spec disagrees with itself — either way
      // there is no fact to check the note against.
      if (defaults.length === 0) continue
      const expected = render(defaults[0])
      if (defaults.some((d) => render(d) !== expected)) continue
      for (const re of [PARENTHESISED_DEFAULT, PROSE_SPEC_DEFAULT]) {
        for (const m of e.note.matchAll(re)) {
          if (m[1] === expected) continue
          wrong.push(
            `${at(e.name)} — "${e.name}" note says «${m[0]}», but the pinned spec default is \`${expected}\``,
          )
        }
      }
    }
    expect(wrong, wrong.join('\n')).toEqual([])
  })

  it('an identifier named in a note or a source citation exists in the tree', () => {
    const phantom: string[] = []
    for (const e of flattenCoverage()) {
      for (const [field, text] of [
        ['note', e.note],
        ['source', e.source],
      ] as const) {
        if (!text) continue
        for (const tok of new Set(text.match(CAMEL_IDENTIFIER) ?? [])) {
          if (TREE.identifiers.has(tok)) continue
          phantom.push(
            `${at(e.name)} — "${e.name}" ${field} names \`${tok}\`, which exists nowhere in ${SOURCE_ROOTS.join(' + ')}`,
          )
        }
      }
    }
    expect(phantom, phantom.join('\n')).toEqual([])
  })
})
