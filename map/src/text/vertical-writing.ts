// CJK vertical writing — the COLUMN. `text-writing-mode: ["vertical"]`,
// ADR-0012 D7 P2 (#2144), governed by docs/plans/2026-08-24-cjk-vertical-text.md.
//
// WHY THIS IS NOT MAPLIBRE'S SHAPE. MapLibre lays a vertical label out along +x
// like any other run, rotates the whole label +90° CW at draw time
// (data/bucket/symbol_bucket.ts:652), and pre-rotates each verticalized glyph
// −90° CCW at quad-build time (symbol/quads.ts:304-327) so it survives that
// rotation upright. It has to: its per-glyph data is baked into a vertex buffer
// in shaping space with one label angle available on the GPU.
//
// X-GIS composes `glyphOffsets` on the CPU every frame and already carries a
// per-glyph `glyphRotations` array, so it writes the column DIRECTLY: offsets
// advance in +y at em pitch, and the rotation is 0 for an upright glyph. The
// cancelling pair is removed, not reproduced — the renderer treats `rotateRad`
// and `glyphRotations` as mutually exclusive (text-renderer.ts:363), so
// mirroring MapLibre would need surgery on the hot glyph loop for no rendered
// difference. Design §3 / §4.2.
//
// WHAT THE TWO AXES MAY DEPEND ON (design §5 — the trap, and it has bitten this
// repo before: CHANGELOG.md:1856 iter-333, pinned by sdf/pbf-glyph-bearingy.test.ts
// and bilingual-label-placement-repro.test.ts):
//   * the COLUMN pitch is the EM (`sizePx`), never `metrics.advance` — MapLibre
//     substitutes a constant ONE_EM for a verticalized glyph (shaping.ts:379-387)
//     precisely because a PBF glyph carries no vertical advance (there is no
//     `vhea` in the format, for MapLibre either);
//   * the CROSS-AXIS centreline is ONE value for the whole column, derived from
//     the em box. In MapLibre's rotated frame this is the constant baseline the
//     +90° turns into the column's x; deriving it from `bearingY` — an INK metric
//     that differs between Latin and Hangul at the same nominal size — is what
//     makes a bilingual column zig-zag sideways.
// Each glyph is then centred ACROSS the column on its own advance box (MapLibre's
// `xHalfWidthOffsetCorrection = ONE_EM / 2 - halfAdvance`, quads.ts:316), which is
// an em/advance quantity, not ink: `東`, `A` and `京` share one centreline.

/** Codepoints with UAX#50 `Vertical_Orientation = U` — the ones that read
 *  upright in a vertical line. RANGE HEURISTIC covering the blocks that carry
 *  real label text (Hangul jamo + syllables, CJK radicals/symbols/kana/bopomofo,
 *  the unified ideographs incl. Ext-A and the SIP planes, compatibility
 *  ideographs, vertical + compatibility forms, fullwidth forms). P3 replaces it
 *  with the generated UAX#50 table (design §12 P3); the deliberate
 *  simplifications until then are the exclusions inside these blocks that
 *  MapLibre's generated regex carves out (e.g. U+2E9A, U+303F) and the
 *  non-CJK upright scripts (Canadian Aboriginal, Mongolian, Yi).
 *  NOT a `/g` regex: a global regex under `.test()` carries `lastIndex` between
 *  calls and would answer differently on the second call for the same input. */
const UPRIGHT_VERTICAL_ORIENTATION =
  /^[\u1100-\u11FF\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA960-\uA97F\uAC00-\uD7FB\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6\u{20000}-\u{3FFFD}]$/u

/** MapLibre `charInComplexShapingScript` (util/script_detection.ts) verbatim —
 *  Arabic is excluded from verticalization by construction, so we exclude it
 *  identically (design §2). Non-global for the `lastIndex` reason above. */
const COMPLEX_SHAPING_SCRIPT = /^\p{sc=Arab}$/u

/** MapLibre `charIsWhitespace`. */
const WHITESPACE = /^\s$/u

/** MapLibre `allowsVerticalWritingMode` (script_detection.ts:19-24): ANY upright
 *  codepoint is enough — one ideograph in an otherwise Latin string verticalizes
 *  the label. There is no "CJK-dominant" ratio test in MapLibre and there is
 *  none here (design §1.4). */
export function allowsVerticalWritingMode(text: string): boolean {
  for (const ch of text) if (UPRIGHT_VERTICAL_ORIENTATION.test(ch)) return true
  return false
}

/** Whether this label lays out as a column. `text-writing-mode` is a HINT: a
 *  string whose script does not support the orientation is laid out in its
 *  natural orientation (v8.json), which is why the style flag alone is not
 *  enough. Absent / `['horizontal']` never reaches here — the converter emits
 *  `LabelDef.writingMode` only for `vertical` (#2051). */
export function verticalWritingActive(
  writingMode: 'horizontal' | 'vertical' | undefined,
  text: string,
): boolean {
  return writingMode === 'vertical' && allowsVerticalWritingMode(text)
}

/** The §1.2(a) truth table for the POINT path (`allowVerticalPlacement === true`):
 *  everything verticalizes EXCEPT whitespace and complex-shaping scripts. Latin,
 *  digits and punctuation therefore render UPRIGHT, one per em cell — that is
 *  MapLibre's behaviour and parity means reproducing it (design §6), not the
 *  "nicer" CSS `text-orientation: mixed` choice of rotating Latin sideways. */
export function glyphVerticalizes(codepoint: number): boolean {
  const ch = String.fromCodePoint(codepoint)
  return !(WHITESPACE.test(ch) || COMPLEX_SHAPING_SCRIPT.test(ch))
}

/** The column's extent along its own axis, in the same frame as `glyphOffsets`
 *  (deltas from the draw anchor) — the shape `deriveLabelBbox` consumes, so the
 *  collision box comes out TALL-AND-NARROW under a column instead of staying
 *  wide-and-short (design §7). */
export interface VerticalColumn {
  blockTop: number
  blockBottom: number
}

/** Compose one vertical column into the two per-glyph arrays the renderer
 *  already understands, and return the block extent for the bbox.
 *
 *  `outOffsets[2i]` is the glyph ORIGIN across the column and `[2i+1]` its
 *  BASELINE along it (the renderer's `baseX`/`baseY2`); `outRotations[i]` is 0
 *  for an upright glyph and +π/2 for one that stays horizontal — the rotation
 *  MapLibre gets for free from the un-cancelled label turn.
 *
 *  THE COLUMN IS ONE EM WIDE, whatever its glyphs advance to. The caller sets
 *  `totalAdvance` to that width before the anchor rule runs, so `drawX` lands
 *  half a column left of a centred anchor and `deriveLabelBbox` gets a
 *  tall-and-narrow box out of the SAME metrics a horizontal label uses (§7).
 *
 *  A hard newline consumes no cell: multi-COLUMN layout (MapLibre breaks a long
 *  vertical label into columns spaced by lineHeight on the cross axis) is not
 *  P2 scope — this is "the column", singular.
 *
 *  Pure; exported for unit testing. */
export function fillVerticalColumn(
  glyphs: readonly { codepoint: number }[],
  advances: ArrayLike<number>,
  sizePx: number,
  letterSpacingPx: number,
  vAlign: 0 | 0.5 | 1,
  outOffsets: Float32Array,
  outRotations: Float32Array,
): VerticalColumn {
  // Cell extent ALONG the column: one em for a verticalized glyph (MapLibre's
  // constant ONE_EM substitution), the glyph's own advance for one that stays
  // horizontal (shaping.ts:379-387 takes the `metrics.advance` branch there).
  let height = 0
  for (let i = 0; i < glyphs.length; i++) {
    if (i > 0) height += letterSpacingPx
    height += cellExtent(glyphs[i]!.codepoint, advances[i]!, sizePx)
  }
  const blockTop = -vAlign * height
  // The cross-axis centreline: half a column (one em) right of the draw anchor,
  // because the caller sets `totalAdvance` to the column width and the anchor
  // rule then places `drawX` half a column left of the anchor for a centred
  // label — the same arithmetic a horizontal label's width gets.
  const centreline = sizePx * 0.5
  let y = blockTop
  for (let i = 0; i < glyphs.length; i++) {
    const cp = glyphs[i]!.codepoint
    const cell = cellExtent(cp, advances[i]!, sizePx)
    const upright = glyphVerticalizes(cp)
    // Baseline at the cell's midpoint: X-GIS's own single-line convention after
    // the #608 cancellation (a centred line's baseline sits at the centre of its
    // line box), applied per cell. Em-derived — no `bearingY` term, so `A` and
    // `東` occupy their cells identically.
    outOffsets[i * 2] = centreline - advances[i]! * 0.5
    outOffsets[i * 2 + 1] = y + cell * 0.5
    outRotations[i] = upright ? 0 : Math.PI * 0.5
    y += cell + letterSpacingPx
  }
  return { blockTop, blockBottom: blockTop + height }
}

function cellExtent(codepoint: number, advance: number, sizePx: number): number {
  if (codepoint === 10) return 0
  return glyphVerticalizes(codepoint) ? sizePx : advance
}
