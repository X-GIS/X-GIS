// Near-on-top DRAW order for overlapping allow-overlap labels (default /
// `symbol-z-order: auto`). Sibling of the #1249 near-first COLLISION fix: that
// decided which of two overlapping labels SURVIVES; this decides, among labels
// that BOTH survive (text-allow-overlap), which paints ON TOP.
//
// The legacy emit painted in source (dispatch) order, so which allow-overlap
// label won the pixels where they overlap depended on tile-dispatch order, and
// was depth-blind: the label FARTHER from the camera could paint over the
// nearer one. Mapbox/MapLibre paint near-on-top. The fix Y-sorts the draw order
// WITHIN each layer group (so layer precedence still dominates): larger anchorY
// (nearer under pitch) paints last = on top.
//
// Gate: a frame with ≥1 allow-overlap label takes the sort; a frame with none
// is byte-identical to source order (this file pins that too). The layer key is
// the label's layerName (threaded on every dispatch path) ranked by first
// appearance = layer precedence; the Y-sort runs WITHIN each layer bucket so
// layer order still dominates. Real TextStage.prepare() + stub GPU device +
// MockRasterizer, same harness as point-label-near-first.test.ts.

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

function pointDef(allowOverlap: boolean): LabelDef {
  return {
    text: litValue(''),
    size: 20,
    letterSpacing: 0,
    font: ['Noto Sans Bold'],
    allowOverlap,
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

// Same layer group ('1'); group | identity per labelCollisionId's encoding.
const id = (name: string) => `1${TIEBREAK_GROUP_SEP}${name}|q`

describe('point-label DRAW order — near-on-top for allow-overlap', () => {
  it('the nearer (larger anchorY) allow-overlap label paints LAST (on top)', () => {
    // Dispatch NEAR first, FAR second — so SOURCE order would paint FAR last
    // (on top), the depth-blind wrong result. The within-layer Y-sort must put
    // FAR first, NEAR last.
    const { stage, captured } = makeStage()
    const def = pointDef(true)
    stage.beginFrame()
    stage.addLabel(litValue('near'), {}, 500, 312, def, undefined, 'city', undefined, id('near'))
    stage.addLabel(litValue('far'), {}, 500, 300, def, undefined, 'city', undefined, id('far'))
    stage.prepare()
    const order = drawTexts(captured[captured.length - 1]!)
    expect(order).toEqual(['far', 'near']) // near emitted last = on top
  })

  it('draw order is dispatch-order invariant (near on top either way)', () => {
    const { stage, captured } = makeStage()
    const def = pointDef(true)
    stage.beginFrame()
    stage.addLabel(litValue('far'), {}, 500, 300, def, undefined, 'city', undefined, id('far'))
    stage.addLabel(litValue('near'), {}, 500, 312, def, undefined, 'city', undefined, id('near'))
    stage.prepare()
    const order = drawTexts(captured[captured.length - 1]!)
    expect(order).toEqual(['far', 'near'])
  })

  it('no allow-overlap label → draw order is source order (byte-identical)', () => {
    // Neither is allow-overlap → the sort gate is off. They also don't overlap
    // (ΔY 200) so both survive; source order is preserved.
    const { stage, captured } = makeStage()
    const def = pointDef(false)
    stage.beginFrame()
    stage.addLabel(litValue('near'), {}, 500, 500, def, undefined, 'city', undefined, id('near'))
    stage.addLabel(litValue('far'), {}, 500, 300, def, undefined, 'city', undefined, id('far'))
    stage.prepare()
    const order = drawTexts(captured[captured.length - 1]!)
    expect(order).toEqual(['near', 'far']) // dispatch order, unsorted
  })

  it('layer precedence dominates Y — a later layer paints on top even if higher on screen', () => {
    // Group '2' = earlier layer (drawn under), group '1' = later layer (on top),
    // per labelCollisionId(invLayer = showCount - showIdx). The later-layer label
    // sits HIGHER on screen (smaller Y) yet must still paint LAST.
    const { stage, captured } = makeStage()
    const def = pointDef(true)
    const earlier = `2${TIEBREAK_GROUP_SEP}under|q` // earlier layer, near (large Y)
    const later = `1${TIEBREAK_GROUP_SEP}over|q` // later layer, far (small Y)
    stage.beginFrame()
    stage.addLabel(litValue('under'), {}, 500, 900, def, undefined, 'a', undefined, earlier)
    stage.addLabel(litValue('over'), {}, 500, 100, def, undefined, 'b', undefined, later)
    stage.prepare()
    const order = drawTexts(captured[captured.length - 1]!)
    expect(order).toEqual(['under', 'over']) // later layer 'over' last, despite higher on screen
  })

  it('a label with no layerName forms its own bucket (drawn after the named layer)', () => {
    // near/far share layer 'city' (dispatched first → rank 0); the bare
    // imperative overlay has no layerName (rank 1, dispatched last). The city
    // labels Y-sort within their bucket (far before near); the bare label,
    // being a later bucket, paints last regardless of its screen Y.
    const { stage, captured } = makeStage()
    const def = pointDef(true)
    stage.beginFrame()
    stage.addLabel(litValue('near'), {}, 500, 312, def, undefined, 'city', undefined, id('near'))
    stage.addLabel(litValue('bare'), {}, 700, 400, def) // no layerName → own bucket
    stage.addLabel(litValue('far'), {}, 500, 300, def, undefined, 'city', undefined, id('far'))
    stage.prepare()
    const order = drawTexts(captured[captured.length - 1]!)
    expect(order).toEqual(['far', 'near', 'bare']) // city Y-sorted, bare bucket last
  })
})
