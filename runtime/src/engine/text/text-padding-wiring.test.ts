// text-padding collision-bbox wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: text-padding is marked
// `supported` (constant + interpolate-by-zoom) in
// compiler/src/convert/spec-coverage/layout-symbol.ts and the symbol
// capability table, but its RUNTIME consumer had only structural / converter
// coverage (negative-clamp, interp-unwrap, spec-default) — none drove the
// renderer, so a break in the runtime data path would ship silently.
//
// Runtime consumer: TextStage.prepare() reads `(p.def.padding ?? 2) * dpr`
// (text-stage.ts:841) and GROWS the per-label collision bbox by that padding
// on every side (text-stage.ts:1094-1097). A larger text-padding therefore
// makes a label's box reach a neighbour that a default-padding box does not,
// flipping a collision drop. The drop is fully CPU-observable via the captured
// draw list (no GPU), so this is the behavioural wiring test the prop needs.
//
// Geometry (mirrors prepare-collision-wiring.test.ts): size 20, MockRasterizer
// advance = sizePx*0.6 = 12 → a single ASCII char's bbox spans
// x[anchorX-pad, anchorX+12+pad], y identical for same-Y same-size labels.
//   A @ (100,100) submitted FIRST, B @ (130,100) submitted SECOND, both 'A'/'B'.
//   • default padding (2): A maxX=114 < B minX=128 → NO overlap → BOTH survive.
//   • A padding=40: A maxX=100+12+40=152 > B minX=128 → OVERLAP. No sortKey, so
//     the reverse-iteration trick makes the LATER submission (B) win; A drops.
//     → exactly ONE survivor, at B's anchor (130,100).
// The ONLY thing that changes between the two cases is A's `padding` field, so
// the survivor count is a non-vacuous function of text-padding's wiring.
//
// Fail-before: replace `(p.def.padding ?? 2) * dpr` at text-stage.ts:841 with
// `2 * dpr` (drop the prop). A's box no longer grows, the labels never collide,
// BOTH survive in the padding=40 case, and the `draws.length === 1` assertion
// goes red — the wire that makes text-padding reach collision is gone.

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

function makeStage() {
  const stage = new TextStage(stubDevice(), new WebGpuDevice(stubDevice()), 'bgra8unorm', {
    rasterizer: new MockRasterizer(),
  })
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

describe('text-padding collision-bbox wiring (GPU-free)', () => {
  it('default text-padding (2): non-touching neighbours BOTH survive (control)', () => {
    // A maxX = 100+12+2 = 114; B minX = 130-2 = 128 → 14px gap, no overlap.
    // This pins the regime: at default padding the two labels do NOT collide,
    // so any drop in the next test is caused solely by text-padding growth.
    const { stage, captured } = makeStage()
    stage.beginFrame()
    stage.addLabel(litValue('A'), {}, 100, 100, pointDef()) // shaped 0
    stage.addLabel(litValue('B'), {}, 130, 100, pointDef()) // shaped 1
    stage.prepare()
    const draws = captured[0]!
    expect(draws.length, 'default-padding neighbours do not collide').toBe(2)
    expect(
      draws.some((d) => atAnchor(d, 100, 100)),
      'A survives at default padding',
    ).toBe(true)
    expect(
      draws.some((d) => atAnchor(d, 130, 100)),
      'B survives at default padding',
    ).toBe(true)
  })

  it('large text-padding on A grows its collision bbox to engulf B → B (later) wins, A drops', () => {
    // SAME geometry, SAME size — the ONLY change is A's padding=40. That grows
    // A's bbox to maxX=152 > B minX=128 → overlap. No sortKey → reverse trick:
    // later-submitted B wins, A drops. If the padding wire is broken (A's box
    // stays at default) the labels never overlap and this stays at 2.
    const { stage, captured } = makeStage()
    stage.beginFrame()
    stage.addLabel(litValue('A'), {}, 100, 100, pointDef({ padding: 40 })) // shaped 0
    stage.addLabel(litValue('B'), {}, 130, 100, pointDef()) // shaped 1
    stage.prepare()
    const draws = captured[0]!
    expect(draws.length, 'text-padding grows A box → exactly one survivor').toBe(1)
    expect(
      atAnchor(draws[0]!, 130, 100),
      'B (later submission) wins the padding-induced overlap',
    ).toBe(true)
    expect(
      draws.some((d) => atAnchor(d, 100, 100)),
      'A dropped — its padded box collided with B',
    ).toBe(false)
  })
})
