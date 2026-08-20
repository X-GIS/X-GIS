#!/usr/bin/env bun
// lint-pr-title — reject a PR title that the changelog cannot file under a type.
//
// WHY THIS EXISTS, AND WHY IT IS NOT A SECOND COMMITLINT. The repo squash-merges,
// so the subject that becomes a changelog entry is composed SERVER-SIDE by GitHub
// from the PR title. commitlint runs in husky's local `commit-msg` hook, which
// only ever sees the commits that squash AWAY — so the one string the changelog is
// actually rendered from is the one string nothing validates. Measured on this
// history at the time this landed (#1842): of the 210 first-parent commits
// touching `shader-dsl/`, 100 do not parse as a conventional commit and 14 more
// carry a scope naming some other package — 54% whose subject does not say what
// changed in the package the reader is reading about. `b93df528` is the witness:
// `fix(ci)+feat(shader-dsl): …` does not parse, so six public exports (linkVariants,
// GlLinker, VariantLinkResult, emitIdentity, EmitTarget, EmitIdentityInput), two new
// modules and diagnostic code SD0016 landed under a line rendered in the `other`
// bucket beginning `fix(ci)`.
//
// THE PREDICATE IS THE GENERATOR'S OWN. This does not re-implement conventional
// commits, and deliberately does not shell out to commitlint: it asks
// `parseSubject` — the exact function the changelog renders with — whether the
// title lands in `other`. So the gate cannot drift from the thing it protects, and
// it inherits for free every shape the generator already blesses (a `Revert "…"`
// title parses as `revert`, and a trailing `(#NNN)` is stripped before the check).
// Adding a type to commitlint.config.js and to TYPE_ORDER is what widens this gate;
// there is nothing to keep in sync here.
//
// SCOPE IS NOT ENFORCED, on purpose. A PR legitimately spanning several packages is
// normal in this repo, and the changelog's per-package view filters by PATH, not by
// scope — so requiring a scope would buy nothing the reader gets and would reject
// honest titles.
//
// Usage — the title comes from the environment, never from an interpolated
// `run:` line, because a PR title is attacker-controlled on a fork PR:
//   PR_TITLE='feat(map): …' bun scripts/lint-pr-title.ts
// An explicit argument wins over the environment, for local spot checks:
//   bun scripts/lint-pr-title.ts 'feat(map): …'

import { parseSubject } from './emit-changelog'

/** Why a title is rejected, or `undefined` when it passes. */
export function rejectionReason(title: string): string | undefined {
  const trimmed = title.trim()
  if (trimmed === '') return 'the PR title is empty'
  if (parseSubject(trimmed).type !== 'other') return undefined
  return (
    `"${trimmed}" does not parse as a conventional commit, so the changelog can file it ` +
    'only under `other` — ungrouped, and invisible to a reader scanning for feat/fix. ' +
    'Write `<type>(<scope>): <summary>`, e.g. `feat(shader-dsl): textureNumLayers`. ' +
    'One type per title: `fix(ci)+feat(shader-dsl): …` is the shape that already cost ' +
    'six public exports their changelog line (#1842). ' +
    'Types: feat, fix, perf, refactor, test, docs, chore, build, ci, style, revert ' +
    '(commitlint.config.js). A `Revert "…"` title is accepted as-is.'
  )
}

if (import.meta.main) {
  const title = process.argv[2] ?? process.env.PR_TITLE ?? ''
  const reason = rejectionReason(title)
  if (reason !== undefined) {
    console.error(`PR title rejected: ${reason}`)
    process.exit(1)
  }
  console.log(`PR title OK: ${parseSubject(title.trim()).type}`)
}
