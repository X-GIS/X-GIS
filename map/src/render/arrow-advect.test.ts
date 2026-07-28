// ═══ The arrow-advection properties no frame can reveal (#1409) ═══
//
// An arrow field that animates smoothly and is WRONG looks exactly like one that is right:
// glyphs drift, nothing throws. Every gate here is a property no frame reveals.
//
// The load-bearing one is THE POSITION ENCODING. An arrow's grid-uv coordinate is written by
// the CPU seed (arrow-advect-state.ts) and by the update shader's `encode_arrow_pos`, and read
// back by both `decode_arrow_pos` and the arrow VS. If any one of them disagrees about channel
// order or the 255 divisor, the arrows advect correctly and are DRAWN somewhere else — which
// reads as a placement bug, not an encoding one. So they are pinned against one another rather
// than each against itself.

import { describe, it, expect } from 'vitest'
import {
  ARROW_ADVECT_TEX_DIM,
  ARROW_ADVECT_COUNT,
  encodeArrowPosition,
  decodeArrowPosition,
  seedArrowPositions,
  ArrowAdvectState,
} from './arrow-advect-state'
import { emitArrowAdvectWgsl, emitArrowAdvectGlsl } from '../shaders/dsl/arrow-advect-step'
import type { RhiDevice } from '@xgis/engine'

describe('arrow position encoding — the CPU/GPU agreement', () => {
  it('CPU encode → CPU decode round-trips to better than a grid cell', () => {
    // 16 bits across two channels. On a 596-cell CBOFS row, 1/65535 of the span is ~1/110 of a
    // cell — far below anything the trail buffer can resolve, so quantization can never be the
    // reason a particle appears to be in the wrong place.
    const buf = new Uint8Array(4)
    for (const [x, y] of [
      [0, 0],
      [1e-6, 0.999999],
      [0.5, 0.5],
      [0.123456, 0.876543],
      [0.999998, 1e-9],
    ] as const) {
      encodeArrowPosition(x, y, buf, 0)
      const [rx, ry] = decodeArrowPosition(buf[0]!, buf[1]!, buf[2]!, buf[3]!)
      expect(Math.abs(rx - x), `x round-trip for ${x}`).toBeLessThan(1 / 32000)
      expect(Math.abs(ry - y), `y round-trip for ${y}`).toBeLessThan(1 / 32000)
    }
  })

  it('the update shader decodes with the same expression the CPU does', () => {
    // Channel order (b/a high, r/g low) and the 255 divisor, asserted as emitted TEXT on both
    // arms. The arrow VS will read the same state texture, so when it lands it must reuse this
    // exact `decode_arrow_pos` body rather than spelling its own — a second decode is how the
    // two would drift.
    const decodeBody = 'return vec2<f32>((c.z + (c.x / 255.0)), (c.w + (c.y / 255.0)));'
    const decodeBodyGl = 'return vec2((c.z + (c.x / 255.0)), (c.w + (c.y / 255.0)));'
    expect(emitArrowAdvectWgsl()).toContain(decodeBody)
    expect(emitArrowAdvectGlsl('fragment')).toContain(decodeBodyGl)

    // And the CPU twin computes that same expression. Evaluated, not eyeballed.
    const shaderDecode = (c: readonly number[]) => [c[2]! + c[0]! / 255, c[3]! + c[1]! / 255]
    const buf = new Uint8Array(4)
    encodeArrowPosition(0.371, 0.628, buf, 0)
    const norm = [buf[0]! / 255, buf[1]! / 255, buf[2]! / 255, buf[3]! / 255]
    const [sx, sy] = shaderDecode(norm)
    const [cx, cy] = decodeArrowPosition(buf[0]!, buf[1]!, buf[2]!, buf[3]!)
    expect(sx).toBeCloseTo(cx, 12)
    expect(sy).toBeCloseTo(cy, 12)
  })

  it('the update shader encodes with the exact inverse of that decode', () => {
    // high = floor(p·255)/255, low = fract(p·255). Emitted as text because getting this
    // backwards (low and high swapped) still produces a bounded, plausible-looking field.
    expect(emitArrowAdvectWgsl()).toContain(
      'return vec4<f32>(fract(_v0.x), fract(_v0.y), (floor(_v0.x) / 255.0), (floor(_v0.y) / 255.0));',
    )
  })
})

describe('the arrow seed', () => {
  it('ARROW_ADVECT_COUNT is the square of the state-texture edge', () => {
    // The update pass runs one fragment per texel and the draw will index arrows by
    // `id % DIM` / `id / DIM`, so a count that is not the exact square would silently either
    // skip arrows or read past the texture.
    expect(ARROW_ADVECT_COUNT).toBe(ARROW_ADVECT_TEX_DIM * ARROW_ADVECT_TEX_DIM)
  })

  it('lands every arrow inside the domain', () => {
    const bytes = seedArrowPositions(ARROW_ADVECT_COUNT)
    expect(bytes).toHaveLength(ARROW_ADVECT_COUNT * 4)
    for (let i = 0; i < ARROW_ADVECT_COUNT; i++) {
      const [x, y] = decodeArrowPosition(
        bytes[i * 4]!,
        bytes[i * 4 + 1]!,
        bytes[i * 4 + 2]!,
        bytes[i * 4 + 3]!,
      )
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(1)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(1)
    }
  })

  it('SPREADS them — every cell of an 8×8 partition is occupied', () => {
    // The failure this forbids is a seed that is technically in-range but clumped (a bad LCG,
    // or a constant): the field would start as a blob of stacked arrows and take many seconds
    // of advection to look like anything, which reads as "the animation is broken".
    const bytes = seedArrowPositions(ARROW_ADVECT_COUNT)
    const buckets = new Set<number>()
    for (let i = 0; i < ARROW_ADVECT_COUNT; i++) {
      const [x, y] = decodeArrowPosition(
        bytes[i * 4]!,
        bytes[i * 4 + 1]!,
        bytes[i * 4 + 2]!,
        bytes[i * 4 + 3]!,
      )
      buckets.add(Math.min(7, Math.floor(x * 8)) * 8 + Math.min(7, Math.floor(y * 8)))
    }
    expect(buckets.size, 'all 64 buckets seeded').toBe(64)
  })

  it('is DETERMINISTIC — a render gate needs the same starting field every run', () => {
    expect(seedArrowPositions(256)).toEqual(seedArrowPositions(256))
  })
})

describe('ArrowAdvectState lifecycle', () => {
  function stub() {
    let id = 0
    const created: string[] = []
    const written: unknown[] = []
    const destroyed: unknown[] = []
    const rhi = {
      createTexture: (d: { label?: string }) => {
        created.push(d.label ?? '?')
        return { native: `tex${id++}` }
      },
      createView: (t: { native: string }) => ({ native: `view-${t.native}` }),
      writeTexture: (t: unknown) => void written.push(t),
      destroyTexture: (t: unknown) => void destroyed.push(t),
    }
    return { rhi: rhi as unknown as RhiDevice, created, written, destroyed }
  }

  it('SEEDS BOTH SIDES on allocation', () => {
    // A cleared position state is not merely ugly, it is degenerate: every arrow stacked at
    // grid-uv (0,0) forever. And seeding only the read side leaves the write side's undefined
    // contents visible for exactly one frame — a flash of arrows at garbage positions.
    const t = stub()
    new ArrowAdvectState().ensure(t.rhi)
    expect(t.created).toEqual(['arrow-advect-a', 'arrow-advect-b'])
    expect(t.written, 'both sides seeded').toHaveLength(2)
    expect(t.written[0]).not.toBe(t.written[1])
  })

  it('allocates ONCE — a re-ensure every frame must not reseed', () => {
    // Reseeding per frame would teleport all 16 384 arrows back to the lattice every frame: the
    // field would jitter in place instead of flowing, which reads as a rate bug.
    const t = stub()
    const p = new ArrowAdvectState()
    for (let i = 0; i < 5; i++) p.ensure(t.rhi)
    expect(t.created).toHaveLength(2)
    expect(t.written).toHaveLength(2)
  })

  it('does NOT resize with the coverage — grid-uv reinterprets against the new footprint', () => {
    // Positions are normalized, so a forecast step or a different region keeps the animation
    // continuous instead of restarting it. There is no size argument to get wrong.
    const t = stub()
    const p = new ArrowAdvectState()
    p.ensure(t.rhi)
    p.ensure(t.rhi)
    expect(t.created).toHaveLength(2)
  })

  it('reallocates on a device swap WITHOUT destroying through the dead device (#737)', () => {
    const a = stub()
    const b = stub()
    const p = new ArrowAdvectState()
    p.ensure(a.rhi)
    p.ensure(b.rhi)
    expect(a.destroyed, 'the old device is gone; its textures died with it').toEqual([])
    expect(b.created).toEqual(['arrow-advect-a', 'arrow-advect-b'])
  })

  it('swap() alternates the sides, and destroy() releases both', () => {
    const t = stub()
    const p = new ArrowAdvectState()
    p.ensure(t.rhi)
    const r0 = p.readView
    const w0 = p.writeView
    expect(r0).not.toEqual(w0)
    p.swap()
    expect(p.readView).toEqual(w0)
    expect(p.writeView).toEqual(r0)
    p.destroy()
    expect(t.destroyed).toHaveLength(2)
    expect(p.readView).toBeNull()
  })
})
