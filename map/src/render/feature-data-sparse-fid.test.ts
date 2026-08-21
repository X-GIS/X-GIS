// ═══ #1947 — the source-level feat_data buffer refuses a sparse fid space ═══
//
// Making `PropertyTable.values` fid-addressed (so per-feature properties follow
// the geometry's fid) handed the source-level packer a NEW failure mode: the
// buffer is indexed directly by fid, so its length is `maxFid + 1` — a size set
// by the id SPACE, not the feature count. `toU32Id` passes integer ids through
// but FNV-hashes everything else across the whole u32 range, so ONE feature
// with `"id": "USA"` lands at slot 2_523_649_480 and the dense array over that
// space is a ~10 GB Float32Array. Before the fid fix that same input allocated
// a 1-row buffer and merely painted the wrong colour; the fix must not turn a
// silent mis-colour into an OOM.
//
// The four cases below are the whole contract:
//   sparse  → refuse, warn, allocate NOTHING (the fallback the empty-table
//             branch already takes) — once at a BOUNDED gap that the unguarded
//             packer can still survive (so the guard has a pasteable
//             fail-before), once at the real hashed-id gap
//   small   → allocate, no warn — the shape `_inline-match-virt`'s fixture has
//             (ids 1 and 2), so the render path is provably untouched
//   dense+  → allocate ABOVE the byte floor, no warn — without this the guard
//             would be indistinguishable from "never allocate over 1 MiB",
//             which would silently drop data-driven paint on every large source
//
// WARNING for anyone re-running this WITHOUT the guard: the hashed-id case does
// not merely over-allocate, it HANGS. The category-map pass iterates
// `for (const row of table.values)` over the whole id space, so 2.5e9 hole
// checks spin a core indefinitely at flat RSS. That is why the bounded case
// exists — it reaches the same verdict in milliseconds.
//
// The real-producer cases build their PropertyTable through the REAL producer
// (`compileGeoJSONToTiles` + the `toU32Id` coercion the legacy route's
// `feature-id-fallback` resolver applies to an explicit `feature.id`), so what
// is pinned is the table production actually emits, not a hand-shaped stand-in.

import { describe, it, expect, afterEach } from 'vitest'
import { compileGeoJSONToTiles, type PropertyTable } from '@xgis/compiler'
import { toU32Id } from '@xgis/data'
import { setLogSink } from '@xgis/shared'
import { FeatureDataBinder } from '@xgis/map'

/** Compile a FeatureCollection the way the legacy inline route does: every
 *  feature carries an explicit `feature.id`, coerced by the same `toU32Id`
 *  the worker's `feature-id-fallback` resolver uses. */
function realTable(ids: (string | number)[]): PropertyTable {
  const features = ids.map((id, i) => ({
    type: 'Feature' as const,
    id,
    properties: { kind: i === 0 ? 'a' : 'b' },
    geometry: {
      type: 'Polygon' as const,
      coordinates: [
        [
          [i * 2, 0],
          [i * 2 + 1, 0],
          [i * 2 + 1, 1],
          [i * 2, 1],
          [i * 2, 0],
        ],
      ],
    },
  }))
  return compileGeoJSONToTiles(
    { type: 'FeatureCollection', features },
    { minZoom: 0, maxZoom: 0, idResolver: (f) => toU32Id(f.id) },
  ).propertyTable
}

/** Drive the REAL `buildFeatureDataBuffer` against a recording device, so the
 *  observable is what the GPU would have been asked for — not a return value
 *  alone. `variantKey` must be unique per case: the warn is once-per-variant. */
function drive(
  table: PropertyTable,
  variantKey: string,
): { built: boolean; sizes: number[]; warnings: string[] } {
  const binder = Object.create(FeatureDataBinder.prototype) as FeatureDataBinder
  const sizes: number[] = []
  const warnings: string[] = []
  setLogSink((level, message) => {
    if (level === 'warn') warnings.push(message)
  })
  ;(binder as unknown as Record<string, unknown>).device = {
    createBuffer: (d: { size: number }) => {
      sizes.push(d.size)
      return { destroy: () => {} }
    },
    queue: { writeBuffer: () => {} },
  }
  const variant = {
    key: variantKey,
    featureFields: ['kind'],
    categoryOrder: { kind: ['a', 'b'] },
  }
  const built = (
    binder as unknown as {
      buildFeatureDataBuffer: (
        v: unknown,
        l: unknown,
        t: PropertyTable | undefined,
        r?: number,
      ) => boolean
    }
  ).buildFeatureDataBuffer(variant, { id: 'layout' }, table)
  return { built, sizes, warnings }
}

// The binder builds real GPUBufferUsage flags and vitest's node environment has
// no WebGPU globals. Stub the two bits it reads so a failure here is an
// ASSERTION about what was allocated, not a ReferenceError that would mask it.
const g = globalThis as unknown as Record<string, unknown>
if (!g.GPUBufferUsage) g.GPUBufferUsage = { STORAGE: 0x80, COPY_DST: 0x08 }

afterEach(() => setLogSink(null))

describe('source-level feat_data sparsity bound (#1947)', () => {
  it('a BOUNDED id gap is refused: no allocation, and the drop is announced', () => {
    // One feature at fid 5_000_000: 20 MB dense, one row — past the byte floor
    // and ~1.25e6× over the density bound, but small enough that the unguarded
    // packer completes, which is what makes this the fail-before vehicle.
    const table = realTable([5_000_000])
    expect(table.values.length).toBe(5_000_001)

    const { built, sizes, warnings } = drive(table, 'sparse-bounded-gap')

    // CAUSE before effect: the thing that must not happen is the
    // ALLOCATION. `built === false` is downstream of it, and asserting that
    // first would let a red run report the return value while saying nothing
    // about the 20 MB buffer that had already been requested.
    expect(sizes).toEqual([])
    expect(built).toBe(false)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('#1947')
  })

  it('a string feature.id makes the table span the u32 range — and NOTHING is allocated', () => {
    const table = realTable(['USA', 'CAN'])
    // Premise, from the real producer: a hashed id parks its row ~2.5e9 slots
    // in, so the dense buffer would be ~10 GB. This is the input the fid fix
    // newly exposes.
    expect(table.values.length).toBeGreaterThan(2_000_000_000)

    const { built, sizes, warnings } = drive(table, 'sparse-hashed-ids')

    // The assertion that matters, and first for the reason above: no allocation
    // was ATTEMPTED. A test that only checked `built === false` would also pass
    // if the packer had allocated 10 GB and then thrown it away.
    expect(sizes).toEqual([])
    expect(built).toBe(false)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('#1947')
    expect(warnings[0]).toContain('sparse')
    expect(warnings[0]).toContain('per-feature data SKIPPED')
  })

  it('the two-quad fixture shape (ids 1 and 2) still takes the fast path, silently', () => {
    const table = realTable([1, 2])
    // 3 slots (fid 0 is the pick sentinel, unclaimed) × 1 field × 4 B = 12 B.
    expect(table.values.length).toBe(3)

    const { built, sizes, warnings } = drive(table, 'small-int-ids')

    expect(built).toBe(true)
    expect(sizes).toHaveLength(1)
    // Buffers floor at 16 bytes; the point is that ONE small buffer was made.
    expect(sizes[0]).toBeLessThanOrEqual(64)
    expect(warnings).toEqual([])
  })

  it('a DENSE table above the byte floor is still allocated — the bound is density, not size', () => {
    // Synthetic on purpose: the subject here is the guard's arithmetic above
    // the floor, and the real-producer SHAPE is already pinned by the two cases
    // above. Compiling ~300k features through earcut to restate it would buy
    // nothing but minutes. Rows sit at fids 1..N exactly as the resolver's
    // id-less branch (`i + 1`) produces them.
    const N = 300_000
    const values: (string | null)[][] = []
    for (let i = 0; i < N; i++) values[i + 1] = [i % 2 === 0 ? 'a' : 'b']
    const table: PropertyTable = {
      fieldNames: ['kind'],
      fieldTypes: ['string'],
      values: values as PropertyTable['values'],
    }
    // 300_001 × 1 × 4 B = 1.2 MiB — past the floor, so the density clause is
    // what decides, and 300_001 slots for 300_000 rows is as dense as the
    // resolver ever gets.
    expect(table.values.length * 4).toBeGreaterThan(1 << 20)

    const { built, sizes, warnings } = drive(table, 'dense-large')

    expect(built).toBe(true)
    expect(sizes).toEqual([N * 4 + 4])
    expect(warnings).toEqual([])
  })
})
