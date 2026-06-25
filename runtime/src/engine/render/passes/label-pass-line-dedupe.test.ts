import { describe, it, expect } from 'vitest'
import type { TextValue } from '@xgis/compiler'
import { lineLabelDeduped, lineLabelDedupeKey } from './label-pass'

// Audit P — OFM one-way road ARROWS (`road_oneway`: icon-image, NO text-field)
// rendered far too infrequently vs MapLibre (~1 arrow for the whole layer on
// screen). ROOT: the along-line cross-tile dedupe keys on the RESOLVED TEXT;
// a text-less arrow resolves to '' for every spacing stop, so the first stop
// records '' and `isTooCloseToSameText('')` then suppresses every later
// dispatchIcon across the whole show. The dedupe is correct for NAMED roads
// (each name a distinct key) but must not collapse the shared '' key.
//
// `lineLabelDeduped` is the extracted predicate; the fix is `'' → never
// deduped`. fail-before: drop the `if (resolvedText === '') return false`
// guard and the empty-key cases below flip (has('') === true), collapsing
// the count test to 1.
describe('lineLabelDeduped — empty (icon-only) keys never dedupe', () => {
  it('empty text is NEVER a duplicate, even once recorded (one-way arrows)', () => {
    const emitted = new Set<string>([''])
    // fail-before: emitted.has('') === true → the second+ arrow is suppressed.
    expect(lineLabelDeduped('', emitted)).toBe(false)
  })

  it('a named road still collapses across tile boundaries (dedupe preserved)', () => {
    expect(lineLabelDeduped('Main St', new Set())).toBe(false) // first stamp places
    expect(lineLabelDeduped('Main St', new Set(['Main St']))).toBe(true) // later stamps drop
  })

  it('distinct names are independent (no cross-name suppression)', () => {
    expect(lineLabelDeduped('A Ave', new Set(['B Blvd']))).toBe(false)
  })

  // Structural teeth: mirror the along-line placement loop
  // (label-pass.ts:852-872) — record only on placement, exactly like
  // recordTextPosition inside the `!isTooClose` block.
  const countPlaced = (total: number, spacing: number, key: string): number => {
    const emitted = new Set<string>()
    let placed = 0
    let nextStop = spacing * 0.5
    while (nextStop <= total) {
      if (!lineLabelDeduped(key, emitted)) { placed++; emitted.add(key) }
      nextStop += spacing
    }
    return placed
  }

  it('places one arrow per spacing stop for a text-less line (was 1 for whole show)', () => {
    // L=1000px, S=75px → stops at 37.5,112.5,… ≤1000 = ⌊(1000−37.5)/75⌋+1 = 13.
    // fail-before (no empty bypass): the shared '' key collapses this to 1.
    expect(countPlaced(1000, 75, '')).toBe(13)
  })

  it('still collapses a NAMED line to a single label (dedupe intact)', () => {
    expect(countPlaced(1000, 75, 'Main St')).toBe(1)
  })
})

// #605 — route-number SHIELDS (text+icon line symbols, OFM highway-shield-*)
// over-duplicated ~6× along a road at z19 vs MapLibre ~1×. ROOT: the cross-tile
// dedupe keyed on the road `name`, but a national route (ref="82") overlays many
// DIFFERENTLY-NAMED OSM road segments (some carry a street `name`, some only
// `ref`). At z19 the route fills the screen across several tiles, so each
// distinct `name` passed the name-dedupe independently and stamped its own "82"
// shield — once per distinct segment name. The shield's DRAWN text is the route
// `ref`, which is identical on every segment, so keying the dedupe on the
// resolved text (lineLabelDedupeKey with pairedWithIcon=true) collapses the
// whole route to one shield — MapLibre's per-route cadence.
//
// fail-before: with the old `name`-preferring key the shield count below is the
// number of DISTINCT segment names (4), not 1. The interstate / plain-name /
// icon-only checks pin that the fix doesn't regress those.
describe('#605 — line-shield dedupe keys on the route ref, not the road name', () => {
  // A shield text-field is `["to-string", ["get", "ref"]]`; `["get","ref"]`
  // is an Identifier read of props.ref in the evaluator (evaluator.ts:40).
  const shieldText: TextValue = { kind: 'expr', expr: { ast: { kind: 'Identifier', name: 'ref' } as never } }
  // A plain road-NAME label resolves the `name` prop the same way.
  const nameText: TextValue = { kind: 'expr', expr: { ast: { kind: 'Identifier', name: 'name' } as never } }

  // One route sliced into N tile polylines. In OSM transportation_name a route
  // alternates between segments that carry a street `name` and segments that
  // carry only `ref`. Each entry is one polyline's feature props.
  const route82Segments: ReadonlyArray<Record<string, unknown>> = [
    { ref: '82', name: '남부순환로' },
    { ref: '82' },               // ref-only segment
    { ref: '82', name: '강남대로' },
    { ref: '82' },               // ref-only segment
    { ref: '82', name: '테헤란로' },
    { ref: '82' },               // ref-only segment
  ]

  // Mirror the curved-walk dedupe across MULTIPLE polylines of one show: the
  // emitted-key Set persists across polylines (label-pass.ts clears it once per
  // show, before forEachLineLabelPolyline), and each polyline places at most one
  // stop for its key (later same-key stops on the same polyline are suppressed).
  const countShieldsForRoute = (
    pairedWithIcon: boolean,
    text: TextValue,
    segments: ReadonlyArray<Record<string, unknown>>,
  ): number => {
    const emitted = new Set<string>()
    let placed = 0
    for (const props of segments) {
      const key = lineLabelDedupeKey(pairedWithIcon, text, props, 19)
      if (!lineLabelDeduped(key, emitted)) { placed++; emitted.add(key) }
    }
    return placed
  }

  it('a route shield collapses to ONE across heterogeneous-name segments (was 4)', () => {
    // fail-before (name-keyed): distinct keys = {남부순환로, 82, 강남대로, 테헤란로}
    // → 4 shields for one route. Ref-keyed: every segment → "82" → 1.
    expect(countShieldsForRoute(true, shieldText, route82Segments)).toBe(1)
  })

  it('the dedupe key for a shield is the REF, not the road name', () => {
    // The discriminating assertion: the segment carries BOTH a name and a ref;
    // a shield must key on the ref (drawn glyph), the old code keyed on name.
    expect(lineLabelDedupeKey(true, shieldText, { ref: '82', name: '강남대로' }, 19)).toBe('82')
  })

  it('two DISTINCT route refs still place independently (interstate I-10 vs I-45 unaffected)', () => {
    const i10 = [{ ref: '10', name: 'Katy Fwy' }, { ref: '10' }]
    const i45 = [{ ref: '45', name: 'Gulf Fwy' }, { ref: '45' }]
    expect(countShieldsForRoute(true, shieldText, [...i10, ...i45])).toBe(2)
  })

  it('a plain road-NAME label still keys on `name` (bilingual cross-segment stability preserved)', () => {
    // No paired icon → name-preferring path. Even if the bilingual text-field
    // would resolve differently per segment, the raw `name` keeps the dedupe
    // stable across segments. Here all carry name "Broadway" → 1.
    const nameSegments = [{ name: 'Broadway', ref: 'X' }, { name: 'Broadway' }, { name: 'Broadway', ref: 'Y' }]
    expect(countShieldsForRoute(false, nameText, nameSegments)).toBe(1)
    // And the chosen key IS the name (not the resolved ref), proving the
    // pairedWithIcon=false branch is unchanged.
    expect(lineLabelDedupeKey(false, nameText, { name: 'Broadway', ref: 'X' }, 19)).toBe('Broadway')
  })

  it('falls back name → name_en → resolved text for plain labels with no `name`', () => {
    expect(lineLabelDedupeKey(false, nameText, { name_en: 'Main', name: 42 }, 19)).toBe('Main')
    // No name / name_en → resolved text (here the `name` Identifier reads 42 → "42").
    expect(lineLabelDedupeKey(false, nameText, { name: 42 }, 19)).toBe('42')
  })
})
