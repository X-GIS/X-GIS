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

/** Slot 1: this batch's BASE TEXEL in the shared arrow state (#1458).
 *
 *  One state texture serves every mosaic region, each owning a contiguous range, so the VS
 *  reads texel `base + instance_index` rather than `instance_index`. Without it every region
 *  indexed from 0: the last region armed owned every texel, its siblings' arrows were leashed
 *  to cells in another domain, and a smaller sibling shrank the texture out from under a
 *  larger one. Carried here rather than in a feat slot for the reason the row exists — the
 *  advected VS has no uniform of its own, and growing the feat stride would change the STATIC
 *  arrow shader's bytes for a value only this path reads. */
export const S111_PARAM_STATE_BASE = 1

/** Slots 2 and 3: the SAMPLE STEPS spanning uv 0→1 on each axis — `(n − 1) · sub`, where `sub`
 *  is how finely the generator subdivided each cell (#1450 B, #1511).
 *
 *  What the VS does with them is turn its two SCREEN bases into a SEEDED-POSITION SPACING. The
 *  bases span one leash (`ARROW_DRIFT_UV`) of grid-uv, which is `ARROW_DRIFT_UV · stepsU` lattice
 *  steps along u, so `|basisU| / (ARROW_DRIFT_UV · stepsU)` is how many pixels apart two adjacent
 *  seeded positions land — the quantity view-driven density has to answer to, and the one the
 *  arm-time stride could not see at all (`arrowStride` reads the cell COUNT and nothing about the
 *  view).
 *
 *  They also recover each arrow's own lattice index from its origin uv, which is what makes the
 *  thinning a nested power-of-two decimation rather than a per-frame reshuffle — and what makes
 *  its `keepEvery = sub` rung fall exactly on the cell centres.
 *
 *  NOT the cell counts. `(n − 1)`, not `n`, is the reciprocal of the uv step the origins are
 *  written in (`u = col / (n − 1)`), so this is exact where a cell count is off by `n / (n − 1)`
 *  — invisible at one arrow per cell, a whole node of index skew on a finer lattice. */
export const S111_PARAM_STEPS_U = 2
export const S111_PARAM_STEPS_V = 3

/** Rows in the uploaded buffer: the nine bands plus the params row. */
export const S111_BAND_TABLE_ROWS = S111_BAND_COUNT + 1
