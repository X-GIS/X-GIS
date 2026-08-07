// ═══ A classified show acquires its tiles even when it paints nothing (#1046 Inc-F2c) ═══
//
// The classifier applies NO paint filter — `classifyVectorTileShows` skips only
// no-data / invisible / out-of-zoom / composed-opacity<0.005 — so a show with no
// fill is still classified, still dispatched, and still expected to have its
// tiles. Two consumers depend on that and neither draws a fill: the label
// dispatch reads the selection's frameTileCache, and `emitTilePointsRhi` reads
// the `stableKeys` this same call records.
//
// `renderFillsRhi` used to acquire BELOW its paint bails while recording
// stableKeys ABOVE them, so on the RHI arm a label-only or points-only show
// returned before requesting a single tile — and drew NOTHING, with no error
// (#1046 Inc-F2b: the chain dispatched zero icons where the twin dispatched
// "shield"). The sibling WebGPU `render()` has no paint bail at all, which is
// how the arms diverged.
//
// This is a SOURCE gate rather than a driver: `renderFillsRhi` needs a real
// device, source, layer cache and camera to run, and a stub deep enough to
// execute it would pin the mock rather than the code.
//
// WHAT IT ASSERTS, and why it is not the obvious thing. A plain "acquisition
// sits above the bails" ordering check is NOT enough, and the first version of
// this file was exactly that — it anchored on `resetUploadFrameCap()` (a
// NEIGHBOUR of the acquisition, not the acquisition) and checked `requestTiles`
// for existence only. Two mutations reintroduced the defect and it passed 3/3
// both times: moving the acquisition block below the bails while leaving
// `resetUploadFrameCap()` in place, and inserting a NEW paint bail above the
// acquisition. Both are the shape the ledger names "the assertion that failed
// either way" (2026-07-28).
//
// So the property asserted here is the stronger one the code actually needs:
// EVERY `return` above the acquisition is one of the two documented DATA bails
// (no source / no selection, each paired with the #1057 `stableKeys = []`
// reset). A paint bail — existing or newly added — cannot satisfy that, and an
// acquisition that slides downward puts the paint bails into the prefix and
// breaks the count. Anchors are the acquisition ITSELF (the neededKeys loop and
// the `requestTiles` dispatch), never a neighbour.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'vector-tile-renderer.ts'),
  'utf8',
)

/** The `renderFillsRhi` body, from its signature to the next method. */
function fillsRhiBody(): string {
  const at = SRC.indexOf('  renderFillsRhi(')
  expect(at, 'renderFillsRhi still exists').toBeGreaterThan(-1)
  const end = SRC.indexOf('\n  renderLinesRhi(', at)
  expect(end, 'renderLinesRhi still follows it').toBeGreaterThan(at)
  return SRC.slice(at, end)
}

describe('renderFillsRhi acquires before it asks what the show paints (#1046 Inc-F2c)', () => {
  const body = fillsRhiBody()
  const iStableKeys = body.indexOf('this.stableKeys =')
  // The acquisition ITSELF — the walk over neededKeys and the batched request it
  // dispatches. Deliberately NOT `resetUploadFrameCap()`: that call merely sits
  // adjacent to the acquisition, so anchoring on it let the whole acquisition
  // block move below the bails with the gate still green (see the header).
  const iAcqLoop = body.indexOf('for (const key of neededKeys)')
  const iRequest = body.indexOf('this.source.requestTiles(toLoad)')
  // #1583 wrapped this bail in a block (it now also reports the fill-gap
  // warning), so the anchor is the block opener, not `if (!fill) return`.
  const iFillBail = body.indexOf('if (!fill) {')
  const iAlphaBail = body.indexOf('if (fillA <= 0.005) return')

  it('every anchor is still present (not vacuous — #996)', () => {
    expect(iStableKeys, 'stableKeys assignment').toBeGreaterThan(-1)
    expect(iAcqLoop, 'the acquisition walk over neededKeys').toBeGreaterThan(-1)
    expect(iRequest, 'the batched requestTiles dispatch').toBeGreaterThan(-1)
    expect(iFillBail, 'the fill-null bail').toBeGreaterThan(-1)
    expect(iAlphaBail, 'the alpha bail').toBeGreaterThan(-1)
    expect(body, 'the per-frame upload cap release').toContain('this.resetUploadFrameCap()')
  })

  it('the acquisition and stableKeys both precede BOTH paint bails', () => {
    const firstBail = Math.min(iFillBail, iAlphaBail)
    expect(
      iAcqLoop,
      'the tile acquisition sits BELOW a paint bail again: a label-only or points-only show ' +
        'returns before requesting its tiles and then draws nothing, silently (#1046 Inc-F2b)',
    ).toBeLessThan(firstBail)
    expect(iRequest, 'the request dispatch must clear the bails too').toBeLessThan(firstBail)
    expect(
      iRequest,
      'the request dispatch belongs after the walk that fills toLoad',
    ).toBeGreaterThan(iAcqLoop)
    expect(iStableKeys, 'stableKeys must stay above the bails too').toBeLessThan(firstBail)
  })

  it('the ONLY returns above the acquisition are the two documented data bails', () => {
    // The load-bearing assertion. Ordering alone is satisfiable by a regression
    // (proven: two separate mutations passed the ordering-only version), because
    // a NEW early return can be added above the acquisition without moving
    // anything. What makes a show paintless-but-tile-needing is precisely that it
    // survives to the acquisition, so nothing may return before it except the two
    // bails that mean "there is no data to acquire": no source/index, and no
    // selection. Both are paired with the #1057 `stableKeys = []` stale-key reset,
    // which is what distinguishes them from a paint bail.
    const prefix = body.slice(0, iAcqLoop)
    const returns = prefix.match(/\breturn\b/g) ?? []
    expect(
      returns.length,
      'a return was added above the tile acquisition. Only the no-source and no-selection ' +
        'DATA bails may return there — a show that reaches this method with a selection must ' +
        'acquire its tiles whether or not it paints a fill (#1046 Inc-F2b/F2c).',
    ).toBe(2)
    // …and they are the documented pair, not two paint bails that happen to count.
    expect(prefix).toContain('if (!this.source?.hasData() || !this.source.getIndex()) {')
    expect(prefix).toContain('if (!sel) {')
    expect(prefix.match(/this\.stableKeys = \[\]/g) ?? [], '#1057 stale-key resets').toHaveLength(2)
  })

  it('the bails return the miss count they earned, never a bare 0', () => {
    // `return 0` past the acquisition would drop those misses from the keep-warm
    // signal — the half-loaded-freeze class (#834 M5 slice 5).
    const fillBailEnd = body.indexOf('\n    }', iFillBail)
    expect(fillBailEnd, 'the fill-null bail block must close').toBeGreaterThan(iFillBail)
    const fillBailBlock = body.slice(iFillBail, fillBailEnd)
    // #1583 — reportRhiFillGap always returns 0 (the draw count for a fill it
    // did not draw); that 0 must not leak out as this bail's OWN return value.
    expect(fillBailBlock, 'the fill-null bail must not return a bare 0').not.toMatch(/\breturn 0\b/)
    expect(fillBailBlock, 'the fill-null bail must return the miss count').toContain(
      'return missing',
    )
    expect(body.slice(iAcqLoop)).not.toMatch(/if \(fillA <= 0\.005\) return 0\b/)
    expect(body).toContain('if (fillA <= 0.005) return missing')
  })
})
