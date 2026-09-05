// #2439 — a seeded source gets a DENSE `categorical()` index, so no two
// categories share a colour.
//
// The wrap had two independent causes and this file owns the second one. The
// palette being 20 entries is fixed in the compiler (`CAT_PALETTE_SIZE`); the
// INDEX being `stableCategoryId`'s 23-bit hash is fixed here. Only fixing the
// palette leaves a BIRTHDAY bound rather than a pigeonhole one — at N=512
// roughly 65 of `countries.geojson`'s 258 names would still collide — so the
// dense rank is what turns "fewer collisions" into "none".
//
// WHERE IT APPLIES, and why that is not a hedge. A dense rank needs the
// COMPLETE distinct set, and #723 needs that set to be identical for every
// tile. A source seeded from a whole FeatureCollection has one; a streamed
// MVT/PMTiles source never does, and ranking within a tile is precisely the
// pre-#723 bug (`categorical-stable-id.test.ts` pins it). So the hash stays
// where it is the only correct answer, and the last describe below asserts it
// stayed — a fix that quietly ranked per-tile would be worse than the bug.

import { describe, it, expect } from 'vitest'
import {
  deriveSeededCategoryOrder,
  packPerTileFeatureData,
  stableCategoryId,
} from './feature-data-pack'
import { CAT_PALETTE_SIZE } from '@xgis/compiler'

const feat = (name: string) => ({ properties: { name } })
const on = (field: string, value: string) => ({ properties: { [field]: value } })
const props = (...names: string[]) =>
  new Map(names.map((n, i) => [i, { name: n } as Record<string, unknown>]))

/** The slot the shader indexes: `CAT_PALETTE[u32(feat_data) % N]`. */
const slot = (id: number) => id % CAT_PALETTE_SIZE

describe('#2439 — deriveSeededCategoryOrder', () => {
  it('is sorted, so the assignment is a pure function of the VALUE SET', () => {
    // Not of feature order: #2439 rejected a first-seen-order registry because
    // its ids depend on arrival, which repaints across page loads and breaks
    // every hash-equality render gate.
    const a = deriveSeededCategoryOrder([feat('b'), feat('a'), feat('c')], ['name'])
    const b = deriveSeededCategoryOrder([feat('c'), feat('c'), feat('a'), feat('b')], ['name'])
    expect(a.name).toEqual(['a', 'b', 'c'])
    expect(b.name).toEqual(a.name)
  })

  it('leaves a field that already carries a compile-time match() order alone', () => {
    // The shader's if-else arms are NUMBERED by that list, so a data-derived
    // one would repaint every arm — the OFM Bright `landuse class` failure
    // mode feature-data-pack.ts documents.
    const out = deriveSeededCategoryOrder([feat('x'), feat('y')], ['name'], {
      name: ['cemetery', 'school'],
    })
    expect(out.name).toBeUndefined()
  })

  it('ignores non-string and missing values rather than inventing categories', () => {
    const fc = [{ properties: { name: 'a' } }, { properties: { name: 7 } }, { properties: {} }, {}]
    expect(deriveSeededCategoryOrder(fc, ['name']).name).toEqual(['a'])
    expect(deriveSeededCategoryOrder(fc, ['absent']).absent).toBeUndefined()
  })
})

describe('#2439 — the seeded path keeps the #2428 wrap diagnostic', () => {
  it('warns when the seeded distinct count exceeds the palette', () => {
    // Regression for a defect this change introduced and a render probe caught:
    // the warning lives in `buildCategoryMap`, which the seeded path does not
    // call, so a source with more categories than colours went silent — the
    // one case the diagnostic exists for.
    const msgs: string[] = []
    // `on(field, v)` and not `feat(v)`: the first draft built features carrying
    // a `name` property and asked about `overflowing_field`, so the walk found
    // nothing, warned nothing, and the test read that blindness as "the code
    // does not warn". A fixture that cannot express the positive case reports
    // zero either way (CLAUDE.md §12).
    const many = Array.from({ length: CAT_PALETTE_SIZE + 4 }, (_, i) =>
      on('overflowing_field', `v${i}`),
    )
    deriveSeededCategoryOrder(many, ['overflowing_field'], {}, (m) => msgs.push(m))
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toContain('overflowing_field')
    expect(msgs[0]).toContain(String(CAT_PALETTE_SIZE + 4))
  })

  it('stays quiet at exactly the palette size — the boundary, not one off it', () => {
    const msgs: string[] = []
    const exact = Array.from({ length: CAT_PALETTE_SIZE }, (_, i) => on('exact_field', `w${i}`))
    deriveSeededCategoryOrder(exact, ['exact_field'], {}, (m) => msgs.push(m))
    expect(msgs).toEqual([])
  })
})

describe('#2439 — the witness: 21 distinct values, no two share a colour', () => {
  // The issue's witness. Stated as PIGEONHOLE, which is what actually fails
  // today: 21 values into a 20-slot palette must collide somewhere — naming
  // the 1st and the 21st specifically would be a birthday claim, not a
  // certainty. Fail-before is therefore CAT_PALETTE_SIZE = 20 plus a hashed
  // index; both halves had to land for this to pass.
  const VALUES = Array.from({ length: 21 }, (_, i) => `cat_${String(i).padStart(2, '0')}`)

  it('every one of 21 seeded categories lands in its own palette slot', () => {
    const seeded = deriveSeededCategoryOrder(VALUES.map(feat), ['name'])
    const packed = packPerTileFeatureData(props(...VALUES), ['name'], {}, seeded)
    expect(packed).not.toBeNull()
    const slots = [...packed!.data].map(slot)
    expect(new Set(slots).size, `slots ${slots.join(',')}`).toBe(VALUES.length)
  })

  it('the ids are a DENSE RANK — 0..20, not scattered hashes', () => {
    // The assertion above is satisfied by any injective map; this one names the
    // mechanism, so a red run says which half broke. A hashed id would be some
    // value up to 2^23 here.
    const seeded = deriveSeededCategoryOrder(VALUES.map(feat), ['name'])
    const packed = packPerTileFeatureData(props(...VALUES), ['name'], {}, seeded)
    expect([...packed!.data].sort((a, b) => a - b)).toEqual(VALUES.map((_, i) => i))
  })

  it('CONTROL — with no seeded order the same values keep the hashed id', () => {
    // The fallback is not merely "still works": it must be the SAME hash, or a
    // streamed source silently repaints. Without this, a change that made the
    // dense path unconditional would pass every assertion above.
    const packed = packPerTileFeatureData(props(...VALUES), ['name'], {})
    expect([...packed!.data]).toEqual(VALUES.map(stableCategoryId))
  })
})

describe('#2439 — the seeded lists cannot outlive the data they came from', () => {
  // `setSourceData` has a reseed-IN-PLACE path (source-manager `_reseedInPlace`)
  // that swaps the backend and KEEPS the renderer. An earlier draft derived the
  // value lists once at attach time, so after such a swap the new features were
  // ranked against the OLD value set: every category shifted by however many
  // values entered or left, and any genuinely new value was appended past the
  // end. Wrong colours, silently — the exact failure mode #723 exists for.
  //
  // Testing it at the derive function is the honest altitude: the binder's job
  // is only to drop its memo and call this again, and THAT is asserted by
  // `feature-data-binder`'s own seeding path. What matters here is that the
  // function is a pure function of the features it is handed.
  it('re-deriving from replaced features yields the NEW ranks, not the old ones', () => {
    const first = deriveSeededCategoryOrder(['b', 'c'].map(feat), ['name'])
    const second = deriveSeededCategoryOrder(['a', 'b', 'c'].map(feat), ['name'])
    expect(first.name).toEqual(['b', 'c'])
    expect(second.name).toEqual(['a', 'b', 'c'])
    // 'b' was rank 0 against the old set and is rank 1 against the new one, so a
    // cached list really would repaint every feature. The bug is not hypothetical.
    expect(first.name!.indexOf('b')).not.toBe(second.name!.indexOf('b'))
  })
})

describe('#2439 — the dense rank keeps #723 subset independence', () => {
  it('a tile holding a SUBSET gives its values the same ids as a full tile', () => {
    // The whole reason the rank is derived from the seeded collection and not
    // from the tile: ranking within a tile is the pre-#723 bug, where a tile
    // carrying only `school` encoded school=0 and painted it in cemetery's
    // colour. The seeded list is the same object for every tile, so this holds
    // by construction — asserted anyway, because "by construction" is exactly
    // what stops being true when someone moves the derivation.
    const all = ['alpha', 'beta', 'gamma', 'delta']
    const seeded = deriveSeededCategoryOrder(all.map(feat), ['name'])
    const full = packPerTileFeatureData(props(...all), ['name'], {}, seeded)!
    const subset = packPerTileFeatureData(props('gamma'), ['name'], {}, seeded)!
    expect(subset.data[0]).toBe(full.data[all.indexOf('gamma')])
    // 3, not 2: the list is SORTED, so 'delta' precedes 'gamma'. Written as 2
    // first, from the declaration order — the failure is the sort proving it
    // is really a sort, which is the property the first describe asserts.
    expect(subset.data[0]).toBe(3)
  })

  it('a value absent from the seeded list is appended past the end, not aliased to 0', () => {
    // Matches the compile-time branch's contract: an unknown value must fall
    // OUTSIDE the authored range rather than colliding with the first category.
    const seeded = deriveSeededCategoryOrder([feat('a'), feat('b')], ['name'])
    const packed = packPerTileFeatureData(props('a', 'b', 'zzz'), ['name'], {}, seeded)!
    expect([...packed.data]).toEqual([0, 1, 2])
  })
})
