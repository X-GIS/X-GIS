// ═══ #2369 F-3 — the palette guard must run BEFORE the buffer is created ═══
//
// `buildPerTileFeatureData` created + wrote the per-tile storage buffer and THEN
// checked whether the renderer had pushed its palette resources yet, returning
// null on that check without destroying what it had just allocated. Nothing
// between the create and the guard reads the buffer, so the allocation was
// simply on the wrong side of the test.
//
// The window is not exotic: the guard's own comment names it ("when the
// renderer hasn't pushed palette resources yet"), which is scene setup — the
// moment a wave of tiles is being built. One orphaned storage buffer per tile
// that lands in it, unreachable for the life of the device.
//
// The assertion is `createBuffer` was never CALLED, not "was called and then
// destroyed": a guard that allocates first and cleans up would pass the weaker
// form while still doing per-tile work the early return exists to avoid.

import { describe, expect, it } from 'vitest'
import { FeatureDataBinder } from './feature-data-binder'

// The production create reads the WebGPU `GPUBufferUsage` global, which node has
// no reason to define. Stubbed so reaching the create is a RECORDED allocation
// rather than a ReferenceError — the test must distinguish "did not allocate"
// from "threw before it could".
;(globalThis as { GPUBufferUsage?: unknown }).GPUBufferUsage ??= { STORAGE: 128, COPY_DST: 8 }

/** Records buffer creation so the test can assert the allocation never happens. */
function recordingDevice() {
  const created: string[] = []
  const device = {
    createBuffer: (d: { label?: string }) => {
      created.push(d.label ?? '(unlabeled)')
      return { label: d.label, destroy: () => {} }
    },
    createBindGroup: () => ({ __bg: true }),
    queue: { writeBuffer: () => {} },
  }
  return { device: device as unknown as GPUDevice, created }
}

/** One feature with one numeric property — enough to reach the pack + create. */
const FEATURE_PROPS = new Map<number, Record<string, unknown>>([[1, { gdp: 42 }]])

const PALETTE_PRESENT = {
  paletteColorAtlasView: { __view: true },
  paletteSampler: { __samp: true },
  spriteAtlasView: { __sprite: true },
} as unknown as Parameters<FeatureDataBinder['buildPerTileFeatureData']>[2]

const PALETTE_ABSENT = {
  paletteColorAtlasView: null,
  paletteSampler: null,
  spriteAtlasView: null,
} as unknown as Parameters<FeatureDataBinder['buildPerTileFeatureData']>[2]

/** Arm the binder past its three early returns so the guard under test is the
 *  next thing it reaches. Built through the prototype with its private state
 *  assigned directly — the same seam feature-data-sparse-fid.test.ts uses,
 *  because the variant capture has no public setter. */
function armedBinder(device: GPUDevice): FeatureDataBinder {
  const binder = Object.create(FeatureDataBinder.prototype) as FeatureDataBinder
  Object.assign(binder, {
    device,
    latestVariantFields: ['gdp'],
    latestVariantCategoryOrder: {},
    latestVariant: null,
    _featureBindGroupLayout: { __layout: true },
    computeHandlesByTile: new Map(),
  })
  return binder
}

describe('#2369 F-3 — buildPerTileFeatureData does not allocate before the palette guard', () => {
  it('creates NO buffer when the palette resources are not pushed yet', () => {
    const { device, created } = recordingDevice()
    const out = armedBinder(device).buildPerTileFeatureData(
      FEATURE_PROPS,
      { __ring: true } as unknown as GPUBuffer,
      PALETTE_ABSENT,
    )
    expect(out, 'the palette-unwired path still returns null').toBeNull()
    expect(created, 'nothing may be allocated on the path that returns null').toEqual([])
  })

  it('CONTROL — with the palette pushed it still builds the buffer + bind group', () => {
    const { device, created } = recordingDevice()
    const out = armedBinder(device).buildPerTileFeatureData(
      FEATURE_PROPS,
      { __ring: true } as unknown as GPUBuffer,
      PALETTE_PRESENT,
    )
    expect(out, 'the wired path must still produce a binding').not.toBeNull()
    expect(created).toContain('per-tile-feature-data')
  })
})
