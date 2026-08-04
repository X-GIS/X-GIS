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
// execute it would pin the mock rather than the code. What must not regress is
// the ORDER — acquisition above the bails — so that is what is asserted, with
// the #996 guards proving the anchors are all still present.

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
  const iAcquire = body.indexOf('this.resetUploadFrameCap()')
  const iFillBail = body.indexOf('if (!fill) return')
  const iAlphaBail = body.indexOf('if (fillA <= 0.005) return')

  it('every anchor is still present (not vacuous — #996)', () => {
    expect(iStableKeys, 'stableKeys assignment').toBeGreaterThan(-1)
    expect(iAcquire, 'the acquisition (resetUploadFrameCap)').toBeGreaterThan(-1)
    expect(iFillBail, 'the fill-null bail').toBeGreaterThan(-1)
    expect(iAlphaBail, 'the alpha bail').toBeGreaterThan(-1)
    expect(body).toContain('this.source.requestTiles(toLoad)')
  })

  it('acquisition and stableKeys both precede BOTH paint bails', () => {
    const firstBail = Math.min(iFillBail, iAlphaBail)
    expect(
      iAcquire,
      'the tile acquisition sits BELOW a paint bail again: a label-only or points-only show ' +
        'returns before requesting its tiles and then draws nothing, silently (#1046 Inc-F2b)',
    ).toBeLessThan(firstBail)
    expect(iStableKeys, 'stableKeys must stay above the bails too').toBeLessThan(firstBail)
  })

  it('the bails return the miss count they earned, never a bare 0', () => {
    // `return 0` past the acquisition would drop those misses from the keep-warm
    // signal — the half-loaded-freeze class (#834 M5 slice 5).
    expect(body.slice(iAcquire)).not.toMatch(/if \(!fill\) return 0\b/)
    expect(body.slice(iAcquire)).not.toMatch(/if \(fillA <= 0\.005\) return 0\b/)
    expect(body).toContain('if (!fill) return missing')
    expect(body).toContain('if (fillA <= 0.005) return missing')
  })
})
