// #728 — the SURVIVOR of two overlapping labels must not depend on the order
// labels are dispatched (addLabel/addCurvedLineLabel) into TextStage. Dispatch
// order = tile-walk order = which tiles are loaded, so a dispatch-order-
// dependent winner flips on pan across a tile boundary (the pan-swap this
// issue fixes). With a stable `collisionId` fed as the greedy tie-break the
// same set produces the SAME winner regardless of dispatch order.
//
// Drives the REAL TextStage.prepare() with a stub GPU (same harness as
// prepare-collision-wiring.test.ts). fail-before: on pre-#728 code prepare()
// takes the reverse-input-order trick for no-sortKey labels, so the LATER-
// dispatched of two overlappers wins → the two dispatch orders below yield
// DIFFERENT survivors and the `same survivor` assertions fail.

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

function atAnchor(d: TextDraw, x: number, y: number): boolean {
  return Math.abs(d.anchorX - x) < 1e-6 && Math.abs(d.anchorY - y) < 1e-6
}

describe('#728 collision survivor is independent of dispatch order', () => {
  // A @ (100,100) and C @ (108,100) overlap (bbox x [98,114] / [106,122] share
  // [106,114], y identical). Same layer field ('00'), so the feature identity
  // decides: 'A' < 'C' → A must win in BOTH dispatch orders.
  const idA = '00 A'
  const idC = '00 C'

  const dispatch = (order: 'AC' | 'CA'): TextDraw[] => {
    const { stage, captured } = makeStage()
    stage.beginFrame()
    const addA = () =>
      stage.addLabel(litValue('A'), {}, 100, 100, pointDef(), undefined, undefined, undefined, idA)
    const addC = () =>
      stage.addLabel(litValue('C'), {}, 108, 100, pointDef(), undefined, undefined, undefined, idC)
    if (order === 'AC') {
      addA()
      addC()
    } else {
      addC()
      addA()
    }
    stage.prepare()
    return captured[0]!
  }

  it('point labels: the SAME label survives regardless of addLabel order', () => {
    const drawsAC = dispatch('AC')
    const drawsCA = dispatch('CA')
    expect(drawsAC.length).toBe(1)
    expect(drawsCA.length).toBe(1)
    // fail-before: reverse trick → 'AC' order lets C (later) win at (108,100),
    // 'CA' order lets A win at (100,100) → different survivors.
    expect(atAnchor(drawsAC[0]!, 100, 100), 'A wins when dispatched A,C').toBe(true)
    expect(atAnchor(drawsCA[0]!, 100, 100), 'A STILL wins when dispatched C,A').toBe(true)
  })

  it('later layer still wins: a higher layer-precedence id beats a lower one', () => {
    // idLate has a SMALLER layer field ('00' = later show) than idEarly ('01').
    // Even though 'late' overlaps 'early' and is dispatched SECOND, the later
    // layer must win — MapLibre "later layer wins", now order-stable.
    const { stage, captured } = makeStage()
    stage.beginFrame()
    stage.addLabel(litValue('E'), {}, 100, 100, pointDef(), undefined, undefined, undefined, '01 E')
    stage.addLabel(litValue('L'), {}, 108, 100, pointDef(), undefined, undefined, undefined, '00 L')
    stage.prepare()
    const draws = captured[0]!
    expect(draws.length).toBe(1)
    expect(atAnchor(draws[0]!, 108, 100), 'later-layer L wins the overlap').toBe(true)
  })
})
