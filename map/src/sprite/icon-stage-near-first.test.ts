// Near-first collision for #417 line-placement icons (the icon sibling of the
// #1249 text-label near-first fix).
//
// prepare()'s #417 overlap pass iterated `this.pending` in DISPATCH order and
// dropped a `collide` icon whose padded box overlapped an already-placed one.
// That is depth-blind: on a pitched view the FAR arrow (dispatched first, or
// lower-on-screen anchorY) claimed the box and the NEAR arrow vanished — the
// same wrong-occlusion direction #1249 fixed for text. Icons place near-first
// now: within the overlap pass the larger-anchorY (nearer under pitch) collide
// icon wins, and equal-Y ties keep dispatch order (byte-identical to before).
//
// Draw (painter) order is unchanged — survivors are emitted in dispatch order;
// only WHICH collide icon survives an overlap changed. Same Object.create stub
// as icon-stage-padding.test.ts (no WebGPU device).

import { describe, it, expect } from 'vitest'
import { IconStage } from './icon-stage'

interface Draw {
  anchorX: number
  anchorY: number
}

function makeStage(dpr = 1): { stage: IconStage; draws: Draw[] } {
  const stage = Object.create(IconStage.prototype) as IconStage
  const draws: Draw[] = []
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
    renderer: { setDraws(d: Draw[]): void }
  }
  s.pending = []
  s.inlineImages = []
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

// 10px sprite, dpr 1 → half-extent 5; default pad 2 → collision box half-extent
// 7. Icons at the same X and ΔY = 10 overlap in Y ([3,7]) and fully in X.
describe('IconStage — #417 collide-icon near-first', () => {
  it('the nearer (larger anchorY) collide icon wins the overlap, not dispatch-first', () => {
    // Dispatch FAR (y=0) first, NEAR (y=10) second. RED before the fix:
    // dispatch-first wins → far (y=0) survives, near dropped.
    const { stage, draws } = makeStage()
    stage.addIcon(0, 0, 'far', { collide: true })
    stage.addIcon(0, 10, 'near', { collide: true })
    stage.prepare()
    expect(draws.length).toBe(1)
    expect(draws[0]!.anchorY).toBe(10) // near survived
  })

  it('winner is dispatch-order invariant (near wins regardless of add order)', () => {
    const { stage, draws } = makeStage()
    stage.addIcon(0, 10, 'near', { collide: true })
    stage.addIcon(0, 0, 'far', { collide: true })
    stage.prepare()
    expect(draws.length).toBe(1)
    expect(draws[0]!.anchorY).toBe(10)
  })

  it('equal-Y overlap keeps dispatch order (byte-identical to pre-fix)', () => {
    // Same Y, ΔX = 8 < 10 → overlap. Dispatch-first (x=0) wins, as before.
    const { stage, draws } = makeStage()
    stage.addIcon(0, 0, 'a', { collide: true })
    stage.addIcon(8, 0, 'b', { collide: true })
    stage.prepare()
    expect(draws.length).toBe(1)
    expect(draws[0]!.anchorX).toBe(0)
  })

  it('survivors keep dispatch DRAW order (painter order unchanged)', () => {
    // Three collide icons: two overlap (near wins), one separate. The two
    // survivors must emit in dispatch (anchorX-ascending here) order.
    const { stage, draws } = makeStage()
    stage.addIcon(0, 0, 'far', { collide: true }) // overlaps next, dropped
    stage.addIcon(0, 10, 'near', { collide: true }) // near wins
    stage.addIcon(100, 0, 'right', { collide: true }) // separate, survives
    stage.prepare()
    expect(draws.map((d) => `${d.anchorX},${d.anchorY}`)).toEqual(['0,10', '100,0'])
  })

  it('non-collide icons are never dropped (allow-overlap point dots, #419)', () => {
    // Two overlapping NON-collide icons at different Y: both survive, near-first
    // does not touch them.
    const { stage, draws } = makeStage()
    stage.addIcon(0, 0, 'dotA', { collide: false })
    stage.addIcon(0, 10, 'dotB', { collide: false })
    stage.prepare()
    expect(draws.length).toBe(2)
  })

  it('a collide icon whose paired text was dropped does not block the near arrow', () => {
    // The pairKey-dropped far icon must NOT seed a blocker box (mirrors the
    // emit-loop skip order): the near collide icon still places.
    const { stage, draws } = makeStage()
    ;(stage as unknown as { droppedPairKeys: Set<string> }).droppedPairKeys = new Set(['p'])
    stage.addIcon(0, 0, 'far', { collide: true, pairKey: 'p' }) // dropped (paired text gone)
    stage.addIcon(0, 10, 'near', { collide: true })
    stage.prepare()
    expect(draws.length).toBe(1)
    expect(draws[0]!.anchorY).toBe(10)
  })
})

// Determinism on the Y-tie (the icon twin of the text #728 fix). On a flat
// road the arrow chain shares one screen Y, so near-first ties them all and
// they fall back to the collision tie-break. A STABLE collisionId must decide
// the survivor so it does not flip with tile-dispatch (I/O) order on pan.
describe('IconStage — collide-icon Y-tie determinism (#728 sibling)', () => {
  // survivor of two SAME-Y overlapping collide icons (ΔX 6 < 10 → overlap),
  // identified by anchorX. Returns the survivor's x for a given dispatch order.
  const survivorX = (order: 'ab' | 'ba'): number => {
    const { stage, draws } = makeStage()
    const A = () => stage.addIcon(0, 0, 'A', { collide: true, collisionId: 'route-a' })
    const B = () => stage.addIcon(6, 0, 'B', { collide: true, collisionId: 'route-b' })
    if (order === 'ab') {
      A()
      B()
    } else {
      B()
      A()
    }
    stage.prepare()
    expect(draws.length).toBe(1)
    return draws[0]!.anchorX
  }

  it('the lower collisionId survives regardless of dispatch order', () => {
    // RED before the fix: the Y-tie fell back to dispatch index, so 'ab' kept A
    // (x=0) and 'ba' kept B (x=6) — a pan-order-dependent flip. With the stable
    // tie-break 'route-a' < 'route-b' wins in BOTH orders.
    expect(survivorX('ab')).toBe(0) // A (route-a)
    expect(survivorX('ba')).toBe(0) // A (route-a) — still, order-invariant
  })

  it('without a collisionId, ties keep dispatch order (byte-identical fallback)', () => {
    // Neither carries a collisionId → the pre-determinism dispatch fallback:
    // whoever is dispatched first claims the box.
    const { stage, draws } = makeStage()
    stage.addIcon(0, 0, 'first', { collide: true })
    stage.addIcon(6, 0, 'second', { collide: true })
    stage.prepare()
    expect(draws.length).toBe(1)
    expect(draws[0]!.anchorX).toBe(0) // dispatch-first
  })

  it('near-first still dominates the tie-break (different Y beats collisionId)', () => {
    // A stable id must NOT override depth: the nearer (larger Y) icon wins even
    // when its collisionId sorts later.
    const { stage, draws } = makeStage()
    stage.addIcon(0, 0, 'farLowId', { collide: true, collisionId: 'route-a' }) // far, low id
    stage.addIcon(0, 10, 'nearHighId', { collide: true, collisionId: 'route-z' }) // near, high id
    stage.prepare()
    expect(draws.length).toBe(1)
    expect(draws[0]!.anchorY).toBe(10) // near wins despite the higher id
  })
})
