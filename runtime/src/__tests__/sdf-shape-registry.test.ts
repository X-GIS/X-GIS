import { describe, it, expect } from 'vitest'
import { ShapeRegistry, BUILTIN_SHAPES } from '../engine/sdf-shape'

// The registry touches `device` only from `uploadToGPU`; constructor and
// add/lookup methods are pure, so a stubbed device is sufficient here.
const fakeDevice = {} as unknown as GPUDevice

describe('ShapeRegistry', () => {
  it('resolves built-in shapes by bare name', () => {
    const r = new ShapeRegistry(fakeDevice)
    expect(r.getShapeId('cross')).toBeGreaterThan(0)
    expect(r.getShapeId('square')).toBeGreaterThan(0)
  })

  it('returns 0 for circle (analytical) and unknown names', () => {
    const r = new ShapeRegistry(fakeDevice)
    expect(r.getShapeId('circle')).toBe(0)
    expect(r.getShapeId('nope')).toBe(0)
  })

  it('user-defined symbols shadow identically-named built-ins', () => {
    const r = new ShapeRegistry(fakeDevice)
    const builtinCrossId = r.getShapeId('cross')
    expect(builtinCrossId).toBeGreaterThan(0)

    // Register a custom `cross` under the user namespace.
    const userId = r.addUserShape('cross', 'M -0.1 -0.6 L 0.1 -0.6 L 0.1 0.6 L -0.1 0.6 Z')
    expect(userId).not.toBe(builtinCrossId)

    // Lookup by bare name now returns the user's shape.
    expect(r.getShapeId('cross')).toBe(userId)
  })

  it('user symbols with unique names still resolve via bare lookup', () => {
    const r = new ShapeRegistry(fakeDevice)
    const id = r.addUserShape('dot', 'M 0 -0.5 L 0.5 0 L 0 0.5 L -0.5 0 Z')
    expect(id).toBeGreaterThan(0)
    expect(r.getShapeId('dot')).toBe(id)
    // And it doesn't accidentally register in the unprefixed namespace too.
    expect(Object.keys(BUILTIN_SHAPES)).not.toContain('dot')
  })
})
