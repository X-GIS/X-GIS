// Phase S Batch 4 — Mapbox `symbol-z-order` (LabelDef.symbolZOrder)
// runtime ordering pass in TextStage.prepare().
//
//   viewport-y — labels ordered by screen Y: lower-on-screen (larger Y)
//                placed FIRST in collision (south wins) and drawn LAST
//                (on top). Mirrors Mapbox's viewport-y painter order.
//   source     — source / submission order for both collision and draw
//                (suppresses the legacy reverse-layer trick).
//   auto / unset — legacy reverse-layer / sortKey ordering, BYTE-
//                IDENTICAL to before this feature.
//
// Same stub-GPU harness as prepare-collision-wiring.test.ts. anchor
// 'left' + no offset ⇒ draw.anchorX/Y === submitted anchorX/Y, so each
// surviving draw maps back to its source label by anchor.

import { describe, it, expect } from 'vitest'
import { TextStage } from './text-stage'
import { MockRasterizer } from './sdf/glyph-rasterizer'
import { WebGpuDevice } from '../render/rhi/rhi-webgpu'
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

function atAnchor(d: TextDraw, x: number, y: number): boolean {
  return Math.abs(d.anchorX - x) < 1e-6 && Math.abs(d.anchorY - y) < 1e-6
}

describe('symbol-z-order ordering pass (TextStage.prepare)', () => {
  it('viewport-y: south (larger Y) wins the overlap; collision orders by Y ascending', () => {
    // N (north, y=100) submitted FIRST; S (south, y=108) submitted SECOND.
    // They overlap in x/y. Legacy reverse-trick would let the LATER (S)
    // win anyway here, so to PROVE viewport-y we submit S FIRST and N
    // SECOND: legacy would then keep N (later) — viewport-y must instead
    // keep S (south / larger Y), proving the Y-sort, not submission order.
    const { stage, captured } = makeStage()
    stage.beginFrame()
    stage.addLabel(litValue('S'), {}, 100, 108, pointDef({ symbolZOrder: 'viewport-y' })) // south, first
    stage.addLabel(litValue('N'), {}, 100, 100, pointDef({ symbolZOrder: 'viewport-y' })) // north, second
    stage.prepare()
    const draws = captured[0]!
    expect(draws.length).toBe(1)
    expect(atAnchor(draws[0]!, 100, 108), 'south (larger Y) wins under viewport-y').toBe(true)
    expect(draws.some(d => atAnchor(d, 100, 100)), 'north dropped').toBe(false)
  })

  it('viewport-y: draw (painter) order is bottom-on-top (south emitted last)', () => {
    // Two non-overlapping labels: north (y=100) and south (y=500). Both
    // place. Painter order must put south LAST so it draws on top.
    const { stage, captured } = makeStage()
    stage.beginFrame()
    stage.addLabel(litValue('N'), {}, 100, 100, pointDef({ symbolZOrder: 'viewport-y' }))
    stage.addLabel(litValue('S'), {}, 600, 500, pointDef({ symbolZOrder: 'viewport-y' }))
    stage.prepare()
    const draws = captured[0]!
    expect(draws.length).toBe(2)
    const idxN = draws.findIndex(d => atAnchor(d, 100, 100))
    const idxS = draws.findIndex(d => atAnchor(d, 600, 500))
    expect(idxN).toBeLessThan(idxS) // south (larger Y) drawn last = on top
  })

  it('source: submission order wins (NOT the reverse-layer trick)', () => {
    // E @ (100,100) submitted FIRST; F @ (108,100) submitted SECOND,
    // overlapping. Legacy no-sortKey path reverses → F (later) wins. Under
    // `source` the FORWARD submission order wins → E (first) places, F drops.
    const { stage, captured } = makeStage()
    stage.beginFrame()
    stage.addLabel(litValue('E'), {}, 100, 100, pointDef({ symbolZOrder: 'source' }))
    stage.addLabel(litValue('F'), {}, 108, 100, pointDef({ symbolZOrder: 'source' }))
    stage.prepare()
    const draws = captured[0]!
    expect(draws.length).toBe(1)
    expect(atAnchor(draws[0]!, 100, 100), 'first-submitted E wins under source order').toBe(true)
  })

  it('default (no symbolZOrder): byte-identical legacy reverse-layer trick (later wins)', () => {
    // Same overlap as the source test but WITHOUT symbolZOrder. Legacy
    // path must keep the LATER submission (F) — proving the default is
    // untouched.
    const { stage, captured } = makeStage()
    stage.beginFrame()
    stage.addLabel(litValue('E'), {}, 100, 100, pointDef())
    stage.addLabel(litValue('F'), {}, 108, 100, pointDef())
    stage.prepare()
    const draws = captured[0]!
    expect(draws.length).toBe(1)
    expect(atAnchor(draws[0]!, 108, 100), 'later-submitted F wins under legacy default').toBe(true)
  })

  it('auto (explicit) is treated as legacy default (later wins, byte-identical)', () => {
    const { stage, captured } = makeStage()
    stage.beginFrame()
    stage.addLabel(litValue('E'), {}, 100, 100, pointDef({ symbolZOrder: 'auto' }))
    stage.addLabel(litValue('F'), {}, 108, 100, pointDef({ symbolZOrder: 'auto' }))
    stage.prepare()
    const draws = captured[0]!
    expect(draws.length).toBe(1)
    expect(atAnchor(draws[0]!, 108, 100), 'auto keeps legacy later-wins behaviour').toBe(true)
  })
})
