// ═══════════════════════════════════════════════════════════════════
// polygon-variant-diff.test.ts — Phase 2.5 US-010 (scaffolding)
// ═══════════════════════════════════════════════════════════════════
//
// Reads the baseline `.wgsl` snapshots committed under
// `__polygon-variant-snapshots__/` by US-000 and pins three
// invariants of the diff-test gate:
//
//   1. The snapshot directory carries at least the AC6 fixture floor
//      (8 files: 4 production-style + 4 synthetic variant patterns).
//   2. Each snapshot's `// baseline: <40-hex-sha>` header is parseable
//      and the body is the expected ~1000+ LOC polygon shader template.
//   3. Every snapshot's baseline SHA matches `git merge-base main HEAD`
//      — the drift gate fires when `main` advances during PR-B / PR-C
//      review and the snapshots haven't been re-captured.
//
// What this test does NOT yet do (deferred to PR-C finalisation):
//   - Re-emit the polygon WGSL via `emitPolygonWgsl(variant, false)`
//     for each fixture and AST-diff against the snapshot. US-007's
//     polygon DSL composer lands the `emitPolygonWgsl` entry point;
//     the AST diff helper (tree-sitter-wgsl OR hand-written tokenizer)
//     is selected at US-010 final-impl time per the ralplan AC6
//     fallback rule.
//
// Until then this file is the minimum-viable US-010 gate: it catches
// snapshot file corruption + SHA drift, which are the two failure
// modes that would silently invalidate the baseline before the AST
// diff layer is wired.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const __filename = fileURLToPath(import.meta.url)
const SNAPSHOT_DIR = join(dirname(__filename), '__polygon-variant-snapshots__')
const BASELINE_HEADER = /^\/\/\s*baseline:\s*([a-f0-9]{40})\s*$/m

function gitMergeBaseMainHead(): string {
  // Resolves the latest common ancestor of `main` and the current
  // branch. On `main` itself this returns HEAD. On a feature branch
  // off main, this returns main's HEAD at fork time.
  return execSync('git merge-base main HEAD').toString().trim()
}

describe('polygon-variant snapshot baseline gate — US-010 scaffolding', () => {
  const files = readdirSync(SNAPSHOT_DIR)
    .filter((f) => f.endsWith('.wgsl'))
    .sort()

  it('snapshot directory contains the AC6 fixture-coverage floor (>=8 files)', () => {
    expect(files.length).toBeGreaterThanOrEqual(8)
  })

  describe('per-fixture invariants', () => {
    for (const file of files) {
      it(`${file}: baseline header parseable + body has the expected polygon-shader size`, () => {
        const content = readFileSync(join(SNAPSHOT_DIR, file), 'utf8')
        const headerMatch = content.match(BASELINE_HEADER)
        expect(headerMatch, `missing or malformed "// baseline: <sha>" header in ${file}`).not.toBeNull()
        const baselineSha = headerMatch![1]!
        expect(baselineSha).toMatch(/^[a-f0-9]{40}$/)

        // POLYGON_SHADER_SOURCE is ~826 LOC; the captured snapshot
        // is the post-buildShader output (which only ADDS variant-
        // specific preamble lines on top). 1000+ lines covers the
        // base shader + the smallest variant injections; under that
        // → the capture is truncated / corrupt.
        const lines = content.split('\n')
        expect(lines.length).toBeGreaterThan(1000)
      })
    }
  })

  it('every snapshot baseline SHA matches git merge-base main HEAD (drift gate)', () => {
    const mergeBase = gitMergeBaseMainHead()
    const drift: { file: string; baseline: string }[] = []
    for (const file of files) {
      const content = readFileSync(join(SNAPSHOT_DIR, file), 'utf8')
      const headerMatch = content.match(BASELINE_HEADER)
      const baselineSha = headerMatch![1]!
      if (baselineSha !== mergeBase) drift.push({ file, baseline: baselineSha })
    }
    expect(
      drift,
      drift.length
        ? `Snapshot baseline drift detected — re-run \`bun scripts/capture-polygon-snapshots.ts\` and recommit __polygon-variant-snapshots__/. Drifted files:\n${drift.map((d) => `  ${d.file}: baseline=${d.baseline} (expected ${mergeBase})`).join('\n')}`
        : '',
    ).toEqual([])
  })
})
