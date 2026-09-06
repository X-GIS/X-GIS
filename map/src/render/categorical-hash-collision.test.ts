// #2579 — the `categorical()` palette diagnostic was keyed on the wrong bound.
//
// `stableCategoryId` is a hash and the shader lands it with
// `CAT_PALETTE[u32(field) % CAT_PALETTE_SIZE]`, so two distinct values share a
// colour on the BIRTHDAY bound: about even odds at 27 values, not at 512. The
// #2428 warning opens with `if (count <= CAT_PALETTE_SIZE) return`, which is the
// PIGEONHOLE bound — two orders of magnitude away. A field already painting
// duplicates therefore reported nothing, and a detector that reports zero reads
// as a clean corpus (CLAUDE.md §12).
//
// The fixture is a streamed-source shape on purpose: 36 OSM-flavoured POI class
// names, the kind an MVT/PMTiles vector source actually carries, and NOT a
// generated `cat-0…cat-N` run. A generated run makes the collision look like an
// artefact of the fixture; these names are what the bug looks like in the field.
//
// The palette is NOT widened here and the hash is NOT replaced: a streamed
// source's distinct set is never final, so the dense rank #2439 gives a seeded
// source is unavailable by construction (`categorical-dense-index.test.ts:11-17`
// records why) and ranking within a tile is the pre-#723 bug
// (`categorical-stable-id.test.ts` pins it). What changes is that the collision
// stops being silent.

import { describe, it, expect, beforeEach } from 'vitest'
import { CAT_PALETTE_SIZE } from '@xgis/compiler'
import { buildCategoryMap, packPerTileFeatureData, stableCategoryId } from './feature-data-pack'
import {
  warnCategoricalPaletteWrap,
  warnCategoricalSlotCollisions,
  resetCategoricalPaletteWrapWarnings,
} from './category-palette-wrap-warning'

/** 36 distinct POI class names — a streamed vector source's `class` field.
 *  Under `stableCategoryId(v) % CAT_PALETTE_SIZE` four slots collide, and the
 *  first assertion below re-derives that rather than trusting this comment.
 *
 *  FOUR, not one, and the tail six are ordered on purpose. One colliding slot
 *  cannot distinguish the message's cross-slot `.sort()` (a one-element list is
 *  invariant under every ordering) and leaves both the `.slice(0, 3)` cut and
 *  the `; and N more slot(s)` suffix unreachable — a mechanism no arm can see is
 *  a mechanism that can be deleted while everything stays green (CLAUDE.md §12).
 *  So: first-occurrence order of the colliding slots is 96, 484, 29, 68 while
 *  sorted order is 29, 68, 96, 484, and there are four of them so the third is
 *  the last named and the suffix reports one more. */
const POI_CLASSES = [
  'hostel',
  'motel',
  'camp_site',
  'picnic_site',
  'viewpoint',
  'attraction',
  'zoo',
  'aquarium',
  'stadium',
  'sports_centre',
  'swimming_pool',
  'golf_course',
  'marina',
  'pier',
  'airport',
  'heliport',
  'railway',
  'bus_station',
  'tram_stop',
  'subway',
  'ferry_terminal',
  'parking',
  'fuel',
  'car_wash',
  'church',
  'mosque',
  'synagogue',
  'temple',
  'shrine',
  'monument',
  // slot 484, first of the added colliding slots — before 29 and 68 in
  // first-occurrence order, after 96. That inversion is what the sort is for.
  'pub',
  'bakery', // slot 29
  'supermarket', // slot 68
  'wine_shop', // slot 29
  'ruins', // slot 68
  'bookshop', // slot 484
]

/** Values that genuinely do not collide — THE CONTROL's positive half. */
const DISTINCT_CLASSES = [
  'residential',
  'commercial',
  'industrial',
  'retail',
  'park',
  'water',
  'school',
]

/** The slot the shader indexes: `CAT_PALETTE[u32(feat_data) % N]`. */
const slot = (id: number): number => id % CAT_PALETTE_SIZE

/** One tile's worth of features, keyed by tile-local feature id. */
const props = (field: string, values: readonly string[]) =>
  new Map(values.map((v, i) => [i, { [field]: v } as Record<string, unknown>]))

describe('#2579 — a hashed categorical field collides on the birthday bound', () => {
  beforeEach(() => resetCategoricalPaletteWrapWarnings())

  // THE PREMISE, re-derived rather than asserted from the prose above. This is
  // NOT the thing being fixed — the collision stays, because the remedies that
  // remove it (a dense rank, a perfect hash) both need the complete distinct
  // set a streamed source never has. It is pinned so the arms below cannot go
  // vacuous the day the hash or the palette length changes: if this stops
  // holding, the fixture no longer expresses the case and says so here rather
  // than by quietly passing everything.
  it('36 streamed values land in 32 slots — four collisions, and their order is inverted', () => {
    const packed = packPerTileFeatureData(props('class', POI_CLASSES), ['class'], {})
    expect(packed).not.toBeNull()
    const slots = [...packed!.data].map(slot)
    expect(slots).toHaveLength(36)
    expect(new Set(slots).size, `slots ${slots.join(',')}`).toBe(32)
    for (const [a, b] of [
      ['monument', 'stadium'],
      ['bakery', 'wine_shop'],
      ['supermarket', 'ruins'],
      ['bookshop', 'pub'],
    ])
      expect(slot(stableCategoryId(a)), `${a} ~ ${b}`).toBe(slot(stableCategoryId(b)))
    // The premise the cross-slot sort is measured against: first occurrence
    // order is NOT slot order, so an unsorted message would differ from a
    // sorted one — which is what makes the determinism arm below load-bearing.
    const firstSeen: number[] = []
    for (const v of POI_CLASSES) {
      const sl = slot(stableCategoryId(v))
      if (!firstSeen.includes(sl)) firstSeen.push(sl)
    }
    const collidingInArrival = firstSeen.filter((sl) =>
      POI_CLASSES.filter((v) => slot(stableCategoryId(v)) === sl).length > 1,
    )
    expect(collidingInArrival).toEqual([96, 484, 29, 68])
    expect([...collidingInArrival].sort((a, b) => a - b)).toEqual([29, 68, 96, 484])
  })

  // FAIL-BEFORE, half one: the count-keyed #2428 detector is blind here. Pinned
  // rather than merely stated, because a "fix" that only lowered that threshold
  // would satisfy the subject arm below while still reporting on a count instead
  // of on the collisions that are actually present.
  it('the count-keyed palette-wrap warning says NOTHING about these 36 values', () => {
    const msgs: string[] = []
    warnCategoricalPaletteWrap('class', POI_CLASSES.length, (m) => msgs.push(m))
    expect(msgs).toEqual([])
    expect(POI_CLASSES.length).toBeLessThan(CAT_PALETTE_SIZE)
  })

  // FAIL-BEFORE, half two: the subject. Naming the PAIR is the point — the
  // remedy (`match()`) is written per value, so a bare count is not actionable.
  it('warns naming the colliding value pair and the slot they share', () => {
    const msgs: string[] = []
    warnCategoricalSlotCollisions('class', buildCategoryMap(POI_CLASSES), (m) => msgs.push(m))
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toContain('class')
    expect(msgs[0]).toContain('8 of the 36 distinct values in this pack')
    // Sorted by slot, and the fourth colliding slot is cut by `.slice(0, 3)` and
    // reported as a remainder instead. Asserting the whole named run rather than
    // three separate `toContain`s is what makes the ORDER part of the assertion.
    expect(msgs[0]).toContain(
      'bakery + wine_shop → slot 29; ruins + supermarket → slot 68; ' +
        'monument + stadium → slot 96; and 1 more slot.',
    )
    expect(msgs[0]).not.toContain('bookshop')
    expect(msgs[0]).toContain('packs per TILE')
  })

  it('the message is a pure function of the VALUE SET, not of feature order', () => {
    // A message built from Map insertion order would differ between two tiles
    // holding the same values in a different order — the arrival-order defect
    // #2439 rejected, reappearing in the diagnostic instead of in the ids.
    const forward: string[] = []
    const reverse: string[] = []
    warnCategoricalSlotCollisions('class', buildCategoryMap(POI_CLASSES), (m) => forward.push(m))
    resetCategoricalPaletteWrapWarnings()
    warnCategoricalSlotCollisions('class', buildCategoryMap([...POI_CLASSES].reverse()), (m) =>
      reverse.push(m),
    )
    expect(forward).toHaveLength(1)
    expect(reverse).toEqual(forward)
  })

  it('latches per field — a second call for the same field is silent', () => {
    const msgs: string[] = []
    const sink = (m: string) => msgs.push(m)
    const ids = buildCategoryMap(POI_CLASSES)
    warnCategoricalSlotCollisions('class', ids, sink)
    warnCategoricalSlotCollisions('class', ids, sink)
    expect(msgs).toHaveLength(1)
    warnCategoricalSlotCollisions('other', ids, sink)
    expect(msgs).toHaveLength(2)
  })
})

describe('#2579 — THE CONTROL: a detector that fired on every field would be worse', () => {
  beforeEach(() => resetCategoricalPaletteWrapWarnings())

  // Arm (a). Without it every assertion above is satisfied by a warner that
  // fires unconditionally, and an author whose 7-category style warns learns to
  // ignore the channel.
  it('says nothing about values that genuinely do NOT share a slot', () => {
    const msgs: string[] = []
    const ids = buildCategoryMap(DISTINCT_CLASSES)
    expect(new Set([...ids.values()].map(slot)).size).toBe(DISTINCT_CLASSES.length)
    warnCategoricalSlotCollisions('class', ids, (m) => msgs.push(m))
    expect(msgs).toEqual([])
  })

  it('says nothing about a single value, or about none', () => {
    const msgs: string[] = []
    warnCategoricalSlotCollisions('one', buildCategoryMap(['residential']), (m) => msgs.push(m))
    warnCategoricalSlotCollisions('none', buildCategoryMap([]), (m) => msgs.push(m))
    expect(msgs).toEqual([])
  })

  // Arm (b). A compile-time `match()` order numbers the shader's if-else arms by
  // ITS list, so the packer ranks instead of hashing and 36 authored values take
  // ranks 0…35, which cannot collide under `% 512`. The latch is the instrument:
  // `packPerTileFeatureData` warns through the module default sink, so what is
  // observable is whether it TOOK the latch. A direct call afterwards that still
  // speaks proves it did not — production stayed silent on the very values that
  // make the hashed path warn.
  //
  // WHAT THIS ARM DOES AND DOES NOT GATE, stated because the difference is easy
  // to overclaim: it gates the packer's compile-time PRECEDENCE
  // (`feature-data-pack.ts:182`'s `categoryOrder[fieldName] ??`) — cut that and
  // these values fall to the hash, collide, and this arm reds. It does NOT gate
  // whether the warner is reachable from the authored branch, because a dense
  // rank under 512 has nothing to report either way. The pigeonhole arm below is
  // where the authored branch's own warning is driven.
  it('says nothing when the field carries a compile-time match() order', () => {
    packPerTileFeatureData(props('class', POI_CLASSES), ['class'], { class: [...POI_CLASSES] })

    const after: string[] = []
    warnCategoricalSlotCollisions('class', buildCategoryMap(POI_CLASSES), (m) => after.push(m))
    expect(after).toHaveLength(1)
  })

  // …and the mirror of it, so the assertion above is not passing because the
  // latch probe is broken: the SAME values with no compile-time order do take
  // the latch, from inside `buildCategoryMap`.
  it('but the hashed path DOES take the latch, from the producer itself', () => {
    packPerTileFeatureData(props('class', POI_CLASSES), ['class'], {})

    const after: string[] = []
    warnCategoricalSlotCollisions('class', buildCategoryMap(POI_CLASSES), (m) => after.push(m))
    expect(after).toEqual([])
  })

  // The pigeonhole case, driven THROUGH the producer. `categorical-palette-wrap.
  // test.ts` had this arm before #2579, keyed on the count warner; the move gave
  // the hash path its own warner and retired that probe with it, and without
  // this one NO arm drives more than the palette's length of values through
  // `buildCategoryMap` any more. The instrument is the latch, as it was there:
  // the producer warns through the module default sink, so what is observable is
  // that a direct call afterwards has been suppressed.
  it('more values than the palette has slots still reports, from the producer', () => {
    const wide = Array.from({ length: CAT_PALETTE_SIZE + 3 }, (_, i) => `cat_${i}`)
    const map = buildCategoryMap(wide, 'wide')
    expect(map.size).toBe(CAT_PALETTE_SIZE + 3)

    // By pigeonhole this set MUST share slots, so the collision warner is the
    // one that speaks now — and it took the latch inside buildCategoryMap.
    const after: string[] = []
    warnCategoricalSlotCollisions('wide', map, (m) => after.push(m))
    expect(after).toEqual([])
  })
})
