// #417 — line-icon overlap collision invariant.
//
// User-reported bug: OFM one-way road arrows render DOUBLED — two
// side-by-side arrow chains where MapLibre shows one. ROOT: two parallel
// road features (the road's two edges, ~9-13px apart on screen) each emit
// a road_oneway arrow chain, and X-GIS had no icon-collision grid so both
// chains drew. MapLibre's symbol collision drops the overlapping second
// chain.
//
// FIX: IconStage.prepare() runs a per-frame AABB overlap test over icons
// flagged `collide` (symbol-placement:line, text-less — see label-pass
// dispatchIcon). An icon whose icon-padding box overlaps an already-placed
// collide-icon is dropped. POINT-placement dots leave `collide` false and
// are never tested → preserves #419 (place-dot blink).
//
// This test drives prepare() WITHOUT WebGPU via Object.create + stubbed
// host/renderer (same pattern as icon-paired-position.test.ts), capturing
// the survivor draws handed to renderer.setDraws.

import { describe, it, expect } from 'vitest'
import { IconStage } from './icon-stage'
import type { IconDraw } from './icon-renderer'

const SPRITE = { width: 20, height: 20, pixelRatio: 1 }

function makeStub(dpr = 1): { stage: IconStage; draws: () => IconDraw[] } {
  let captured: IconDraw[] = []
  const stage = Object.create(IconStage.prototype) as IconStage
  ;(stage as unknown as { pending: unknown[] }).pending = []
  ;(stage as unknown as { dpr: number }).dpr = dpr
  ;(stage as unknown as { missingIconNames: Set<string> }).missingIconNames = new Set()
  ;(stage as unknown as { dispatchedIconNames: Set<string> }).dispatchedIconNames = new Set()
  ;(stage as unknown as { droppedPairKeys: Set<string> }).droppedPairKeys = new Set()
  ;(stage as unknown as { _iconDump: null })._iconDump = null
  ;(stage as unknown as { _iconDebugHook: null })._iconDebugHook = null
  ;(stage as unknown as { host: unknown }).host = {
    getState: () => ({ status: 'loaded' }),
    get: () => SPRITE,
  }
  ;(stage as unknown as { renderer: unknown }).renderer = {
    setDraws: (d: IconDraw[]) => { captured = d },
  }
  return { stage, draws: () => captured }
}

describe('#417 — line-icon overlap collision', () => {
  it('FAIL-BEFORE: two OVERLAPPING collide-icons collapse to one (the doubling fix)', () => {
    // Sprite 20px @pr1, dpr1 → box half-width 10 + pad 2 = 12 reach.
    // Anchors 10px apart → boxes [88,112] and [98,122] overlap → drop 2nd.
    const { stage, draws } = makeStub()
    stage.addIcon(100, 100, 'oneway', { collide: true })
    stage.addIcon(110, 100, 'oneway', { collide: true })
    stage.prepare()
    expect(draws().length).toBe(1)
    expect(draws()[0]!.anchorX).toBe(100) // first-placed wins
  })

  it('non-overlapping collide-icons both survive (spacing along a single chain)', () => {
    // 100px apart → boxes [88,112] and [188,212] disjoint → both kept.
    const { stage, draws } = makeStub()
    stage.addIcon(100, 100, 'oneway', { collide: true })
    stage.addIcon(200, 100, 'oneway', { collide: true })
    stage.prepare()
    expect(draws().length).toBe(2)
  })

  it('OVERLAPPING non-collide icons BOTH survive — point dots untouched (#419 preserved)', () => {
    const { stage, draws } = makeStub()
    stage.addIcon(100, 100, 'circle_11_black') // collide defaults false
    stage.addIcon(105, 100, 'circle_11_black')
    stage.prepare()
    expect(draws().length).toBe(2)
  })

  it('a collide-icon is NOT blocked by a prior NON-collide icon at the same spot', () => {
    // Non-collide icons never enter the placed-box grid, so they can
    // neither block nor be blocked — only collide-vs-collide collides.
    const { stage, draws } = makeStub()
    stage.addIcon(100, 100, 'circle_11_black') // not in grid
    stage.addIcon(100, 100, 'oneway', { collide: true }) // first collide → placed
    stage.prepare()
    expect(draws().length).toBe(2)
  })

  it('collision is dpr-scaled — boxes grow with dpr so the same world spacing still collides', () => {
    // dpr 2 → box half (10*2) + pad (2*2) = 24 reach. Anchors here are
    // PHYSICAL px (already dpr-multiplied upstream): 30px apart → boxes
    // [-28,28]+100 etc. overlap → 2nd dropped.
    const { stage, draws } = makeStub(2)
    stage.addIcon(100, 100, 'oneway', { collide: true })
    stage.addIcon(130, 100, 'oneway', { collide: true })
    stage.prepare()
    expect(draws().length).toBe(1)
  })
})
