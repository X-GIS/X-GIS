// Phase 2 PR 2c.3.C — setBackgroundFill(null) lifecycle contract test.
//
// Reviewer MAJOR #1 (code-review-findings.md from PR 2c.3.B) flagged
// setBackgroundFill(null) as a one-way door: clears _backgroundColor
// but doesn't tear down the synthetic source or filter the synthetic
// show. PR 2c.3.C closes that gap. This test pins the contract.
//
// Device-free: instantiating XGISMap requires a full WebGPU + canvas
// context which is heavy. Instead we source-grep the map.ts text for
// the contract obligations and structurally assert each one is present.
// Pattern mirrors opaque-pass-clear-value.test.ts (Phase 2 PR 2c.3.B)
// and the renderer-stub-construction tests.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const MAP_SRC = readFileSync(resolve(__dirname, '..', '..', '..', 'map', 'src', 'map.ts'), 'utf8')

// Extract the setBackgroundFill method body so assertions don't false-
// positive on unrelated references elsewhere in map.ts.
function extractSetBackgroundFillBody(): string {
  const m = MAP_SRC.match(/setBackgroundFill\([^)]+\):\s*void\s*\{([\s\S]*?)\n {2}\}/)
  if (!m) throw new Error('setBackgroundFill method not found in map.ts')
  return m[1]!
}

const SET_BG_BODY = extractSetBackgroundFillBody()

// Isolate the null branch — the teardown contract lives entirely in
// the `if (rgba === null) { ... }` block.
function extractNullBranch(body: string): string {
  const m = body.match(/if \(rgba === null\) \{([\s\S]*?)return\s*\n\s*\}/)
  if (!m) throw new Error('null branch of setBackgroundFill not found')
  return m[1]!
}

const NULL_BRANCH = extractNullBranch(SET_BG_BODY)

describe('AC2c.3.C — setBackgroundFill(null) lifecycle teardown', () => {
  it('calls teardownSource(SYNTHETIC_EARTH_SURFACE_SOURCE) when backend installed', () => {
    expect(NULL_BRANCH).toMatch(/this\.teardownSource\(SYNTHETIC_EARTH_SURFACE_SOURCE\)/)
  })

  it('deletes synthetic entry from rawDatasets to mirror install-side seeding', () => {
    expect(NULL_BRANCH).toMatch(/this\.rawDatasets\.delete\(SYNTHETIC_EARTH_SURFACE_SOURCE\)/)
  })

  it('nulls the _syntheticBackend field so future install can re-create', () => {
    expect(NULL_BRANCH).toMatch(/this\._syntheticBackend\s*=\s*null/)
  })

  it('filters the synthetic ShowCommand out of showCommands', () => {
    expect(NULL_BRANCH).toMatch(/this\.showCommands\.findIndex/)
    expect(NULL_BRANCH).toMatch(/s\.targetName === SYNTHETIC_EARTH_SURFACE_SOURCE/)
    expect(NULL_BRANCH).toMatch(/this\.showCommands\.splice\(synthIdx, 1\)/)
  })

  it('invalidates the resolveShow cache for the removed synthetic show', () => {
    // The cache holds (ShowCommand → ResolvedShow) by reference; without
    // explicit invalidation a future reinstall could find a stale entry.
    expect(NULL_BRANCH).toMatch(/invalidateResolvedShowCache\(this\.showCommands\[synthIdx\]!\)/)
  })

  it('clears _backgroundColor and invalidates the next frame', () => {
    expect(NULL_BRANCH).toMatch(/this\._backgroundColor\s*=\s*null/)
    expect(NULL_BRANCH).toMatch(/this\.invalidate\(\)/)
  })

  it('teardown is guarded so calling setBackgroundFill(null) twice is idempotent', () => {
    // The teardownSource + rawDatasets.delete + show splice are each
    // idempotent on their own (delete-of-absent = no-op, findIndex
    // returns -1 when absent), but the _syntheticBackend null check
    // skips the redundant teardownSource call. Confirm the guard.
    expect(NULL_BRANCH).toMatch(/if \(this\._syntheticBackend\)\s*\{[\s\S]*?this\.teardownSource/)
  })

  it('non-null branch still validates RGBA finiteness (regression guard)', () => {
    // Non-null path must still reject malformed input.
    expect(SET_BG_BODY).toMatch(/Number\.isFinite/)
    expect(SET_BG_BODY).toMatch(/setBackgroundFill: rejected non-finite/)
  })

  it('non-null path re-installs the synthetic source when backend was torn down (round-trip)', () => {
    // install → null → install must re-create the synthetic source.
    // The non-null branch guards on `!this._syntheticBackend && this.renderer`
    // to call _installSyntheticEarthSurfaceSource + prepend the show.
    expect(SET_BG_BODY).toMatch(
      /if \(!this\._syntheticBackend && this\.renderer\)\s*\{[\s\S]*?this\._installSyntheticEarthSurfaceSource/,
    )
    // #777 I-E pivot: the re-installed show carries the style's background-
    // pattern through the round-trip (third arg) — pin the carrier, not the
    // old two-arg shape.
    expect(SET_BG_BODY).toMatch(
      /buildSyntheticEarthSurfaceShow\(rgba, null, this\._backgroundPattern\)/,
    )
    expect(SET_BG_BODY).toMatch(/this\.showCommands\s*=\s*\[syntheticShow,/)
  })
})
