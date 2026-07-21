import { describe, it, expect } from 'vitest'
import { greedyPlaceBboxes } from '@xgis/map'

const bbox = (minX: number, minY: number, maxX: number, maxY: number) => ({
  minX,
  minY,
  maxX,
  maxY,
})

const placedFlags = (results: ReturnType<typeof greedyPlaceBboxes>) => results.map((r) => r.placed)

describe('greedyPlaceBboxes', () => {
  it('places a single label', () => {
    expect(placedFlags(greedyPlaceBboxes([{ bboxes: [bbox(0, 0, 10, 10)] }]))).toEqual([true])
  })

  it('places two non-overlapping labels', () => {
    expect(
      placedFlags(
        greedyPlaceBboxes([{ bboxes: [bbox(0, 0, 10, 10)] }, { bboxes: [bbox(20, 0, 30, 10)] }]),
      ),
    ).toEqual([true, true])
  })

  it('drops the second label when bboxes overlap', () => {
    expect(
      placedFlags(
        greedyPlaceBboxes([{ bboxes: [bbox(0, 0, 10, 10)] }, { bboxes: [bbox(5, 5, 15, 15)] }]),
      ),
    ).toEqual([true, false])
  })

  it('input order decides the winner', () => {
    expect(
      placedFlags(
        greedyPlaceBboxes([{ bboxes: [bbox(5, 5, 15, 15)] }, { bboxes: [bbox(0, 0, 10, 10)] }]),
      ),
    ).toEqual([true, false])
  })

  it('allowOverlap places the label even when overlapping', () => {
    expect(
      placedFlags(
        greedyPlaceBboxes([
          { bboxes: [bbox(0, 0, 10, 10)] },
          { bboxes: [bbox(5, 5, 15, 15)], allowOverlap: true },
        ]),
      ),
    ).toEqual([true, true])
  })

  it('allowOverlap-placed label still blocks later labels by default', () => {
    expect(
      placedFlags(
        greedyPlaceBboxes([
          { bboxes: [bbox(0, 0, 10, 10)] },
          { bboxes: [bbox(5, 5, 15, 15)], allowOverlap: true },
          { bboxes: [bbox(8, 8, 12, 12)] },
        ]),
      ),
    ).toEqual([true, true, false])
  })

  it('ignorePlacement does not block subsequent labels', () => {
    expect(
      placedFlags(
        greedyPlaceBboxes([
          { bboxes: [bbox(0, 0, 10, 10)], ignorePlacement: true },
          { bboxes: [bbox(5, 5, 15, 15)] },
        ]),
      ),
    ).toEqual([true, true])
  })

  it('allowOverlap + ignorePlacement: always visible, never blocks', () => {
    expect(
      placedFlags(
        greedyPlaceBboxes([
          { bboxes: [bbox(0, 0, 10, 10)] },
          { bboxes: [bbox(5, 5, 15, 15)], allowOverlap: true, ignorePlacement: true },
          { bboxes: [bbox(20, 20, 30, 30)] },
          { bboxes: [bbox(7, 7, 14, 14)] },
        ]),
      ),
    ).toEqual([true, true, true, false])
  })

  it('touching edges count as non-overlap (open intervals)', () => {
    expect(
      placedFlags(
        greedyPlaceBboxes([{ bboxes: [bbox(0, 0, 10, 10)] }, { bboxes: [bbox(10, 0, 20, 10)] }]),
      ),
    ).toEqual([true, true])
  })

  it('empty input returns empty array', () => {
    expect(greedyPlaceBboxes([])).toEqual([])
  })

  it('many overlapping labels — only the first survives', () => {
    const items = Array.from({ length: 5 }, (_, i) => ({
      bboxes: [bbox(i, i, i + 8, i + 8)],
    }))
    expect(placedFlags(greedyPlaceBboxes(items))).toEqual([true, false, false, false, false])
  })

  describe('variable anchor candidates', () => {
    it('falls back to second candidate when first collides', () => {
      // Label A occupies (0, 0, 10, 10). Label B's primary bbox
      // overlaps A but its second candidate is clear; greedy picks
      // the second.
      const r = greedyPlaceBboxes([
        { bboxes: [bbox(0, 0, 10, 10)] },
        { bboxes: [bbox(5, 5, 15, 15), bbox(20, 0, 30, 10)] },
      ])
      expect(r[0]).toEqual({ placed: true, chosen: 0 })
      expect(r[1]).toEqual({ placed: true, chosen: 1 })
    })

    it('drops when ALL candidates collide', () => {
      const r = greedyPlaceBboxes([
        { bboxes: [bbox(0, 0, 100, 100)] },
        { bboxes: [bbox(10, 10, 20, 20), bbox(30, 30, 40, 40)] },
      ])
      expect(r[1]).toEqual({ placed: false, chosen: -1 })
    })

    it('candidate order is priority order (first non-collide wins, not best)', () => {
      // Even if a later candidate would be "more central", greedy
      // takes the first that fits.
      const r = greedyPlaceBboxes([
        { bboxes: [bbox(0, 0, 5, 5)] },
        { bboxes: [bbox(10, 0, 15, 5), bbox(20, 0, 25, 5)] },
      ])
      expect(r[1]).toEqual({ placed: true, chosen: 0 })
    })
  })

  describe('Mapbox / MapLibre layer-order semantic (reverse-iterate)', () => {
    // The text-stage's prepare() reverses the collision input order so
    // that later layers (country) win over earlier layers (water_name)
    // when bboxes overlap. This pins the algorithmic pattern.

    it('reverse-iteration: later overlapping item wins, earlier drops', () => {
      // Two overlapping labels — item 0 is "water" (earlier in style),
      // item 1 is "country" (later in style). Both compete for the
      // same screen real-estate.
      const items = [
        { bboxes: [bbox(0, 0, 10, 10)] },
        { bboxes: [bbox(5, 5, 15, 15)] }, // overlaps item 0
      ]
      // Forward order (legacy first-wins): item 0 placed, item 1 drops.
      const fwd = greedyPlaceBboxes(items)
      expect(fwd[0].placed).toBe(true)
      expect(fwd[1].placed).toBe(false)
      // Reversed input: item 1 placed first (= country wins), item 0
      // (water) drops. The text-stage maps the placements back to
      // original indices before submitting to the renderer.
      const reversed = [items[1], items[0]]
      const rev = greedyPlaceBboxes(reversed)
      expect(rev[0].placed).toBe(true) // country
      expect(rev[1].placed).toBe(false) // water
    })

    it('non-overlapping labels are unaffected by iteration order', () => {
      const items = [{ bboxes: [bbox(0, 0, 10, 10)] }, { bboxes: [bbox(100, 100, 110, 110)] }]
      expect(placedFlags(greedyPlaceBboxes(items))).toEqual([true, true])
      expect(placedFlags(greedyPlaceBboxes([items[1], items[0]]))).toEqual([true, true])
    })
  })

  // ── symbol-sort-key (Mapbox priority-aware collision) ──
  describe('sortKey iteration order', () => {
    it('lower sortKey wins collision against higher sortKey', () => {
      // Input order: state(sortKey=10), shield(sortKey=1).
      // Without sortKey: state would win (first in input order).
      // With sortKey: shield (key=1) wins, state (key=10) drops.
      // Output index follows ORIGINAL input order.
      const results = greedyPlaceBboxes([
        { bboxes: [bbox(0, 0, 10, 10)], sortKey: 10 },
        { bboxes: [bbox(5, 5, 15, 15)], sortKey: 1 },
      ])
      expect(results[0]!.placed).toBe(false) // state (key=10) dropped
      expect(results[1]!.placed).toBe(true) // shield (key=1) won
    })

    it('higher sortKey label drops when colliding with lower-key earlier in input', () => {
      const results = greedyPlaceBboxes([
        { bboxes: [bbox(5, 5, 15, 15)], sortKey: 1 }, // shield
        { bboxes: [bbox(0, 0, 10, 10)], sortKey: 10 }, // state
      ])
      expect(results[0]!.placed).toBe(true)
      expect(results[1]!.placed).toBe(false)
    })

    it('equal sortKey keeps stable (input) order', () => {
      const results = greedyPlaceBboxes([
        { bboxes: [bbox(0, 0, 10, 10)], sortKey: 5 },
        { bboxes: [bbox(5, 5, 15, 15)], sortKey: 5 },
      ])
      // Item 0 first by stable sort, blocks item 1.
      expect(results[0]!.placed).toBe(true)
      expect(results[1]!.placed).toBe(false)
    })

    it('no sortKey on any item → legacy behaviour (byte-identical)', () => {
      const items = [{ bboxes: [bbox(0, 0, 10, 10)] }, { bboxes: [bbox(5, 5, 15, 15)] }]
      // Same expectation as the legacy "drops the second" test.
      expect(placedFlags(greedyPlaceBboxes(items))).toEqual([true, false])
    })

    it('mixed: sortKey items prioritised, undefined items treated as 0', () => {
      const results = greedyPlaceBboxes([
        { bboxes: [bbox(0, 0, 10, 10)], sortKey: 10 }, // dropped
        { bboxes: [bbox(5, 5, 15, 15)] }, // sortKey=0, wins
      ])
      expect(results[1]!.placed).toBe(true)
      expect(results[0]!.placed).toBe(false)
    })
  })

  // ── #728 stable tieBreak (deterministic collision identity) ──
  // The survivor of two overlapping labels must be a function of a STABLE
  // per-feature identity, NOT input (tile-dispatch) order. fail-before: on
  // pre-#728 code `tieBreak` is ignored, so first-in-input wins and the
  // survivor flips when the same set is fed in a different order.
  describe('#728 stable tieBreak', () => {
    it('survivor is identical under any input order (the lower tieBreak wins)', () => {
      const A = { bboxes: [bbox(0, 0, 10, 10)], tieBreak: 'id-A' }
      const B = { bboxes: [bbox(5, 5, 15, 15)], tieBreak: 'id-B' } // overlaps A
      const forward = greedyPlaceBboxes([A, B])
      expect(forward[0]!.placed).toBe(true) // A (lower id) wins
      expect(forward[1]!.placed).toBe(false)
      // A is now index 1, yet still wins — winner independent of order.
      const reversed = greedyPlaceBboxes([B, A])
      expect(reversed[1]!.placed).toBe(true) // A
      expect(reversed[0]!.placed).toBe(false) // B
    })

    it('permutation-invariant survivor set (frame_stability pan gate)', () => {
      // Two overlapping pairs. In EVERY permutation the survivors are the
      // lower-tieBreak of each pair — the property that keeps a pan across a
      // tile boundary from swapping which label survives.
      const items = [
        { bboxes: [bbox(0, 0, 10, 10)], tieBreak: 'b' },
        { bboxes: [bbox(5, 5, 15, 15)], tieBreak: 'a' }, // overlaps 'b' → 'a' wins
        { bboxes: [bbox(100, 100, 110, 110)], tieBreak: 'c' },
        { bboxes: [bbox(102, 102, 112, 112)], tieBreak: 'd' }, // overlaps 'c' → 'c' wins
      ]
      const survivors = (arr: typeof items): Set<string> => {
        const r = greedyPlaceBboxes(arr)
        return new Set(arr.filter((_, i) => r[i]!.placed).map((it) => it.tieBreak))
      }
      const expected = new Set(['a', 'c'])
      expect(survivors(items)).toEqual(expected)
      const perms: (typeof items)[] = [
        [items[3]!, items[2]!, items[1]!, items[0]!],
        [items[1]!, items[3]!, items[0]!, items[2]!],
        [items[2]!, items[0]!, items[3]!, items[1]!],
      ]
      for (const p of perms) expect(survivors(p)).toEqual(expected)
    })

    it('sortKey dominates tieBreak (lower key wins even with a larger identity)', () => {
      const results = greedyPlaceBboxes([
        { bboxes: [bbox(0, 0, 10, 10)], sortKey: 10, tieBreak: 'a' }, // larger key → drops
        { bboxes: [bbox(5, 5, 15, 15)], sortKey: 1, tieBreak: 'z' }, // lower key → wins
      ])
      expect(results[0]!.placed).toBe(false)
      expect(results[1]!.placed).toBe(true)
    })

    it('items WITH a tieBreak place before items without at the same sortKey', () => {
      // Deterministic total order for mixed frames (tiled labels carry a
      // tieBreak, imperative overlays do not).
      const withId = greedyPlaceBboxes([
        { bboxes: [bbox(0, 0, 10, 10)] }, // no tieBreak
        { bboxes: [bbox(5, 5, 15, 15)], tieBreak: 'x' }, // overlaps → identified wins
      ])
      expect(withId[1]!.placed).toBe(true)
      expect(withId[0]!.placed).toBe(false)
    })
  })

  // ── nearY near-first (pitched-view occlusion direction) ──
  // Site report: at pitch 81° Shanghai (nearer the camera, lower on screen)
  // was dropped in favour of Seoul (farther, higher) because the #728
  // tieBreak is lexicographic ("Seoul…" < "Shanghai…") and depth-blind.
  // Mapbox/MapLibre place near-first (their symbol tile sort is rotated-Y
  // descending), so the FRONT label must win the overlap. `nearY` (anchor
  // screen Y, +Y down) breaks ties AFTER the tieBreak's group segment
  // (layer precedence) and BEFORE the full-identity compare.
  describe('nearY near-first (pitched occlusion direction)', () => {
    // Group segment '1' = same layer for both (labelCollisionId shape).
    const seoul = {
      bboxes: [bbox(500, 355, 560, 370)],
      tieBreak: '1\u0000Seoul|q',
      nearY: 362,
    }
    const shanghai = {
      bboxes: [bbox(510, 360, 580, 375)], // overlaps seoul
      tieBreak: '1\u0000Shanghai|q',
      nearY: 505,
    }

    it('within the same group the larger nearY (nearer) wins, not the lower identity', () => {
      const r = greedyPlaceBboxes([seoul, shanghai])
      expect(r[0]!.placed).toBe(false) // Seoul (far) dropped
      expect(r[1]!.placed).toBe(true) // Shanghai (near) wins
    })

    it('winner is input-order invariant (keeps the #728 permutation property)', () => {
      const r = greedyPlaceBboxes([shanghai, seoul])
      expect(r[0]!.placed).toBe(true) // Shanghai
      expect(r[1]!.placed).toBe(false) // Seoul
    })

    it('the group segment (layer precedence) outranks nearY', () => {
      // '1\u0000…' sorts before '2\u0000…' — the later layer (lower inv
      // rank) wins even though the earlier layer's label is nearer.
      const laterLayerFar = { bboxes: [bbox(0, 0, 10, 10)], tieBreak: '1\u0000far', nearY: 100 }
      const earlierLayerNear = {
        bboxes: [bbox(5, 5, 15, 15)],
        tieBreak: '2\u0000near',
        nearY: 900,
      }
      const r = greedyPlaceBboxes([earlierLayerNear, laterLayerFar])
      expect(r[0]!.placed).toBe(false)
      expect(r[1]!.placed).toBe(true)
    })

    it('sortKey outranks nearY', () => {
      const r = greedyPlaceBboxes([
        { bboxes: [bbox(0, 0, 10, 10)], sortKey: 1, tieBreak: '1\u0000far', nearY: 100 },
        { bboxes: [bbox(5, 5, 15, 15)], sortKey: 10, tieBreak: '1\u0000near', nearY: 900 },
      ])
      expect(r[0]!.placed).toBe(true)
      expect(r[1]!.placed).toBe(false)
    })

    it('equal nearY falls back to the stable identity', () => {
      const r = greedyPlaceBboxes([
        { bboxes: [bbox(0, 0, 10, 10)], tieBreak: '1\u0000b', nearY: 50 },
        { bboxes: [bbox(5, 5, 15, 15)], tieBreak: '1\u0000a', nearY: 50 },
      ])
      expect(r[0]!.placed).toBe(false)
      expect(r[1]!.placed).toBe(true) // 'a' < 'b'
    })

    it('nearY on only ONE item is ignored (identity decides, deterministic)', () => {
      const r = greedyPlaceBboxes([
        { bboxes: [bbox(0, 0, 10, 10)], tieBreak: '1\u0000a' },
        { bboxes: [bbox(5, 5, 15, 15)], tieBreak: '1\u0000b', nearY: 900 },
      ])
      expect(r[0]!.placed).toBe(true) // 'a' wins — no one-sided depth jump
      expect(r[1]!.placed).toBe(false)
    })

    it('without nearY the pass is byte-identical to the #728 ordering', () => {
      const r = greedyPlaceBboxes([
        { bboxes: [bbox(0, 0, 10, 10)], tieBreak: '1\u0000Seoul|q' },
        { bboxes: [bbox(5, 5, 15, 15)], tieBreak: '1\u0000Shanghai|q' },
      ])
      expect(r[0]!.placed).toBe(true) // lexicographic winner, as before
      expect(r[1]!.placed).toBe(false)
    })
  })
})
