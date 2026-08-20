// ═══ The dependency-drift check, against the shape that actually bit ═══
//
// On 2026-08-20 `main` gained `shiki` in `site` (#1911) while this container's
// node_modules predated it. `bun run build` then died with a Rollup "cannot resolve
// shiki/core", which reads like a code bug — it was misdiagnosed twice, in opposite
// directions, before file timestamps settled it.
//
// So the fixtures below are that shape on disk, not a hand-made one: a workspace whose
// package.json DECLARES a dependency that is not linked. `bun install --frozen-lockfile
// --dry-run` cannot see this — it plans against the lockfile and prints "done" — which is
// why resolution is checked against the filesystem instead.
//
// The second fixture is the decoy that keeps this usable in a monorepo: bun HOISTS most
// dependencies to the root, so a package's own `node_modules` is usually near-empty. A
// check that only looked beside the manifest would report almost every dependency in this
// repo as missing, every run, and be turned off within a day.

import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { missingDeps, resolves } from './session-check.js'

/** Build a throwaway workspace on disk. `linked` lists `<dir>/node_modules/<name>`
 *  paths to create, so a fixture can place a package at the root, beside its manifest,
 *  or nowhere at all. */
function fixture(
  manifests: Record<string, Record<string, string>>,
  linked: readonly string[],
): string {
  const root = mkdtempSync(join(tmpdir(), 'ws-'))
  const workspaces = Object.keys(manifests).filter((k) => k !== '.')
  for (const [ws, deps] of Object.entries(manifests)) {
    const dir = join(root, ws)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify(ws === '.' ? { workspaces, dependencies: deps } : { dependencies: deps }),
    )
  }
  for (const l of linked) mkdirSync(join(root, l), { recursive: true })
  return root
}

describe('missingDeps — declared but not installed', () => {
  it('catches the shiki shape: declared by a workspace, linked nowhere', () => {
    const root = fixture({ '.': {}, site: { shiki: '4.2.0' } }, [])
    expect(missingDeps(root, ['site'])).toEqual([{ pkg: 'site', dep: 'shiki', want: '4.2.0' }])
  })

  it('accepts a dependency HOISTED to the root — the monorepo default', () => {
    const root = fixture({ '.': {}, site: { shiki: '4.2.0' } }, ['node_modules/shiki'])
    expect(missingDeps(root, ['site'])).toEqual([])
  })

  it('accepts one linked beside its own manifest', () => {
    const root = fixture({ '.': {}, site: { shiki: '4.2.0' } }, ['site/node_modules/shiki'])
    expect(missingDeps(root, ['site'])).toEqual([])
  })

  it('checks the ROOT manifest too, not only the workspaces', () => {
    const root = fixture({ '.': { vitest: '1.0.0' }, site: {} }, [])
    expect(missingDeps(root, ['site'])).toEqual([{ pkg: '.', dep: 'vitest', want: '1.0.0' }])
  })

  it('reports every miss, so one run names the whole gap', () => {
    const root = fixture({ '.': {}, site: { a: '1', b: '2' }, map: { c: '3' } }, ['node_modules/a'])
    expect(
      missingDeps(root, ['site', 'map'])
        .map((m) => m.dep)
        .sort(),
    ).toEqual(['b', 'c'])
  })

  it('skips a workspace with no manifest instead of throwing', () => {
    const root = fixture({ '.': {} }, [])
    expect(missingDeps(root, ['does-not-exist'])).toEqual([])
  })
})

describe('resolves — both reachable locations count', () => {
  it('is false when a package is in NEITHER node_modules', () => {
    const root = fixture({ '.': {}, site: {} }, [])
    expect(resolves(root, join(root, 'site'), 'shiki')).toBe(false)
  })
})
