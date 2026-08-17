import { describe, it, expect } from 'vitest'
import { ShapeRegistry, BUILTIN_SHAPES } from '@xgis/map'
import { WebGpuDevice } from '@xgis/rhi-webgpu'

// The registry touches `device` only from `uploadToGPU`; constructor and
// add/lookup methods are pure, so a stubbed device is sufficient here.
const fakeDevice = {} as unknown as GPUDevice

describe('ShapeRegistry', () => {
  it('resolves built-in shapes by bare name', () => {
    const r = new ShapeRegistry(new WebGpuDevice(fakeDevice))
    expect(r.getShapeId('cross')).toBeGreaterThan(0)
    expect(r.getShapeId('square')).toBeGreaterThan(0)
  })

  it('returns 0 for circle (analytical) and unknown names', () => {
    const r = new ShapeRegistry(new WebGpuDevice(fakeDevice))
    expect(r.getShapeId('circle')).toBe(0)
    expect(r.getShapeId('nope')).toBe(0)
  })

  it('user-defined symbols shadow identically-named built-ins', () => {
    const r = new ShapeRegistry(new WebGpuDevice(fakeDevice))
    const builtinCrossId = r.getShapeId('cross')
    expect(builtinCrossId).toBeGreaterThan(0)

    // Register a custom `cross` under the user namespace.
    const userId = r.addUserShape('cross', 'M -0.1 -0.6 L 0.1 -0.6 L 0.1 0.6 L -0.1 0.6 Z')
    expect(userId).not.toBe(builtinCrossId)

    // Lookup by bare name now returns the user's shape.
    expect(r.getShapeId('cross')).toBe(userId)
  })

  it('user symbols with unique names still resolve via bare lookup', () => {
    const r = new ShapeRegistry(new WebGpuDevice(fakeDevice))
    const id = r.addUserShape('dot', 'M 0 -0.5 L 0.5 0 L 0 0.5 L -0.5 0 Z')
    expect(id).toBeGreaterThan(0)
    expect(r.getShapeId('dot')).toBe(id)
    // And it doesn't accidentally register in the unprefixed namespace too.
    expect(Object.keys(BUILTIN_SHAPES)).not.toContain('dot')
  })
})

describe('ShapeRegistry multi-element symbols (#1766)', () => {
  // Two disjoint unit squares, side by side in the symbol's own frame — the shape of a
  // `symbol pair { rect … rect … }` block after lowering (one path string per element).
  // Each square is FOUR segments: three explicit `L` plus the `Z` close-back to the `M`.
  const LEFT = 'M -2 -0.5 L -1 -0.5 L -1 0.5 L -2 0.5 Z'
  const RIGHT = 'M 1 -0.5 L 2 -0.5 L 2 0.5 L 1 0.5 Z'

  function desc(r: ShapeRegistry, name: string): { segCount: number; bboxMaxX: number } {
    const internal = (
      r as unknown as { shapes: Map<string, { desc: { segCount: number; bboxMaxX: number } }> }
    ).shapes
    const entry = internal.get('user:' + name)
    if (!entry) throw new Error(`shape ${name} not registered`)
    return entry.desc
  }

  it('registers one shape carrying EVERY element (segment count is the sum)', () => {
    const r = new ShapeRegistry(new WebGpuDevice(fakeDevice))
    const id = r.addUserSymbol('pair', [LEFT, RIGHT])
    expect(r.getShapeId('pair')).toBe(id)
    // 4 + 4. Registering the elements one at a time yields 4 (see the next case).
    expect(desc(r, 'pair').segCount).toBe(8)
    // …and STRUCTURE, not only the count: max-extent normalization divides the combined raw
    // bbox (x ∈ [-2, 2]) by 2, so the glyph spans x ∈ [-1, 1] plus the 0.1 margin. With only
    // the first element it would span x ∈ [-1, -0.5] and this would read ≈ -0.4.
    expect(desc(r, 'pair').bboxMaxX).toBeCloseTo(1.1, 5)
  })

  it('per-element registration under one name keeps only the FIRST element', () => {
    // The defect this method exists to prevent, locked in: `addShape` is keyed by NAME and
    // returns the existing id on a hit, so a second call for the same symbol is a silent
    // no-op. That is why the elements have to be joined BEFORE registration rather than
    // accumulated inside it.
    const r = new ShapeRegistry(new WebGpuDevice(fakeDevice))
    const first = r.addUserShape('pair', LEFT)
    expect(r.addUserShape('pair', RIGHT)).toBe(first)
    expect(desc(r, 'pair').segCount).toBe(4)
  })
})

describe('ShapeRegistry path normalization', () => {
  // The registry's `shapes` map exposes desc.bbox indirectly; we use a
  // tiny accessor pattern: register, then read the internal entry. The
  // bbox stored on ShapeDescData includes a +0.1 margin per axis (see
  // pathToSegments), so post-normalization a ±1 path's bbox spans
  // approximately [-1.1, 1.1] on each axis.
  function readBBox(r: ShapeRegistry, name: string): [number, number, number, number] {
    const internal = (
      r as unknown as {
        shapes: Map<
          string,
          { desc: { bboxMinX: number; bboxMinY: number; bboxMaxX: number; bboxMaxY: number } }
        >
      }
    ).shapes
    const userKey = 'user:' + name
    const entry = internal.get(userKey) ?? internal.get(name)
    if (!entry) throw new Error(`shape ${name} not registered`)
    const b = entry.desc
    return [b.bboxMinX, b.bboxMinY, b.bboxMaxX, b.bboxMaxY]
  }

  it('normalizes a sub-unit path so max-|coord| becomes 1', () => {
    const r = new ShapeRegistry(new WebGpuDevice(fakeDevice))
    // Diamond authored at ±0.5 (max-extent 0.5)
    r.addUserShape('mydot', 'M 0 -0.5 L 0.5 0 L 0 0.5 L -0.5 0 Z')
    const [minX, minY, maxX, maxY] = readBBox(r, 'mydot')
    // Margin of 0.1 added to normalized [-1, 1] bounds.
    expect(maxX).toBeGreaterThan(1.05)
    expect(maxX).toBeLessThan(1.15)
    expect(maxY).toBeGreaterThan(1.05)
    expect(maxY).toBeLessThan(1.15)
    expect(minX).toBeLessThan(-1.05)
    expect(minX).toBeGreaterThan(-1.15)
    expect(minY).toBeLessThan(-1.05)
    expect(minY).toBeGreaterThan(-1.15)
  })

  it('preserves aspect ratio for anisotropic paths', () => {
    const r = new ShapeRegistry(new WebGpuDevice(fakeDevice))
    // Long thin rectangle: x extent ±0.5, y extent ±0.1.
    // Max-extent is 0.5 → scale by 2. Y becomes ±0.2.
    r.addUserShape('bar', 'M -0.5 -0.1 L 0.5 -0.1 L 0.5 0.1 L -0.5 0.1 Z')
    const [, minY, maxX, maxY] = readBBox(r, 'bar')
    expect(maxX).toBeGreaterThan(1.05)
    expect(maxX).toBeLessThan(1.15)
    // Y axis: 0.1 × 2 = 0.2, plus 0.1 margin → ~0.3
    expect(maxY).toBeGreaterThan(0.25)
    expect(maxY).toBeLessThan(0.35)
    expect(minY).toBeLessThan(-0.25)
    expect(minY).toBeGreaterThan(-0.35)
  })

  it('built-in `square` (now ±1 source) registers at ±1 normalized extent', () => {
    const r = new ShapeRegistry(new WebGpuDevice(fakeDevice))
    const [minX, minY, maxX, maxY] = readBBox(r, 'square')
    expect(maxX).toBeGreaterThan(1.05)
    expect(maxX).toBeLessThan(1.15)
    expect(maxY).toBeGreaterThan(1.05)
    expect(maxY).toBeLessThan(1.15)
    expect(minX).toBeLessThan(-1.05)
    expect(minX).toBeGreaterThan(-1.15)
    expect(minY).toBeLessThan(-1.05)
    expect(minY).toBeGreaterThan(-1.15)
  })

  it('handles degenerate paths without NaN (single-point M then Z)', () => {
    const r = new ShapeRegistry(new WebGpuDevice(fakeDevice))
    // Max-extent is 0 → scale skipped; bbox is just origin ± margin.
    r.addUserShape('blank', 'M 0 0 Z')
    const [minX, minY, maxX, maxY] = readBBox(r, 'blank')
    expect(Number.isFinite(minX)).toBe(true)
    expect(Number.isFinite(minY)).toBe(true)
    expect(Number.isFinite(maxX)).toBe(true)
    expect(Number.isFinite(maxY)).toBe(true)
    expect(maxX).toBeCloseTo(0.1, 5)
    expect(minX).toBeCloseTo(-0.1, 5)
  })
})
