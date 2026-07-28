// ═══ S-111 band-table row layout — the ONE slot authority ═══
//
// Sibling of arrow-retained-feat-layout.ts, and here for the same reason: the CPU builder
// (render/s111-portrayal.ts, which turns the vendored catalogue into a GPU-indexable table) and
// the shader that indexes it (arrow-retained.ts's advected VS) must agree slot for slot, and a
// layout that lives in either one of them is a layout the other has to restate.
//
// Row `i` is catalogue band `i+1`:
//   0  upper edge          — the band's exclusive upper bound, in the shader's OWN units
//   1  scale constant      · 2  scale per unit speed   (select_arrow.xsl is affine in every band)
//   3  pad
//   4-7  r, g, b, a        — 0..1, from the s111-speed banded ramp
//
// Two vec4s per row, so the row is std140/std430-aligned on both backends.

/** Floats per band row. */
export const S111_BAND_STRIDE = 8

/** Bands in the catalogue's own order (1..9). */
export const S111_BAND_COUNT = 9

/** The catalogue's band 9 has no upper edge (`geSemiInterval`). A finite sentinel is uploaded
 *  instead of `Infinity`, which is not representable in an f32 buffer the shader can compare
 *  against — any speed at or above it lands in the last band, which is the same rule. */
export const S111_BAND_TOP_SENTINEL = 1e9

/** One TRAILING row after the nine bands, carrying the per-batch scalars the advected VS needs.
 *  Slot 0 = `uvAspect`, the grid's true-distance aspect (see s111-portrayal.ts).
 *
 *  Why here and not in a feat slot: the arrow VS has no uniform of its own, and the feat stride
 *  is baked into the emitted shader text — growing it would change the STATIC arrow shader's
 *  bytes for a value only the advected path reads, forfeiting the byte-identity guarantee that
 *  is the whole reason the advected variant is a separate module. This buffer is already
 *  per-batch, already bound only by that module, and already the place the shader looks for
 *  numbers it must not invent. */
export const S111_BAND_PARAMS_ROW = S111_BAND_COUNT

/** Slot 0 of the params row: `trueLonSpan / trueLatSpan` for this coverage. */
export const S111_PARAM_UV_ASPECT = 0

/** Rows in the uploaded buffer: the nine bands plus the params row. */
export const S111_BAND_TABLE_ROWS = S111_BAND_COUNT + 1
