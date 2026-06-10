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
import { TextStage } from './text-stage'
import { MockRasterizer } from './sdf/glyph-rasterizer'
import type { LabelDef, TextValue } from '@xgis/compiler'
import type { TextDraw } from './text-renderer'

const g = globalThis as Record<string, unknown>
g.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 }
g.GPUBufferUsage ??= {
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16,
  VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
}
g.GPUTextureUsage ??= {
  COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16,
}
g.GPUColorWrite ??= { RED: 1, GREEN: 2, BLUE: 4, ALPHA: 8, ALL: 15 }

function stubDevice(): GPUDevice {
  const stub: unknown = new Proxy(function () { return stub }, {
    get(_t, p) {
      if (p === 'size') return 1 << 22
      if (p === 'width' || p === 'height') return 4096
      if (p === 'limits') return { maxTextureDimension2D: 8192 }
      if (p === Symbol.toPrimitive) return () => 0
      return stub
    },
    apply() { return stub },
  })
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
  const stage = new TextStage(stubDevice(), 'bgra8unorm', opts)
  const captured: TextDraw[][] = []
  ;(stage as unknown as { renderer: { setDraws(d: TextDraw[]): void } }).renderer.setDraws =
    (d: TextDraw[]) => { captured.push(d) }
  return { stage, captured }
}

/** True when a draw sits at the given submitted anchor (anchor 'left',
 *  no offset → draw.anchorX/Y === submitted anchorX/Y). */
function atAnchor(d: TextDraw, x: number, y: number): boolean {
  return Math.abs(d.anchorX - x) < 1e-6 && Math.abs(d.anchorY - y) < 1e-6
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
    stage.addLabel(litValue('A'), {}, 100, 100, pointDef())   // shaped 0
    stage.addLabel(litValue('B'), {}, 500, 500, pointDef())   // shaped 1
    stage.addLabel(litValue('C'), {}, 108, 100, pointDef())   // shaped 2
    stage.prepare()
    const draws = captured[0]!
    // Exactly two survivors: B (far) and C (later of the overlapping pair).
    expect(draws.length).toBe(2)
    expect(draws.some(d => atAnchor(d, 500, 500)), 'B (far) should survive').toBe(true)
    expect(draws.some(d => atAnchor(d, 108, 100)), 'C (later) should win the overlap').toBe(true)
    expect(draws.some(d => atAnchor(d, 100, 100)), 'A (earlier) must be dropped').toBe(false)
    // Draw order preserves shaped order (B at index 1 before C at index 2).
    const idxB = draws.findIndex(d => atAnchor(d, 500, 500))
    const idxC = draws.findIndex(d => atAnchor(d, 108, 100))
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
    expect(draws.some(d => atAnchor(d, 108, 100)), 'higher-sortKey P dropped').toBe(false)
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
    const words = ['서울특별', '부산광역', '인천대구', '광주울산', '대전세종', '평양원산', '청진함흥', '개성신의']
    words.forEach((w, i) => small.stage.addLabel(litValue(w), {}, 100 + i * 40, 100, pointDef()))
    small.stage.prepare()
    expect(small.stage.wasLastPrepareFullyResolved(),
      'overflow-dropped label leaves prepare not-fully-resolved').toBe(false)
  })
})
