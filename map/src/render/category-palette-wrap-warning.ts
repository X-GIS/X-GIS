// ═══ A `categorical()` field with more values than the palette says so (#2428) ═══
//
// `categorical(field)` indexes a FIXED 20-colour array modulo its length —
// `CAT_PALETTE[u32(field) % CAT_PALETTE_SIZE]` (shader-gen.ts:287, :406). Past 20
// distinct categories the index wraps: the 21st value paints exactly like the 1st.
// Distinct data reads as duplicated data, and nothing anywhere said so.
//
// #724 raised this and shipped only its smaller half — single-sourcing the bound
// from `CAT_PALETTE_SIZE` so the modulo and the array cannot drift — then closed
// as completed. The wrap itself survived, with a NOTE in `categorical-encoder.ts`
// still forwarding readers to the closed issue. This is the diagnostic half.
//
// IT DOES NOT FIX THE WRAP, and that is deliberate rather than a shortcut: a
// data-sized palette (#2428 option (a)) is the real remedy and needs the palette
// built where the distinct-category count is known. Painting a representative
// colour instead would misreport the data. What remains is the same bargain
// `per-feature-color-warning.ts` and `rhi-fill-gap-warning.ts` struck — the
// fallback stays, it stops being SILENT.
//
// WHY THE RUNTIME AND NOT THE COMPILER. #724 asked for a "compile-time
// diagnostic", which is not available: the category count comes from the DATA,
// which the compiler never sees. A static warning on every `categorical()` use
// would fire on the correct ones too. `buildCategoryMap` is the only place that
// holds the distinct set, so the diagnostic lives at that single producer and
// both packers (per-tile and source-level) inherit it by construction (§12).
//
// Its own module for the reason `per-feature-color-warning.ts` gives: this is a
// latched, IO-performing diagnostic, and `feature-data-pack.ts` is the
// import-free packing authority.
//
// SINCE #2579 IT OWNS TWO DIAGNOSTICS, because the palette has two independent
// bounds and each path has only one of them. `warnCategoricalPaletteWrap` is the
// PIGEONHOLE bound and stays correct where the id is a dense rank; the HASHED id
// a streamed source gets collides on the BIRTHDAY bound instead, which the count
// cannot see, so `warnCategoricalSlotCollisions` counts the collisions that are
// actually there. Two latches, one reset — see each function.

import { xlog } from '@xgis/shared'
import { CAT_PALETTE_SIZE } from '@xgis/compiler'

/** Field names already reported. Module-scope and STRINGS ONLY — nothing here
 *  references a map, a renderer or a GPU resource, so a destroyed map is not
 *  pinned (#1567). */
const warned = new Set<string>()

/** Report, at most once per field, that a `categorical()` field has more distinct
 *  values than the auto-palette can distinguish.
 *
 *  Latched because the caller runs once per TILE per field: unlatched, a source
 *  with thousands of tiles emits thousands of identical lines and scrolls the
 *  message away, which for the author it is written for is the same as silence.
 *
 *  `count` is the distinct-value count THIS packer saw, so the per-tile caller
 *  may report a smaller number than the source-level one. That is honest — it is
 *  what wrapped in the set that was packed — and the message says "at least",
 *  because a later tile can raise it and the latch means only the first is seen. */
export function warnCategoricalPaletteWrap(
  fieldName: string,
  count: number,
  sink: (msg: string) => void = xlog.warn,
): void {
  if (count <= CAT_PALETTE_SIZE) return
  if (warned.has(fieldName)) return
  warned.add(fieldName)
  sink(
    `[X-GIS] categorical("${fieldName}") saw at least ${count} distinct values but the auto ` +
      `palette has ${CAT_PALETTE_SIZE} colours, so the index wraps (\`% ${CAT_PALETTE_SIZE}\`) and ` +
      `value ${CAT_PALETTE_SIZE + 1} onward repeat earlier colours — distinct categories render ` +
      `as duplicates (#2428). Use \`match(${fieldName}, …)\` with explicit colours for the ` +
      `categories that must be told apart.`,
  )
}

/** Field names already reported for a hash SLOT COLLISION (#2579). A second
 *  latch rather than a shared one: the two diagnostics describe different
 *  defects and neither should be able to silence the other. */
const collided = new Set<string>()

/** Report, at most once per field, that a `categorical()` field's HASHED ids
 *  land two or more distinct values in the same palette slot (#2579).
 *
 *  WHY THIS EXISTS ALONGSIDE `warnCategoricalPaletteWrap`. That one is keyed on
 *  the PIGEONHOLE bound — more distinct values than colours — which is the true
 *  and only bound for a DENSE index (`deriveSeededCategoryOrder`). The hashed
 *  path has no such floor: `stableCategoryId` is a hash landed with
 *  `% CAT_PALETTE_SIZE`, so collisions follow the BIRTHDAY bound and cross even
 *  odds at ~27 distinct values — two orders of magnitude below the palette
 *  length. A count-keyed check therefore reports zero on a field that is
 *  already painting duplicates, which reads as a clean corpus.
 *
 *  So this one does not estimate: it counts the collisions actually present in
 *  the map the packer just built, and names the colliding VALUE PAIRS — the one
 *  form an author can act on, because the remedy (`match()`) is written per
 *  value.
 *
 *  Latched for the reason `warnCategoricalPaletteWrap` is: the caller runs once
 *  per TILE per field. The set it sees is the set that was PACKED, so a per-tile
 *  caller reports the collisions inside one tile; the source-level packer sees
 *  the whole table. Both are honest about what they saw, and the first to find a
 *  collision is the one that speaks. */
export function warnCategoricalSlotCollisions(
  fieldName: string,
  ids: ReadonlyMap<string, number>,
  sink: (msg: string) => void = xlog.warn,
): void {
  const bySlot = new Map<number, string[]>()
  for (const [value, id] of ids) {
    const slot = id % CAT_PALETTE_SIZE
    const bucket = bySlot.get(slot)
    if (bucket) bucket.push(value)
    else bySlot.set(slot, [value])
  }
  // Sorted by slot, and by value within a slot, so the message is a pure
  // function of the VALUE SET — never of the feature order the packer happened
  // to walk. #2439 rejected arrival-order behaviour for the same reason.
  const collisions = [...bySlot]
    .filter(([, values]) => values.length > 1)
    .sort((a, b) => a[0] - b[0])
  if (collisions.length === 0) return
  if (collided.has(fieldName)) return
  collided.add(fieldName)

  const shared = collisions.reduce((n, [, values]) => n + values.length, 0)
  const named = collisions
    .slice(0, 3)
    .map(([slot, values]) => `${[...values].sort().join(' + ')} → slot ${slot}`)
    .join('; ')
  sink(
    `[X-GIS] categorical("${fieldName}") — ${shared} of ${ids.size} distinct values share a ` +
      `palette slot with another value, so they render in the SAME colour: ${named}` +
      `${collisions.length > 3 ? `; and ${collisions.length - 3} more slots` : ''}. The id is a ` +
      `hash landed with \`% ${CAT_PALETTE_SIZE}\`, so collisions follow the birthday bound — even ` +
      `odds at about 27 distinct values, not at ${CAT_PALETTE_SIZE}. Use \`match(${fieldName}, …)\` ` +
      `with explicit colours for the categories that must be told apart, or seed the source from a ` +
      `complete FeatureCollection so it gets the collision-free dense index instead (#2579).`,
  )
}

/** Drop BOTH latches — tests only, so one case's warning cannot silence the
 *  next one's. One reset for the module: a test file that cleared one latch and
 *  not the other would pass or fail by test ORDER, which is the failure these
 *  injectable sinks exist to prevent. */
export function resetCategoricalPaletteWrapWarnings(): void {
  warned.clear()
  collided.clear()
}
