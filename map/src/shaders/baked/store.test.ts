// ═══ The baked-source store — the three fall-through outcomes are the whole point (#1679) ═══
//
// `store.ts` has no readers yet (increment 3 adds the seam), so there is no render to
// judge it by and no downstream gate that would notice it lying. What it MUST get right
// is the accounting, because increment 3 onward asserts `misses === 0` on it:
//
//   * a lookup for an id the installed artifact does not carry is a BUG (#996: a call
//     site keyed to a string the bake never wrote — silent, permanent, and correct on
//     screen, because a miss just runs the thunk);
//   * a lookup for a family nothing installed is EXPECTED, at every increment before the
//     last, and must not read as that bug;
//   * a body flip is EXPECTED too, and must not turn a page of would-be hits into a page
//     of bug reports — and it must RE-OPEN when the body returns, which is the whole
//     reason the guard is asked per lookup instead of snapshotted at install.
//
// Each of those is its own arm below, and each is written to fail for a DIFFERENT reason:
// the miss arm and the absent arm drive THE SAME id and differ only in what is installed,
// so a store that collapsed the two counters onto one cannot pass both.
//
// The ids are built by `ids.ts` rather than typed as literals — a grammar change must
// move this spec's inputs with it, or the spec would be pinning strings nothing produces.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EARTH, MOON, configureBody, type Body } from '@xgis/shared'
import { configureBodyConsts } from '../../body-consts'
import { _resetBakedBodyGuardMemo, liveBodyConsts } from './body-guard'
import {
  LINE_FRAGMENT,
  LINE_FRAGMENT_PATTERN,
  lineGlslId,
  polygonGlslFragmentId,
  simpleWgslId,
} from './ids'
import {
  bakedSeamEmitted,
  bakedSeamServed,
  bakedSource,
  bakedStoreStats,
  installBakedSources,
  mergeBakedSources,
  _resetBakedStore,
} from './store'
import type { BakedArtifact, BakedMeta } from './registry'

const FILL = polygonGlslFragmentId(false, 'fs_fill')
const STROKE = polygonGlslFragmentId(false, 'fs_stroke')
const LINE = lineGlslId(true, LINE_FRAGMENT_PATTERN)
const LINE_PLAIN = lineGlslId(true, LINE_FRAGMENT)
const TEXT = simpleWgslId('text')

const switchBody = (body: Body): void => {
  configureBody(body)
  configureBodyConsts(body)
}

/** A meta the body guard OPENS on: the four live const values, read now. The
 *  fingerprint is not consulted by the guard (see `body-guard.ts`). */
const openMeta = (): BakedMeta => ({ ...liveBodyConsts(), projectionFingerprint: 'spec' })

/** A committed artifact in miniature — content-addressed the same way the generator
 *  writes it, so identical sources collapse onto one entry exactly as they do there. */
function artifactOf(sources: Readonly<Record<string, string>>, meta = openMeta()): BakedArtifact {
  const contents: Record<string, string> = {}
  const index: Record<string, string> = {}
  for (const [id, source] of Object.entries(sources)) {
    let hash = Object.keys(contents).find((h) => contents[h] === source)
    if (hash === undefined) {
      hash = `c${Object.keys(contents).length}`
      contents[hash] = source
    }
    index[id] = hash
  }
  return { meta, contents, index }
}

beforeEach(() => {
  _resetBakedStore()
  _resetBakedBodyGuardMemo()
})

afterEach(() => {
  switchBody(EARTH)
  _resetBakedBodyGuardMemo()
  _resetBakedStore()
})

describe('baked source store — install and serve (#1679)', () => {
  it('an installed id is served, and the lookup is counted as a hit', () => {
    installBakedSources(artifactOf({ [FILL]: 'FILL BYTES' }))
    expect(bakedSource(FILL)).toBe('FILL BYTES')
    expect(bakedStoreStats()).toMatchObject({
      ids: 1,
      coverage: 1,
      hits: 1,
      misses: 0,
      absent: 0,
      closed: 0,
    })
    expect(bakedSeamServed()).toEqual([FILL])
    expect(bakedSeamEmitted()).toEqual([])
  })

  it('merge adds a second artifact; install REPLACES the store', () => {
    installBakedSources(artifactOf({ [FILL]: 'FILL BYTES' }))
    mergeBakedSources(artifactOf({ [TEXT]: 'TEXT BYTES' }))
    expect(bakedSource(FILL)).toBe('FILL BYTES')
    expect(bakedSource(TEXT)).toBe('TEXT BYTES')
    expect(bakedStoreStats()).toMatchObject({ ids: 2, coverage: 2, hits: 2 })

    installBakedSources(artifactOf({ [TEXT]: 'TEXT BYTES' }))
    expect(bakedSource(TEXT), 'the re-installed artifact still serves').toBe('TEXT BYTES')
    expect(bakedSource(FILL), 'install dropped the previous artifact').toBeUndefined()
    expect(
      bakedStoreStats(),
      'install resets the accounting too — the counters describe THIS install',
    ).toMatchObject({ ids: 1, coverage: 1, hits: 1, absent: 1, misses: 0 })
  })
})

describe('baked source store — the three fall-through outcomes (#1679)', () => {
  it('an unknown id in an INSTALLED family is a MISS, not an absent', () => {
    // polygon is installed and carries fs_fill; a call site keyed to fs_stroke is the
    // #996 case — the bake never wrote that string, and only this counter can say so.
    installBakedSources(artifactOf({ [FILL]: 'FILL BYTES' }))
    expect(bakedSource(STROKE)).toBeUndefined()
    expect(bakedStoreStats()).toMatchObject({ misses: 1, absent: 0, closed: 0, hits: 0 })
    expect(bakedSeamEmitted(), 'the counter says a bug happened; the set says WHICH').toEqual([
      STROKE,
    ])
  })

  it('an id whose family is NOT installed is an ABSENT, not a miss', () => {
    installBakedSources(artifactOf({ [FILL]: 'FILL BYTES' }))
    expect(bakedSource(LINE)).toBeUndefined()
    expect(bakedStoreStats()).toMatchObject({ absent: 1, misses: 0, closed: 0 })

    // The verdict must be a function of COVERAGE, not of the id: install the line family
    // (a DIFFERENT line id) and the very same lookup becomes a miss. Without this the
    // arm above would pass on a store that answered `absent` to everything.
    mergeBakedSources(artifactOf({ [LINE_PLAIN]: 'LINE BYTES' }))
    expect(bakedSource(LINE)).toBeUndefined()
    expect(bakedStoreStats()).toMatchObject({ absent: 1, misses: 1 })
  })

  it('a dangling content hash reads as a MISS — a truncated bake is a bug, not an absent', () => {
    const broken: BakedArtifact = { meta: openMeta(), contents: {}, index: { [FILL]: 'gone' } }
    installBakedSources(broken)
    expect(bakedSource(FILL)).toBeUndefined()
    expect(bakedStoreStats()).toMatchObject({ ids: 0, coverage: 1, misses: 1, absent: 0 })
  })

  it('a body flip CLOSES every lookup — and it RE-OPENS when the body returns', () => {
    installBakedSources(artifactOf({ [FILL]: 'FILL BYTES' }))
    expect(bakedSource(FILL), 'on Earth the Earth bake serves').toBe('FILL BYTES')

    switchBody(MOON)
    expect(bakedSource(FILL), 'the bake embeds Earth radii as literals').toBeUndefined()
    // A would-be MISS is reported closed too: a flip must not manufacture bug reports out
    // of lookups whose only problem is the planet.
    expect(bakedSource(STROKE)).toBeUndefined()
    expect(bakedStoreStats()).toMatchObject({ closed: 2, misses: 0, absent: 0, hits: 1 })

    // The graft over an install-time snapshot. No memo reset here on purpose — the guard
    // must re-derive on its own (the epoch moved), or a returning body would find the
    // bake closed for the rest of the process.
    switchBody(EARTH)
    expect(bakedSource(FILL), 'the body returned; so must the bake').toBe('FILL BYTES')
    expect(bakedStoreStats()).toMatchObject({ hits: 2, closed: 2, misses: 0 })
  })
})

describe('baked source store — the named sets and the reset (#1679)', () => {
  it('served and emitted name the right ids', () => {
    installBakedSources(artifactOf({ [FILL]: 'FILL BYTES' }))
    bakedSource(FILL) // hit
    bakedSource(STROKE) // miss  — polygon is installed
    bakedSource(TEXT) // absent — nothing installed text
    expect(bakedSeamServed()).toEqual([FILL])
    expect(bakedSeamEmitted()).toEqual([STROKE, TEXT].sort())
    expect(bakedStoreStats()).toMatchObject({ hits: 1, misses: 1, absent: 1 })
  })

  it('_resetBakedStore clears the sources AND the accounting', () => {
    installBakedSources(artifactOf({ [FILL]: 'FILL BYTES' }))
    bakedSource(FILL)
    bakedSource(TEXT)

    _resetBakedStore()
    expect(bakedStoreStats()).toMatchObject({
      ids: 0,
      coverage: 0,
      hits: 0,
      misses: 0,
      absent: 0,
      closed: 0,
    })
    expect(bakedSeamServed()).toEqual([])
    expect(bakedSeamEmitted()).toEqual([])
    expect(bakedSource(FILL), 'nothing is installed any more').toBeUndefined()
    expect(bakedStoreStats()).toMatchObject({ absent: 1 })
  })
})
