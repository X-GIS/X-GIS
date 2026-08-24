// iter-283 — BundleKeyState type guard
import { describe, it, expect } from 'vitest'
import { isBundleKeyState, type BundleKeyState } from './bundle-cache-key'
import { structuralHashKey } from './structural-key'

const validKey: BundleKeyState = {
  sliceLayer: 'roads',
  phase: 'opaque',
  neededKeys: [1, 2, 3],
  epochs: [10, 20, 30],
  worldOffsets: null,
  bindGroupEpoch: 5,
  pickOn: false,
  samples: 1,
  mainPipelineLabel: 'fill-pipeline',
  linePipelineLabel: 'line-pipeline',
  ringCursor: 0,
  lineLayerOffset: 0,
  lineLayerOffsetGap: -1,
}

describe('BundleKeyState type', () => {
  it('valid object passes type guard', () => {
    expect(isBundleKeyState(validKey)).toBe(true)
  })

  it('null fails', () => {
    expect(isBundleKeyState(null)).toBe(false)
  })

  it('missing required string field fails', () => {
    const { sliceLayer: _, ...rest } = validKey
    expect(isBundleKeyState(rest)).toBe(false)
  })

  it('wrong type fails', () => {
    expect(isBundleKeyState({ ...validKey, pickOn: 'yes' })).toBe(false)
  })

  it('structuralHashKey changes when any field changes', () => {
    const base = structuralHashKey(validKey)
    expect(structuralHashKey({ ...validKey, sliceLayer: 'water' })).not.toBe(base)
    expect(structuralHashKey({ ...validKey, phase: 'oit-fill' })).not.toBe(base)
    expect(structuralHashKey({ ...validKey, neededKeys: [1, 2, 99] })).not.toBe(base)
    expect(structuralHashKey({ ...validKey, epochs: [10, 20, 99] })).not.toBe(base)
    expect(structuralHashKey({ ...validKey, bindGroupEpoch: 6 })).not.toBe(base)
    expect(structuralHashKey({ ...validKey, pickOn: true })).not.toBe(base)
    expect(structuralHashKey({ ...validKey, samples: 4 })).not.toBe(base)
    expect(structuralHashKey({ ...validKey, mainPipelineLabel: 'other' })).not.toBe(base)
    // #1190 — the replay-validity trio: a shifted ring base or a moved
    // stroke layer-slot offset must be a different key (i.e. a MISS),
    // never a hit that replays baked offsets against foreign slots.
    expect(structuralHashKey({ ...validKey, ringCursor: 7 })).not.toBe(base)
    expect(structuralHashKey({ ...validKey, lineLayerOffset: 256 })).not.toBe(base)
    expect(structuralHashKey({ ...validKey, lineLayerOffsetGap: 512 })).not.toBe(base)
  })

  it('null pipeline label produces distinct hash from named one', () => {
    const a = structuralHashKey({ ...validKey, linePipelineLabel: null })
    const b = structuralHashKey({ ...validKey, linePipelineLabel: 'x' })
    expect(a).not.toBe(b)
  })
})
