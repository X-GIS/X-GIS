// text-translate-anchor: 'map' runtime render-wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap. text-translate-anchor
// is marked `supported` (constant) for the symbol layer (runtime/src/
// capabilities/symbol.ts:65) and the COMPILE/lower side is covered by
// compiler/src/__tests__/translate-anchor-map-end-to-end.test.ts (it pins
// ShowCommand.label.translateAnchorMap === true). But the RUNTIME side — the
// part that actually makes the flag bend a pixel — was verified only
// structurally: nothing pinned that TextStage.prepare() READS translateAnchorMap
// + the map bearing and rotates the text-translate [dx,dy] before baking the
// draw anchor. A wiring break there (drop the flag, or stop threading the
// bearing) would ship silently — the heatmap-class bug this corpus targets.
//
// The runtime contract (text-stage.ts:855-859 → :1007-1008 → :1010-1011):
//   drawX = anchorX + rotate(translate, anchorMap, bearing).x * dpr
//   drawY = anchorY + rotate(translate, anchorMap, bearing).y * dpr
// where rotate() is a pure 2D bearing rotation when anchorMap is true, and the
// identity (screen-space, byte-identical default) when anchorMap is
// false/undefined.
//
// This drives the REAL TextStage.prepare() against the WebGPU/CPU stub (no GPU,
// same harness as prepare-collision-wiring.test.ts) and intercepts the
// renderer's setDraws to read the post-translate draw anchor of the single
// submitted label. With translate=[10,0] and bearing=90°:
//   anchorMap=true  → rotate([10,0],90°) = [~0, 10] → drawX≈anchorX, drawY≈anchorY+10
//   anchorMap=false → identity [10,0]            → drawX=anchorX+10, drawY=anchorY
// The two cases differ ONLY by the flag, so the assertion is non-vacuous: it
// pins that translateAnchorMap (with the map bearing) actually rotates the
// text-translate offset into the draw anchor.
//
// Fail-before: in text-stage.ts replace `p.def.translateAnchorMap` (the 3rd arg
// to rotateLabelTranslate, :858) with `false`. The flag is severed, the map
// case stops rotating (drawX=anchorX+10, drawY=anchorY like the viewport case),
// and the anchorMap=true assertions go red — the wiring that makes
// text-translate-anchor:'map' reach the rendered anchor is gone, and this test
// catches it before any pixel is drawn.

import { describe, it, expect } from 'vitest'
import { TextStage } from '@xgis/map'
import { MockRasterizer } from '@xgis/map'
import { WebGpuDevice } from '@xgis/engine'
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

/** Point-label def. anchor 'left' + no text-offset → drawX/Y == anchorX/Y +
 *  the (possibly rotated) text-translate only. */
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

const ANCHOR_X = 200
const ANCHOR_Y = 300
const TRANSLATE: [number, number] = [10, 0]
const BEARING = 90

/** Submit ONE 'left'-anchored label with text-translate [10,0] at the given
 *  bearing + anchor mode, run prepare(), and return its post-translate draw
 *  anchor. dpr defaults to 1 (makeStage never calls setDpr), so the draw anchor
 *  is exactly anchorXY + rotate(translate). */
function capturedDrawAnchor(
  stage: TextStage,
  captured: TextDraw[][],
  anchorMap: boolean | undefined,
): { x: number; y: number } {
  stage.setBearing(BEARING)
  stage.beginFrame()
  stage.addLabel(
    litValue('A'),
    {},
    ANCHOR_X,
    ANCHOR_Y,
    pointDef({ translate: TRANSLATE, translateAnchorMap: anchorMap }),
  )
  stage.prepare()
  const draws = captured[captured.length - 1]!
  expect(draws.length).toBe(1)
  return { x: draws[0]!.anchorX, y: draws[0]!.anchorY }
}

describe('text-translate-anchor map flag runtime wiring (GPU-free)', () => {
  it('anchorMap=true rotates text-translate by the bearing into the draw anchor', () => {
    const { stage, captured } = makeStage()
    // rotate([10,0], 90°) = [10*cos90, 10*sin90] = [~0, 10].
    const a = capturedDrawAnchor(stage, captured, true)
    expect(a.x).toBeCloseTo(ANCHOR_X + 0, 4) // dx rotated out of X
    expect(a.y).toBeCloseTo(ANCHOR_Y + 10, 4) // dx rotated into +Y
  })

  it('anchorMap=false (viewport default) leaves text-translate screen-space — unrotated', () => {
    const { stage, captured } = makeStage()
    // identity [10,0] regardless of bearing → drawX = anchorX+10, drawY = anchorY.
    const a = capturedDrawAnchor(stage, captured, false)
    expect(a.x).toBeCloseTo(ANCHOR_X + 10, 4)
    expect(a.y).toBeCloseTo(ANCHOR_Y + 0, 4)
  })

  it('anchorMap undefined (absent) == viewport — byte-identical screen-space', () => {
    const { stage, captured } = makeStage()
    const a = capturedDrawAnchor(stage, captured, undefined)
    expect(a.x).toBeCloseTo(ANCHOR_X + 10, 4)
    expect(a.y).toBeCloseTo(ANCHOR_Y + 0, 4)
  })
})
