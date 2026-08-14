// ═══════════════════════════════════════════════════════════════════
// polygon-variant-diff.test.ts — Phase 2.5 US-010 (impl)
// ═══════════════════════════════════════════════════════════════════
//
// Per-commit drift gate for the polygon DSL composer. For each of the
// 8 fixtures in `_polygon-fixtures.FIXTURES`:
//
//   1. Compute `emitForFixture(fx)` — the DSL composer's output for
//      that variant shape.
//   2. Read the committed snapshot under `__polygon-variant-snapshots__/`.
//   3. Compare body byte-equal (after stripping the snapshot's
//      `// baseline: <sha>` + `// fixture: ...` header). Mismatch
//      surfaces as test failure with a hint to re-capture.
//
// The baseline is byte-equal, NOT AST-equivalent, against the legacy
// POLYGON_SHADER_SOURCE-based emit:
//   - The composer's declaration order, paren density, and swizzle
//     conventions differ structurally from the legacy template; a
//     legacy-vs-DSL diff would need a tree-sitter-wgsl AST diff or
//     a hand-rolled ~300-LOC tokenizer normaliser, both deferred.
//   - Pixel survey + CI render-gate validate the LEGACY ≡ DSL
//     semantic equivalence end-to-end (4/4 across 3 runs at PR-B
//     close); this gate sits one level above and pins DSL-output
//     stability per commit.
//
// Refresh protocol: a composer change that intentionally perturbs
// the emit must be paired with a `bun scripts/capture-polygon-snapshots.ts`
// + commit of the refreshed `__polygon-variant-snapshots__/`. The
// ancestor-SHA gate confirms the baseline stays reachable from HEAD.
// Capturing on a feature branch needs `--baseline=$(git rev-parse main)`, or a
// squash merge orphans the stamped SHA and turns this gate red on main with no
// emit change at all — the capture script's header owns that rule in full.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { FIXTURES, emitForFixture, type Fixture } from './_polygon-fixtures'

const __filename = fileURLToPath(import.meta.url)
const SNAPSHOT_DIR = join(dirname(__filename), '__polygon-variant-snapshots__')
const BASELINE_HEADER = /^\/\/\s*baseline:\s*([a-f0-9]{40})\s*$/m
const SLUG_HEADER = /^\/\/\s*fixture:\s*([\w-]+)\s*$/m
// The snapshot header is 5 leading `//` comment lines (baseline,
// fixture, variant.key, pick, note); strip them to get the WGSL
// body for byte-equal comparison.
const HEADER_LINES = 5

/** True when this clone's history is TRUNCATED (`git clone --depth N`), so an ancestry
 *  question about a historical commit cannot be answered here (#1706).
 *
 *  This is not the same condition as the missing-object guard inside the ancestry test,
 *  and that difference is the whole bug it fixes. At `--depth 1` (the `actions/checkout`
 *  default, i.e. CI) the baseline commit is not present at all, so `git cat-file -e`
 *  fails and that guard fails open. At a deeper truncation — `--depth 50`, which is what
 *  container dev environments and Claude Code on the web get — the baseline commit IS
 *  present while the PATH from HEAD to it is cut at the graft boundary. `git merge-base
 *  --is-ancestor` then exits **1**: a clean "no", not an error. So the object guard
 *  passes, nothing throws, and all 8 baselines are reported as orphaned on a tree with no
 *  drift whatsoever.
 *
 *  Skipping rather than failing is deliberate. The failure text tells the reader to
 *  re-capture and recommit the snapshots, which on a false positive rewrites 8 correct
 *  baselines and destroys the very history this gate protects — a red gate that instructs
 *  a destructive fix is worse than an honest skip. The gate remains live where it can
 *  actually run: a full clone, which is where a human re-captures snapshots. */
const SHALLOW_CLONE = ((): boolean => {
  try {
    return (
      execSync('git rev-parse --is-shallow-repository', { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim() === 'true'
    )
  } catch {
    // Not a git repo, or git unavailable — leave the test enabled; its own per-baseline
    // guards already fail open when they cannot read an object.
    return false
  }
})()

function snapshotBody(content: string): string {
  // Normalise CRLF→LF before the byte-equal comparison. git autocrlf
  // checks the committed snapshot out with CRLF on Windows, but the DSL
  // composer always emits LF — so without this the gate false-fails on
  // EVERY line on a CRLF working tree (Linux CI, which keeps LF, passes).
  // Normalising masks only line-ending differences, never a real emit
  // drift (the emitter has no CRLF code path), so the gate's purpose is
  // preserved while it stops being OS-dependent.
  return content.replace(/\r\n/g, '\n').split('\n').slice(HEADER_LINES).join('\n')
}

function fixtureBySlug(slug: string): Fixture | undefined {
  return FIXTURES.find((f) => f.slug === slug)
}

describe('polygon-variant snapshot drift gate — US-010 impl', () => {
  const files = readdirSync(SNAPSHOT_DIR)
    .filter((f) => f.endsWith('.wgsl'))
    .sort()

  it('snapshot directory contains the AC6 fixture-coverage floor (>=8 files)', () => {
    expect(files.length).toBeGreaterThanOrEqual(8)
  })

  describe('per-fixture invariants', () => {
    for (const file of files) {
      it(`${file}: baseline + fixture headers parseable`, () => {
        const content = readFileSync(join(SNAPSHOT_DIR, file), 'utf8')
        const baselineMatch = content.match(BASELINE_HEADER)
        expect(
          baselineMatch,
          `missing/malformed "// baseline: <sha>" header in ${file}`,
        ).not.toBeNull()
        expect(baselineMatch![1]).toMatch(/^[a-f0-9]{40}$/)
        const slugMatch = content.match(SLUG_HEADER)
        expect(slugMatch, `missing "// fixture: <slug>" header in ${file}`).not.toBeNull()
        // Body should be the composer's emit. The auto-var + ioStruct.construct()
        // authoring cleanup made the emit more compact (field-by-field output
        // assigns collapsed to one constructor), so the minimum fixture now lands
        // ~494 LOC. 400 LOC floor preserves the spirit of "meaningful emit" without
        // rejecting legitimate simplification.
        const lines = content.split('\n')
        expect(lines.length).toBeGreaterThan(400)
      })
    }
  })

  describe('per-fixture composer emit byte-equal vs snapshot', () => {
    for (const file of files) {
      it(`${file}: emitForFixture(fx) byte-equals committed snapshot`, () => {
        const content = readFileSync(join(SNAPSHOT_DIR, file), 'utf8')
        const slugMatch = content.match(SLUG_HEADER)
        expect(slugMatch, `${file} missing "// fixture: <slug>" header`).not.toBeNull()
        const slug = slugMatch![1]!
        const fx = fixtureBySlug(slug)
        expect(fx, `${file} fixture slug "${slug}" not in FIXTURES`).toBeDefined()
        const emitted = emitForFixture(fx!) + '\n'
        const body = snapshotBody(content)
        if (emitted !== body) {
          // Find the first diff line for a focused error message.
          const a = emitted.split('\n')
          const b = body.split('\n')
          let firstLine = -1
          for (let i = 0; i < Math.min(a.length, b.length); i++) {
            if (a[i] !== b[i]) {
              firstLine = i
              break
            }
          }
          if (firstLine === -1) firstLine = Math.min(a.length, b.length)
          const ctx = (lines: string[], n: number) =>
            lines
              .slice(Math.max(0, n - 2), n + 3)
              .map((l, i) => `  ${(n - 2 + i).toString().padStart(4)}| ${l}`)
              .join('\n')
          expect.fail(
            `Composer emit drift in ${file}.\n` +
              `Re-run \`bun scripts/capture-polygon-snapshots.ts\` and commit if change is intentional.\n` +
              `First diff at line ${firstLine + 1}:\n` +
              `--- snapshot ---\n${ctx(b, firstLine)}\n` +
              `--- emit ---\n${ctx(a, firstLine)}\n`,
          )
        }
      })
    }
  })

  it('snapshot baseline SHAs are consistent across all fixtures (env-independent gate)', () => {
    // Cheap invariant: every captured snapshot pins the same baseline.
    // Catches half-captured re-runs where one snapshot has a fresh SHA
    // and the others are stale.
    const baselines = new Set<string>()
    for (const file of files) {
      const content = readFileSync(join(SNAPSHOT_DIR, file), 'utf8')
      const headerMatch = content.match(BASELINE_HEADER)
      baselines.add(headerMatch![1]!)
    }
    expect(
      [...baselines],
      `Snapshots have inconsistent baselines — re-run \`bun scripts/capture-polygon-snapshots.ts\`. Baselines seen: ${[...baselines].join(', ')}`,
    ).toHaveLength(1)
  })

  it.skipIf(SHALLOW_CLONE)(
    'every snapshot baseline SHA is an ancestor of current HEAD (live drift gate)',
    () => {
      // Earlier this gate required strict equality with `git merge-base
      // main HEAD`, which forced a re-capture on every commit to main
      // (each new commit advances merge-base past the snapshot
      // baseline). The ancestor relaxation is the correct semantics —
      // a snapshot baseline that's still reachable from HEAD is
      // structurally consistent with main's history; only an ORPHANED
      // baseline (force-push detached it) signals real drift.
      const drift: { file: string; baseline: string }[] = []
      for (const file of files) {
        const content = readFileSync(join(SNAPSHOT_DIR, file), 'utf8')
        const headerMatch = content.match(BASELINE_HEADER)
        const baselineSha = headerMatch![1]!
        let ancestor = true
        try {
          // Pre-check reachability. CI (actions/checkout@v4
          // fetch-depth=1 default) only sees HEAD's commit; historical
          // baselines aren't testable there. Treat unreachable-SHA as
          // ancestor=true so the local-dev (full clone) drift check
          // still fires but the CI shallow checkout doesn't false-
          // positive on every commit.
          // NOTE (#1706): this covers only the depth-1 case, where the object is
          // ABSENT. A deeper truncation keeps the object and cuts the PATH, which
          // this guard cannot see — SHALLOW_CLONE above skips the whole test there.
          execSync(`git cat-file -e ${baselineSha}^{commit}`, {
            stdio: ['ignore', 'ignore', 'ignore'],
          })
          try {
            execSync(`git merge-base --is-ancestor ${baselineSha} HEAD`, {
              stdio: ['ignore', 'ignore', 'ignore'],
            })
            ancestor = true
          } catch {
            ancestor = false
          }
        } catch {
          ancestor = true
        }
        if (!ancestor) drift.push({ file, baseline: baselineSha })
      }
      expect(
        drift,
        drift.length
          ? `Snapshot baseline orphaned (not an ancestor of HEAD) — re-run \`bun scripts/capture-polygon-snapshots.ts\` and recommit __polygon-variant-snapshots__/. This clone is NOT shallow, so the history really does not reach these baselines (a shallow clone skips this test instead — #1706). Drifted files:\n${drift.map((d) => `  ${d.file}: baseline=${d.baseline}`).join('\n')}`
          : '',
      ).toEqual([])
    },
  )
})
