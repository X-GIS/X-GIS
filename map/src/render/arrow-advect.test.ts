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
  arrowAdvectDim,
  ARROW_ADVECT_MAX_COUNT,
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

const SEED_N = 128 * 128 // a representative field size; the seed is size-agnostic

describe('the arrow seed', () => {
  it('the edge HOLDS the count — never one texel short (#1450 A)', () => {
    // The draw indexes arrows by `inst % dim` / `inst / dim`, so an edge that does not cover
    // the count sends the tail instances reading past the texture: out-of-bounds
    // `textureLoad` returns 0 on WebGPU, i.e. every one of them collapses onto grid-uv (0,0).
    for (const n of [1, 2, 3, 4, 5, 16, 17, 16_384, 16_385, 69_700, 100_000]) {
      const dim = arrowAdvectDim(n)
      expect(dim * dim, `${n} arrows must fit in ${dim}x${dim}`).toBeGreaterThanOrEqual(n)
      expect(
        (dim - 1) * (dim - 1),
        `${n} must not fit in ${dim - 1}²  — no wasted row`,
      ).toBeLessThan(n)
    }
  })

  it('an empty batch allocates NOTHING — a 1x1 nobody reads is still a texture', () => {
    expect(arrowAdvectDim(0)).toBe(0)
    expect(arrowAdvectDim(-5)).toBe(0)
  })

  it('the bound stays — a global field wants instance generation, not a bigger texture', () => {
    const dim = arrowAdvectDim(ARROW_ADVECT_MAX_COUNT * 10)
    expect(dim * dim).toBeLessThan(ARROW_ADVECT_MAX_COUNT * 1.01)
  })

  it('lands every arrow inside the domain', () => {
    const bytes = seedArrowPositions(SEED_N)
    expect(bytes).toHaveLength(SEED_N * 4)
    for (let i = 0; i < SEED_N; i++) {
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
    const bytes = seedArrowPositions(SEED_N)
    const buckets = new Set<number>()
    for (let i = 0; i < SEED_N; i++) {
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

const N = 16_384 // a representative batch

describe('ArrowAdvectState lifecycle', () => {
  function stub() {
    let id = 0
    const created: string[] = []
    const written: unknown[] = []
    const destroyed: unknown[] = []
    const descs: Array<{ label?: string; usage: readonly string[]; width: number }> = []
    const rhi = {
      createTexture: (d: { label?: string; usage: readonly string[]; width: number }) => {
        created.push(d.label ?? '?')
        descs.push(d)
        return { native: `tex${id++}` }
      },
      createView: (t: { native: string }) => ({ native: `view-${t.native}` }),
      writeTexture: (t: unknown) => void written.push(t),
      destroyTexture: (t: unknown) => void destroyed.push(t),
    }
    return { rhi: rhi as unknown as RhiDevice, created, written, destroyed, descs }
  }

  it('SEEDS BOTH SIDES on allocation', () => {
    // A cleared position state is not merely ugly, it is degenerate: every arrow stacked at
    // grid-uv (0,0) forever. And seeding only the read side leaves the write side's undefined
    // contents visible for exactly one frame — a flash of arrows at garbage positions.
    const t = stub()
    new ArrowAdvectState().ensure(t.rhi, N)
    expect(t.created).toEqual(['arrow-advect-a', 'arrow-advect-b', 'arrow-advect-origin'])
    expect(t.written, 'both sides seeded').toHaveLength(2)
    expect(t.written[0]).not.toBe(t.written[1])
  })

  it('declares copy-dst on EVERY side — this module writes them all', () => {
    // A WebGPU-only crash, and one no render gate here could have caught: WebGL2 does not
    // validate texture usage, so the same writeTexture simply works under SwiftShader. WebGPU
    // rejects it — "Usage (TextureBinding|RenderAttachment) of [Texture "arrow-advect-a"]
    // doesn't include TextureUsage::CopyDst, while calling Queue.WriteTexture" — and the whole
    // arrow field dies at boot. The property is checkable without any GPU: a texture this
    // module seeds with writeTexture must declare that it is written.
    const t = stub()
    const p = new ArrowAdvectState()
    p.writeOrigins(t.rhi, 'k', Float32Array.from([0.5]), Float32Array.from([0.5]))
    expect(t.descs.length, 'both position sides and the origins').toBe(3)
    for (const d of t.descs) {
      expect(d.usage, `${d.label} is written by writeTexture`).toContain('copy-dst')
      expect(d.usage, `${d.label} is sampled`).toContain('sample')
    }
    // …and the pair really is written, so the requirement is not hypothetical.
    expect(t.written.length).toBeGreaterThan(0)
  })

  it('allocates ONCE — a re-ensure every frame must not reseed', () => {
    // Reseeding per frame would teleport every arrow back to the lattice every frame: the field
    // would jitter in place instead of flowing, which reads as a rate bug. The per-frame step
    // calls `ensure(rhi)` with NO count, which is what makes the remembered one load-bearing.
    const t = stub()
    const p = new ArrowAdvectState()
    p.ensure(t.rhi, N)
    for (let i = 0; i < 5; i++) p.ensure(t.rhi)
    expect(t.created).toHaveLength(3)
    expect(t.written).toHaveLength(2)
  })

  it('does not resize with the coverage GEOMETRY — grid-uv reinterprets against the footprint', () => {
    // Positions are normalized, so a forecast step or a different region keeps the animation
    // continuous instead of restarting it. Only the COUNT resizes it (#1450 A).
    const t = stub()
    const p = new ArrowAdvectState()
    p.ensure(t.rhi, N)
    p.ensure(t.rhi, N)
    expect(t.created).toHaveLength(3)
  })

  it('RESIZES with the count — and frees the old trio rather than holding both (#1450 A)', () => {
    // The count is what the 1:1 instance/texel contract is against: a bigger batch on the old
    // texture would send its tail instances reading out of bounds, which on WebGPU returns 0 —
    // every one of them collapsed onto grid-uv (0,0).
    const t = stub()
    const p = new ArrowAdvectState()
    p.ensure(t.rhi, 100)
    expect(t.descs.map((d) => d.width)).toEqual([10, 10, 10])
    p.ensure(t.rhi, 10_000)
    expect(t.destroyed, 'the old trio is freed BEFORE the new one is uploaded').toHaveLength(3)
    expect(t.descs.slice(3).map((d) => d.width)).toEqual([100, 100, 100])
  })

  it('an EMPTY batch allocates nothing at all', () => {
    const t = stub()
    const p = new ArrowAdvectState()
    p.ensure(t.rhi, 0)
    expect(t.created).toEqual([])
    expect(p.readView).toBeNull()
  })

  it('reallocates on a device swap WITHOUT destroying through the dead device (#737)', () => {
    const a = stub()
    const b = stub()
    const p = new ArrowAdvectState()
    p.ensure(a.rhi, N)
    p.ensure(b.rhi) // the step's bare call: the batch did not change, only the device
    expect(a.destroyed, 'the old device is gone; its textures died with it').toEqual([])
    expect(b.created).toEqual(['arrow-advect-a', 'arrow-advect-b', 'arrow-advect-origin'])
  })

  it('swap() alternates the sides, and destroy() releases every texture', () => {
    const t = stub()
    const p = new ArrowAdvectState()
    p.ensure(t.rhi, N)
    const r0 = p.readView
    const w0 = p.writeView
    expect(r0).not.toEqual(w0)
    p.swap()
    expect(p.readView).toEqual(w0)
    expect(p.writeView).toEqual(r0)
    p.destroy()
    expect(t.destroyed, 'both position sides AND the origins').toHaveLength(3)
    expect(p.readView).toBeNull()
  })
})

describe('the arrow origins (#1419)', () => {
  function stub() {
    let id = 0
    const created: string[] = []
    const writes: Array<{ tex: { native: string }; bytes: Uint8Array }> = []
    const rhi = {
      createTexture: (d: { label?: string }) => {
        created.push(d.label ?? '?')
        return { native: `tex${id++}` }
      },
      createView: (t: { native: string }) => ({ native: `view-${t.native}` }),
      writeTexture: (t: { native: string }, bytes: Uint8Array) =>
        void writes.push({ tex: t, bytes }),
      destroyTexture: () => {},
    }
    return { rhi: rhi as unknown as RhiDevice, created, writes }
  }

  it('lands every instance at its OWN origin — the first frame IS the static portrayal', () => {
    // The property the render gate leans on: before any advect step, an advected batch draws
    // exactly where `coverage-arrow-show` placed its glyphs. "The arrows moved" is then a
    // comparison against the catalogue placement itself, not against an arbitrary scatter.
    const t = stub()
    const p = new ArrowAdvectState()
    const u = Float32Array.from([0.25, 0.5, 0.75])
    const v = Float32Array.from([0.1, 0.6, 0.9])
    p.writeOrigins(t.rhi, 'cbofs/3', u, v)
    const seeded = t.writes.slice(-3) // origins, then both position sides
    expect(seeded).toHaveLength(3)
    for (const w of seeded) {
      for (let i = 0; i < u.length; i++) {
        const [x, y] = decodeArrowPosition(
          w.bytes[i * 4]!,
          w.bytes[i * 4 + 1]!,
          w.bytes[i * 4 + 2]!,
          w.bytes[i * 4 + 3]!,
        )
        expect(x).toBeCloseTo(u[i]!, 4)
        expect(y).toBeCloseTo(v[i]!, 4)
      }
    }
  })

  it('an unchanged key SKIPS the upload — a forecast step must not teleport the field home', () => {
    // Same instance layout, new data underneath: the arrows keep drifting. Re-seeding here is
    // the visible failure of a continuous animation restarting on every data refresh.
    const t = stub()
    const p = new ArrowAdvectState()
    const u = Float32Array.from([0.25])
    const v = Float32Array.from([0.25])
    p.writeOrigins(t.rhi, 'cbofs/1', u, v)
    const after = t.writes.length
    p.writeOrigins(t.rhi, 'cbofs/1', u, v)
    expect(t.writes).toHaveLength(after)
    // A DIFFERENT instance set is a different arrow per texel, so a stale position belongs to
    // someone else — that one must re-seed.
    p.writeOrigins(t.rhi, 'cbofs/2', u, v)
    expect(t.writes.length).toBe(after + 3)
  })

  it('re-uploads after a device swap even though the batch did not change', () => {
    // The origins went with the dead device. Keeping the key would leave the new device's
    // origin texture at all-zero — every arrow leashed to grid-uv (0,0).
    const a = stub()
    const b = stub()
    const p = new ArrowAdvectState()
    const u = Float32Array.from([0.4])
    const v = Float32Array.from([0.4])
    p.writeOrigins(a.rhi, 'cbofs/1', u, v)
    p.writeOrigins(b.rhi, 'cbofs/1', u, v)
    expect(b.writes.length, 'seed on ensure, then origins + both sides').toBe(5)
  })
})
