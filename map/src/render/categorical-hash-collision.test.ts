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
// The fixture is a streamed-source shape on purpose: 30 OSM-flavoured POI class
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

/** 30 distinct POI class names — a streamed vector source's `class` field.
 *  Under `stableCategoryId(v) % CAT_PALETTE_SIZE` exactly one pair collides
 *  (`monument` + `stadium`), which the first assertion below re-derives rather
 *  than trusting this comment. */
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
  it('30 streamed values land in 29 slots — the collision is real', () => {
    const packed = packPerTileFeatureData(props('class', POI_CLASSES), ['class'], {})
    expect(packed).not.toBeNull()
    const slots = [...packed!.data].map(slot)
    expect(slots).toHaveLength(POI_CLASSES.length)
    expect(new Set(slots).size, `slots ${slots.join(',')}`).toBe(POI_CLASSES.length - 1)
    expect(slot(stableCategoryId('monument'))).toBe(slot(stableCategoryId('stadium')))
  })

  // FAIL-BEFORE, half one: the count-keyed #2428 detector is blind here. Pinned
  // rather than merely stated, because a "fix" that only lowered that threshold
  // would satisfy the subject arm below while still reporting on a count instead
  // of on the collisions that are actually present.
  it('the count-keyed palette-wrap warning says NOTHING about these 30 values', () => {
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
    expect(msgs[0]).toContain('monument + stadium')
    expect(msgs[0]).toContain(`slot ${slot(stableCategoryId('monument'))}`)
    expect(msgs[0]).toContain('2 of 30')
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
  // ITS list, so the packer never hashes and there is nothing to collide. The
  // latch is the instrument: `packPerTileFeatureData` warns through the module
  // default sink, so what is observable is whether it TOOK the latch. A direct
  // call afterwards that still speaks proves it did not — i.e. production stayed
  // silent on the same 30 values that make the hashed path warn.
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
})
