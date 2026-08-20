#!/usr/bin/env bun
// ═══ Verify what the last session left behind; do not inherit it ═══
//
//   bun scripts/session-check.ts
//
// A session starts with no memory of the one before it, and the artifacts it inherits —
// a branch, a node_modules, a "the gate is green" — are CLAIMS, not facts. On 2026-08-20
// three separate hours went into believing one:
//
//   • `bun install` was needed after main moved (#1911 added `shiki` to `site`), and the
//     symptom was a Rollup "cannot resolve shiki/core" that reads like a code bug. It was
//     misdiagnosed twice, once in each direction, before the timestamps settled it.
//   • a flake "fixed" in #1897 had recurred and the fix still looked like a fix.
//   • a subagent-era lesson (§12) says a branch can be somewhere other than you think.
//
// This script owns the MECHANICAL half of that check — the part that is a fact about the
// working copy, not a judgement. The judgement half lives in CLAUDE.md §13, because it
// cannot be scripted: re-verifying an inherited claim means reading the evidence, not
// running a command.
//
// It is deliberately NOT a gate in CI. It answers "is this working copy what I think it
// is", which is a question only a fresh session has.

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

/** A dependency a package.json declares that is not linked under any reachable
 *  node_modules. THIS is the shape that bit: `bun install --frozen-lockfile --dry-run`
 *  plans against the LOCKFILE and reports "done" while the tree on disk is stale, so it
 *  cannot see a declared-but-unlinked package. Resolution is checked on disk instead. */
export interface MissingDep {
  readonly pkg: string
  readonly dep: string
  readonly want: string
}

/** Does `dep` resolve for a package at `dir`? Bun links workspace deps into the
 *  package's own `node_modules` or hoists them to the root, so both are reachable. */
export function resolves(root: string, dir: string, dep: string): boolean {
  return existsSync(join(dir, 'node_modules', dep)) || existsSync(join(root, 'node_modules', dep))
}

/** Every declared dependency that does not resolve, across the workspace. */
export function missingDeps(
  root: string,
  workspaces: readonly string[],
  read: (p: string) => string = (p) => readFileSync(p, 'utf8'),
): MissingDep[] {
  const out: MissingDep[] = []
  for (const ws of ['.', ...workspaces]) {
    const manifest = join(root, ws, 'package.json')
    if (!existsSync(manifest)) continue
    const json = JSON.parse(read(manifest)) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const declared = { ...json.dependencies, ...json.devDependencies }
    for (const [dep, want] of Object.entries(declared)) {
      // A `workspace:` or `file:` spec points at a sibling in this repo; bun links those
      // by name too, so the same resolution check applies and no special case is needed.
      if (!resolves(root, join(root, ws), dep)) out.push({ pkg: ws, dep, want })
    }
  }
  return out
}

const git = (...args: string[]): string =>
  execFileSync('git', args, { encoding: 'utf8', cwd: process.cwd() }).trim()

if (import.meta.main) {
  const root = git('rev-parse', '--show-toplevel')
  const workspaces =
    (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { workspaces?: string[] })
      .workspaces ?? []

  const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
  const head = git('log', '-1', '--format=%h %s')
  const dirty = git('status', '--porcelain')
    .split('\n')
    .filter((l) => l !== '').length

  console.log(`branch   ${branch}`)
  console.log(`head     ${head}`)
  console.log(`dirty    ${dirty} file(s)`)

  // Behind/ahead is only meaningful against a fetched ref, and a stale one turns someone
  // else's regression into yours (§12). Report the ref's age rather than pretending.
  try {
    const [behind, ahead] = git('rev-list', '--left-right', '--count', 'origin/main...HEAD')
      .split(/\s+/)
      .map(Number)
    console.log(`vs main  ${behind} behind, ${ahead} ahead (origin/main — fetch first if stale)`)
  } catch {
    console.log('vs main  origin/main not present — fetch first')
  }

  const missing = missingDeps(root, workspaces)
  if (missing.length === 0) {
    console.log(`deps     all declared dependencies resolve (${workspaces.length + 1} manifests)`)
    process.exit(0)
  }
  console.log(`deps     ${missing.length} DECLARED BUT NOT INSTALLED — run \`bun install\`:`)
  for (const m of missing.slice(0, 12)) console.log(`           ${m.pkg}: ${m.dep}@${m.want}`)
  if (missing.length > 12) console.log(`           … and ${missing.length - 12} more`)
  // Exit non-zero: this one is unambiguous and actionable, and a build that starts here
  // fails somewhere far away (a Rollup resolve error that reads like a code bug).
  process.exit(1)
}
