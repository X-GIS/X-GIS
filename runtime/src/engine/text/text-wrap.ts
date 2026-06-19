// ═══════════════════════════════════════════════════════════════════
// Text wrap engine (Knuth-Plass line breaking + across-frame LRU cache)
// ═══════════════════════════════════════════════════════════════════
//
// SRP: MapLibre-parity Knuth-Plass line breaking over shaped glyph
// advances, with its across-frame LRU result cache.
//
// DO-NOT-SPLIT: the wrap engine and its `_pretextCache` must not
// separate — the DP chain in `_kpWrapSegment` is atomic, and the cache
// key embeds the advances bucketing that survives zoom drift but catches
// the PBF-landing advance step. `_pretextCache` stays a MODULE-LEVEL
// singleton: it is shared across all TextStage instances exactly as it
// was when this lived inside text-stage.ts (multi-map pages share wrap
// results — current behavior, preserved).

import type { GlyphInfo } from './sdf/glyph-atlas-host'
import type { WrappedLineRange, KPBreak } from './text-stage-types'

/** LRU cache for wrap results. Same (glyph sequence, font, size,
 *  letter-spacing, maxWidth) tuple produces identical line breaks. On
 *  rapid zoom in / out the same label text reappears with a small set
 *  of sizes; without this cache, every "cold" frame re-ran the wrap
 *  algorithm for every label, dominating prepare() at 44 ms / frame on
 *  Bright + compute=1 zoom oscillation.
 *
 *  LRU eviction by re-insert: Map preserves insertion order, so
 *  `delete + set` on hit moves the entry to the tail. When size
 *  exceeds the cap, drop the head (oldest). */
const PRETEXT_CACHE_MAX = 1024
const _pretextCache = new Map<number, WrappedLineRange[]>()

/** Cheap FNV-1a-style 32-bit hash for the wrap cache key. Replaces the
 *  earlier O(N) string concatenation per cache lookup — for label-dense
 *  scenes (Bright Korea z=5 has ~5000 addLabel calls/frame), the string
 *  alloc burn was the top GC pressure source AND dominated the prepare()
 *  trace on multi-instance pages (user-reported "엄청 부하가 걸리네" when
 *  opening several compare-html tabs simultaneously). Integer hashing
 *  collapses the key build to ~10 integer ops per glyph + 4 fixed-size
 *  bucket hashes, with no per-frame allocation. Collision rate at
 *  1024-entry cache is well below visibly-distinguishable thresholds. */
function pretextCacheKey(
  glyphs: readonly GlyphInfo[],
  // iter-241 — `ArrayLike<number>` accepts both `number[]` and
  // `Float32Array` (the FrameArena-backed view). Hashing uses
  // index access + length, common to both.
  advances: ArrayLike<number>,
  fontKey: string, fontSizePx: number,
  letterSpacingPx: number, maxWidthPx: number,
): number {
  let h = 0x811c9dc5 | 0  // FNV-1a 32-bit offset basis
  // fontKey character codes
  for (let i = 0; i < fontKey.length; i++) {
    h = Math.imul(h ^ fontKey.charCodeAt(i), 0x01000193)
  }
  // size / spacing / maxWidth buckets — pre-quantise to integers so
  // sub-pixel-zoom variations collapse onto one entry like before.
  h = Math.imul(h ^ ((fontSizePx * 10) | 0), 0x01000193)
  h = Math.imul(h ^ ((letterSpacingPx * 100) | 0), 0x01000193)
  h = Math.imul(h ^ (maxWidthPx === Infinity ? -1 : (maxWidthPx * 10) | 0), 0x01000193)
  // Per-glyph codepoint + advance signature. Advances bucketed at
  // 0.5 px — sub-pixel-zoom drift stays inside one bucket so the
  // cache survives camera animation, but the larger PBF-land step
  // (Canvas2D fallback advance → real PBF advance is ~10-20 %, well
  // over 0.5 px on any visible glyph) crosses bucket boundaries and
  // invalidates the entry correctly.
  for (let i = 0; i < glyphs.length; i++) {
    h = Math.imul(h ^ glyphs[i]!.codepoint, 0x01000193)
    h = Math.imul(h ^ ((advances[i]! * 2) | 0), 0x01000193)
  }
  return h | 0
}

/** Compute the rendered width of glyph range [start, end) using the
 *  per-glyph advances + letter-spacing convention the renderer uses. */
function rangeWidth(
  advances: ArrayLike<number>, start: number, end: number, letterSpacingPx: number,
): number {
  let w = 0
  for (let j = start; j < end; j++) {
    w += advances[j]!
    if (j < end - 1) w += letterSpacingPx
  }
  return w
}

// ─── Knuth-Plass-style line breaking (port of MapLibre tagged_string) ───
//
// The old `wrapWithPretext` path delegated to the browser line breaker
// (greedy fit-as-much-as-possible per line). On real map labels —
// "Yellow Sea", "Sea of Japan", "黄海 / 황해 / 조선서해" — the greedy
// algorithm broke EVERY line at the first opportunity it could,
// producing 5-7 line stacks where MapLibre kept text on 2-3 lines.
//
// MapLibre uses the algorithm from `src/symbol/tagged_string.ts`:
//   1. averageLineWidth = totalWidth / ceil(totalWidth / maxWidth)
//   2. At each breakable codepoint (space, hyphen, ideographic, `\n`,
//      …) record a potential break with badness = (lineWidth -
//      targetWidth)^2 + penalty²
//   3. Dynamic programming: each break's "best prior break" is the
//      one minimising cumulative badness. The final answer follows
//      the chain back from the last break.
//   4. Last-line badness halves when shorter than target (favours
//      ragged-right paragraphs) and doubles when longer.
//
// Key correctness detail copied verbatim: WHITESPACE codepoints
// (0x20, 0x09, 0x0a, 0x0d, 0x3000) do NOT contribute to currentX —
// they collapse against the break point ahead. Without this we'd
// over-count line widths by `~spacing per inter-word gap` and force
// more breaks than necessary.
const _BREAKABLE_CP: Record<number, true> = {
  0x0a: true, 0x20: true, 0x26: true, 0x29: true, 0x2b: true, 0x2d: true,
  0x2f: true, 0xad: true, 0xb7: true, 0x200b: true, 0x2010: true,
  0x2013: true, 0x2027: true,
}
const _BREAKABLE_BEFORE_CP: Record<number, true> = { 0x28: true }
function _charIsWhitespace(cp: number): boolean {
  return cp === 0x09 || cp === 0x0a || cp === 0x0d || cp === 0x20 || cp === 0x3000
}
// MapLibre's regex-based `codePointAllowsIdeographicBreaking` covers
// the CJK + Hangul + Hiragana + Katakana + CJK Symbols + Fullwidth
// ranges. The numeric range form below matches the BMP-only cases the
// regex tests for — adequate for everything OFM/Bright/Liberty source
// data ships. Supplementary-plane ideographs (rare CJK extensions)
// fall through to the Latin-style breakable-only path.
function _allowsIdeographicBreaking(cp: number): boolean {
  return (cp >= 0x2e80 && cp <= 0x2fdf)
    || (cp >= 0x2ff0 && cp <= 0x303f)
    || (cp >= 0x3041 && cp <= 0x3096)
    || (cp >= 0x309d && cp <= 0x309f)
    || (cp >= 0x30a1 && cp <= 0x30fa)
    || (cp >= 0x30fd && cp <= 0x30ff)
    || (cp >= 0x3105 && cp <= 0x312f)
    || (cp >= 0x31a0 && cp <= 0x4dbf)
    || (cp >= 0x4e00 && cp <= 0xa48c)
    || (cp >= 0xa490 && cp <= 0xa4c6)
    || (cp >= 0xac00 && cp <= 0xd7a3)   // Hangul syllables
    || (cp >= 0xf900 && cp <= 0xfa6d)
    || (cp >= 0xfa70 && cp <= 0xfad9)
    || (cp >= 0xfe10 && cp <= 0xfe1f)
    || (cp >= 0xfe30 && cp <= 0xfe4f)
    || (cp >= 0xff00 && cp <= 0xffef)
    || cp === 0x02ea || cp === 0x02eb
}

/** Minimum on-screen size (CSS px) for a label containing CJK/Hangul
 *  ideographs. Dense Han glyphs carry far more ink than Latin, so the fixed
 *  24-px SDF atlas minified to the zoom-clamped low-zoom text-size (~9 px at
 *  z0) collapses e.g. 国 into a solid dark box (cjk-minification-box.test +
 *  project_non_merc_z0_disc_render_fail headed evidence). Flooring the display
 *  size keeps the minification mild enough to stay legible. The floor only
 *  binds where the style size has already clamped below it (very low zoom), so
 *  higher-zoom rendering — and the label pixel-match baselines — are unchanged. */
export const CJK_MIN_DISPLAY_PX = 14

/** Local-ideograph display-size ladder (#421). CJK/ideograph glyphs are
 *  rasterised LOCALLY at one of these CSS-px buckets (× dpr) instead of the
 *  fixed 24-px PBF reference, so a small CJK label stays crisp (minification
 *  ≤ ~bucket/displaySize) instead of minifying a 24-px SDF into a solid box —
 *  the box-out the old `CJK_MIN_DISPLAY_PX` floor papered over by INFLATING the
 *  label (which broke MapLibre size parity, #421). A coarse ladder keeps the
 *  atlas-slot count + re-raster churn bounded as zoom moves a label between
 *  buckets. Buckets ≤ 48 fit the 64-px atlas slot (48 + 2·8 = 64). */
export const CJK_SIZE_BUCKETS_CSS = [12, 16, 20, 24, 32, 48] as const

/** Pick the display-size bucket (device px) for a CJK glyph rendered at
 *  `displayCssPx`. Returns the smallest bucket ≥ the display size (always
 *  minify, never magnify → no blur from upscaling a too-small SDF), clamped to
 *  the largest bucket. */
export function cjkBucketPx(displayCssPx: number, dpr: number): number {
  let bucket = CJK_SIZE_BUCKETS_CSS[CJK_SIZE_BUCKETS_CSS.length - 1]!
  for (const b of CJK_SIZE_BUCKETS_CSS) {
    if (b >= displayCssPx) { bucket = b; break }
  }
  return Math.round(bucket * dpr)
}

/** Display-size bucket (device px) for a label, or 0 when it has no CJK
 *  (Latin-only → plain PBF path). Replaces the old CJK_MIN_DISPLAY_PX floor:
 *  CJK renders crisp at its bucket so the authored size is kept (#421). */
export function cjkBucketFor(text: string, sizeCss: number, dpr: number): number {
  return hasCjkIdeograph(text) ? cjkBucketPx(sizeCss, dpr) : 0
}

/** True if the codepoint is a CJK/Hangul/Kana ideograph. MapLibre renders
 *  these with a SYNTHETIC oblique in italic labels because the italic glyph
 *  PBF (e.g. "Noto Sans Italic") serves them UPRIGHT — Noto has no italic
 *  CJK face. The text renderer gates its oblique shear on this so Latin runs
 *  (real font italic) stay untouched while CJK runs slant. Reuses the
 *  ideographic-break range table. */
export function codePointIsIdeographic(cp: number): boolean {
  return _allowsIdeographicBreaking(cp)
}

/** True if the label text contains any CJK/Hangul/Kana ideograph (reuses the
 *  ideographic-break range table). */
export function hasCjkIdeograph(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (_allowsIdeographicBreaking(text.charCodeAt(i))) return true
  }
  return false
}

function _kpBadness(lineWidth: number, targetWidth: number, penalty: number, isLast: boolean): number {
  const ragged = (lineWidth - targetWidth) ** 2
  if (isLast) return lineWidth < targetWidth ? ragged / 2 : ragged * 2
  return ragged + Math.abs(penalty) * penalty
}

function _kpPenalty(cp: number, nextCp: number, penalisableIdeo: boolean): number {
  let penalty = 0
  if (cp === 0x0a) penalty -= 10000
  if (penalisableIdeo) penalty += 150
  if (cp === 0x28 || cp === 0xff08) penalty += 50
  if (nextCp === 0x29 || nextCp === 0xff09) penalty += 50
  return penalty
}

function _kpEvaluateBreak(
  breakIndex: number,
  breakX: number,
  targetWidth: number,
  potentialBreaks: KPBreak[],
  penalty: number,
  isLast: boolean,
): KPBreak {
  let bestPrior: KPBreak | null = null
  let bestBadness = _kpBadness(breakX, targetWidth, penalty, isLast)
  for (const p of potentialBreaks) {
    const lineW = breakX - p.x
    const b = _kpBadness(lineW, targetWidth, penalty, isLast) + p.badness
    if (b <= bestBadness) {
      bestPrior = p
      bestBadness = b
    }
  }
  return { index: breakIndex, x: breakX, prior: bestPrior, badness: bestBadness }
}

function _kpCollectBreakIndices(last: KPBreak | null): number[] {
  const out: number[] = []
  for (let b = last; b !== null; b = b.prior) out.push(b.index)
  return out.reverse()
}

/** Knuth-Plass line break for a single segment (no `\n` inside).
 *  Returns the list of WrappedLineRange covering glyphs[start..end). */
function _kpWrapSegment(
  glyphs: readonly GlyphInfo[],
  advances: ArrayLike<number>,
  letterSpacingPx: number,
  maxWidthPx: number,
  segStart: number, segEnd: number,
  hasZeroWidthSpaces: boolean,
): WrappedLineRange[] {
  const n = segEnd - segStart
  if (n <= 0) return [{ start: segStart, end: segEnd, width: 0 }]
  if (maxWidthPx === Infinity) {
    return [{
      start: segStart, end: segEnd,
      width: rangeWidth(advances, segStart, segEnd, letterSpacingPx),
    }]
  }
  // 1. targetWidth = totalWidth / ceil(totalWidth / maxWidth).
  //    MapLibre `determineAverageLineWidth` sums getGlyphAdvance
  //    (advance + spacing) for EVERY char INCLUDING whitespace —
  //    only the break-position walk below skips whitespace. Skipping
  //    it here too shrank totalWidth, picking a smaller lineCount /
  //    targetWidth than MapLibre → over-wrapped CJK/Latin labels.
  let totalWidth = 0
  for (let i = segStart; i < segEnd; i++) {
    totalWidth += advances[i]! + letterSpacingPx
  }
  const lineCount = Math.max(1, Math.ceil(totalWidth / maxWidthPx))
  const targetWidth = totalWidth / lineCount
  // 2. Walk; record potential breaks at every breakable codepoint.
  const potential: KPBreak[] = []
  let currentX = 0
  for (let i = segStart; i < segEnd; i++) {
    const cp = glyphs[i]!.codepoint
    if (!_charIsWhitespace(cp)) currentX += advances[i]! + letterSpacingPx
    const isLast = i === segEnd - 1
    if (isLast) continue  // only emit the FINAL break via evaluateBreak below
    const nextCp = glyphs[i + 1]!.codepoint
    const ideoBreak = _allowsIdeographicBreaking(cp)
    const allowBreakBefore = i + 2 < segEnd ? _BREAKABLE_BEFORE_CP[nextCp] === true : false
    if (_BREAKABLE_CP[cp] === true || ideoBreak || allowBreakBefore) {
      // MapLibre only penalises ideographic breaks (+150) when the
      // text has a U+200B somewhere — `calculatePenalty(cp, next,
      // ideographicBreak && hasZeroWidthSpaces)`. Without a ZWSP a
      // CJK/Latin label freely breaks between ideographs; penalising
      // unconditionally made it dodge CJK breaks and split the Latin
      // word ("Yellow Sea" → "Yellow"/"Sea").
      const penalty = _kpPenalty(cp, nextCp, ideoBreak && hasZeroWidthSpaces)
      potential.push(_kpEvaluateBreak(i + 1, currentX, targetWidth, potential, penalty, false))
    }
  }
  // 3. Final break at segment end (isLast=true).
  const finalBreak = _kpEvaluateBreak(n + segStart, currentX, targetWidth, potential, 0, true)
  // 4. Walk back to collect break indices (each is the START of the
  //    next line). Convert to WrappedLineRange[].
  const indices = _kpCollectBreakIndices(finalBreak)
  const lines: WrappedLineRange[] = []
  let prev = segStart
  for (const idx of indices) {
    if (idx > prev) {
      lines.push({
        start: prev, end: idx,
        width: rangeWidth(advances, prev, idx, letterSpacingPx),
      })
    }
    prev = idx
  }
  return lines.length > 0 ? lines : [{
    start: segStart, end: segEnd,
    width: rangeWidth(advances, segStart, segEnd, letterSpacingPx),
  }]
}

export function wrapWithKnuthPlass(
  glyphs: readonly GlyphInfo[],
  // iter-241 — accept Float32Array (FrameArena-backed view) in
  // addition to `number[]`. Both expose `[i]` + `length` matching
  // ArrayLike<number>.
  advances: ArrayLike<number>,
  fontKey: string,
  fontSizePx: number,
  letterSpacingPx: number,
  maxWidthPx: number,
): WrappedLineRange[] {
  const cacheKey = pretextCacheKey(glyphs, advances, fontKey, fontSizePx, letterSpacingPx, maxWidthPx)
  const hit = _pretextCache.get(cacheKey)
  if (hit) {
    // LRU touch: re-insert to move to tail (most-recently-used).
    _pretextCache.delete(cacheKey)
    _pretextCache.set(cacheKey, hit)
    return hit
  }

  // Pre-split on hard newlines. Mapbox text-field expressions use `\n`
  // between bilingual scripts (`concat(name:latin, "\n", name:nonlatin)`).
  // Each segment runs through the Knuth-Plass DP independently — a
  // forced newline never carries badness into the next segment.
  const segments: { start: number; end: number }[] = []
  {
    let segStart = 0
    for (let i = 0; i < glyphs.length; i++) {
      if (glyphs[i]!.codepoint === 10 /* \n */) {
        segments.push({ start: segStart, end: i })
        segStart = i + 1
      }
    }
    segments.push({ start: segStart, end: glyphs.length })
  }

  // MapLibre's `hasZeroWidthSpaces` tests the WHOLE string
  // (`this.text.includes('​')`), not per-segment — compute once
  // over every glyph and share across the `\n`-split segments.
  const hasZeroWidthSpaces = glyphs.some(g => g.codepoint === 0x200b)

  const lines: WrappedLineRange[] = []
  for (const seg of segments) {
    if (seg.start === seg.end) {
      lines.push({ start: seg.start, end: seg.end, width: 0 })
      continue
    }
    const segLines = _kpWrapSegment(glyphs, advances, letterSpacingPx, maxWidthPx, seg.start, seg.end, hasZeroWidthSpaces)
    for (const ln of segLines) lines.push(ln)
  }

  if (lines.length === 0) lines.push({ start: 0, end: 0, width: 0 })
  _pretextCache.set(cacheKey, lines)
  if (_pretextCache.size > PRETEXT_CACHE_MAX) {
    const oldest = _pretextCache.keys().next().value
    if (oldest !== undefined) _pretextCache.delete(oldest)
  }
  return lines
}

/** Test-only entry into the Knuth-Plass line breaker. Builds minimal
 *  GlyphInfo stubs from raw codepoints (wrap only reads `.codepoint`)
 *  and returns the line ranges. Mirrors MapLibre `tagged_string.ts`
 *  `determineLineBreaks`; the parity assertions live in
 *  text-wrap.test.ts. */
export function wrapForTesting(
  codepoints: readonly number[],
  advances: readonly number[],
  maxWidthPx: number,
  letterSpacingPx = 0,
): { start: number; end: number; width: number }[] {
  const glyphs = codepoints.map(
    cp => ({ codepoint: cp } as unknown as GlyphInfo),
  )
  return wrapWithKnuthPlass(
    glyphs, advances, '__wrap_test__', 16, letterSpacingPx, maxWidthPx,
  ).map(l => ({ start: l.start, end: l.end, width: l.width }))
}
