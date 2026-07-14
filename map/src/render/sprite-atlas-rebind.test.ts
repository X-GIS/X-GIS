// Sprite-atlas push → tile bind-group rebuild (#777 I-E probe root cause),
// GPU-free.
//
// WebGPU bind groups are immutable once created (renderer.ts setSpriteAtlas's
// own rationale). The VTR tile bind groups bind the sprite atlas at binding 5,
// seeded with the factory's 1×1 stub — so when the REAL atlas lands (the
// render-loop `_resolveFillPatterns` push), every already-built group must be
// REBUILT against the new view and the bind-group epoch must bump (stale
// RenderBundles miss). A push that only swaps the registry FIELD leaves every
// existing group sampling the stub forever on styles whose uniform ring never
// grows again — a fill-pattern / background-pattern style then draws invisible
// pattern fills (the #777 I-E §5 probe: pattern chain green end-to-end, zero
// pattern pixels).
//
// This drives the REAL VectorTileRenderer public surface (the exact
// setBindGroupLayout → setPaletteResources → setSpriteAtlasView call order the
// synthetic-source install + render-loop push use) against a recording stub
// device, and pins the rebuild contract:
//   • the base tile group is (re)built with binding 5 = the pushed view,
//   • a second push REPLACES the group (new identity) + bumps the epoch,
//   • binding 5 of the rebuilt group is the NEW view (not the stub).
//
// Fail-before: make VTR.setSpriteAtlasView forward the field only (drop its
// _onUniformRingGrow() fan-out) — the group identity survives the push, the
// epoch stays, and binding 5 keeps the stub.

import { describe, it, expect } from 'vitest'
import { VectorTileRenderer } from './vector-tile-renderer'
import type { GPUContext } from '@xgis/rhi-webgpu'

interface CapturedGroup {
  label?: string
  entries: Array<{ binding: number; resource: unknown }>
  token: object
}

function makeHarness() {
  const groups: CapturedGroup[] = []
  const device = {
    createBindGroup: (desc: { label?: string; entries: CapturedGroup['entries'] }) => {
      const token = { __bg: groups.length }
      groups.push({ label: desc.label, entries: desc.entries, token })
      return token
    },
    createBuffer: () => ({ __buf: true }),
    queue: { writeBuffer: () => {} },
  }
  const nativeRing = { __nativeRing: true }
  const rhi = {
    backend: 'webgpu',
    createBuffer: () => ({ __rhiBuf: true }),
    unwrapBuffer: () => nativeRing,
  }
  const ctx = { device, rhi, format: 'bgra8unorm' } as unknown as GPUContext
  const vtr = new VectorTileRenderer(ctx)
  return { vtr, groups }
}

const LAYOUT = { __layout: 'base' } as unknown as GPUBindGroupLayout
const PALETTE_VIEW = { __view: 'palette' } as unknown as GPUTextureView
const PALETTE_SAMPLER = { __sampler: 'palette' } as unknown as GPUSampler
const STUB_VIEW = { __view: 'sprite-stub' } as unknown as GPUTextureView
const REAL_VIEW = { __view: 'sprite-real' } as unknown as GPUTextureView

/** binding-5 resource of the group backing `baseGroup()` right now. */
function binding5Of(groups: CapturedGroup[], token: unknown): unknown {
  const g = groups.find((x) => x.token === token)
  return g?.entries.find((e) => e.binding === 5)?.resource
}

describe('sprite-atlas push rebuilds the VTR tile bind groups (#777 I-E)', () => {
  it('the install order (layout → palette → stub atlas) builds the base group against the stub', () => {
    const { vtr, groups } = makeHarness()
    vtr.setBindGroupLayout(LAYOUT)
    vtr.setPaletteResources(PALETTE_VIEW, PALETTE_SAMPLER)
    vtr.setSpriteAtlasView(STUB_VIEW)
    const g = (vtr as unknown as { _bindGroups: { baseGroup(): unknown } })._bindGroups.baseGroup()
    expect(g, 'base tile group must exist after the full install').not.toBeNull()
    expect(binding5Of(groups, g)).toBe(STUB_VIEW)
  })

  it('the REAL-atlas push replaces the group (new identity), rebinds binding 5, bumps the epoch', () => {
    const { vtr, groups } = makeHarness()
    const reg = (vtr as unknown as { _bindGroups: { baseGroup(): unknown; epoch(): number } })
      ._bindGroups
    vtr.setBindGroupLayout(LAYOUT)
    vtr.setPaletteResources(PALETTE_VIEW, PALETTE_SAMPLER)
    vtr.setSpriteAtlasView(STUB_VIEW)
    const gStub = reg.baseGroup()
    const epochStub = reg.epoch()
    expect(binding5Of(groups, gStub)).toBe(STUB_VIEW)

    // The render-loop `_resolveFillPatterns` push once the atlas lands.
    vtr.setSpriteAtlasView(REAL_VIEW)

    const gReal = reg.baseGroup()
    expect(gReal, 'push must rebuild the base group').not.toBeNull()
    // Immutable bind groups: the push MUST mint a new group…
    expect(gReal, 'group identity must change on push').not.toBe(gStub)
    // …whose binding 5 is the REAL atlas, not the boot stub…
    expect(binding5Of(groups, gReal)).toBe(REAL_VIEW)
    // …and the epoch must bump so cached RenderBundles miss.
    expect(reg.epoch()).toBeGreaterThan(epochStub)
  })
})
