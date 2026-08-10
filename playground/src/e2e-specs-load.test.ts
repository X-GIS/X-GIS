// ═══ Every e2e spec must LOAD (#1638) ═══
//
// `bun run test:e2e` collected `0 tests in 0 files` for an unknown length of
// time. Six specs threw at module scope, and a module-scope throw is a
// COLLECTION error — Playwright aborts the entire run rather than the one
// file, so six rotted specs silently took 379 healthy ones with them.
// `--grep-invert` does not rescue it either: filtering happens after module
// load.
//
// CI never noticed because `.github/workflows/test.yml` names its render-gate
// specs EXPLICITLY, so it only ever loads the ~49 it lists. The failure was
// visible only to a human running the documented whole-suite command.
//
// WHY THIS ASSERTS LOADING AND NOT A LINT RULE. The three root causes were an
// untracked baseline read at module scope, a stale relative import, and a
// workspace-package import that the Playwright loader cannot resolve. A static
// rule catches the first two; the third is indistinguishable from the package
// imports that DO work (`_vs-clip-parity` imports `@xgis/compiler` and is green
// in CI), so no syntactic rule separates them. Actually loading every module is
// the only check that covers all three — and `--list` does exactly that for
// 5 s, with no browser and no dev server.

import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLAYGROUND = resolve(HERE, '..')
const E2E_DIR = join(PLAYGROUND, 'e2e')

/** Spec files on disk — the population `--list` must be able to load. */
const specFiles = readdirSync(E2E_DIR).filter((f) => f.endsWith('.spec.ts'))

describe('every e2e spec loads — a module-scope throw aborts the whole suite (#1638)', () => {
  it('the corpus is nonempty', () => {
    // A gate that does not prove its own population is the bug it guards
    // against, one level up (#1625).
    expect(specFiles.length, `no .spec.ts files under ${E2E_DIR}`).toBeGreaterThan(300)
  })

  it('`playwright test --list` collects every spec file, with no collection errors', () => {
    let stdout: string
    try {
      stdout = execFileSync('./node_modules/.bin/playwright', ['test', '--list'], {
        cwd: PLAYGROUND,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 180_000,
      })
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message: string }
      throw new Error(
        `playwright could not collect the e2e suite — one or more specs throw at module ` +
          `scope, which aborts the run for ALL of them (#1638). Fix the erroring spec; a ` +
          `module-scope readFileSync of an untracked path, a stale relative import, and a ` +
          `workspace-package import the loader cannot resolve have each caused this.\n\n` +
          `${err.stderr ?? ''}\n${err.stdout ?? err.message}`.slice(0, 4000),
      )
    }

    const match = /Total:\s+(\d+)\s+tests? in\s+(\d+)\s+files?/.exec(stdout)
    expect(
      match,
      `could not parse a "Total:" line from --list output:\n${stdout.slice(-2000)}`,
    ).not.toBeNull()

    const filesCollected = Number(match![2])
    // Exact equality would break on any spec that legitimately generates no
    // test (none today); the floor that matters is "essentially all of them",
    // which still goes red the moment one spec's throw drops the count to 0.
    expect(
      filesCollected,
      `--list collected ${filesCollected} of ${specFiles.length} spec files — a spec that ` +
        `fails to load takes the whole suite with it (#1638)`,
    ).toBeGreaterThanOrEqual(specFiles.length)
  })
})
