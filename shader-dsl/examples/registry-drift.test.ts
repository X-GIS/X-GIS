// ═══ examples/index.ts vs the directory — the registry drift gate (#1716) ═══
//
// `index.ts` is the file #1716 names: hand-maintained imports, hand-maintained re-exports,
// hand-maintained array. It is NOT regenerated here, and that is a finding rather than a
// shortcut — the part of it that is genuinely hand-maintained is the ORDER:
//
//     /** All examples, cartographic first (they belong on a map site), then generic … */
//
// A directory scan can enumerate the modules. It cannot know that cartographic examples
// lead because the site is a map site. That curation is editorial value a generator does
// not produce, the same thing #1700 says about the reference page's grouping. So the
// curation stays authored and this gate proves the two halves agree — which is exactly the
// check `buildRegistry` performs, run here against the real corpus.
//
// What it catches is the failure that has no other symptom: add an example file, forget to
// register it, and it is simply absent — no error, no test, just missing from the site and
// from every emit sweep that iterates `examples`.

import { describe, it, expect } from 'vitest'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { examples } from './index.js'
import { buildRegistry } from '../src/core/registry.js'
import { discoverExamples } from './_scan.js'

const HERE = dirname(fileURLToPath(import.meta.url))

// The scan moved to `_scan.ts` when #1716's generator landed, and is SHARED with it. Two
// copies of the export-convention regex is how a generator and the gate that checks it come
// to disagree — and the disagreement is invisible, because both keep passing on different
// sets.
const discovered = discoverExamples(HERE)

describe('examples registry — the directory and the curated list agree', () => {
  it('the scan actually found the corpus (it is not vacuously empty)', () => {
    // Every arm below is a set comparison, and two empty sets are equal. This is the
    // reader-is-broken floor that stops a regex change from greening the whole file.
    expect(discovered.length).toBeGreaterThanOrEqual(30)
    expect(examples.length).toBeGreaterThanOrEqual(30)
  })

  it('every example file is registered, and every registration has a file', () => {
    // buildRegistry reports BOTH directions in one failure, so a diff shows the added
    // file and the stale entry together rather than one per run.
    expect(() =>
      buildRegistry(discovered, {
        order: examples.map((e) => e.id),
        regenerateWith: 'add the new example to `examples` in shader-dsl/examples/index.ts',
      }),
    ).not.toThrow()
  })

  it('no example id is declared twice', () => {
    const ids = examples.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('the curated ORDER is real editorial content, not the scan order', () => {
    // Pins the finding this gate is built around: if these ever coincide, the curation has
    // been lost (or alphabetised by accident) and #1716's generator could own the file
    // outright. Failing here is a prompt to re-read that decision, not a bug.
    expect(examples.map((e) => e.id)).not.toEqual(discovered.map((d) => d.id))
  })
})
