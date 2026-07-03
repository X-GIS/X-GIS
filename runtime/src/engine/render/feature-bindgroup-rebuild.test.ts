// iter-349 — per-tile feature bind groups must be rebuilt when the uniform
// ring grows. The per-tile featureBindGroup (data-driven MVT fills) binds
// the uniform ring at binding 0, created once at upload. On a mid-frame
// uniform-ring grow the ring buffer IDENTITY changes (new buffer; the old
// one is retired + destroyed next frame). Without rebuilding the per-tile
// groups they keep referencing the old/destroyed ring → data-driven fills
// read stale uniform colours during interaction (user-reported high-pitch
// "land flashes water-blue"; compute=1 reads colour from its output buffer
// → was immune). This test pins that the FeatureDataBinder's per-tile
// rebuild (CALLED by VTR.rebuildTileBindGroups, the single onGrow trigger)
// re-points every cached per-tile group at the CURRENT ring.
//
// VTR decomposition (U2-prime): `rebuildPerTileFeatureBindGroups` moved onto
// FeatureDataBinder.rebuildPerTileGroups(gpuCache, ringBuf, palette) —
// gpuCache + ring + palette arrive as CALL ARGUMENTS (the binder never
// references VTR). featureBindGroupLayout + computeHandlesByTile are now
// binder-owned.
import { describe, it, expect } from 'vitest'
import { FeatureDataBinder } from '@xgis/map'

interface FakeBuf {
  id: string
}
interface FakeBG {
  id: string
  entries: { binding: number; resource: { buffer?: FakeBuf } }[]
}

describe('iter-349 per-tile feature bind group rebuild on ring grow', () => {
  it('rebuildPerTileGroups re-points every cached featureBindGroup at the current uniform ring', () => {
    const binder = Object.create(FeatureDataBinder.prototype) as FeatureDataBinder
    const NEW_RING: FakeBuf = { id: 'new-ring' }
    const OLD_BG: FakeBG = {
      id: 'old-bg',
      entries: [{ binding: 0, resource: { buffer: { id: 'old-ring' } } }],
    }
    const featBuf: FakeBuf = { id: 'feat-data' }
    const created: FakeBG[] = []
    const tile = { featureBindGroup: OLD_BG, featureDataBuffer: featBuf } as unknown as {
      featureBindGroup: unknown
      featureDataBuffer: unknown
    }
    const inj = binder as unknown as Record<string, unknown>
    inj.device = {
      createBindGroup: (d: { entries: { binding: number; resource: { buffer?: FakeBuf } }[] }) => {
        const bg: FakeBG = { id: `bg${created.length}`, entries: d.entries }
        created.push(bg)
        return bg
      },
    }
    inj._featureBindGroupLayout = { id: 'feat-layout' }
    inj.computeHandlesByTile = new Map()
    const gpuCache = new Map([['water', new Map([[42, tile]])]])
    const palette = {
      paletteColorAtlasView: { id: 'pal' },
      paletteSampler: { id: 'samp' },
      spriteAtlasView: { id: 'sprite' },
    }

    ;(
      binder as unknown as {
        rebuildPerTileGroups: (c: unknown, r: unknown, p: unknown) => void
      }
    ).rebuildPerTileGroups(gpuCache as never, NEW_RING as never, palette as never)

    // A new bind group was created and stored on the tile.
    expect(created.length).toBe(1)
    expect(tile.featureBindGroup).toBe(created[0])
    // Binding 0 now points at the CURRENT ring (not the old one).
    const b0 = created[0]!.entries.find((e) => e.binding === 0)
    expect(b0?.resource.buffer).toBe(NEW_RING)
    // Feature data buffer (binding 1) preserved.
    const b1 = created[0]!.entries.find((e) => e.binding === 1)
    expect(b1?.resource.buffer).toBe(featBuf)
  })

  it('no-op when atlas/palette not yet wired (setup-time call, empty cache safe)', () => {
    const binder = Object.create(FeatureDataBinder.prototype) as FeatureDataBinder
    const inj = binder as unknown as Record<string, unknown>
    inj.device = {
      createBindGroup: () => {
        throw new Error('should not be called')
      },
    }
    inj._featureBindGroupLayout = null // not ready
    inj.computeHandlesByTile = new Map()
    const palette = { paletteColorAtlasView: null, paletteSampler: null, spriteAtlasView: null }
    expect(() =>
      (
        binder as unknown as {
          rebuildPerTileGroups: (c: unknown, r: unknown, p: unknown) => void
        }
      ).rebuildPerTileGroups(new Map() as never, { id: 'r' } as never, palette as never),
    ).not.toThrow()
  })
})
