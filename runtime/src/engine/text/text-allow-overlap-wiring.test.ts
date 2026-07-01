// text-allow-overlap: runtime WIRING pin (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap. `text-allow-overlap`
// is marked `supported` and lowers to LabelDef.allowOverlap
// (compiler/src/ir/render-node.ts:495, lower-label.ts:786). greedyPlaceBboxes
// itself honours `allowOverlap` and is well covered (text-collision.test.ts),
// but those tests HAND-BUILD CollisionItems — none drive the real
// TextStage.prepare() threading that copies the lowered flag through:
//   def.allowOverlap  → ShapedLabel.allowOverlap (text-stage.ts:947,
//   `p.def.allowOverlap === true`) → CollisionItem.allowOverlap
//   (text-stage.ts:1441, `allowOverlap: s.allowOverlap`) → greedy :126.
// A break at that threading step (e.g. `allowOverlap: false`) would let the
// overlapping label collide and drop, yet EVERY existing test would still
// pass — the prop would be silently un-wired (the heatmap-class bug).
//
// Drives the REAL TextStage.prepare() against a stub GPU (same harness as
// prepare-collision-wiring.test.ts / bilingual-prepare-scatter.test.ts) and
// captures the surviving draws via renderer.setDraws. Every label uses anchor
// 'left' with no offset so drawX/Y === anchorX/Y exactly — each survivor maps
// back to its source label by draw.anchorX/anchorY.
//
// Non-vacuous: the SAME geometry is run twice — once with the overlapping
// label carrying allowOverlap:true, once without. The control case proves the
// overlap really collides (label drops); the wired case proves allowOverlap
// rescues it. The assertion turns on the prop value, not on a constant.
//
// Fail-before: replace text-stage.ts:1441 `allowOverlap: s.allowOverlap` with
// `allowOverlap: false` (drop the threading) and the wired case's overlapping
// label collides → draws.length 1 not 2 → this test goes red.

import { describe, it, expect } from 'vitest'
import { TextStage } from '@xgis/map'
import { MockRasterizer } from '@xgis/map'
import { WebGpuDevice } from '@xgis/engine'
import type { LabelDef, TextValue } from '@xgis/compiler'
import type { TextDraw } from '@xgis/map'

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

function makeStage() {
  const stage = new TextStage(stubDevice(), new WebGpuDevice(stubDevice()), 'bgra8unorm', { rasterizer: new MockRasterizer() })
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

// Two labels whose bboxes overlap: A @ (100,100) and B @ (108,100). With
// anchor 'left', size 20, single-char ASCII, the bboxes share screen x in
// roughly [106,114] at identical y — a genuine collision.
const AX = 100, AY = 100
const BX = 108, BY = 100

describe('text-allow-overlap prepare() wiring (GPU-free, text-stage.ts:1441)', () => {
  it('CONTROL: overlapping label with NO allow-overlap collides and is dropped', () => {
    // No sortKey → reverse trick: greedy runs [B,A]; B (later) places, A
    // collides with B → dropped. Exactly one survivor (B).
    const { stage, captured } = makeStage()
    stage.beginFrame()
    stage.addLabel(litValue('A'), {}, AX, AY, pointDef())   // shaped 0
    stage.addLabel(litValue('B'), {}, BX, BY, pointDef())   // shaped 1
    stage.prepare()
    const draws = captured[0]!
    expect(draws.length, 'plain overlap: one label must drop').toBe(1)
    expect(draws.some(d => atAnchor(d, BX, BY)), 'B (later) wins the overlap').toBe(true)
    expect(draws.some(d => atAnchor(d, AX, AY)), 'A (earlier) dropped').toBe(false)
  })

  it('WIRED: allow-overlap on the EARLIER label rescues it from the same collision', () => {
    // Same geometry, but A now carries allowOverlap:true. The threading at
    // text-stage.ts:1441 must copy that flag into A's CollisionItem so the
    // greedy pass (text-collision.ts:126) places A despite overlapping B.
    // BOTH survive → draws.length 2 and A appears at its own anchor.
    const { stage, captured } = makeStage()
    stage.beginFrame()
    stage.addLabel(litValue('A'), {}, AX, AY, pointDef({ allowOverlap: true })) // shaped 0
    stage.addLabel(litValue('B'), {}, BX, BY, pointDef())                       // shaped 1
    stage.prepare()
    const draws = captured[0]!
    // Drop the `allowOverlap: s.allowOverlap` threading → A collides with B
    // and this becomes 1, failing the test (the fail-before proof).
    expect(draws.length, 'allow-overlap label co-places with its overlapper').toBe(2)
    expect(draws.some(d => atAnchor(d, AX, AY)), 'A survives via text-allow-overlap').toBe(true)
    expect(draws.some(d => atAnchor(d, BX, BY)), 'B also survives').toBe(true)
  })
})
