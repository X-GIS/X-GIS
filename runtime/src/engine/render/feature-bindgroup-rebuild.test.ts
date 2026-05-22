// iter-349 — per-tile feature bind groups must be rebuilt when the uniform
// ring grows. The per-tile featureBindGroup (data-driven MVT fills) binds
// the uniform ring at binding 0, created once at upload. On a mid-frame
// uniform-ring grow the ring buffer IDENTITY changes (new buffer; the old
// one is retired + destroyed next frame). Without rebuilding the per-tile
// groups they keep referencing the old/destroyed ring → data-driven fills
// read stale uniform colours during interaction (user-reported high-pitch
// "land flashes water-blue"; compute=1 reads colour from its output buffer
// → was immune). This test pins that rebuildTileBindGroups re-points every
// cached per-tile group at the CURRENT ring.
import { describe, it, expect } from 'vitest'
import { VectorTileRenderer } from './vector-tile-renderer'

interface FakeBuf { id: string }
interface FakeBG { id: string; entries: { binding: number; resource: { buffer?: FakeBuf } }[] }

describe('iter-349 per-tile feature bind group rebuild on ring grow', () => {
  it('rebuildTileBindGroups re-points every cached featureBindGroup at the current uniform ring', () => {
    const vtr = Object.create(VectorTileRenderer.prototype) as VectorTileRenderer
    const NEW_RING: FakeBuf = { id: 'new-ring' }
    const OLD_BG: FakeBG = { id: 'old-bg', entries: [{ binding: 0, resource: { buffer: { id: 'old-ring' } } }] }
    const featBuf: FakeBuf = { id: 'feat-data' }
    const created: FakeBG[] = []
    const tile = { featureBindGroup: OLD_BG, featureDataBuffer: featBuf } as unknown as { featureBindGroup: unknown; featureDataBuffer: unknown }
    const inj = vtr as unknown as Record<string, unknown>
    inj.device = {
      createBindGroup: (d: { entries: { binding: number; resource: { buffer?: FakeBuf } }[] }) => {
        const bg: FakeBG = { id: `bg${created.length}`, entries: d.entries }; created.push(bg); return bg
      },
    }
    inj.uniformRing = NEW_RING
    inj.featureBindGroupLayout = { id: 'feat-layout' }
    inj.paletteColorAtlasView = { id: 'pal' }
    inj.paletteSampler = { id: 'samp' }
    inj.spriteAtlasView = { id: 'sprite' }
    inj.computeHandlesByTile = new Map()
    inj.gpuCache = new Map([['water', new Map([[42, tile]])]])

    ;(vtr as unknown as { rebuildPerTileFeatureBindGroups: () => void }).rebuildPerTileFeatureBindGroups()

    // A new bind group was created and stored on the tile.
    expect(created.length).toBe(1)
    expect(tile.featureBindGroup).toBe(created[0])
    // Binding 0 now points at the CURRENT ring (not the old one).
    const b0 = created[0]!.entries.find(e => e.binding === 0)
    expect(b0?.resource.buffer).toBe(NEW_RING)
    // Feature data buffer (binding 1) preserved.
    const b1 = created[0]!.entries.find(e => e.binding === 1)
    expect(b1?.resource.buffer).toBe(featBuf)
  })

  it('no-op when atlas/palette not yet wired (setup-time call, empty cache safe)', () => {
    const vtr = Object.create(VectorTileRenderer.prototype) as VectorTileRenderer
    const inj = vtr as unknown as Record<string, unknown>
    inj.device = { createBindGroup: () => { throw new Error('should not be called') } }
    inj.uniformRing = { id: 'r' }
    inj.featureBindGroupLayout = null   // not ready
    inj.paletteColorAtlasView = null
    inj.computeHandlesByTile = new Map()
    inj.gpuCache = new Map()
    expect(() => (vtr as unknown as { rebuildPerTileFeatureBindGroups: () => void }).rebuildPerTileFeatureBindGroups()).not.toThrow()
  })
})
