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

import {
  warnCategoricalPaletteWrap,
  warnCategoricalSlotCollisions,
} from './category-palette-wrap-warning'

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
export function buildCategoryMap(
  values: Iterable<string>,
  fieldName?: string,
): Map<string, number> {
  const map = new Map<string, number>()
  for (const v of values) if (!map.has(v)) map.set(v, stableCategoryId(v))
  // #2579 — the shader lands this id with `% CAT_PALETTE_SIZE`, and the id is a
  // HASH, so two distinct values collide on the BIRTHDAY bound (even odds at ~27
  // values) rather than the pigeonhole one. The count-keyed #2428 check that used
  // to live on this line therefore reported nothing on a field already painting
  // duplicates — 145 values / 21 collisions and silence. It is not gone: it is the
  // right bound for the DENSE ids `deriveSeededCategoryOrder` produces and still
  // fires from there. Here the map itself is in hand, so the collisions are
  // counted rather than estimated.
  //
  // This is still the only place the distinct set exists, so the check stays at
  // the single producer and both packers inherit it (§12). `fieldName` is
  // optional so the #723 subset-independence tests can call this without
  // inventing one; both PRODUCTION callers pass it, which
  // `categorical-palette-wrap.test.ts` gates at the source rather than trusting
  // the convention.
  if (fieldName !== undefined) warnCategoricalSlotCollisions(fieldName, map)
  return map
}

/** Derive a deterministic value list for `categorical()` fields from a source's
 *  COMPLETE seeded FeatureCollection — the dense-index half of #2439.
 *
 *  WHY THIS EXISTS AND WHERE IT DOES NOT APPLY. `stableCategoryId` is a 23-bit
 *  hash, so the shader's `CAT_PALETTE[id % N]` collides on the BIRTHDAY bound,
 *  not the pigeonhole one: at N=512 roughly 65 of `countries.geojson`'s 258
 *  names would still share a colour. A rank in `[0, D)` collides never. The
 *  rank needs the complete distinct set, and #723 needs it to be the same set
 *  for every tile — which is exactly what a seeded collection is and what a
 *  streamed MVT/PMTiles source can never be. Those sources pass nothing here
 *  and keep the hash (plus the #2579 collision warning), which remains the
 *  only correct answer where the distinct set is never final.
 *
 *  Sorted, so the assignment is a pure function of the VALUE SET — never of
 *  feature order, tile arrival order, or anything else network-dependent
 *  (#2439 rejected a first-seen-order registry for exactly that reason: it
 *  repaints differently across two page loads and breaks hash-equality gates).
 *
 *  CALLED FROM THE ATTACH SITE (`map.ts`, the inline-GeoJSON virtual-PMTiles
 *  branch) because that is the one place holding BOTH the complete collection
 *  and the variant's field list — and it runs before the first tile is packed,
 *  which matters: the packers read this per tile, so a list arriving later
 *  would leave already-uploaded tiles on the old ids.
 *
 *  Fields that already carry a COMPILE-TIME order from a `match()` are skipped:
 *  the shader's if-else arms are numbered by that list, so a data-derived one
 *  would repaint every arm. Compile-time wins, here and at the read site. */
export function deriveSeededCategoryOrder(
  features: readonly { properties?: Record<string, unknown> | null }[],
  fields: readonly string[],
  compileTimeOrder: Readonly<Record<string, readonly string[]>> = {},
  /** Diagnostic sink, injectable for the same reason
   *  `warnCategoricalPaletteWrap` takes one: the latch is module-global, so a
   *  test that asserted on the console would pass or fail by test ORDER. */
  warnSink?: (msg: string) => void,
): Record<string, readonly string[]> {
  const out: Record<string, readonly string[]> = {}
  for (const field of fields) {
    const authored = compileTimeOrder[field]
    if (authored && authored.length > 0) continue
    const seen = new Set<string>()
    for (const f of features) {
      const v = f.properties?.[field]
      if (typeof v === 'string') seen.add(v)
    }
    if (seen.size === 0) continue
    // This path BYPASSES `buildCategoryMap` — so without this line a seeded
    // source silently lost the only diagnostic it had, and lost it exactly
    // where the author is most likely to have too many categories (a whole
    // FeatureCollection, not one tile). Caught by the render probe: the warning
    // that fired before the dense index stopped firing after it, on the same
    // scene.
    //
    // The PIGEONHOLE bound is the right one HERE and only here: these ids are a
    // dense rank, so they collide when — and only when — there are more of them
    // than slots, which makes the count it reports exact rather than "at least".
    // The hashed path takes `warnCategoricalSlotCollisions` instead, because a
    // count cannot see a birthday collision (#2579).
    warnCategoricalPaletteWrap(field, seen.size, warnSink)
    out[field] = [...seen].sort()
  }
  return out
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
  seededOrder?: Readonly<Record<string, readonly string[]>>,
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
    // Compile-time order FIRST, then the seeded one (#2439). Precedence, not
    // a merge: a `match()` numbers the shader's if-else arms by ITS list, so a
    // data-derived list must never displace it. Both take the identical branch
    // below — a dense rank with unknowns appended past the end — because they
    // are the same kind of object: an ordered value list whose index IS the id.
    const order = categoryOrder[fieldName] ?? seededOrder?.[fieldName]
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
      // Reached when neither an authored `match()` list nor a SEEDED one
      // exists — i.e. a streamed MVT/PMTiles source, whose distinct set is
      // never final. The hash collides on the birthday bound (#2439) and
      // `buildCategoryMap`'s #2579 collision warning is what tells the author;
      // a dense rank here would be the pre-#723 subset-dependent bug, so this
      // stays.
      const vals: string[] = []
      for (const props of featureProps.values()) {
        const v = props[fieldName]
        if (typeof v === 'string') vals.push(v)
      }
      for (const [v, id] of buildCategoryMap(vals, fieldName)) map.set(v, id)
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
