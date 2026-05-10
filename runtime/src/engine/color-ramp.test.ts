import { describe, expect, it } from 'vitest'
import { availableRamps } from './color-ramp'
import { ComputeDispatcher } from './gpu/compute'

describe('Color Ramp', () => {
  it('has built-in ramps', () => {
    const ramps = availableRamps()
    expect(ramps).toContain('viridis')
    expect(ramps).toContain('hot')
    expect(ramps).toContain('blues')
    expect(ramps).toContain('reds')
    expect(ramps).toContain('rdylgn')
    expect(ramps).toContain('coolwarm')
    expect(ramps).toContain('ocean')
    expect(ramps).toContain('terrain')
    expect(ramps).toContain('plasma')
    expect(ramps).toContain('grayscale')
    expect(ramps.length).toBeGreaterThanOrEqual(10)
  })
})

describe('ComputeDispatcher', () => {
  it('generates valid WGSL compute shader', () => {
    const shader = ComputeDispatcher.generateShader(
      'clamp(feat_data[feat_idx + 0u] / 50.0, 4.0, 24.0)',
      3,
      64,
    )
    expect(shader).toContain('@compute @workgroup_size(64)')
    expect(shader).toContain('fn main(')
    expect(shader).toContain('var<storage, read> feat_data')
    expect(shader).toContain('var<storage, read_write> result')
    expect(shader).toContain('feat_idx = idx * 3u')
    expect(shader).toContain('clamp(feat_data[feat_idx + 0u] / 50.0, 4.0, 24.0)')
  })

  it('generates shader with custom workgroup size', () => {
    const shader = ComputeDispatcher.generateShader('feat_data[feat_idx]', 1, 128)
    expect(shader).toContain('@workgroup_size(128)')
  })
})
