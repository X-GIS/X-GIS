// ═══ text-translate is out of the layout cache and out of its key (#2170) ═══
//
// #2170's converter half landed in #2252: an ABSENT `text-translate-anchor` now
// means the spec default `map`, so a bearing-rotated translate is the DEFAULT
// for every symbol layer authoring `text-translate` rather than an opt-in.
//
// That flip has a cost the issue had deferred for, and this file removes it.
// The layout cache used to fold the bearing-rotated translate into the cached
// `dx`/`dy` and pass it as two terms of `layoutCacheKey`, so a rotating camera
// re-keyed every map-anchored label every frame — an all-miss, LRU-evicting
// re-shape. The translate is a rigid translation of the whole block applied
// after the layout, and nothing the entry stores depends on it (bboxMetrics is
// {totalAdvance, blockTop, blockBottom, padding}; glyphOffsets are deltas from
// the draw anchor; the collision box is derived from drawX/drawY at BOTH the
// hit and miss sites), so it belongs at the draw sites instead.
//
// Two properties, two gates:
//   1. the key is bearing-invariant, so a rotation HITS — and the hit is not
//      stale, i.e. the offset still moves with the bearing;
//   2. the moved term is PARENTHESISED, because dropping the parens silently
//      shifts ~30% of labels by 1 ULP (see the second describe).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
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

const ANCHOR_X = 200
const ANCHOR_Y = 300
const TRANSLATE: [number, number] = [10, 0]

/** One map-anchored label at `bearing`; returns its draw anchor. */
function frameAt(
  stage: TextStage,
  captured: TextDraw[][],
  bearing: number,
): { x: number; y: number } {
  stage.setBearing(bearing)
  stage.beginFrame()
  stage.addLabel(
    litValue('Seoul'),
    {},
    ANCHOR_X,
    ANCHOR_Y,
    pointDef({ text: litValue('Seoul'), translate: TRANSLATE, translateAnchorMap: true }),
  )
  stage.prepare()
  const draws = captured[captured.length - 1]!
  expect(draws.length, 'exactly one label per frame').toBe(1)
  return { x: draws[0]!.anchorX, y: draws[0]!.anchorY }
}

describe('#2170 — a bearing change no longer re-keys a map-anchored label', () => {
  it('the second bearing HITS the layout cache, and the hit is not stale', () => {
    const { stage, captured } = makeStage()

    const a = frameAt(stage, captured, 0)
    const afterFirst = stage.getLayoutCacheStats()
    expect(afterFirst.misses, 'the first frame must shape it once').toBeGreaterThan(0)

    const b = frameAt(stage, captured, 90)
    const afterSecond = stage.getLayoutCacheStats()

    // THE PERF PROPERTY, asserted on MISSES rather than hits. Hits is the
    // wrong quantity: it can rise for reasons unrelated to this key term, so
    // `hits went up` passes whether or not the key is bearing-invariant —
    // measured, by putting the terms back and watching that form stay green.
    // "The second frame shaped nothing new" is the property, and only the
    // miss counter says it.
    expect(
      afterSecond.misses,
      'a bearing change re-keyed the layout cache — the rotated translate is a key term again, so every map-anchored label re-shapes on every frame of a rotation',
    ).toBe(afterFirst.misses)
    expect(afterSecond.hits, 'and it was served from the cache').toBeGreaterThan(afterFirst.hits)

    // AND THE HIT IS NOT STALE. A cache that returns the bearing-0 entry is
    // only correct because the translate is applied AFTER the lookup; if the
    // hoist were wrong, this label would stop moving with the bearing and the
    // gate above would be measuring a bug rather than a fix.
    expect(a.x, 'bearing 0: [10,0] unrotated').toBeCloseTo(ANCHOR_X + 10, 4)
    expect(a.y).toBeCloseTo(ANCHOR_Y, 4)
    expect(b.x, 'bearing 90: rotated out of X').toBeCloseTo(ANCHOR_X, 4)
    expect(b.y, 'bearing 90: rotated into +Y').toBeCloseTo(ANCHOR_Y + 10, 4)
  })

  it('two labels differing ONLY in their translate share one entry', () => {
    // The same property from the other side: the translate is no longer part
    // of the identity of a layout, so it cannot fragment the cache.
    const { stage, captured } = makeStage()
    const push = (t: [number, number]): void => {
      stage.setBearing(0)
      stage.beginFrame()
      stage.addLabel(
        litValue('Seoul'),
        {},
        ANCHOR_X,
        ANCHOR_Y,
        pointDef({ text: litValue('Seoul'), translate: t, translateAnchorMap: true }),
      )
      stage.prepare()
    }
    push([10, 0])
    const one = stage.getLayoutCacheStats().entries
    push([37, -19])
    const two = stage.getLayoutCacheStats().entries
    expect(
      two,
      'a different text-translate allocated a second cache entry — the translate is keying the layout again',
    ).toBe(one)
    expect(captured[captured.length - 1]![0]!.anchorX, 'and the second offset still applies').toBe(
      ANCHOR_X + 37,
    )
  })
})

// ─── The parentheses at the two draw sites ──────────────────────────────────

const STAGE_SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'text-stage.ts'),
  'utf8',
)

describe('#2170 — the moved term is grouped, so the hoist is bit-identical', () => {
  it('IEEE-754 addition is not associative on this domain — the instrument can see it', () => {
    // Validate the instrument against a known positive BEFORE trusting the
    // source assertion below: if these operands were dyadic the two forms
    // would agree and the whole concern would be untestable. That is exactly
    // the blind spot of the two existing wiring tests, whose operands
    // (ANCHOR_X 200/600, TRANSLATE [10,0]/[17,-29], dpr 1) are all dyadic.
    const a = 1814 // anchorX, physical px
    const b = -92.55341749904129 // -totalAdvance / 2
    const c = 10 * Math.cos(Math.PI / 7) // a bearing-rotated txRaw * dpr
    expect(
      Object.is(a + b + c, a + (b + c)),
      'these operands are dyadic, so this file cannot detect a regrouping — pick non-dyadic ones',
    ).toBe(false)
    // And the grouped form is what the pre-hoist two-step computed:
    //   dx += c   (b ⊕ c)   then   drawX = a + dx   (a ⊕ (b ⊕ c))
    let dx = b
    dx += c
    expect(Object.is(a + dx, a + (b + c))).toBe(true)
  })

  it('both draw sites group the translate with dx, not with the anchor', () => {
    // Fail-before: drop either pair of parentheses and the site computes
    // (a ⊕ b) ⊕ c, which differs from every frame drawn before this change on
    // ~30% of labels in the bearing-rotated domain (measured, 200k draws).
    for (const site of [
      'const drawX = p.anchorX + (hit.dx + txRaw * dpr)',
      'const drawY = p.anchorY + (hit.dy + tyRaw * dpr)',
      'const drawX = p.anchorX + (dx + txRaw * dpr)',
      'const drawY = p.anchorY + (dy + tyRaw * dpr)',
    ]) {
      expect(
        STAGE_SRC.includes(site),
        `text-stage.ts must compute \`${site}\` — ungrouped, JS's left-associative + reassociates the sum and shifts the draw anchor by 1 ULP against every frame drawn before #2170`,
      ).toBe(true)
    }
  })
})
