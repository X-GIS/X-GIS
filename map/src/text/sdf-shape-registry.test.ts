import { describe, it, expect } from 'vitest'
import { ShapeRegistry, BUILTIN_SHAPES, type SegmentData } from '@xgis/map'
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

describe('ShapeRegistry curve flattening (#1765)', () => {
  // `circle r: 0.5` exactly as compiler/src/ir/symbol-elements.ts `circlePath` emits it: four
  // cubics with the standard quarter-arc control offset k = 4/3·(√2 − 1)·r = 0.2761. Max-extent
  // normalization scales the 0.5 radius to 1, so every emitted vertex must sit at |p| ≈ 1.
  const CIRCLE =
    'M 0.5 0 C 0.5 0.2761 0.2761 0.5 0 0.5 C -0.2761 0.5 -0.5 0.2761 -0.5 0 ' +
    'C -0.5 -0.2761 -0.2761 -0.5 0 -0.5 C 0.2761 -0.5 0.5 -0.2761 0.5 0 Z'
  // The rect half of the fixture's `sym_pair` (playground/src/examples/
  // fixture-symbol-anchor-inline.xgis), which shares the shape's 32-segment budget with a circle.
  const PAIR_RECT = 'M -2 -0.5 L -1 -0.5 L -1 0.5 L -2 0.5 Z'
  const PAIR_CIRCLE =
    'M 2 0 C 2 0.2761 1.7761 0.5 1.5 0.5 C 1.2239 0.5 1 0.2761 1 0 ' +
    'C 1 -0.2761 1.2239 -0.5 1.5 -0.5 C 1.7761 -0.5 2 -0.2761 2 0 Z'

  function segmentsOf(r: ShapeRegistry, name: string): SegmentData[] {
    const internal = (r as unknown as { shapes: Map<string, { segments: SegmentData[] }> }).shapes
    const entry = internal.get('user:' + name)
    if (!entry) throw new Error(`shape ${name} not registered`)
    return entry.segments
  }

  /** Shoelace area of the closed chain the segments trace. */
  const chainArea = (segs: SegmentData[]): number =>
    Math.abs(segs.reduce((a, s) => a + (s.p0x * s.p1y - s.p1x * s.p0y), 0)) / 2

  it('turns the four-cubic circle into line segments that stay round to the pixel bound', () => {
    const r = new ShapeRegistry(new WebGpuDevice(fakeDevice))
    r.addUserSymbol('ring', [CIRCLE])
    const segs = segmentsOf(r, 'ring')

    // The load-bearing property: the SDF's winding test (`winding_line`) and its distance
    // (`dist_to_line`) are exact ONLY for kind 0. Before the fix these were four `kind: 2`
    // cubics and the shader wound them by their CHORDS — a diamond.
    expect(segs.every((s) => s.kind === 0)).toBe(true)
    // Inside the cap the shader actually walks (`min(seg_count, 32)`), so nothing is dropped.
    expect(segs.length).toBeLessThanOrEqual(32)
    expect(segs.length).toBeGreaterThanOrEqual(24)

    // ROUNDNESS, measured rather than asserted structurally. Each chord's midpoint must sit
    // within FLATTEN_TOL-ish of the unit circle; the achieved 7-pieces-per-quarter split gives a
    // measured sagitta of 0.00657 (analytic bound 0.75·M/n² = 0.00704 with M = 0.4598, n = 7).
    // 1/140 is that bound expressed as HALF A PIXEL for a `size-70` glyph (the fixture's
    // `sym_dot`): radius_px is 70, so 0.5 px is 1/140 of the radius. The pre-fix chord
    // quadrilateral scores 1 − cos(π/4) = 0.2929, forty-one times over.
    const sagitta = Math.max(
      ...segs.map((s) => 1 - Math.hypot((s.p0x + s.p1x) / 2, (s.p0y + s.p1y) / 2)),
    )
    expect(sagitta).toBeGreaterThan(0) // inscribed, never outside
    expect(sagitta).toBeLessThan(1 / 140)

    // …and the same fact as AREA, the quantity the render gate reads off the frame: a 28-gon
    // inscribed in the unit circle is 0.9919·π, the chord diamond only 2/π = 0.6366·π.
    const areaRatio = chainArea(segs) / Math.PI
    expect(areaRatio).toBeGreaterThan(0.98)
    expect(areaRatio).toBeLessThanOrEqual(1)
  })

  it('shares the 32-segment budget so a rect+circle block cannot overrun it', () => {
    const r = new ShapeRegistry(new WebGpuDevice(fakeDevice))
    r.addUserSymbol('pair', [PAIR_RECT, PAIR_CIRCLE])
    const segs = segmentsOf(r, 'pair')
    // 4 (rect) + 4 × 6 (the circle's equal share of what the straight segments leave) = 28.
    // Without the share-out the circle alone would want 4 × 14 and the shape would be truncated
    // mid-outline — a partial winding sum, i.e. garbage fill.
    expect(segs.length).toBeLessThanOrEqual(32)
    expect(segs.every((s) => s.kind === 0)).toBe(true)
    // The circle half still resolves: its own chain (everything past the rect's 4 segments)
    // encloses ~π·0.25², not the 2·0.25² of a diamond.
    const circleArea = chainArea(segs.slice(4))
    expect(circleArea / (Math.PI * 0.25 * 0.25)).toBeGreaterThan(0.98)
  })

  it('spends nothing extra on a curve that is already flat', () => {
    const r = new ShapeRegistry(new WebGpuDevice(fakeDevice))
    // Control points ON the chord — max|B″| is ~0, so the tolerance (not the budget) decides.
    r.addUserShape('flat', 'M -1 0 C -0.3333 0 0.3333 0 1 0')
    expect(segmentsOf(r, 'flat')).toHaveLength(1)
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
