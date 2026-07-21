// ═══ Earth-literal ratchet (#798 P1) ═══
//
// Pins `shared/src/body.ts` as the ONLY authority for Earth's geodesy
// constants and fails CI on any NEW hardcoded Earth literal in library src.
// P1 centralised ~28 scattered copies of the WGS84 numbers into `EARTH`;
// this gate is what keeps the count at zero — same convention as the
// dependency-direction ratchet (#929): violating the boundary is a
// mechanical CI failure, not a review comment.
//
// ALLOWLIST holds the files that legitimately spell the numbers out:
// the authority itself, plus the two GPU ConstDecl files. These ConstDecls are
// the shipped Earth DEFAULTS (WGS84_A / EARTH_R = 6378137, WGS84_E2 / EARTH_E2 =
// f·(2−f)) that the body-consts seam routes through the active Body — an
// UNCONFIGURED process must emit byte-identical Earth WGSL, which requires the
// numbers spelled as defaults. So these two entries are PERMANENT, not
// migration-temporary: #1152 INC-3 single-sourced the values (WGS84_E2 now
// spells EARTH.e2's f·(2−f), un-pinning #798 PIN #2) but the spelled DEFAULTS
// stay. The binding invariant — every default here must bit-equal its EARTH.*
// field — is enforced by map/src/body-consts.test.ts, not by deleting the entry.
// Shrink-only still governs any OTHER file: a stale entry fails below.

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The Earth numbers that must come from `EARTH` (shared/src/body.ts).
 *  Matched against comment-stripped source, so prose mentions are fine. */
const LITERAL_RE = /6378137|40075016|298\.257223563|0\.00669437/

/** Files allowed to spell the literals out. Repo-relative, POSIX-style. */
const ALLOWLIST: readonly string[] = [
  // The single authority — pins the numbers everything else reads.
  'shared/src/body.ts',
  // GPU-side ConstDecls (wgslValue/cpuValue pairs) — the shipped Earth defaults
  // the body-consts seam routes through the active Body. PERMANENT: the
  // unconfigured-process byte-identical-Earth guarantee needs the numbers spelled
  // as defaults (WGS84_A/EARTH_R = 6378137; WGS84_E2/EARTH_E2 = f·(2−f), matched
  // by /0\.00669437/). #1152 INC-3 single-sourced the VALUES to EARTH.* (un-pinned
  // #798 PIN #2) — the defaults must now bit-equal EARTH.*, enforced by
  // body-consts.test.ts. Not a migration entry; do not delete.
  'map/src/shaders/dsl/ecef.ts',
  'map/src/shaders/dsl/projections.ts',
]

/** Same exemptions as the dependency ratchet: runtime is the pre-#732
 *  monolith being retired; playground + site are consumers, not libraries. */
const EXEMPT = new Set(['runtime', 'playground', 'site'])

const isTestPath = (p: string): boolean =>
  p.includes('.test.') ||
  p.includes('__tests__') ||
  p.includes('__test-support__') ||
  p.includes('test-setup')

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      yield* walk(full)
    } else if (entry.name.endsWith('.ts')) {
      yield full
    }
  }
}

// Strip block comments and `// …` line tails so doc mentions of the
// numbers (frequent — the constants are well-commented) don't trip the
// gate. Coarse on purpose: a `//` inside a string eats the line's tail,
// which can only hide a literal, never invent one.
const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

function scanLiterals(): Set<string> {
  const workspaces = (
    JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      workspaces: string[]
    }
  ).workspaces
  const hits = new Set<string>()
  for (const pkg of workspaces) {
    if (EXEMPT.has(pkg)) continue
    for (const file of walk(join(REPO_ROOT, pkg, 'src'))) {
      if (isTestPath(file)) continue
      if (LITERAL_RE.test(stripComments(readFileSync(file, 'utf8')))) {
        hits.add(relative(REPO_ROOT, file).split('\\').join('/'))
      }
    }
  }
  return hits
}

describe('earth-literal ratchet (#798 P1)', () => {
  const hits = scanLiterals()

  it('scanner sanity — the authority itself is seen', () => {
    // body.ts pins the literals by design; if the scan stops seeing it the
    // walker/regex/stripper broke and the gate is passing on nothing.
    expect(hits.has('shared/src/body.ts')).toBe(true)
  })

  it('no Earth literals outside the allowlist', () => {
    const allowed = new Set(ALLOWLIST)
    expect(
      [...hits].filter((f) => !allowed.has(f)).sort(),
      'NEW hardcoded Earth constant in library src. Import EARTH from ' +
        '@xgis/shared instead (see shared/src/body.ts — #798). If the file ' +
        'genuinely must pin a literal (a new GPU ConstDecl twin), add it to ' +
        'ALLOWLIST here, in this commit, with a rationale.',
    ).toEqual([])
  })

  it('allowlist only shrinks (stale entries must be deleted)', () => {
    expect(
      ALLOWLIST.filter((f) => !hits.has(f)),
      'Allowlisted file no longer contains an Earth literal — migration ' +
        'achieved. Delete its ALLOWLIST entry in this same commit so the ' +
        'ratchet locks the win.',
    ).toEqual([])
  })
})
