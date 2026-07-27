import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// What a forecast-hour step is allowed to cost (#1367).
//
// The reported symptom was the map freezing for a moment on every time change. The measured
// cause was not one slow function — it was the SHAPE of the step: a coverage data swap ran a
// full `rebuildLayers()`, and the forecast slider started one of those per input event. On a
// real 596×433 CBOFS cell the coverage arm alone measures ~73 ms of main-thread CPU (fill pack
// 4.6, flow u,v pack 16.9, arrow field 27.3, particle field 24.8), so re-deriving the ENTIRE
// scene on top of it, N times per drag, is multi-frame stall territory.
//
// These are STRUCTURAL gates rather than timing assertions: a wall-clock threshold in CI is a
// flake generator, and the defect is not "this function got 10% slower" — it is "this path calls
// the wrong thing". The source of the two arms is the authority, so that is what is pinned.

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'map.ts'), 'utf8')

/** The body of one method, from its signature to the next method at the same indent. */
function methodBody(signature: string): string {
  const start = SRC.indexOf(signature)
  expect(start, `${signature} not found — renamed? repoint this gate`).toBeGreaterThan(-1)
  const rest = SRC.slice(start + signature.length)
  const end = rest.search(/\n {2}(?:\/\*\*|[a-zA-Z_])/)
  expect(end, `could not find the end of ${signature}`).toBeGreaterThan(-1)
  return rest.slice(0, end)
}

const setCoverageData = () => methodBody('async setCoverageData(')
const setCoverageTime = () => methodBody('async setCoverageTime(')
const refreshCoverage = () => methodBody('async refreshCoverage(')
const rearmCoverage = () => methodBody('private _rearmCoverage(')

// REPOINTED (#1158 <- #1367): the arm this gate pins moved. `setCoverageData` and
// `setCoverageTime` each carried their own copy of the post-swap re-arm block; #1158
// extracted the copies into `_rearmCoverage`, and a third swap path (`refreshCoverage`)
// joined them. So the literal `_armCoverageFields(handle)` no longer sits in either method
// body — it sits once, in the shared authority.
//
// The INVARIANT is unchanged and is now checked in two halves: every swap path must route
// through the shared re-arm and must not rebuild the scene itself, and the shared re-arm
// must use the coverage arm rather than `rebuildLayers()`. That is what the gate's own
// `methodBody` message ("renamed? repoint this gate") anticipates. Following the code beats
// asserting a string that has moved — a gate whose anchor drifted is how a fix goes
// vacuously green (CLAUDE.md §12).

describe('forecast-hour step cost (#1367)', () => {
  it('THE FIX: the shared re-arm re-derives the COVERAGE arm, not the whole scene', () => {
    // `rebuildLayers()` clears and re-adds every vector-tile show, every direct layer, the
    // point/heatmap renderers, the raster + hillshade URL templates, the layer-id registry and
    // every XGISLayer wrapper — to re-derive one coverage's field. `_armCoverageFields` is that
    // same coverage arm with none of the rest, and it already served `setCoverageFrame`.
    expect(rearmCoverage()).toContain('_armCoverageFields(handle)')
    expect(rearmCoverage(), 'the re-arm must not rebuild the scene').not.toContain(
      'this.rebuildLayers()',
    )
  })

  it('every swap path routes through it — and none rebuilds the scene itself', () => {
    // Three paths share the re-arm; a fourth added later must join them rather than grow a
    // second copy, which is the duplication that let the two originals diverge.
    for (const [name, body] of [
      ['a data swap', setCoverageData()],
      ['a time step', setCoverageTime()],
      ['a live refresh', refreshCoverage()],
    ] as const) {
      expect(body, `${name} must route through the shared re-arm`).toContain('_rearmCoverage(')
      expect(body, `${name} must not rebuild the scene`).not.toContain('this.rebuildLayers()')
    }
  })

  it('THE GUARD: a superseded data swap cannot arm — dragging the slider is N pushes', () => {
    // Without it, every push the user already dragged past still ran its full arm, AND they
    // landed in COMPLETION order: a slow decode arming after a newer one leaves the map showing
    // the wrong forecast hour. The claim is not just "a token exists" — it must be claimed
    // BEFORE the await and checked AFTER, or it proves nothing.
    const body = setCoverageData()
    const claim = body.indexOf('this._coverageTime.nextEpoch()')
    const awaitRead = body.indexOf('await readCoverage(')
    const check = body.indexOf('this._coverageTime.isCurrent(token)')
    expect(claim, 'no epoch claimed').toBeGreaterThan(-1)
    expect(awaitRead, 'no decode await — repoint this gate').toBeGreaterThan(-1)
    expect(check, 'no epoch check').toBeGreaterThan(-1)
    expect(claim, 'the epoch must be claimed BEFORE the decode').toBeLessThan(awaitRead)
    expect(check, 'the epoch must be checked AFTER the decode').toBeGreaterThan(awaitRead)
    // ...and the check must actually bail, not merely log.
    expect(body.slice(check, check + 120)).toMatch(/isCurrent\(token\)\)\s*return/)
  })

  it('the guard is checked before ANY state is mutated', () => {
    // Arming is not the only observable: `rawDatasets.set` is what `getCoverage()` returns, so a
    // superseded push writing it would leave the reported hour disagreeing with the drawn one.
    const body = setCoverageData()
    expect(body.indexOf('this._coverageTime.isCurrent(token)')).toBeLessThan(
      body.indexOf('this.rawDatasets.set('),
    )
  })

  it('the two swap paths share ONE epoch counter, so either supersedes the other', () => {
    // A region swap (pan) and a time step both change the displayed frame. On separate counters
    // a pan landing after a time step would silently revert the hour.
    expect(setCoverageData()).toContain('this._coverageTime.nextEpoch()')
    expect(setCoverageTime()).toContain('this._coverageTime.nextEpoch()')
  })
})
