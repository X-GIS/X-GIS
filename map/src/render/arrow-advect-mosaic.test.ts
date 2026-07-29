// ═══ A MOSAIC shares one arrow state by RANGE, not by collision (#1458) ═══
//
// Reported: several NOAA HDF5 domains on screen at once and the arrow field breaks up. It was
// BOTH failures at once, and both followed from one fact — the FlowRenderer owns ONE
// ArrowAdvectState while every region gets its own advected batch, and each batch indexed the
// state from texel 0:
//
//   OFFSET   — the last region armed owned every texel, so its siblings' arrows were leashed to
//              origin cells belonging to another domain.
//   OVERFLOW — once the size followed the batch (#1450 A), a smaller sibling shrank the texture
//              under a larger one, whose tail instances then read out of bounds (0 on WebGPU,
//              i.e. collapsed onto grid-uv (0,0)) against textures that had just been freed.
//
// Each batch now RESERVES a contiguous range and the VS reads `base + instance_index`. These
// tests were written as a reproduction first (they asserted the breakage), then inverted here —
// so what they check is exactly what was measured to be wrong.

import { describe, expect, it } from 'vitest'
import { ArrowAdvectState, decodeArrowPosition } from './arrow-advect-state'
import type { RhiDevice } from '@xgis/engine'

interface Upload {
  label: string
  bytes: Uint8Array
  width: number
}

/** Records every createTexture size and every writeTexture payload, per texture label. */
function stub(): { rhi: RhiDevice; uploads: Upload[]; live: Set<string> } {
  const uploads: Upload[] = []
  const live = new Set<string>()
  let id = 0
  const labels = new Map<string, string>()
  const widths = new Map<string, number>()
  const rhi = {
    createTexture: (d: { label?: string; width: number }) => {
      const native = `tex${id++}`
      labels.set(native, d.label ?? '?')
      widths.set(native, d.width)
      live.add(native)
      return { native }
    },
    createView: (t: { native: string }) => ({ native: `view-${t.native}` }),
    writeTexture: (t: { native: string }, bytes: Uint8Array) =>
      void uploads.push({
        label: labels.get(t.native) ?? '?',
        bytes: new Uint8Array(bytes),
        width: widths.get(t.native) ?? 0,
      }),
    destroyTexture: (t: { native: string }) => void live.delete(t.native),
    createSampler: () => ({}),
    destroySampler: () => {},
  }
  return { rhi: rhi as unknown as RhiDevice, uploads, live }
}

/** `n` origins on a distinct diagonal, so a region's origins are identifiable by value. */
function origins(n: number, at: number): { u: Float32Array; v: Float32Array } {
  const u = new Float32Array(n)
  const v = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    u[i] = at
    v[i] = at
  }
  return { u, v }
}

/** The origin texture's decoded texel `i` from the most recent upload that touched it. */
function originTexel(uploads: Upload[], i: number): [number, number] | null {
  const last = [...uploads].reverse().find((up) => up.label === 'arrow-advect-origin')
  if (!last) return null
  const at = i * 4
  if (at + 3 >= last.bytes.length) return null // texel does not exist — an OVERFLOW read
  return decodeArrowPosition(
    last.bytes[at]!,
    last.bytes[at + 1]!,
    last.bytes[at + 2]!,
    last.bytes[at + 3]!,
  )
}

describe('MOSAIC × one shared arrow state — offset or overflow?', () => {
  it('NO OFFSET COLLISION: each region keeps its own origins, at its own base', () => {
    const t = stub()
    const s = new ArrowAdvectState()
    const a = origins(400, 0.25)
    const b = origins(400, 0.75)
    const baseA = s.writeOrigins(t.rhi, 'cbofs|20x20|400', 'cbofs', a.u, a.v)
    const baseB = s.writeOrigins(t.rhi, 'dbofs|20x20|400', 'dbofs', b.u, b.v)

    expect(baseA).toBe(0)
    expect(baseB, 'the second region starts where the first ends').toBe(400)
    expect(originTexel(t.uploads, baseA)![0], 'region A still owns its texels').toBeCloseTo(0.25, 2)
    expect(originTexel(t.uploads, baseB)![0], 'region B has its own').toBeCloseTo(0.75, 2)
    expect(originTexel(t.uploads, baseA + 399)![0], "…across region A's whole range").toBeCloseTo(
      0.25,
      2,
    )
  })

  it('a re-armed region keeps its BASE, so a forecast step does not snap it home', () => {
    // Same key, same count — the arrows keep drifting. This is the property the forecast step
    // depends on, and a naive append-per-arm would have destroyed it.
    const t = stub()
    const s = new ArrowAdvectState()
    const a = origins(400, 0.25)
    const first = s.writeOrigins(t.rhi, 'cbofs|20x20|400', 'cbofs', a.u, a.v)
    s.writeOrigins(t.rhi, 'dbofs|20x20|400', 'dbofs', origins(400, 0.75).u, origins(400, 0.75).v)
    const again = s.writeOrigins(t.rhi, 'cbofs|20x20|400', 'cbofs', a.u, a.v)
    expect(again).toBe(first)
  })

  it('a dropped region frees its range for the next one', () => {
    const t = stub()
    const s = new ArrowAdvectState()
    s.writeOrigins(t.rhi, 'cbofs|20x20|400', 'cbofs', origins(400, 0.25).u, origins(400, 0.25).v)
    const b = s.writeOrigins(
      t.rhi,
      'dbofs|20x20|400',
      'dbofs',
      origins(400, 0.75).u,
      origins(400, 0.75).v,
    )
    s.releaseOrigins('dbofs|20x20|400')
    const c = s.writeOrigins(
      t.rhi,
      'sfbofs|20x20|300',
      'sfbofs',
      origins(300, 0.5).u,
      origins(300, 0.5).v,
    )
    expect(c, 'the freed range is reused rather than appended past').toBe(b)
  })

  it('NO OVERFLOW: a smaller second region does not shrink the texture under a larger first', () => {
    // #1450 A made the state size follow the batch. With one region that is exactly right; with
    // a mosaic it means the LAST region armed decides the size, and a larger sibling's tail
    // instances index texels that no longer exist. Out-of-bounds textureLoad returns 0 on
    // WebGPU, i.e. those arrows collapse onto grid-uv (0,0).
    const t = stub()
    const s = new ArrowAdvectState()
    const big = origins(4_000, 0.25) // dim 64 → 4096 texels
    const small = origins(100, 0.75) // dim 10 → 100 texels
    s.writeOrigins(t.rhi, 'cbofs|100x40|4000', 'cbofs', big.u, big.v)
    s.writeOrigins(t.rhi, 'sfbofs|10x10|100', 'sfbofs', small.u, small.v)

    expect(
      originTexel(t.uploads, 3_999),
      "the first region's last instance still reads",
    ).not.toBeNull()
    expect(originTexel(t.uploads, 3_999)![0], '…and still reads ITS OWN origin').toBeCloseTo(
      0.25,
      2,
    )
    expect(originTexel(t.uploads, 4_099)![0], 'the second region sits past it').toBeCloseTo(0.75, 2)
  })

  it('GROWING for a new region re-uploads the siblings — the mirror is what survives', () => {
    // A grow DOES reallocate, and the old trio's contents die with it. The CPU-side mirror is
    // the only copy of every resident origin, so the whole thing is re-uploaded; without that,
    // the region that did not change would read zeros and stack on grid-uv (0,0).
    const t = stub()
    const s = new ArrowAdvectState()
    s.writeOrigins(t.rhi, 'cbofs|20x20|400', 'cbofs', origins(400, 0.25).u, origins(400, 0.25).v)
    s.writeOrigins(
      t.rhi,
      'dbofs|100x40|4000',
      'dbofs',
      origins(4_000, 0.75).u,
      origins(4_000, 0.75).v,
    )
    expect(originTexel(t.uploads, 0)![0], 'the untouched sibling survived the grow').toBeCloseTo(
      0.25,
      2,
    )
  })
})
