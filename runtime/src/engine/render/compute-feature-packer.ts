// ═══════════════════════════════════════════════════════════════════
// Feature property → compute-kernel `feat_data` layout
// ═══════════════════════════════════════════════════════════════════
//
// Plan Phase 4 runtime piece. Pure function that converts a tile's
// per-feature property values into the Float32Array the compute
// kernels read at `feat_data[fid * stride + offset]`.
//
// Two value categories the packer must handle:
//
//   - Numeric fields. ternary / interpolate kernels predicate on
//     numeric comparisons (`v_rank > 5.0`), so the property goes
//     straight into the typed array as f32. Missing / non-numeric
//     values become 0 (matching the inline fragment path's default).
//
//   - String fields used by match() kernels. The kernel compares
//     against integer IDs assigned by alphabetical sort
//     (categoryOrder). The packer converts the string into the
//     matching index. Unmatched strings → -1 so the kernel's
//     fall-through `else` branch fires (default colour).
//
// The packer is shared between worker-side feature decode (where
// the typed array is built once per tile) and main-thread per-tile
// upload (where it's transferred into the GPU buffer). Pure: no
// GPU, no DOM, no allocations beyond the returned Float32Array.

/** One feature's property bag. Worker decode produces these from
 *  MVT / PMTiles tags; main-thread GeoJSON sources surface them
 *  directly from the parsed JSON. Values are whatever the source
 *  produced — string, number, boolean, null, undefined. */
export type FeaturePropertyBag = Record<string, unknown>

/** Inputs for `packFeatureData`. `props` is indexed by feature ID
 *  (0..featureCount-1); missing IDs produce zero-filled feature
 *  rows. `fieldOrder` + `categoryOrder` come from a ComputePlanEntry
 *  (or directly from a ComputeKernel) — they're the contract the
 *  kernel needs the buffer to satisfy. */
export interface PackFeatureDataInput {
  /** Lookup by feature ID. ID is whatever the source assigns; the
   *  packer treats fid as an array index 0..featureCount-1. */
  getProps: (fid: number) => FeaturePropertyBag | null | undefined
  /** Field names + order — kernel reads `feat_data[fid * N + i]`
   *  where i is the position in this list. */
  fieldOrder: readonly string[]
  /** For string-typed match() fields, the alphabetical pattern list
   *  whose index is the f32 ID the kernel compares against. Fields
   *  without an entry are treated as numeric. */
  categoryOrder: Record<string, readonly string[]>
  /** Total number of features the kernel will be dispatched over.
   *  Determines the returned array length (`featureCount * N`). */
  featureCount: number
}

/** Convert per-feature property values into the f32 layout the
 *  compute kernel reads. */
export function packFeatureData(input: PackFeatureDataInput): Float32Array {
  const stride = input.fieldOrder.length
  // No fields → no work. Return a sentinel 0-length buffer so the
  // caller can still wire it through writeBuffer (the buffer's size
  // would be 0 anyway, and an empty Float32Array is a stable
  // identity for the GPU buffer factory).
  if (stride === 0 || input.featureCount === 0) {
    return new Float32Array(0)
  }

  const out = new Float32Array(input.featureCount * stride)

  // Pre-compute per-field category lookup maps. Pattern → ID lookup
  // dominates the hot loop on string-typed fields; an object lookup
  // is faster than `indexOf` once arrays exceed ~16 entries.
  const fieldCategoryLookup = new Array<Map<string, number> | null>(stride)
  for (let i = 0; i < stride; i++) {
    const name = input.fieldOrder[i]!
    const patterns = input.categoryOrder[name]
    if (!patterns || patterns.length === 0) {
      fieldCategoryLookup[i] = null
      continue
    }
    const m = new Map<string, number>()
    for (let p = 0; p < patterns.length; p++) {
      m.set(patterns[p]!, p)
    }
    fieldCategoryLookup[i] = m
  }

  for (let fid = 0; fid < input.featureCount; fid++) {
    const bag = input.getProps(fid)
    if (!bag) continue
    const base = fid * stride
    for (let i = 0; i < stride; i++) {
      const name = input.fieldOrder[i]!
      const raw = bag[name]
      const catMap = fieldCategoryLookup[i]
      if (catMap !== null) {
        // String-typed match field. Lookup → ID, miss → -1 so the
        // kernel's else-branch fires (default colour).
        if (typeof raw === 'string') {
          const id = catMap.get(raw)
          out[base + i] = id !== undefined ? id : -1
        } else {
          out[base + i] = -1
        }
        continue
      }
      // Numeric field (ternary / interpolate / boolean-conditional).
      // Booleans become 0/1 so conditional kernel's `v_field != 0.0`
      // predicate fires. Strings / null / undefined → 0.
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        out[base + i] = raw
      } else if (typeof raw === 'boolean') {
        out[base + i] = raw ? 1 : 0
      }
      // Else: out[base + i] stays at its initialised 0 (Float32Array
      // is zero-filled by default). No explicit write needed.
    }
  }

  return out
}
