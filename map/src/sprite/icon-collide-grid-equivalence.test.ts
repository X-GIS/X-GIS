// The #417 collide-icon overlap pass is greedy first-wins over a near-first
// ordering. Its "does this padded box overlap an already-placed one" query used
// to scan every placed box (O(k²), 10.8 ms for 3000 mutually-crowded arrows);
// it now goes through a uniform grid. The grid is an ACCELERATOR, not a policy
// change — this pins that: over randomised scenes (mixed sprite sizes, mixed
// icon-padding, mixed anchorY ties, unresolved candidates) the surviving icon
// set must equal the brute-force greedy result exactly.
//
// Same Object.create stub as icon-stage-near-first.test.ts (no WebGPU device).

import { describe, it, expect } from 'vitest'
import { IconStage } from './icon-stage'

interface Draw {
  anchorX: number
  anchorY: number
}

interface Spec {
  x: number
  y: number
  name: string
  size: number
  padding: number
  fadeId?: string
}

const SPRITES: Record<string, { width: number; height: number; pixelRatio: number }> = {
  small: { width: 8, height: 8, pixelRatio: 1 },
  wide: { width: 40, height: 10, pixelRatio: 1 },
  tall: { width: 10, height: 40, pixelRatio: 1 },
  hidpi: { width: 30, height: 30, pixelRatio: 2 },
}

function makeStage(dpr: number): { stage: IconStage; draws: Draw[] } {
  const stage = Object.create(IconStage.prototype) as IconStage
  const draws: Draw[] = []
  const s = stage as unknown as Record<string, unknown>
  s.pending = []
  s.inlineImages = []
  s._iconDump = null
  s._iconDebugHook = null
  s.dpr = dpr
  s.droppedPairKeys = new Set()
  s.missingIconNames = new Set()
  s.dispatchedIconNames = new Set()
  s.host = {
    get: (n: string) => SPRITES[n],
    getState: () => ({ status: 'loaded' }),
  }
  s.renderer = {
    setDraws: (d: Draw[]) => {
      draws.length = 0
      for (const one of d) draws.push(one)
    },
  }
  return { stage, draws }
}

/** The pre-grid algorithm, transcribed: near-first order (larger anchorY wins,
 *  fadeId then dispatch index breaks ties), greedy first-wins over a full scan
 *  of the already-placed padded boxes. Returns the surviving dispatch indices. */
function bruteForceSurvivors(specs: Spec[], dpr: number): number[] {
  const order = specs.map((_, i) => i)
  order.sort((a, b) => {
    const pa = specs[a]!
    const pb = specs[b]!
    if (pa.y !== pb.y) return pb.y - pa.y
    const ca = pa.fadeId
    const cb = pb.fadeId
    if (ca !== undefined && cb !== undefined && ca !== cb) return ca < cb ? -1 : 1
    return a - b
  })
  const placed: { minX: number; minY: number; maxX: number; maxY: number }[] = []
  const dropped = new Set<number>()
  for (const i of order) {
    const p = specs[i]!
    const sprite = SPRITES[p.name]
    if (!sprite) continue // unresolved: never blocks, never drops
    const sizeScale = p.size * dpr
    const cdW = (sprite.width / sprite.pixelRatio) * sizeScale
    const cdH = (sprite.height / sprite.pixelRatio) * sizeScale
    const pad = p.padding * dpr
    const minX = p.x - cdW / 2 - pad
    const maxX = p.x + cdW / 2 + pad
    const minY = p.y - cdH / 2 - pad
    const maxY = p.y + cdH / 2 + pad
    let overlaps = false
    for (const b of placed) {
      if (minX < b.maxX && maxX > b.minX && minY < b.maxY && maxY > b.minY) {
        overlaps = true
        break
      }
    }
    if (overlaps) {
      dropped.add(i)
      continue
    }
    placed.push({ minX, minY, maxX, maxY })
  }
  return specs.map((_, i) => i).filter((i) => !dropped.has(i))
}

/** Deterministic PRNG so a failure is reproducible from the seed alone. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

function scene(seed: number, n: number, spreadPx: number): Spec[] {
  const r = rng(seed)
  const names = ['small', 'wide', 'tall', 'hidpi', 'missing']
  const out: Spec[] = []
  for (let i = 0; i < n; i++) {
    // Quantised anchorY on a coarse grid so same-Y ties (a flat road's arrow
    // chain — the case the fadeId tie-break exists for) actually occur.
    out.push({
      x: Math.round(r() * spreadPx),
      y: Math.round(r() * 12) * 40,
      name: names[Math.floor(r() * names.length)]!,
      size: 0.5 + r() * 1.5,
      padding: Math.floor(r() * 4),
      ...(r() < 0.7 ? { fadeId: `f${Math.floor(r() * 50)}` } : {}),
    })
  }
  return out
}

/** Anchors stepped by EXACTLY one padded-box extent, so consecutive boxes TOUCH
 *  (or miss touching by a hair). Random floats never land in this regime, yet it
 *  is the shape of the real input — a chain of identical arrows at a regular
 *  `symbol-spacing` pitch — and it is where the overlap predicate's strictness
 *  decides the whole chain: `minX < b.maxX` is false for a perfect touch, so all
 *  of them survive, while an inclusive `<=` collapses every second one. The
 *  randomised scenes above pass either way; these do not. */
function touchingScene(seed: number, n: number, vertical: boolean): Spec[] {
  const r = rng(seed)
  const name = (['small', 'wide', 'tall', 'hidpi'] as const)[Math.floor(r() * 4)]!
  const sprite = SPRITES[name]!
  const size = 0.25 + r() * 2
  const padding = Math.floor(r() * 4)
  const dpr = seed % 3 === 0 ? 2 : 1
  const ss = size * dpr
  const extent = ((vertical ? sprite.height : sprite.width) / sprite.pixelRatio) * ss
  const pitch = extent / 2 + padding * dpr + (extent / 2 + padding * dpr)
  // Jitter each step by a few ULP either way so the chain straddles the exact
  // touch instead of only landing on it.
  const JITTER = [0, 1e-12, -1e-12, 1e-9, -1e-9, 1e-6, -1e-6]
  const out: Spec[] = []
  let at = 300
  for (let i = 0; i < n; i++) {
    out.push({
      x: vertical ? 500 : at,
      y: vertical ? at : 500,
      name,
      size,
      padding,
      ...(r() < 0.5 ? { fadeId: `f${i}` } : {}),
    })
    at += pitch + JITTER[Math.floor(r() * JITTER.length)]!
  }
  return out
}

describe('IconStage — collide-overlap grid equals the brute-force greedy pass', () => {
  for (const [label, n, spread] of [
    ['sparse', 40, 4000],
    ['crowded', 250, 600],
    ['pile-up', 400, 200],
  ] as const) {
    it(`${label}: identical survivors across 40 randomised scenes`, () => {
      for (let seed = 1; seed <= 40; seed++) {
        const dpr = seed % 3 === 0 ? 2 : 1
        const specs = scene(seed, n, spread)
        const { stage, draws } = makeStage(dpr)
        for (const p of specs) {
          stage.addIcon(p.x, p.y, p.name, {
            sizeScale: p.size,
            padding: p.padding,
            collide: true,
            ...(p.fadeId !== undefined ? { fadeId: p.fadeId } : {}),
          })
        }
        stage.prepare()
        // Survivors, in dispatch (painter) order — resolved sprites only, since
        // an unresolved name never reaches the draw list.
        const expected = bruteForceSurvivors(specs, dpr).filter((i) => SPRITES[specs[i]!.name])
        expect(
          draws.map((d) => `${d.anchorX},${d.anchorY}`),
          `seed ${seed}`,
        ).toEqual(expected.map((i) => `${specs[i]!.x},${specs[i]!.y}`))
      }
    })
  }

  for (const vertical of [false, true]) {
    it(`${vertical ? 'vertical' : 'horizontal'} chains at exactly the box pitch: identical survivors across 60 scenes`, () => {
      for (let seed = 1; seed <= 60; seed++) {
        const dpr = seed % 3 === 0 ? 2 : 1
        const specs = touchingScene(seed, 24, vertical)
        const { stage, draws } = makeStage(dpr)
        for (const p of specs) {
          stage.addIcon(p.x, p.y, p.name, {
            sizeScale: p.size,
            padding: p.padding,
            collide: true,
            ...(p.fadeId !== undefined ? { fadeId: p.fadeId } : {}),
          })
        }
        stage.prepare()
        const expected = bruteForceSurvivors(specs, dpr)
        expect(
          draws.map((d) => `${d.anchorX},${d.anchorY}`),
          `seed ${seed}`,
        ).toEqual(expected.map((i) => `${specs[i]!.x},${specs[i]!.y}`))
      }
    })
  }

  it('a box far outside the viewport still blocks its overlapping twin', () => {
    // Negative / large cell coordinates exercise the key packing.
    for (const [x, y] of [
      [-9_000, -4_000],
      [250_000, 180_000],
    ] as const) {
      const { stage, draws } = makeStage(1)
      stage.addIcon(x, y, 'small', { collide: true })
      stage.addIcon(x + 2, y, 'small', { collide: true })
      stage.addIcon(x + 400, y, 'small', { collide: true })
      stage.prepare()
      expect(draws.length).toBe(2)
    }
  })
})
