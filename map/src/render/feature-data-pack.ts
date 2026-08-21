// ═══ feat_data packing — the ONE featureProps → Float32Array authority ═══
//
// Extracted from FeatureDataBinder.buildPerTileFeatureData (#1592) so the RHI
// fill path can pack the SAME bytes without holding a GPUDevice. The binder is
// WebGPU-native end to end (createBuffer / writeBuffer / createBindGroup) and on
// the webgl2 backend there is no device to hand it — but everything ABOVE that
// half is pure: the `fid * fieldCount + j` row layout the polygon variant shader
// indexes, and the categorical string → id maps that decide WHICH match() arm a
// feature lands in.
//
// Copying it into the RHI path instead would drift exactly where drift is
// invisible: a category id computed differently on one backend paints a
// different colour with no error anywhere, which is the #723 bug class this
// stable-id scheme exists to close. One authority, two callers.

/** #723 — stable, tile-independent categorical palette id. FNV-1a of the
 *  value, masked to 23 bits so it round-trips EXACTLY through the f32
 *  `feat_data` slot (f32 mantissa is 24 bits); the `categorical()` shader
 *  applies `% <palette>` (shader-gen.ts:227) to land it in a palette slot.
 *  The prior code used the ALPHABETICAL RANK of the values present in a
 *  single tile, so the same value mapped to a different slot depending on
 *  which other values shared the tile — a `categorical()` fill therefore
 *  changed colour across zoom/pan (issue #723). An id that is a pure
 *  function of the value is identical in every tile by construction. */
export function stableCategoryId(v: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < v.length; i++) h = Math.imul(h ^ v.charCodeAt(i), 0x01000193)
  return (h >>> 0) & 0x7fffff
}

/** Build a value→id map for a `categorical()` field that has NO compile-time
 *  `categoryOrder` (i.e. the palette path, not `match()`). The id is
 *  `stableCategoryId(value)` — a pure function of the value, NOT the
 *  per-tile / per-source rank. Shared by the per-tile and source-level
 *  packers so both agree on a value's colour. See #723. */
export function buildCategoryMap(values: Iterable<string>): Map<string, number> {
  const map = new Map<string, number>()
  for (const v of values) if (!map.has(v)) map.set(v, stableCategoryId(v))
  return map
}

/** Pack one tile's worker-emitted `featureProps` into the flat `feat_data[fid *
 *  fieldCount + j]` layout the polygon variant shader indexes by the stride-28
 *  vertex `feature_id`.
 *
 *  featId is tile-local but not necessarily contiguous (the worker may filter
 *  features out), so the row count is `max(featId) + 1` — direct indexing, no
 *  featId → row mapping table. Unfilled slots stay 0, which is what the
 *  variant's fallback arm expects.
 *
 *  That `max(featId) + 1` needs NO sparsity bound, unlike the source-level
 *  packer's (see DENSE_TABLE_FLOOR_BYTES in feature-data-binder.ts): every
 *  producer of a `featureProps` map keys it by the TILE-LOCAL ARRAY INDEX —
 *  `buildFeatureProps` (data/src/workers/mvt-worker.ts:42) and the per-tile
 *  props loop (data/src/sources/pmtiles-backend.ts:612) — and every other
 *  `featureProps:` in the tree is a passthrough of one of those two. So
 *  `max(featId) + 1 <= features.length` here by construction. A stable USER id
 *  (`toU32Id`, hashed across the whole u32 range for a non-integer id) only
 *  ever rides the SOURCE-level table, which is where the bound lives (#1947).
 *
 *  Returns null when there is nothing to pack (no props, no fields, or every
 *  featId negative), so the caller can skip the buffer allocation entirely. */
export function packPerTileFeatureData(
  featureProps: ReadonlyMap<number, Record<string, unknown>> | undefined,
  fields: readonly string[],
  categoryOrder: Readonly<Record<string, readonly string[]>>,
): { data: Float32Array; featureCount: number } | null {
  if (!featureProps || featureProps.size === 0) return null
  const fieldCount = fields.length
  if (fieldCount === 0) return null

  let maxFid = -1
  for (const fid of featureProps.keys()) {
    if (fid > maxFid) maxFid = fid
  }
  const featureCount = maxFid + 1
  if (featureCount <= 0) return null

  const data = new Float32Array(featureCount * fieldCount)

  // Per-field categorical maps — compile-time order FIRST so the shader's
  // if-else chain IDs match. Without it the runtime falls back to "alphabetical
  // rank of the unique values in THIS tile", which collides with the shader's
  // IDs whenever the tile's data is a proper subset of the pattern set (a tile
  // holding only `school` would encode school=0 and paint it in cemetery's arm).
  const catMaps = new Map<string, Map<string, number>>()
  for (const fieldName of fields) {
    const order = categoryOrder[fieldName]
    const map = new Map<string, number>()
    if (order && order.length > 0) {
      order.forEach((v, i) => map.set(v, i))
      // Unknown values get IDs beyond the if-else range → fallback arm.
      const unseen = new Set<string>()
      for (const props of featureProps.values()) {
        const v = props[fieldName]
        if (typeof v === 'string' && !map.has(v)) unseen.add(v)
      }
      let next = order.length
      for (const v of [...unseen].sort()) map.set(v, next++)
    } else {
      // #723 — categorical() palette id is a pure function of the value
      // (stableCategoryId), NOT the per-tile alphabetical rank, so the same
      // value gets the same palette slot in every tile / at every zoom.
      const vals: string[] = []
      for (const props of featureProps.values()) {
        const v = props[fieldName]
        if (typeof v === 'string') vals.push(v)
      }
      for (const [v, id] of buildCategoryMap(vals)) map.set(v, id)
    }
    catMaps.set(fieldName, map)
  }

  for (const [fid, props] of featureProps) {
    for (let j = 0; j < fieldCount; j++) {
      const fieldName = fields[j]!
      const val = props[fieldName]
      const catMap = catMaps.get(fieldName)
      if (catMap && typeof val === 'string') {
        data[fid * fieldCount + j] = catMap.get(val) ?? 0
      } else if (typeof val === 'number') {
        data[fid * fieldCount + j] = val
      }
    }
  }

  return { data, featureCount }
}
