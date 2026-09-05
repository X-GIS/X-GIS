// `text-optional: true` — the icon survives its label, WITH an obstacle box (#2440).
//
// The spec default (`text-optional: false`) is already X-GIS's behaviour and is
// not a gap: a collision-rejected label stamps its pairKey into
// `droppedPairKeys` and IconStage skips the paired icon, which IS MapLibre's
// text+icon-as-one-symbol rule. `true` is the gap — the icon should survive
// alone when only the label cannot fit.
//
// WHY THIS IS NOT "just stop stamping the pairKey". Suppressing the cascade
// alone leaves the surviving icon with NO obstacle box, because #609
// deliberately removed it: `computeObstacles` skips an icon whose pairKey is in
// `getActiveTextPairKeys()`, on the premise that "if the text wins, its own
// bbox blocks; if it loses, the icon is dropped — either way the icon's box is
// redundant-or-harmful". `text-optional: true` falsifies the SECOND half only.
// A drawn icon participating in nothing is a phantom in the opposite direction
// from the one #609 fixed, so a test that asserts only "the icon survived"
// passes on exactly the bug — the vacuity shape §12 warns about. Every subject
// arm here asserts the BOX.
//
// The fix rides ONE predicate. A `text-optional: true` label is excluded from
// `getActiveTextPairKeys()`, which by itself makes `computeObstacles` seed the
// icon's box through the path an icon-only symbol already takes — IconStage is
// untouched. The same predicate suppresses the cascade stamp. Single producer,
// two consumers, so they cannot drift (§12).
//
// The over-block cost of always seeding that box is ZERO when the text wins,
// and structurally so rather than by measurement: `PairedBadgeBoxes.union`
// (paired-symbol-box.ts:105-119) has already grown the live text's bbox to
// cover the icon's half-extents on the shared anchor, computed by
// `pairedIconHalfExtents` (icon-stage.ts:687-701) with the same arithmetic
// `computeObstacles` (icon-stage.ts:639-662) uses. At the default
// `icon-anchor: center` those are the identical rectangle, so the seeded box is
// a subset of an obstacle that is already there.

import { describe, it, expect } from 'vitest'
import { TextStage, IconStage, MockRasterizer, greedyPlaceBboxes } from '@xgis/map'
import { WebGpuDevice } from '@xgis/rhi-webgpu'
import type { LabelDef, TextValue } from '@xgis/compiler'
import type { TextDraw, CollisionObstacle, CollisionItem } from '@xgis/map'

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

/** Same stub-GPU harness as prepare-collision-wiring.test.ts. */
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

/** Point-label def. anchor 'left' + no offset → drawX/Y === anchorX/Y. */
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

const SPRITE = { width: 20, height: 20, pixelRatio: 1 }
/** Same Object.create stub the #609 obstacle test uses. */
function makeIconStub(): IconStage {
  const stage = Object.create(IconStage.prototype) as IconStage
  ;(stage as unknown as { inlineImages: unknown[] }).inlineImages = []
  ;(stage as unknown as { pending: unknown[] }).pending = []
  ;(stage as unknown as { dpr: number }).dpr = 1
  ;(stage as unknown as { host: unknown }).host = {
    getState: () => ({ status: 'loaded' }),
    get: () => SPRITE,
  }
  return stage
}

const box = (x: number, y: number, w = 10, h = 10) => ({
  minX: x,
  minY: y,
  maxX: x + w,
  maxY: y + h,
})

describe('#2440 — a text-optional label leaves the live-text set, so its icon keeps a box', () => {
  // THE CONTROL. Without it every subject arm is satisfied by a predicate that
  // excluded EVERY paired label, which would re-open #609's phantom over-drop
  // for the whole corpus — strictly worse than the bug being fixed.
  it('a plain paired label IS in the live-text set (#609 unchanged)', () => {
    const { stage } = makeStage()
    stage.beginFrame()
    stage.addLabel(litValue('Cafe'), {}, 100, 100, pointDef(), undefined, undefined, 'poi:1')
    expect(stage.getActiveTextPairKeys().has('poi:1')).toBe(true)
  })

  it('a text-optional label is NOT in the live-text set', () => {
    const { stage } = makeStage()
    stage.beginFrame()
    stage.addLabel(
      litValue('Airport'),
      {},
      100,
      100,
      pointDef({ textOptional: true }),
      undefined,
      undefined,
      'airport:1',
    )
    expect(stage.getActiveTextPairKeys().has('airport:1')).toBe(false)
  })

  it('mixed dispatch: only the text-optional key leaves the set', () => {
    const { stage } = makeStage()
    stage.beginFrame()
    stage.addLabel(litValue('Cafe'), {}, 100, 100, pointDef(), undefined, undefined, 'poi:1')
    stage.addLabel(
      litValue('Airport'),
      {},
      300,
      300,
      pointDef({ textOptional: true }),
      undefined,
      undefined,
      'airport:1',
    )
    const live = stage.getActiveTextPairKeys()
    expect([...live].sort()).toEqual(['poi:1'])
  })
})

// THE ASSERTION THE ISSUE DEMANDS. "The icon survived" is satisfied by the
// phantom; only the box separates a fix from it.
describe('#2440 — the surviving icon is IN the collision pass, not a phantom', () => {
  it('the text-optional icon seeds an obstacle box that blocks a different-group label', () => {
    const { stage } = makeStage()
    stage.beginFrame()
    stage.addLabel(
      litValue('Airport'),
      {},
      10,
      10,
      pointDef({ textOptional: true }),
      undefined,
      undefined,
      'airport:1',
    )
    const icons = makeIconStub()
    icons.addIcon(10, 10, 'airport_11', { collide: true, pairKey: 'airport:1' })

    const obstacles = icons.computeObstacles(stage.getActiveTextPairKeys()) as CollisionObstacle[]
    // fail-before: the pairKey is still live, computeObstacles skips it, and
    // this is length 0 — the phantom.
    expect(obstacles).toHaveLength(1)
    expect(obstacles[0]!.groupKey).toBe('airport:1')

    const road: CollisionItem = { bboxes: [box(5, 5)], groupKey: 'road:9' }
    expect(greedyPlaceBboxes([road], { obstacles })[0]!.placed).toBe(false)
  })

  it('the SAME icon paired to a plain label seeds nothing (control — #609 preserved)', () => {
    const { stage } = makeStage()
    stage.beginFrame()
    stage.addLabel(litValue('Cafe'), {}, 10, 10, pointDef(), undefined, undefined, 'poi:1')
    const icons = makeIconStub()
    icons.addIcon(10, 10, 'cafe_11', { collide: true, pairKey: 'poi:1' })

    const obstacles = icons.computeObstacles(stage.getActiveTextPairKeys()) as CollisionObstacle[]
    expect(obstacles).toHaveLength(0)
  })

  it('the box still does not block its OWN text (same groupKey)', () => {
    // The obstacle carries groupKey = pairKey, and greedyPlaceBboxes exempts a
    // label of the obstacle's own group (#609 layer 1). Without this the fix
    // would make a text-optional label unplaceable BY ITS OWN ICON — the label
    // could then never win, which is the opposite of what the property asks.
    const icons = makeIconStub()
    icons.addIcon(10, 10, 'airport_11', { collide: true, pairKey: 'airport:1' })
    const obstacles = icons.computeObstacles(new Set<string>()) as CollisionObstacle[]
    const ownText: CollisionItem = { bboxes: [box(5, 5)], groupKey: 'airport:1' }
    expect(greedyPlaceBboxes([ownText], { obstacles })[0]!.placed).toBe(true)
  })
})

// The write site. Two consumers read one predicate; a fix that changed only the
// live-text set would leave the icon dropped anyway.
describe('#2440 — a rejected text-optional label does not stamp the drop cascade', () => {
  it('the loser stamps its pairKey when it is NOT text-optional (control)', () => {
    const { stage, captured } = makeStage()
    stage.beginFrame()
    // Overlapping pair: the LATER label wins, the earlier is rejected
    // (prepare-collision-wiring.test.ts pins this precedence).
    stage.addLabel(litValue('L'), {}, 100, 100, pointDef(), undefined, undefined, 'k')
    stage.addLabel(litValue('W'), {}, 108, 100, pointDef(), undefined, undefined, 'w')
    stage.prepare()
    expect(captured[0]!.length, 'exactly one label survives the overlap').toBe(1)
    expect(stage.getDroppedPairKeys().has('k')).toBe(true)
  })

  it('the same loser does NOT stamp when it IS text-optional', () => {
    const { stage, captured } = makeStage()
    stage.beginFrame()
    stage.addLabel(
      litValue('L'),
      {},
      100,
      100,
      pointDef({ textOptional: true }),
      undefined,
      undefined,
      'k',
    )
    stage.addLabel(litValue('W'), {}, 108, 100, pointDef(), undefined, undefined, 'w')
    stage.prepare()
    // Same collision as the control — the label still loses and still does not
    // draw. Only the CASCADE is suppressed, so its icon survives.
    expect(captured[0]!.length, 'the text-optional label still loses the overlap').toBe(1)
    expect(stage.getDroppedPairKeys().has('k')).toBe(false)
    expect(stage.getDroppedPairKeys().has('w')).toBe(false)
  })
})
