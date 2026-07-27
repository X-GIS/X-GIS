// Near-first collision wiring gate (site report, layer_below_labels demo at
// #2.90/42.29894/119.09100/30.0/81.4): two same-layer point labels whose
// screen boxes overlap on a pitched view must resolve the overlap in favour
// of the label NEARER the camera (lower on screen, larger anchor Y) — not
// the lexicographically-lower #728 identity. Before the fix "Seoul…" <
// "Shanghai…" made the FAR label win and the near one vanish.
//
// Drives the REAL TextStage.prepare() (CPU-only) with a stub GPU device +
// MockRasterizer and reads the post-collision setDraws capture — the same
// harness as curved-line-shaping.test.ts. This pins the WIRING
// (ShapedLabel.anchorY → CollisionItem.nearY), not just the
// greedyPlaceBboxes comparator (text-collision.test.ts covers that).

import { describe, it, expect } from 'vitest'
import { TextStage, MockRasterizer, TIEBREAK_GROUP_SEP } from '@xgis/map'
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

function pointDef(): LabelDef {
  return {
    text: litValue(''),
    size: 20,
    letterSpacing: 0,
    font: ['Noto Sans Bold'],
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

const drawTexts = (draws: TextDraw[]): string[] =>
  draws.map((d) => String.fromCodePoint(...d.glyphs.map((g) => g.codepoint)))

// Same layer group ('1'), pan-invariant identities as labelCollisionId
// composes them. Lexicographically 'Seoul…' < 'Shanghai…'.
const idSeoul = `1${TIEBREAK_GROUP_SEP}Seoul|q`
const idShanghai = `1${TIEBREAK_GROUP_SEP}Shanghai|q`

describe('point-label collision — near-first under overlap', () => {
  it('the lower-on-screen (nearer) label survives, the far one drops', () => {
    const { stage, captured } = makeStage()
    stage.beginFrame()
    // Seoul FAR (screen y 300), Shanghai NEAR (y 312) — 12px apart at
    // size 20 → their glyph boxes overlap vertically; anchors share x.
    stage.addLabel(
      litValue('Seoul'),
      {},
      500,
      300,
      pointDef(),
      undefined,
      'city',
      undefined,
      idSeoul,
    )
    stage.addLabel(
      litValue('Shanghai'),
      {},
      500,
      312,
      pointDef(),
      undefined,
      'city',
      undefined,
      idShanghai,
    )
    stage.prepare()
    const texts = drawTexts(captured[captured.length - 1]!)
    expect(texts).toContain('Shanghai') // near wins
    expect(texts).not.toContain('Seoul') // far occluded
  })

  it('winner is dispatch-order invariant (#728 property preserved)', () => {
    const { stage, captured } = makeStage()
    stage.beginFrame()
    stage.addLabel(
      litValue('Shanghai'),
      {},
      500,
      312,
      pointDef(),
      undefined,
      'city',
      undefined,
      idShanghai,
    )
    stage.addLabel(
      litValue('Seoul'),
      {},
      500,
      300,
      pointDef(),
      undefined,
      'city',
      undefined,
      idSeoul,
    )
    stage.prepare()
    const texts = drawTexts(captured[captured.length - 1]!)
    expect(texts).toContain('Shanghai')
    expect(texts).not.toContain('Seoul')
  })

  it('non-overlapping labels both survive (nearY changes priority, not placement)', () => {
    const { stage, captured } = makeStage()
    stage.beginFrame()
    stage.addLabel(
      litValue('Seoul'),
      {},
      500,
      100,
      pointDef(),
      undefined,
      'city',
      undefined,
      idSeoul,
    )
    stage.addLabel(
      litValue('Shanghai'),
      {},
      500,
      600,
      pointDef(),
      undefined,
      'city',
      undefined,
      idShanghai,
    )
    stage.prepare()
    const texts = drawTexts(captured[captured.length - 1]!)
    expect(texts).toContain('Seoul')
    expect(texts).toContain('Shanghai')
  })
})
