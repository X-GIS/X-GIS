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

/** Drop the latch — tests only, so one case's warning cannot silence the next one's. */
export function resetCategoricalPaletteWrapWarnings(): void {
  warned.clear()
}
