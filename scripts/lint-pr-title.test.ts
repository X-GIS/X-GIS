// Unit tests for the PR-title gate (#1842).
//
// The gate's whole value is that it DISTINGUISHES the states it claims to, so the
// arms are paired: for every shape accepted there is a neighbouring shape rejected.
// A gate that accepted everything would be indistinguishable from no gate at all,
// and would sit green while the `other` bucket kept filling — which is exactly the
// state this replaces.

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { rejectionReason } from './lint-pr-title'

const script = fileURLToPath(new URL('./lint-pr-title.ts', import.meta.url))

describe('rejectionReason', () => {
  it('accepts every type the changelog groups by', () => {
    for (const type of [
      'feat',
      'fix',
      'perf',
      'refactor',
      'test',
      'docs',
      'chore',
      'build',
      'ci',
      'style',
      'revert',
    ]) {
      expect(rejectionReason(`${type}(shader-dsl): a summary`)).toBeUndefined()
    }
  })

  it('accepts the shapes that carry no scope, a breaking marker, or a PR suffix', () => {
    // Scope is deliberately not required — a PR spanning packages is normal here,
    // and the per-package changelog view filters by PATH, not by scope.
    expect(rejectionReason('feat: a summary')).toBeUndefined()
    expect(rejectionReason('refactor!: dissolve @xgis/runtime')).toBeUndefined()
    expect(rejectionReason('feat(map,shader-dsl): two packages at once')).toBeUndefined()
    // GitHub appends `(#NNN)` on squash; parseSubject strips it before typing.
    expect(rejectionReason('fix(geo): off-by-one (#1234)')).toBeUndefined()
    // The generator gives GitHub's revert button its own type, so the gate must too.
    expect(rejectionReason('Revert "fix(shader-dsl): guard df64_mul cross terms"')).toBeUndefined()
  })

  it('REJECTS the exact title that cost six public exports their changelog line', () => {
    // b93df528. Two types welded together do not parse, so the entry rendered in
    // `other` under a line beginning `fix(ci)` while index.ts gained six exports.
    const reason = rejectionReason(
      "fix(ci)+feat(shader-dsl): the mirror that never ran, hostBlock, #1715's two gates (#1723)",
    )
    expect(reason).toBeDefined()
    expect(reason).toContain('other')
  })

  it('rejects the other ways a title escapes typing', () => {
    expect(rejectionReason('')).toBeDefined()
    expect(rejectionReason('   ')).toBeDefined()
    // A type that is not in commitlint's enum is not a type.
    expect(rejectionReason('wip(map): halfway there')).toBeDefined()
    // Prose with no type at all — the single most common `other` shape in history.
    expect(rejectionReason('shader-dsl: exhaustive integer dispatch (#666)')).toBeDefined()
    expect(rejectionReason('GPU-free fixes: compute-gen LUT -1 sentinel')).toBeDefined()
    expect(rejectionReason('Merge pull request #831 from X-GIS/claude/gpu-webgl2')).toBeDefined()
  })

  it('names the fix, not just the failure', () => {
    const reason = rejectionReason('shader-dsl: exhaustive integer dispatch') ?? ''
    // An author who has just been stopped needs the shape and the vocabulary, or
    // the gate is a wall rather than a gate.
    expect(reason).toContain('<type>(<scope>): <summary>')
    expect(reason).toContain('commitlint.config.js')
  })
})

describe('the entrypoint', () => {
  const run = (args: readonly string[], env: Record<string, string> = {}) =>
    spawnSync('bun', [script, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    })

  it('exits 0 and names the type for an acceptable title', () => {
    const ok = run([], { PR_TITLE: 'feat(shader-dsl): textureNumLayers' })
    expect(ok.status).toBe(0)
    expect(ok.stdout).toContain('feat')
  })

  it('exits 1 and explains, reading the title from the ENVIRONMENT', () => {
    // The environment is the CI path: a PR title is attacker-controlled on a fork
    // PR, so it must never reach the runner as an interpolated `run:` line.
    const bad = run([], { PR_TITLE: 'fix(ci)+feat(shader-dsl): welded types' })
    expect(bad.status).toBe(1)
    expect(bad.stderr).toContain('PR title rejected')
  })

  it('exits 1 when no title reaches it at all — an unset env is not a pass', () => {
    // The failure mode this arm exists for: a workflow typo leaves PR_TITLE unset,
    // the script sees '', and a gate that treated empty as "nothing to check" would
    // go green on every PR forever.
    const missing = run([], { PR_TITLE: '' })
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('empty')
  })

  it('prefers an explicit argument over the environment', () => {
    const ok = run(['docs(site): a local spot check'], { PR_TITLE: 'not a conventional commit' })
    expect(ok.status).toBe(0)
    expect(ok.stdout).toContain('docs')
  })
})
