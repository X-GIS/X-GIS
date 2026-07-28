// ═══ REPRODUCTION: what a MOSAIC does to one shared arrow state ═══
//
// Reported: several NOAA HDF5 domains on screen at once and the arrow field breaks up. The
// question to settle is whether that is an OFFSET (arrows drawn at the wrong place) or an
// OVERFLOW (arrows indexing past what exists) — so this drives the real objects and asserts
// what each region's batch actually receives, rather than reasoning about it.
//
// The setup under test: ONE `ArrowAdvectState` on the FlowRenderer, and one advected BATCH per
// region, each of which calls `writeArrowOrigins` with its own key and then draws its own
// instance count starting at texel 0.

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
  it('THE OFFSET: region B’s origins land on the texels region A’s instances read', () => {
    // Both batches index the state from texel 0, so region A instance `i` and region B
    // instance `i` are the SAME texel. Whichever region wrote last owns it.
    const t = stub()
    const s = new ArrowAdvectState()
    const a = origins(400, 0.25)
    const b = origins(400, 0.75)
    s.writeOrigins(t.rhi, 'cbofs|20x20|400', a.u, a.v)
    s.writeOrigins(t.rhi, 'dbofs|20x20|400', b.u, b.v)

    const [x] = originTexel(t.uploads, 0)!
    expect(x, 'texel 0 belongs to whoever wrote LAST, not to region A').toBeCloseTo(0.75, 2)
    // Region A's batch still draws 400 instances against these texels: every one of its arrows
    // is now leashed to a cell in the OTHER domain, and the drift it draws is the difference
    // between its own position and a foreign origin.
  })

  it('THE OVERFLOW: a smaller second region SHRINKS the texture under the larger first one', () => {
    // #1450 A made the state size follow the batch. With one region that is exactly right; with
    // a mosaic it means the LAST region armed decides the size, and a larger sibling's tail
    // instances index texels that no longer exist. Out-of-bounds textureLoad returns 0 on
    // WebGPU, i.e. those arrows collapse onto grid-uv (0,0).
    const t = stub()
    const s = new ArrowAdvectState()
    const big = origins(4_000, 0.25) // dim 64 → 4096 texels
    const small = origins(100, 0.75) // dim 10 → 100 texels
    s.writeOrigins(t.rhi, 'cbofs|100x40|4000', big.u, big.v)
    s.writeOrigins(t.rhi, 'sfbofs|10x10|100', small.u, small.v)

    expect(originTexel(t.uploads, 99), 'the last region fits').not.toBeNull()
    expect(
      originTexel(t.uploads, 3_999),
      "the first region's last instance has no texel to read",
    ).toBeNull()
  })

  it('and the shrink DESTROYS the textures the larger region’s draw is still bound to', () => {
    // The resize frees the old trio. Any bind group still holding those views is now pointing
    // at freed memory — the same class as the destroyed-texture crash fixed in #1445, reached
    // by a different route.
    const t = stub()
    const s = new ArrowAdvectState()
    const big = origins(4_000, 0.25)
    const small = origins(100, 0.75)
    s.writeOrigins(t.rhi, 'cbofs|100x40|4000', big.u, big.v)
    const afterFirst = new Set(t.live)
    s.writeOrigins(t.rhi, 'sfbofs|10x10|100', small.u, small.v)
    const stillLive = [...afterFirst].filter((n) => t.live.has(n))
    expect(stillLive, 'the first region’s trio is gone').toEqual([])
  })
})
