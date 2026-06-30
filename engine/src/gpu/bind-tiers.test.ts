// ═══════════════════════════════════════════════════════════════════
// bind-tiers.ts — pure planner tests
// ═══════════════════════════════════════════════════════════════════
//
// Asserts the tier grouping, descriptor materialisation, and
// duplicate-binding collision detection. No GPUDevice needed —
// every assertion is on plain TypeScript objects.

import { describe, expect, it } from 'vitest'
import { BindTier, BindTierRegistry, planTierLayout, tierLayoutOrder, type TierSlot } from './bind-tiers'

// Avoid hard import of GPUShaderStage (WebGPU typings) in tests —
// the planner doesn't care about the actual numeric value, just
// that the bit is preserved on the output entry.
const VERTEX = 1
const FRAGMENT = 2

describe('bind-tiers — planTierLayout', () => {
  it('empty slot list → all four tiers materialised, every entries[] empty', () => {
    const planned = planTierLayout([])
    expect(planned.entries.get(BindTier.Constants)).toEqual([])
    expect(planned.entries.get(BindTier.Camera)).toEqual([])
    expect(planned.entries.get(BindTier.Tile)).toEqual([])
    expect(planned.entries.get(BindTier.Feature)).toEqual([])
    expect(planned.hasTier.get(BindTier.Constants)).toBe(false)
    expect(planned.hasTier.get(BindTier.Feature)).toBe(false)
  })

  it('groups slots by tier + sorts within tier by binding', () => {
    const slots: TierSlot[] = [
      { tier: BindTier.Tile, binding: 0, visibility: VERTEX | FRAGMENT, resourceType: 'uniform-dynamic', label: 'tile-uniform' },
      { tier: BindTier.Constants, binding: 4, visibility: FRAGMENT, resourceType: 'sampler-filtering', label: 'palette-samp' },
      { tier: BindTier.Constants, binding: 2, visibility: FRAGMENT, resourceType: 'texture-float-2d', label: 'palette-atlas' },
      { tier: BindTier.Feature, binding: 0, visibility: FRAGMENT, resourceType: 'storage-readonly', label: 'feat-data' },
    ]
    const planned = planTierLayout(slots)

    expect(planned.entries.get(BindTier.Constants)).toEqual([
      { binding: 2, visibility: FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
      { binding: 4, visibility: FRAGMENT, sampler: { type: 'filtering' } },
    ])
    expect(planned.entries.get(BindTier.Tile)).toEqual([
      { binding: 0, visibility: VERTEX | FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true } },
    ])
    expect(planned.entries.get(BindTier.Feature)).toEqual([
      { binding: 0, visibility: FRAGMENT, buffer: { type: 'read-only-storage' } },
    ])
    expect(planned.entries.get(BindTier.Camera)).toEqual([])

    expect(planned.hasTier.get(BindTier.Constants)).toBe(true)
    expect(planned.hasTier.get(BindTier.Tile)).toBe(true)
    expect(planned.hasTier.get(BindTier.Feature)).toBe(true)
    expect(planned.hasTier.get(BindTier.Camera)).toBe(false)
  })

  it('resourceType maps to the correct WebGPU field', () => {
    const cases: Array<[TierSlot['resourceType'], object]> = [
      ['uniform', { buffer: { type: 'uniform' } }],
      ['uniform-dynamic', { buffer: { type: 'uniform', hasDynamicOffset: true } }],
      ['storage-readonly', { buffer: { type: 'read-only-storage' } }],
      ['texture-float-2d', { texture: { sampleType: 'float', viewDimension: '2d' } }],
      ['texture-uint-2d', { texture: { sampleType: 'uint', viewDimension: '2d' } }],
      ['sampler-filtering', { sampler: { type: 'filtering' } }],
      ['sampler-nonfiltering', { sampler: { type: 'non-filtering' } }],
    ]
    for (const [type, expected] of cases) {
      const planned = planTierLayout([
        { tier: BindTier.Camera, binding: 0, visibility: FRAGMENT, resourceType: type },
      ])
      const entry = planned.entries.get(BindTier.Camera)![0]!
      // Pick whichever resource field is present and compare.
      expect(entry).toMatchObject({ binding: 0, visibility: FRAGMENT, ...expected })
    }
  })

  it('duplicate (tier, binding) collision throws with both labels', () => {
    const slots: TierSlot[] = [
      { tier: BindTier.Tile, binding: 0, visibility: VERTEX, resourceType: 'uniform', label: 'first' },
      { tier: BindTier.Tile, binding: 0, visibility: FRAGMENT, resourceType: 'uniform', label: 'second' },
    ]
    expect(() => planTierLayout(slots)).toThrowError(/tier 2 @binding\(0\) collision.*first.*second/)
  })

  it('same binding number in DIFFERENT tiers is allowed', () => {
    const slots: TierSlot[] = [
      { tier: BindTier.Constants, binding: 0, visibility: FRAGMENT, resourceType: 'texture-float-2d', label: 'const-tex' },
      { tier: BindTier.Tile, binding: 0, visibility: VERTEX, resourceType: 'uniform-dynamic', label: 'tile-uni' },
    ]
    const planned = planTierLayout(slots)
    expect(planned.entries.get(BindTier.Constants)).toHaveLength(1)
    expect(planned.entries.get(BindTier.Tile)).toHaveLength(1)
  })
})

describe('bind-tiers — tierLayoutOrder', () => {
  it('returns layouts in tier order, skipping empty tiers', () => {
    const slots: TierSlot[] = [
      { tier: BindTier.Constants, binding: 0, visibility: FRAGMENT, resourceType: 'texture-float-2d' },
      // skip Camera
      { tier: BindTier.Tile, binding: 0, visibility: VERTEX, resourceType: 'uniform-dynamic' },
      // skip Feature
    ]
    const planned = planTierLayout(slots)
    // Sentinel objects keyed by tier so we can assert the right
    // layout was placed at each pipeline-layout slot.
    const layoutByTier = new Map<number, GPUBindGroupLayout>([
      [BindTier.Constants, { _tag: 'const-layout' } as unknown as GPUBindGroupLayout],
      [BindTier.Tile, { _tag: 'tile-layout' } as unknown as GPUBindGroupLayout],
    ])
    const ordered = tierLayoutOrder(planned, t => layoutByTier.get(t)!)
    expect(ordered).toHaveLength(2)
    expect((ordered[0] as unknown as { _tag: string })._tag).toBe('const-layout')
    expect((ordered[1] as unknown as { _tag: string })._tag).toBe('tile-layout')
  })

  it('all four tiers present → returns 4 layouts in 0..3 order', () => {
    const slots: TierSlot[] = [
      { tier: BindTier.Feature, binding: 0, visibility: FRAGMENT, resourceType: 'storage-readonly' },
      { tier: BindTier.Camera, binding: 0, visibility: VERTEX, resourceType: 'uniform' },
      { tier: BindTier.Constants, binding: 0, visibility: FRAGMENT, resourceType: 'texture-float-2d' },
      { tier: BindTier.Tile, binding: 0, visibility: VERTEX, resourceType: 'uniform-dynamic' },
    ]
    const planned = planTierLayout(slots)
    const tags = ['t0', 't1', 't2', 't3']
    const ordered = tierLayoutOrder(planned, t => ({ _tag: tags[t]! } as unknown as GPUBindGroupLayout))
    expect(ordered.map(l => (l as unknown as { _tag: string })._tag))
      .toEqual(['t0', 't1', 't2', 't3'])
  })

  it('empty plan → empty layout list', () => {
    const ordered = tierLayoutOrder(
      planTierLayout([]),
      () => ({} as GPUBindGroupLayout),
    )
    expect(ordered).toEqual([])
  })
})

describe('bind-tiers — BindTierRegistry', () => {
  // Minimal GPUDevice stub: every createBindGroupLayout returns a
  // distinct sentinel object tagged with the label so the test can
  // verify the registry created the right entries.
  function makeFakeDevice(): {
    device: GPUDevice
    createdLabels: string[]
    createdEntries: GPUBindGroupLayoutEntry[][]
  } {
    const createdLabels: string[] = []
    const createdEntries: GPUBindGroupLayoutEntry[][] = []
    const device = {
      createBindGroupLayout(desc: GPUBindGroupLayoutDescriptor): GPUBindGroupLayout {
        createdLabels.push(desc.label ?? '<unlabeled>')
        createdEntries.push([...desc.entries])
        return { _label: desc.label } as unknown as GPUBindGroupLayout
      },
    } as unknown as GPUDevice
    return { device, createdLabels, createdEntries }
  }

  it('creates a layout only on first getLayout per tier (caches afterwards)', () => {
    const { device, createdLabels } = makeFakeDevice()
    const planned = planTierLayout([
      { tier: BindTier.Constants, binding: 2, visibility: 2, resourceType: 'texture-float-2d' },
      { tier: BindTier.Constants, binding: 4, visibility: 2, resourceType: 'sampler-filtering' },
      { tier: BindTier.Tile, binding: 0, visibility: 3, resourceType: 'uniform-dynamic' },
    ])
    const reg = new BindTierRegistry(device, planned)
    const c1 = reg.getLayout(BindTier.Constants)
    const c2 = reg.getLayout(BindTier.Constants)
    const t1 = reg.getLayout(BindTier.Tile)
    expect(c1).toBe(c2)             // cached on second call
    expect(c1).not.toBe(t1)         // different tier → different layout
    expect(createdLabels.length).toBe(2)  // one per tier, not per get
  })

  it('returns null for tiers with no slots', () => {
    const { device } = makeFakeDevice()
    const planned = planTierLayout([
      { tier: BindTier.Camera, binding: 0, visibility: 1, resourceType: 'uniform' },
    ])
    const reg = new BindTierRegistry(device, planned)
    expect(reg.getLayout(BindTier.Constants)).toBeNull()
    expect(reg.getLayout(BindTier.Feature)).toBeNull()
    expect(reg.getLayout(BindTier.Camera)).not.toBeNull()
  })

  it('applies labelPrefix to the created bind-group layout label', () => {
    const { device, createdLabels } = makeFakeDevice()
    const planned = planTierLayout([
      { tier: BindTier.Tile, binding: 0, visibility: 1, resourceType: 'uniform-dynamic' },
    ])
    const reg = new BindTierRegistry(device, planned, 'vtr')
    reg.getLayout(BindTier.Tile)
    expect(createdLabels).toEqual(['vtr-tier2'])
  })

  it('pipelineLayoutOrder returns layouts in tier 0..3 order, lazy-creating each', () => {
    const { device, createdLabels } = makeFakeDevice()
    const planned = planTierLayout([
      { tier: BindTier.Feature, binding: 0, visibility: 2, resourceType: 'storage-readonly' },
      { tier: BindTier.Constants, binding: 0, visibility: 2, resourceType: 'texture-float-2d' },
    ])
    const reg = new BindTierRegistry(device, planned)
    const ordered = reg.pipelineLayoutOrder()
    expect(ordered).toHaveLength(2)
    expect(createdLabels).toEqual(['bind-tier-tier0', 'bind-tier-tier3'])
  })

  it('plan getter surfaces the same PlannedTiers for diagnostic introspection', () => {
    const { device } = makeFakeDevice()
    const planned = planTierLayout([
      { tier: BindTier.Camera, binding: 0, visibility: 1, resourceType: 'uniform' },
    ])
    const reg = new BindTierRegistry(device, planned)
    expect(reg.plan).toBe(planned)
  })

  it('entries handed to GPUDevice.createBindGroupLayout match the planner output', () => {
    const { device, createdEntries } = makeFakeDevice()
    const planned = planTierLayout([
      { tier: BindTier.Constants, binding: 2, visibility: 2, resourceType: 'texture-float-2d', label: 'tex' },
      { tier: BindTier.Constants, binding: 4, visibility: 2, resourceType: 'sampler-filtering', label: 'samp' },
    ])
    const reg = new BindTierRegistry(device, planned)
    reg.getLayout(BindTier.Constants)
    expect(createdEntries).toHaveLength(1)
    expect(createdEntries[0]).toEqual([
      { binding: 2, visibility: 2, texture: { sampleType: 'float', viewDimension: '2d' } },
      { binding: 4, visibility: 2, sampler: { type: 'filtering' } },
    ])
  })
})
