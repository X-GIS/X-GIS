// Phase-0 characterization pin for the prepare()-SIDE collision WIRING
// (text-stage.ts ~:1915-1968). greedyPlaceBboxes itself is well tested
// (text-collision.test.ts, line-label-collision.test.ts) but the
// wiring that drives it from prepare() was blind:
//   - the no-sortKey REVERSE-iteration layer-order trick + un-reverse
//     index mapping (:1934-1941) — an off-by-one here silently assigns
//     placements to the WRONG labels;
//   - the anySortKey forward-iteration branch select (:1929-1932);
//   - the droppedPairKeys stamping (:1951-1966) — getDroppedPairKeys
//     had ZERO test references before this file;
//   - wasLastPrepareFullyResolved() (:2024) S16 frame-control contract.
//
// Drives the REAL TextStage.prepare() with a stub GPU (same harness as
// bilingual-prepare-scatter.test.ts). Golden source = the documented
// precedence contract (:1884-1911) + greedy first-wins.
//
// Geometry: every label uses anchor 'left' with NO offset/translate, so
// drawX = anchorX and drawY = anchorY exactly (text-stage.ts:1468,
// :1514-1515). That lets each surviving draw be mapped back to its
// source label by draw.anchorX/anchorY — the key off-by-one detector.
// size 20, ASCII single-char text → bbox ≈ x[X-2, X+14], y[Y-14, Y+14].

import { describe, it, expect } from 'vitest'
import { TextStage } from '@xgis/map'
import { MockRasterizer } from '@xgis/map'
import { WebGpuDevice } from '@xgis/rhi-webgpu'
import type { LabelDef, TextValue } from '@xgis/compiler'
import type { TextDraw } from '@xgis/map'

const g = globalThis as Record<string, unknown>
g.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 }
g.GPUBufferUsage ??= {
  MAP_READ: 1,
  MAP_WRITE: 2,
  COPY_SRC: 4,
  COPY_DST: 8,
  INDEX: 16,
  VERTEX: 32,
  UNIFORM: 64,
  STORAGE: 128,
  INDIRECT: 256,
  QUERY_RESOLVE: 512,
}
g.GPUTextureUsage ??= {
  COPY_SRC: 1,
  COPY_DST: 2,
  TEXTURE_BINDING: 4,
  STORAGE_BINDING: 8,
  RENDER_ATTACHMENT: 16,
}
g.GPUColorWrite ??= { RED: 1, GREEN: 2, BLUE: 4, ALPHA: 8, ALL: 15 }

function stubDevice(): GPUDevice {
  const stub: unknown = new Proxy(
    function () {
      return stub
    },
    {
      get(_t, p) {
        if (p === 'size') return 1 << 22
        if (p === 'width' || p === 'height') return 4096
        if (p === 'limits') return { maxTextureDimension2D: 8192 }
        if (p === Symbol.toPrimitive) return () => 0
        return stub
      },
      apply() {
        return stub
      },
    },
  )
  return stub as GPUDevice
}

function litValue(s: string): TextValue {
  return { kind: 'expr', expr: { ast: { kind: 'StringLiteral', value: s } as never } }
}

/** Point-label def. anchor 'left' + no offset → drawX/Y == anchorX/Y. */
function pointDef(extra: Partial<LabelDef> = {}): LabelDef {
  return {
    text: litValue(''),
    size: 20,
    letterSpacing: 0,
    font: ['Noto Sans Bold'],
    anchor: 'left',
    ...extra,
  } as LabelDef
}

function makeStage(small = false) {
  const opts = small
    ? { rasterizer: new MockRasterizer(), slotSize: 32, pageSize: 128 } // 16 slots
    : { rasterizer: new MockRasterizer() }
  const stage = new TextStage(stubDevice(), new WebGpuDevice(stubDevice()), 'bgra8unorm', opts)
  const captured: TextDraw[][] = []
  ;(stage as unknown as { renderer: { setDraws(d: TextDraw[]): void } }).renderer.setDraws = (
    d: TextDraw[],
  ) => {
    captured.push(d)
  }
  return { stage, captured }
}

/** True when a draw sits at the given submitted anchor (anchor 'left',
 *  no offset → draw.anchorX/Y === submitted anchorX/Y). */
function atAnchor(d: TextDraw, x: number, y: number): boolean {
  return Math.abs(d.anchorX - x) < 1e-6 && Math.abs(d.anchorY - y) < 1e-6
}

/** A straight horizontal polyline [x0,x1] at constant y (screen px). */
function hLine(x0: number, x1: number, y: number): [Float32Array, Float32Array] {
  return [new Float32Array([x0, x1]), new Float32Array([y, y])]
}

/** Curved (tangent-rotated) line-label def — placement 'line'. */
function lineDef(extra: Partial<LabelDef> = {}): LabelDef {
  return {
    text: litValue(''),
    size: 20,
    letterSpacing: 0,
    font: ['Noto Sans Bold'],
    placement: 'line',
    ...extra,
  } as LabelDef
}

describe('prepare() collision wiring (text-stage.ts:1915-1968)', () => {
  it('no sortKey: later-submitted label wins overlap; un-reverse maps each placement to its OWN label', () => {
    // Three labels in submission (shaped) order: A(0), B(1), C(2).
    //   A @ (100,100), C @ (108,100) OVERLAP (bbox x ranges [98,114] /
    //     [106,122] share [106,114], y identical).
    //   B @ (500,500) is far — never collides.
    // No sortKey → reverse trick: greedy runs [C,B,A]; C places, B
    // places, A collides with C → dropped. Un-reversed:
    //   placements = [dropped(A), placed(B), placed(C)].
    // So the LATER of the overlapping pair (C) wins (layer-order), A
    // drops, and B (far) survives. An off-by-one in the un-reverse
    // index math would attach the placed flag to the wrong label →
    // either A's anchor appears or B/C drops.
    const { stage, captured } = makeStage()
    stage.beginFrame()
    stage.addLabel(litValue('A'), {}, 100, 100, pointDef()) // shaped 0
    stage.addLabel(litValue('B'), {}, 500, 500, pointDef()) // shaped 1
    stage.addLabel(litValue('C'), {}, 108, 100, pointDef()) // shaped 2
    stage.prepare()
    const draws = captured[0]!
    // Exactly two survivors: B (far) and C (later of the overlapping pair).
    expect(draws.length).toBe(2)
    expect(
      draws.some((d) => atAnchor(d, 500, 500)),
      'B (far) should survive',
    ).toBe(true)
    expect(
      draws.some((d) => atAnchor(d, 108, 100)),
      'C (later) should win the overlap',
    ).toBe(true)
    expect(
      draws.some((d) => atAnchor(d, 100, 100)),
      'A (earlier) must be dropped',
    ).toBe(false)
    // Draw order preserves shaped order (B at index 1 before C at index 2).
    const idxB = draws.findIndex((d) => atAnchor(d, 500, 500))
    const idxC = draws.findIndex((d) => atAnchor(d, 108, 100))
    expect(idxB).toBeLessThan(idxC)
  })

  it('anySortKey branch: lower sortKey wins regardless of submission order (forward iteration)', () => {
    // Q @ (100,100) sortKey 1 submitted FIRST; P @ (108,100) sortKey 5
    // submitted SECOND; they overlap. With ANY sortKey present the
    // wiring takes the forward (non-reversed) branch and greedy sorts
    // ascending → Q (key 1) places first, P (key 5) collides → dropped.
    // In the NO-sortKey path the LATER submission (P) would have won;
    // here the lower-key (Q, submitted first) wins → proves the branch.
    const { stage, captured } = makeStage()
    stage.beginFrame()
    stage.addLabel(litValue('Q'), {}, 100, 100, pointDef({ sortKey: 1 }))
    stage.addLabel(litValue('P'), {}, 108, 100, pointDef({ sortKey: 5 }))
    stage.prepare()
    const draws = captured[0]!
    expect(draws.length).toBe(1)
    expect(atAnchor(draws[0]!, 100, 100), 'lower-sortKey Q wins').toBe(true)
    expect(
      draws.some((d) => atAnchor(d, 108, 100)),
      'higher-sortKey P dropped',
    ).toBe(false)
  })

  it('droppedPairKeys: rejected label stamps its pairKey; placed label does not; cleared next prepare', () => {
    // Loser L @ (100,100) pairKey 'k' submitted FIRST (shaped 0).
    // Winner W @ (108,100) pairKey 'w' submitted SECOND (shaped 1).
    // Overlap, no sortKey → reverse trick: greedy [W,L] → W places,
    // L collides → dropped. Drop loop stamps L's pairKey 'k'.
    // pairKey is the 8th addLabel arg (value, props, x, y, def, fontKey,
    // layerName, pairKey) — NOT a LabelDef field.
    const { stage, captured } = makeStage()
    stage.beginFrame()
    stage.addLabel(litValue('L'), {}, 100, 100, pointDef(), undefined, undefined, 'k')
    stage.addLabel(litValue('W'), {}, 108, 100, pointDef(), undefined, undefined, 'w')
    stage.prepare()
    let draws = captured[0]!
    expect(draws.length).toBe(1)
    expect(atAnchor(draws[0]!, 108, 100), 'W (later) wins').toBe(true)
    const dropped = stage.getDroppedPairKeys()
    expect(dropped.has('k'), "loser L's pairKey stamped").toBe(true)
    expect(dropped.has('w'), "winner W's pairKey NOT stamped").toBe(false)
    expect(dropped.size).toBe(1)

    // Next prepare with a single non-colliding label → set re-cleared.
    stage.reset()
    stage.beginFrame()
    stage.addLabel(litValue('X'), {}, 200, 200, pointDef())
    stage.prepare()
    draws = captured[1]!
    expect(draws.length).toBe(1)
    expect(stage.getDroppedPairKeys().size, 'droppedPairKeys re-cleared each prepare').toBe(0)
  })

  it('droppedPairKeys: an EMPTY prepare() between two non-empty ones does not leak a stale pairKey (#2338)', () => {
    // WITNESS — fails before the #2338 hoist. IconStage holds this set BY
    // REFERENCE (label-pass.ts), so a stale key surviving an empty-frame
    // prepare() (style toggle / tile flush) would wrongly drop a later
    // icon whose freshly-minted, RECYCLED pairKey happens to equal it.
    const { stage, captured } = makeStage()
    stage.beginFrame()
    stage.addLabel(litValue('L'), {}, 100, 100, pointDef(), undefined, undefined, 'k')
    stage.addLabel(litValue('W'), {}, 108, 100, pointDef(), undefined, undefined, 'w')
    stage.prepare()
    expect(captured[0]!.length).toBe(1)
    expect(stage.getDroppedPairKeys().has('k'), "frame 1: loser L's pairKey stamped").toBe(true)

    // Frame 2: zero labels — the early-return branch. Must start from an
    // empty set per the getDroppedPairKeys() doc contract (:724-728),
    // not carry frame 1's 'k' forward.
    stage.reset()
    stage.beginFrame()
    stage.prepare()
    expect(
      stage.getDroppedPairKeys().size,
      'BUG: empty-frame prepare() must clear droppedPairKeys just like a non-empty one does',
    ).toBe(0)
  })

  it('droppedPairKeys: non-empty prepare() still clears+recomputes exactly as before the hoist (control)', () => {
    // CONTROL — proves the hoist left the always-worked case unchanged:
    // back-to-back non-empty frames must not leak frame 1's dropped key
    // into frame 2, even when frame 2 REUSES that same pairKey (the
    // sequence-counter recycling the issue describes) on a label that
    // this time does NOT collide.
    const { stage, captured } = makeStage()
    stage.beginFrame()
    stage.addLabel(litValue('L'), {}, 100, 100, pointDef(), undefined, undefined, 'k')
    stage.addLabel(litValue('W'), {}, 108, 100, pointDef(), undefined, undefined, 'w')
    stage.prepare()
    expect(captured[0]!.length).toBe(1)
    expect(stage.getDroppedPairKeys().has('k')).toBe(true)

    stage.reset()
    stage.beginFrame()
    stage.addLabel(litValue('M'), {}, 300, 300, pointDef(), undefined, undefined, 'k')
    stage.prepare()
    expect(captured[1]!.length).toBe(1)
    expect(
      stage.getDroppedPairKeys().has('k'),
      "frame 2's own 'k' was not collided this frame, so it must not be stamped",
    ).toBe(false)
    expect(stage.getDroppedPairKeys().size).toBe(0)
  })

  it('wasLastPrepareFullyResolved: true on empty + fully-resident prepare; false when glyphs withheld (overflow)', () => {
    const { stage } = makeStage()
    // Empty prepare → resolved true (nothing to resolve).
    stage.beginFrame()
    stage.prepare()
    expect(stage.wasLastPrepareFullyResolved()).toBe(true)
    // Fully-resident prepare (MockRasterizer always lands) → true.
    stage.reset()
    stage.beginFrame()
    stage.addLabel(litValue('A'), {}, 100, 100, pointDef())
    stage.prepare()
    expect(stage.wasLastPrepareFullyResolved()).toBe(true)

    // Tiny-atlas overflow: 16 slots, far more unique glyphs than fit.
    // hasAllGlyphs fails for the evicted labels → p.text='' drop →
    // fullyResolved=false (the S16 contract: an unresolved label this
    // frame must NOT freeze the label-pass skip).
    const small = makeStage(true)
    small.stage.setCameraZoom(11)
    small.stage.beginFrame()
    const words = [
      '서울특별',
      '부산광역',
      '인천대구',
      '광주울산',
      '대전세종',
      '평양원산',
      '청진함흥',
      '개성신의',
    ]
    words.forEach((w, i) => small.stage.addLabel(litValue(w), {}, 100 + i * 40, 100, pointDef()))
    small.stage.prepare()
    expect(
      small.stage.wasLastPrepareFullyResolved(),
      'overflow-dropped label leaves prepare not-fully-resolved',
    ).toBe(false)
  })
})

// #605 — cross-tile route-shield over-duplication. greedyPlaceBboxes has a
// same-line min-spacing gate (lineId + anchorDistancePx + minLineSpacingPx,
// unit-tested in line-label-collision.test.ts) but prepare() never WIRED it:
// addCurvedLineLabel didn't carry lineId/anchorDistancePx and prepare() called
// greedyPlaceBboxes without minLineSpacingPx. So a long route — sliced into a
// SEPARATE per-tile polyline by PMTiles — re-emitted the same shield once per
// tile (~4-6 on screen at z19) because each tile's bbox sits at a distinct
// screen position and the AABB pass alone can't collapse non-overlapping
// near-duplicates across tiles.
//
// These drive the REAL TextStage.prepare() via addCurvedLineLabel. Each tile's
// shield is on its OWN horizontal polyline at a DIFFERENT screen Y (so the bbox
// AABB pass never merges them — the cross-tile-seam geometry) but carries the
// SAME tile-stable lineId (the route ref) and an anchorDistancePx within the
// 250 px symbol-spacing window. WITH the wiring only one survives; WITHOUT it
// (no minLineSpacingPx / no lineId threaded) all of them place — the fail-before
// the cross-tile count this issue is about. dpr defaults to 1 → window 250 px.
describe('#605 cross-tile shield same-line screen-space cap (prepare wiring)', () => {
  // anchorDistancePx within the 250 px window must be passed for each
  // — this mirrors the label-pass passing nextStop along each tile polyline.
  const SAME_REF = 'roads_shield 82' // layer ref, the tile-stable lineId

  it('caps repeats of one route to ~1 across tiles (fail-before: per-tile count)', () => {
    const { stage, captured } = makeStage()
    stage.beginFrame()
    // Six tiles each emit the "82" shield on their own seam-offset polyline.
    // Distinct Y rows ⇒ NO bbox overlap (AABB alone keeps all six). Same lineId
    // + anchorDistancePx all inside one 250 px window ⇒ the line-spacing gate
    // keeps exactly the first-iterated one.
    const anchors = [40, 80, 120, 160, 200, 240]
    anchors.forEach((aDist, i) => {
      const [px, py] = hLine(0, 600, 1000 + i * 30) // row per tile, well separated in Y
      stage.addCurvedLineLabel(
        litValue('82'),
        {},
        px,
        py,
        aDist,
        lineDef(),
        undefined,
        'roads_shield',
        undefined,
        SAME_REF,
        aDist,
      )
    })
    stage.prepare()
    const draws = captured[0]!
    // WITHOUT the wiring this is 6 (one shield per tile). WITH it, the same-line
    // spacing gate collapses the window to one survivor.
    expect(draws.length, 'one route shield repeated within symbol-spacing collapses to 1').toBe(1)
  })

  it('keeps shields that are MORE than symbol-spacing apart along the route', () => {
    const { stage, captured } = makeStage()
    stage.beginFrame()
    // Same route, but anchors 300 px apart (> 250 window) on distinct rows.
    const anchors = [40, 340, 640]
    anchors.forEach((aDist, i) => {
      const [px, py] = hLine(0, 900, 2000 + i * 30)
      stage.addCurvedLineLabel(
        litValue('82'),
        {},
        px,
        py,
        aDist,
        lineDef(),
        undefined,
        'roads_shield',
        undefined,
        SAME_REF,
        aDist,
      )
    })
    stage.prepare()
    expect(captured[0]!.length, 'spaced-out repeats of the same route all place').toBe(3)
  })

  it('distinct refs (e.g. Texas interstates) each place independently', () => {
    const { stage, captured } = makeStage()
    stage.beginFrame()
    // Three DIFFERENT route refs, anchors within the window but DIFFERENT lineId.
    // The interstate case the prior fix preserved: distinct refs never merge.
    const refs = ['10', '35', '45']
    refs.forEach((ref, i) => {
      const [px, py] = hLine(0, 600, 3000 + i * 30)
      stage.addCurvedLineLabel(
        litValue(ref),
        {},
        px,
        py,
        100,
        lineDef(),
        undefined,
        'roads_shield',
        undefined,
        `roads_shield ${ref}`,
        100,
      )
    })
    stage.prepare()
    expect(captured[0]!.length, 'distinct route refs each survive (interstate parity)').toBe(3)
  })

  it('a curved label WITHOUT lineId is never subject to the gate (legacy path)', () => {
    const { stage, captured } = makeStage()
    stage.beginFrame()
    // No lineId/anchorDistancePx (undefined) — e.g. a plain along-line label on
    // a layer the dedupe doesn't key. Distinct Y rows ⇒ AABB keeps all three;
    // the spacing gate must not touch lineId-less items.
    ;[0, 1, 2].forEach((i) => {
      const [px, py] = hLine(0, 600, 4000 + i * 30)
      stage.addCurvedLineLabel(
        litValue('Main St'),
        {},
        px,
        py,
        100,
        lineDef(),
        undefined,
        'roads',
        undefined,
        undefined,
        undefined,
      )
    })
    stage.prepare()
    expect(captured[0]!.length, 'lineId-less curved labels unaffected by min-line spacing').toBe(3)
  })
})

// #2323 — the #605 same-line spacing gate above used ONE frame-wide window
// (250*dpr) for every layer, regardless of its authored `symbol-spacing`. A
// layer spaced BELOW 250 (OFM highway-shield-* = 200) had every second
// consecutive stop of its own run rejected by that oversized window — a 200 px
// cadence rendered at 400 px, half the authored rate. addCurvedLineLabel now
// takes the run's own spacing as a trailing `minLineSpacingPx` (dispatch
// forwards `run.spacingPx`), which overrides the frame-wide default per item.
describe("#2323 same-route window follows the run's own symbol-spacing", () => {
  it('two stops 200 px apart (run spacing 200) both place when the run spacing is forwarded', () => {
    const { stage, captured } = makeStage()
    stage.beginFrame()
    // One 600 px polyline; two stops 200 px apart, well inside the frame-wide
    // 250 px default but exactly at the run's OWN 200 px cadence — a 2-glyph
    // shield at size 20 is far narrower than 200 px, so the bboxes don't
    // overlap and only the same-line spacing gate can drop either one.
    const [px, py] = hLine(0, 600, 5000)
    const LINE_ID = 'roads_shield 82'
    ;[100, 300].forEach((aDist) => {
      stage.addCurvedLineLabel(
        litValue('82'),
        {},
        px,
        py,
        aDist,
        lineDef(),
        undefined,
        'roads_shield',
        undefined,
        LINE_ID,
        aDist,
        'roads_shield' + LINE_ID,
        undefined, // ground
        200, // #2323 — the run's own authored symbol-spacing
      )
    })
    stage.prepare()
    expect(
      captured[0]!.length,
      'both stops of a symbol-spacing 200 run are legitimately spaced and must place',
    ).toBe(2)
  })

  it('a caller that omits the run spacing keeps the frame-wide 250 px default (legacy fallback)', () => {
    const { stage, captured } = makeStage()
    stage.beginFrame()
    const [px, py] = hLine(0, 600, 6000)
    const LINE_ID = 'roads_shield 83'
    ;[100, 300].forEach((aDist) => {
      stage.addCurvedLineLabel(
        litValue('83'),
        {},
        px,
        py,
        aDist,
        lineDef(),
        undefined,
        'roads_shield',
        undefined,
        LINE_ID,
        aDist,
        'roads_shield' + LINE_ID,
      )
    })
    stage.prepare()
    expect(
      captured[0]!.length,
      'no per-run spacing supplied → the 250 px default still gates a 200 px cadence',
    ).toBe(1)
  })
})

// #2313 — a curved line label the shaping loop cannot lay out (glyph walk
// rejects the run length or text-max-angle, degenerate polyline, no glyphs)
// left the loop WITHOUT entering `shaped`, and the drop loop stamps
// droppedPairKeys only from `shaped`. IconStage therefore kept the paired
// shield badge: an empty white box with no road number on highway-shield
// layers. MapLibre draws neither half. Every unshapeable line label must now
// enter `shaped` with an empty layout list so the existing collision + drop
// wiring reports it as unplaced and stamps its pairKey.
describe('#2313 unshapeable curved label drops its paired badge', () => {
  it('does not fit the run: 6 glyphs on a 10 px polyline -> no draw, pairKey stamped', () => {
    const { stage, captured } = makeStage()
    stage.beginFrame()
    const [px, py] = hLine(0, 10, 100)
    stage.addCurvedLineLabel(
      litValue('ABCDEF'),
      {},
      px,
      py,
      5,
      lineDef(),
      undefined,
      'highway-shield',
      'k',
      undefined,
      undefined,
      'shield ABCDEF',
    )
    stage.prepare()
    expect(captured[0]!.length, 'label wider than its run is not drawn').toBe(0)
    expect(stage.getDroppedPairKeys().has('k'), 'undrawn label stamps pairKey k').toBe(true)
  })

  it('text-max-angle: 90-degree corner run -> no draw, pairKey stamped', () => {
    const { stage, captured } = makeStage()
    stage.beginFrame()
    stage.addCurvedLineLabel(
      litValue('ABCDEF'),
      {},
      new Float32Array([0, 100, 100]),
      new Float32Array([100, 100, 200]),
      100,
      lineDef(),
      undefined,
      'highway-shield',
      'k2',
      undefined,
      undefined,
      'shield corner',
    )
    stage.prepare()
    expect(captured[0]!.length, 'max-angle-rejected label is not drawn').toBe(0)
    expect(stage.getDroppedPairKeys().has('k2'), 'undrawn label stamps pairKey k2').toBe(true)
  })

  it('degenerate polyline (single vertex) -> no draw, pairKey stamped', () => {
    const { stage, captured } = makeStage()
    stage.beginFrame()
    stage.addCurvedLineLabel(
      litValue('AB'),
      {},
      new Float32Array([50]),
      new Float32Array([50]),
      0,
      lineDef(),
      undefined,
      'highway-shield',
      'k3',
      undefined,
      undefined,
      'shield degenerate',
    )
    stage.prepare()
    expect(captured[0]!.length, 'single-vertex polyline is not drawn').toBe(0)
    expect(stage.getDroppedPairKeys().has('k3'), 'undrawn label stamps pairKey k3').toBe(true)
  })

  it('atlas-overflow drop (no glyphs): every undrawn label stamps its pairKey', () => {
    // Tiny atlas (16 slots) + far more unique CJK glyphs than fit: the
    // overflow guard blanks the evicted labels' text, so ensureString returns
    // no glyphs. Rows are 200 px apart, so nothing collides — the only reason
    // a label is missing from the draws is the empty shaping.
    const { stage, captured } = makeStage(true)
    stage.setCameraZoom(11)
    stage.beginFrame()
    const words = ['서울특별', '부산광역', '인천대구', '광주울산', '대전세종', '평양원산']
    words.forEach((w, i) => {
      const [px, py] = hLine(0, 600, 100 + i * 200)
      stage.addCurvedLineLabel(
        litValue(w),
        {},
        px,
        py,
        300,
        lineDef(),
        undefined,
        'highway-shield',
        `p${i}`,
        undefined,
        undefined,
        `shield ${w}`,
      )
    })
    stage.prepare()
    const drawn = captured[0]!.length
    expect(drawn, 'the tiny atlas must drop at least one label').toBeLessThan(words.length)
    expect(
      stage.getDroppedPairKeys().size,
      'every label that produced no draw stamped its pairKey',
    ).toBe(words.length - drawn)
  })
})
