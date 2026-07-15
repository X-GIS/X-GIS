// #777 cluster I-D — IconStage per-icon collision padding.
//
// prepare()'s #417 line-icon overlap AABB inflated every collide-icon box by a
// FIXED `2 * dpr` (icon-stage.ts:290). I-D replaces that constant with the
// per-icon `padding` opt threaded from LabelDef.iconPadding, so a symbol layer's
// `icon-padding` actually changes which icons collide. Absent padding defaults
// to 2 → byte-identical to the old constant.
//
// Geometry: a 10px sprite (pixelRatio 1) at dpr 1 → half-width 5. Two collide
// icons Δ apart overlap iff Δ < 10 + 2·pad, i.e. iff pad > (Δ-10)/2. At Δ=18:
//   pad 2 (default) → 2 > 4 is false → both placed (draws = 2)
//   pad 7           → 7 > 4 is true  → 2nd dropped (draws = 1)
// The placement verdict flips with the property — that IS the :290 replacement
// showing through. Constructed via the Object.create stub (icon-stage-reset.test
// pattern) so no WebGPU device is needed.

import { describe, it, expect } from 'vitest'
import { IconStage } from './icon-stage'

function makeStage(dpr = 1): { stage: IconStage; draws: { anchorX: number }[] } {
  const stage = Object.create(IconStage.prototype) as IconStage
  const draws: { anchorX: number }[] = []
  const s = stage as unknown as {
    pending: unknown[]
    inlineImages: unknown[]
    _iconDump: null
    _iconDebugHook: null
    dpr: number
    droppedPairKeys: Set<string>
    missingIconNames: Set<string>
    dispatchedIconNames: Set<string>
    host: {
      get(n: string): { width: number; height: number; pixelRatio: number }
      getState(): { status: string }
    }
    renderer: { setDraws(d: { anchorX: number }[]): void }
  }
  s.pending = []
  s.inlineImages = [] // #777 I-G — prepare() reads it (constructor bypassed by the stub)
  s._iconDump = null
  s._iconDebugHook = null
  s.dpr = dpr
  s.droppedPairKeys = new Set()
  s.missingIconNames = new Set()
  s.dispatchedIconNames = new Set()
  s.host = {
    get: () => ({ width: 10, height: 10, pixelRatio: 1 }),
    getState: () => ({ status: 'loaded' }),
  }
  s.renderer = {
    setDraws: (d) => {
      draws.length = 0
      draws.push(...d)
    },
  }
  return { stage, draws }
}

// Two collide icons 18px apart; return how many survive prepare()'s AABB.
function placedCount(padding: number | undefined): number {
  const { stage, draws } = makeStage(1)
  stage.addIcon(0, 0, 'a', { collide: true, padding })
  stage.addIcon(18, 0, 'b', { collide: true, padding })
  stage.prepare()
  return draws.length
}

describe('IconStage — icon-padding collision box (#777 I-D)', () => {
  it('padding 7 inflates the box → 2nd icon collides and is dropped', () => {
    // RED before I-D: addIcon ignored `padding`, the box used the fixed 2 → the
    // icons never collided at Δ=18 → both placed (returns 2, not 1).
    expect(placedCount(7)).toBe(1)
  })

  it('padding 2 (spec default) → both placed — byte-identical to the old constant', () => {
    expect(placedCount(2)).toBe(2)
  })

  it('absent padding → defaults to 2 → both placed (byte-identical)', () => {
    expect(placedCount(undefined)).toBe(2)
  })

  it('padding 20 collides icons that padding 2 keeps apart (verdict flips with the value)', () => {
    // Δ=18: pad 20 > 4 → collide (1); pad 2 not > 4 → both (2).
    expect(placedCount(20)).toBe(1)
    expect(placedCount(2)).toBe(2)
  })
})
