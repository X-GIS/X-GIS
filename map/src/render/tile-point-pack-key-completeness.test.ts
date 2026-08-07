// ═══ The tile-point pack key must cover everything the pack it guards depends on (#1616) ═══
//
// `#1581` leg B made `emitTilePointsRhi` skip its accumulation + repack — and with
// it the per-frame `getTileData` RE-READ — whenever `TilePointPackKey` compares
// equal to the key the current GPU buffers were built from. That turns the key into
// a correctness contract: any input `flushTilePointsRhi` bakes into those buffers
// and the key does NOT carry is an input whose change draws the STALE pack, with no
// error and no upper bound on how long it persists.
//
// Three such inputs shipped uncovered. Each test below is the discriminating case
// for one of them, and each FAILS on the pre-fix key (the field simply did not
// exist, so the two keys compared equal and `canSkipTilePointRepack` returned true):
//
//   1. tile CONTENT replaced under an already-selected key — `stableKeysHash`
//      answers WHICH tiles, never what they hold, and `indexGeneration` counts
//      index entries, which only grow. Both are identical across a re-tile.
//   2. the visible Mercator world-copy set — BAKED into the buffer (`totalN =
//      N * COPIES.length`) but derived by unprojecting the canvas corners, so it
//      moves with pan / bearing / canvas size / DPR. The key carried only
//      zoom + pitch.
//   3. `circleStrokeOpacityShape` — declared on the key's own input type, read at
//      flush time into `stroke_a` AND into the opaque/translucent pipeline
//      `variant`, but never compared.
//
// The CONTROL in each case is the same key built twice: it must compare EQUAL, or
// the field would be "discriminating" only by breaking the memo outright, and the
// assertion would pass for the wrong reason (#996).

import { describe, it, expect } from 'vitest'
import {
  buildTilePointPackKey,
  hashStableKeys,
  tilePointPackKeyEqual,
  worldCopyMaskOf,
  type TilePointShow,
} from './tile-point-pack-key'

const SHOW: TilePointShow = { fill: '#ff8800', stroke: null, size: 6, opacity: 1 }
const KEYS = [11, 22, 33]
const COPY_0 = 0b00100 // offset 0 only — the single-copy case

/** The key as built by `emitTilePointsRhi`, with every varying input defaulted. */
function key(over: { content?: number; copies?: number; show?: TilePointShow } = {}) {
  return buildTilePointPackKey(
    hashStableKeys(KEYS),
    'layer',
    over.show ?? SHOW,
    4, // zoom
    0, // pitch
    over.content ?? 0,
    over.copies ?? COPY_0,
  )
}

describe('TilePointPackKey covers the pack it guards (#1616)', () => {
  it('CONTROL — the same inputs build a key that compares EQUAL', () => {
    // Without this, every assertion below could pass because the key never
    // matches anything, which would defeat the memo rather than fix it.
    expect(tilePointPackKeyEqual(key(), key())).toBe(true)
  })

  it('1 — a tile REPLACED under an already-selected key invalidates the pack', () => {
    // The whole selected set is unchanged: same keys, same hash, same everything
    // the pre-fix key carried. Only the content generation moved.
    const before = key({ content: 7 })
    const after = key({ content: 8 })
    expect(before.stableKeysHash, 'the selected key set is identical').toBe(after.stableKeysHash)
    expect(
      tilePointPackKeyEqual(before, after),
      'a re-tiled key must repack: the cache-hit path skips the getTileData re-read ' +
        'that used to pick a replacement up for free, so a stale pack would redraw the ' +
        'superseded points indefinitely',
    ).toBe(false)
  })

  it('2 — a changed visible world-copy set invalidates the pack', () => {
    // Pan/resize at a fixed zoom+pitch: the copy set widens from {0} to {-1,0,1}
    // while every pre-fix field stays put. `totalN` is baked per copy, so reusing
    // the old pack drops the newly-exposed copies' points entirely.
    const before = key({ copies: COPY_0 })
    const after = key({ copies: worldCopyMaskOf([-1, 0, 1]) })
    expect(before.zoom, 'zoom unchanged').toBe(after.zoom)
    expect(before.pitch, 'pitch unchanged').toBe(after.pitch)
    expect(tilePointPackKeyEqual(before, after)).toBe(false)
  })

  it('3 — a changed circleStrokeOpacityShape invalidates the pack', () => {
    // Not just a wrong alpha: this shape also picks the opaque-vs-translucent
    // pipeline variant, so a stale one is the wrong blend/depth state.
    const shapeA = {
      kind: 'constant',
      value: 1,
    } as unknown as TilePointShow['circleStrokeOpacityShape']
    const shapeB = {
      kind: 'constant',
      value: 0.25,
    } as unknown as TilePointShow['circleStrokeOpacityShape']
    const before = key({ show: { ...SHOW, circleStrokeOpacityShape: shapeA } })
    const after = key({ show: { ...SHOW, circleStrokeOpacityShape: shapeB } })
    expect(tilePointPackKeyEqual(before, after)).toBe(false)
    // …and the SAME shape reference still hits, so this is a change-detector, not
    // a blanket "always miss when the field is set".
    expect(
      tilePointPackKeyEqual(
        key({ show: { ...SHOW, circleStrokeOpacityShape: shapeA } }),
        key({ show: { ...SHOW, circleStrokeOpacityShape: shapeA } }),
      ),
    ).toBe(true)
  })
})

describe('worldCopyMaskOf encodes the copy set exactly (#1616)', () => {
  it('distinguishes every set the copy walker can return', () => {
    // computeVisibleWorldCopies clamps offsets to -2..+2, so 5 bits hold the set
    // losslessly. Distinctness is the property that matters: two different visible
    // sets must never collide onto one mask, or the key silently stops guarding.
    const sets = [[0], [-1, 0], [0, 1], [-1, 0, 1], [-2, -1, 0, 1, 2], [-2, 0, 2]]
    const masks = sets.map(worldCopyMaskOf)
    expect(new Set(masks).size, 'every distinct copy set gets a distinct mask').toBe(sets.length)
  })

  it('is order-independent and ignores out-of-range offsets', () => {
    expect(worldCopyMaskOf([1, -1, 0])).toBe(worldCopyMaskOf([-1, 0, 1]))
    // Defensive: an offset outside the clamp cannot shift a bit into another
    // copy's slot (1 << negative / 1 << huge are both nonsense in JS).
    expect(worldCopyMaskOf([0, 99, -99])).toBe(COPY_0)
  })
})
