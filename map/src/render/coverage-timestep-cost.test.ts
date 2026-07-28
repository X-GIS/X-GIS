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
//
// The arms moved from map.ts to coverage-source.ts when the mosaic went multi-region (#1272
// E-④) — map.ts is shrink-only and the residency logic outgrew it. Same invariants, and the
// epoch guard gained a REGION: concurrent neighbour loads must not cancel each other.

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, '..', 'coverage-source.ts'), 'utf8')
const MAP_SRC = readFileSync(join(HERE, '..', 'map.ts'), 'utf8')
/** SRC with comments blanked — a gate that greps for a forbidden CALL must not fire on the
 *  prose explaining why the call is forbidden. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

/** The body of one top-level function, from its signature to the next top-level declaration. */
function fnBody(signature: string): string {
  const start = SRC.indexOf(signature)
  expect(start, `${signature} not found — renamed? repoint this gate`).toBeGreaterThan(-1)
  const rest = SRC.slice(start + signature.length)
  const end = rest.search(/\n(?:\/\*\*|export |function |async function )/)
  expect(end, `could not find the end of ${signature}`).toBeGreaterThan(-1)
  return rest.slice(0, end)
}

const push = () => fnBody('export async function pushCoverageRegion(')
const stepOne = () => fnBody('async function stepOneRegion(')

describe('forecast-hour step cost (#1367)', () => {
  it('THE FIX: a data swap re-derives the COVERAGE arm, not the whole scene', () => {
    // `rebuildLayers()` clears and re-adds every vector-tile show, every direct layer, the
    // point/heatmap renderers, the raster + hillshade URL templates, the layer-id registry and
    // every XGISLayer wrapper — to re-derive one coverage's field. `armFields` is that same
    // coverage arm with none of the rest, and it already served `setCoverageFrame`.
    expect(push()).toContain('armRegion(')
    expect(CODE, 'the coverage arm must not rebuild the scene').not.toContain('rebuildLayers')
    // …and the map-side method must be a pure delegation, so nothing can creep back in beside it.
    expect(MAP_SRC).toContain(
      'return pushCoverageRegion(this._coverageDeps, sourceId, bytes, opts)',
    )
  })

  it('...and so does a time step', () => {
    expect(stepOne()).toContain('armRegion(')
    expect(MAP_SRC).toContain(
      'return stepCoverageRegions(this._coverageDeps, sourceId, indexOrISO)',
    )
  })

  it('THE GUARD: a superseded data swap cannot arm — dragging the slider is N pushes', () => {
    // Without it, every push the user already dragged past still ran its full arm, AND they
    // landed in COMPLETION order: a slow decode arming after a newer one leaves the map showing
    // the wrong forecast hour. The claim is not just "a token exists" — it must be claimed
    // BEFORE the await and checked AFTER, or it proves nothing.
    const body = push()
    const claim = body.indexOf('deps.time.nextEpoch(region)')
    const awaitRead = body.indexOf('await readCoverage(')
    const check = body.indexOf('deps.time.isCurrent(token, region)')
    expect(claim, 'no epoch claimed').toBeGreaterThan(-1)
    expect(awaitRead, 'no decode await — repoint this gate').toBeGreaterThan(-1)
    expect(check, 'no epoch check').toBeGreaterThan(-1)
    expect(claim, 'the epoch must be claimed BEFORE the decode').toBeLessThan(awaitRead)
    expect(check, 'the epoch must be checked AFTER the decode').toBeGreaterThan(awaitRead)
    // ...and the check must actually bail, not merely log.
    expect(body.slice(check, check + 120)).toMatch(/isCurrent\(token, region\)\)\s*return/)
  })

  it('the guard is checked before ANY state is mutated', () => {
    // Arming is not the only observable: the region write is what `getCoverage()` returns, so a
    // superseded push writing it would leave the reported hour disagreeing with the drawn one.
    const body = push()
    expect(body.indexOf('deps.time.isCurrent(token, region)')).toBeLessThan(
      body.indexOf('writeRegion('),
    )
  })

  it('the two swap paths share ONE epoch counter, so either supersedes the other', () => {
    // A region swap (pan) and a time step both change the displayed frame. On separate counters
    // a pan landing after a time step would silently revert the hour.
    expect(push()).toContain('deps.time.nextEpoch(region)')
    expect(stepOne()).toContain('deps.time.nextEpoch(region)')
  })

  it('THE MOSAIC GUARD: the epoch is claimed PER REGION, never globally (#1272 E-④)', () => {
    // A single global counter made each newly-loading region supersede every other region's
    // in-flight decode, so a mosaic collapsed to whichever domain happened to start last —
    // indistinguishable from the selection logic being wrong. Every claim and every check must
    // name the region.
    const epochCalls = [...CODE.matchAll(/\.(nextEpoch|isCurrent)\(([^)]*)\)/g)]
    expect(epochCalls.length, 'no epoch calls found — repoint this gate').toBeGreaterThan(0)
    for (const call of epochCalls) {
      expect(call[2], `${call[0]} must be region-scoped`).toMatch(/\bregion\b/)
    }
  })

  it('a region write never rebuilds from a PRE-AWAIT snapshot (concurrent siblings)', () => {
    // Regions load and step concurrently. Copying a Map captured before the await and writing it
    // back would silently discard whatever a sibling region committed in the meantime — the
    // mosaic would keep losing a random neighbour under load.
    const body = fnBody('function writeRegion(')
    expect(body, 'writeRegion must re-read rawDatasets at call time').toContain(
      'deps.rawDatasets.get(sourceId)',
    )
  })
})
