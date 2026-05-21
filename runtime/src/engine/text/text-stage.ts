// ═══════════════════════════════════════════════════════════════════
// Text Stage (Batch 1c-8b)
// ═══════════════════════════════════════════════════════════════════
//
// Single-call orchestration over the four text subsystems:
//   - GlyphAtlasHost   (slot LRU + rasterise dispatch)
//   - GlyphAtlasGPU    (R8 texture + writeTexture loop)
//   - TextRenderer     (WGSL pipeline + vertex gen)
//   - resolveText      (TextValue + props → string)
//
// MapRenderer/VTR integration is a thin call: collect labels per
// frame via `addLabel(...)`, then `render(pass, viewport)`. The
// stage handles everything else (ensureString, atlas flush, draw
// list, color resolution from LabelDef).
//
// Coordinate frame: caller supplies SCREEN PIXELS for the anchor.
// The stage never touches projection — keeping that out of here
// means the same stage works for both lat/lon-anchored map labels
// AND screen-space overlays (HUD, scale bar).

import type { LabelDef, TextValue } from '@xgis/compiler'
import { resolveText, type FeatureProps } from './text-resolver'
import {
  GlyphAtlasHost, type GlyphAtlasHostOptions,
} from './sdf/glyph-atlas-host'
import { GlyphAtlasGPU } from './sdf/glyph-atlas-gpu'
import { createRasterizer, createMetricsRasterizer, type GlyphRasterizer } from './sdf/glyph-rasterizer'
import { GlyphPbfCache } from './sdf/pbf/glyph-pbf-cache'
import { bumpAlloc } from '../__profile__/alloc-counter'
import { FrameArena } from '../gpu/frame-arena'
import { InlineGlyphProvider, type InlineGlyphSource } from './sdf/pbf/inline-glyph-provider'
import type { GlyphProvider } from './sdf/pbf/glyph-provider'
import { PbfRasterizer } from './sdf/pbf-rasterizer'
import { TextRenderer, type TextDraw } from './text-renderer'
import { greedyPlaceBboxes, type CollisionItem } from './text-collision'
import { FONT_KEY_SENTINEL } from './sdf/glyph-rasterizer'
import type { GlyphInfo } from './sdf/glyph-atlas-host'
import {
  applyTextTransform, stripCurveLineExtraScripts,
  evaluateVariableOffsetEm, variableAnchorOffsetEm,
  type LabelAnchor,
} from './text-stage-helpers'
// iter-265 — sub-phase drill inside prepare(). encoder.stage-prepare
// shows 1.31 ms/frame in iter-263 budget but we don't know which
// inner phase dominates (point shape vs curved line layout vs
// collision vs emit). Sub-marks let the perf harness identify the
// hottest sub-phase to attack next.
import { markStart as perfMarkStart, markEnd as perfMarkEnd } from '../__profile__/perf-marks'

interface WrappedLineRange { start: number; end: number; width: number }

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
/** FNV-1a 32-bit hash of (fontKey, text codepoints). Used by the
 *  iter-167 glyph-string cache. Same hash shape as pretextCacheKey
 *  but without the size/spacing fields (the cached value depends on
 *  fontKey + text only). Collisions trade a misrender against speed:
 *  at 32 bits and ≤4096 entries collision probability is well below
 *  pixel-visible — same trade-off the wrap cache already accepts. */
function glyphsCacheKey(fontKey: string, text: string): number {
  let h = 0x811c9dc5 | 0
  for (let i = 0; i < fontKey.length; i++) {
    h = Math.imul(h ^ fontKey.charCodeAt(i), 0x01000193)
  }
  // 0x1f delimiter — defends against the (fontKey + text) collision
  // case `("AB","CD") vs ("ABC","D")` that a plain concat would
  // permit. Same trick xgis uses for tile-key composition.
  h = Math.imul(h ^ 0x1f, 0x01000193)
  // Codepoint-aware (matches ensureString's surrogate handling).
  const len = text.length
  let i = 0
  while (i < len) {
    const cp = text.codePointAt(i)!
    h = Math.imul(h ^ cp, 0x01000193)
    i += cp > 0xFFFF ? 2 : 1
  }
  return h | 0
}

/** Fingerprint for the iter-168 layout cache (single-anchor static
 *  case). Mixes the slice-1 glyphsKey (which encodes fontKey + text)
 *  with every shape-affecting def field. Numeric fields are
 *  bucket-quantised so sub-px / sub-frame jitter collapses on one
 *  entry (same convention as pretextCacheKey). 32-bit hash, 4096-
 *  entry cap — collision probability well below pixel-visible. */
const _ANCHOR_ORDINAL: Record<string, number> = {
  center: 0, top: 1, bottom: 2, left: 3, right: 4,
  'top-left': 5, 'top-right': 6, 'bottom-left': 7, 'bottom-right': 8,
}
const _JUSTIFY_ORDINAL: Record<string, number> = {
  center: 0, left: 1, right: 2, auto: 3,
}
function layoutCacheKey(
  glyphsKey: number,
  sizePx: number, letterSpacingPx: number, maxWidthPx: number,
  lineHeightPx: number,
  justify: string, anchor: string,
  offsetX: number, offsetY: number,
  translateX: number, translateY: number,
  padding: number,
  haloWidth: number, haloBlur: number,
): number {
  let h = glyphsKey | 0
  h = Math.imul(h ^ ((sizePx * 10) | 0), 0x01000193)
  h = Math.imul(h ^ ((letterSpacingPx * 100) | 0), 0x01000193)
  h = Math.imul(h ^ (maxWidthPx === Infinity ? -1 : (maxWidthPx * 10) | 0), 0x01000193)
  h = Math.imul(h ^ ((lineHeightPx * 10) | 0), 0x01000193)
  h = Math.imul(h ^ ((_JUSTIFY_ORDINAL[justify] ?? 15) + 1), 0x01000193)
  h = Math.imul(h ^ ((_ANCHOR_ORDINAL[anchor] ?? 15) + 1), 0x01000193)
  h = Math.imul(h ^ ((offsetX * 10) | 0), 0x01000193)
  h = Math.imul(h ^ ((offsetY * 10) | 0), 0x01000193)
  h = Math.imul(h ^ ((translateX * 10) | 0), 0x01000193)
  h = Math.imul(h ^ ((translateY * 10) | 0), 0x01000193)
  h = Math.imul(h ^ ((padding * 10) | 0), 0x01000193)
  h = Math.imul(h ^ ((haloWidth * 10) | 0), 0x01000193)
  h = Math.imul(h ^ ((haloBlur * 10) | 0), 0x01000193)
  return h | 0
}

/** iter-167/190 — quick FNV-1a of `(fontKey, text)` for the layout
 *  cache. Smaller than pretextCacheKey (no advances bucket) since
 *  the layout cache is keyed by `(text, font, size, …)` and the
 *  advances depend on the resolved glyphs, which themselves are
 *  function of `(fontKey, text)` — folding advances into this key
 *  would just be redundant entropy. The atlas-generation guard at
 *  the cache-hit site catches the stale-slot case that needed
 *  per-advance bucketing in pretextCacheKey. */
function textKeyFor(fontKey: string, text: string): number {
  let h = 0x811c9dc5 | 0
  for (let i = 0; i < fontKey.length; i++) {
    h = Math.imul(h ^ fontKey.charCodeAt(i), 0x01000193)
  }
  // Separator byte so `font+text` != `fon+ttext`.
  h = Math.imul(h ^ 0x7f, 0x01000193)
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  }
  return h | 0
}

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
  advances: readonly number[], start: number, end: number, letterSpacingPx: number,
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

interface KPBreak {
  index: number
  x: number
  prior: KPBreak | null
  badness: number
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
  advances: readonly number[],
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

function wrapWithKnuthPlass(
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

/** ONE_EM / SHAPING_DEFAULT_OFFSET — MapLibre `shaping.ts` constants.
 *  MapLibre lays text in a 24-unit em space; the baseline of every
 *  line sits a FIXED −17/24 em below the line-box top, independent of
 *  the glyphs' own ink metrics. We work in display px, so the em→px
 *  factor is sizePx/ONE_EM. */
const ONE_EM = 24
const SHAPING_DEFAULT_OFFSET = -17

export interface MlVerticalLayout {
  /** Per-line baseline Y in px, relative to the label anchor
   *  (screen-down positive). The renderer converts baseline→quad-top
   *  by subtracting each glyph's own bearingY.
   *
   *  iter-242 — widened to `ArrayLike<number>` so FrameArena-backed
   *  `Float32Array` views work as drop-in. Read-only access via `[i]`
   *  + `length` — both Array<number> and Float32Array satisfy. */
  baselineY: ArrayLike<number>
  /** Block bbox edges in px relative to the anchor (collision). */
  blockTop: number
  blockBottom: number
}

/** MapLibre `shapeLines` + `align()` vertical model for the common
 *  single-section (scale=1, no inline images) case — every map label
 *  in OFM/MapLibre-demo styles. Each line occupies a CONSTANT
 *  `lineHeightPx` box; the per-line baseline is
 *  `li·LH + OFF + (−vAlign·n·LH + 0.5·LH)` (the `maxLineHeight ===
 *  lineHeight` branch of MapLibre `align`), with `OFF = −17·sizePx/24`.
 *  This replaces the old per-glyph maxAscent/maxDescent box, which
 *  diverged from MapLibre whenever line scripts had different ink
 *  metrics (bilingual Latin+Hangul). `vAlign` is MapLibre
 *  `getAnchorAlignment`: top→0, bottom→1, else 0.5. */
export function mlVerticalLayout(
  vAlign: 0 | 0.5 | 1, lineCount: number,
  lineHeightPx: number, sizePx: number,
  // iter-242 (Plan AAA B.2) — optional FrameArena for baselineY
  // scratch. When provided, the per-line baseline array carves from
  // the arena (no per-call allocation); when undefined (test seam),
  // falls back to `new Array(n)`. The returned `baselineY` is a
  // typed-array view that's only valid until the arena's next
  // `beginFrame()` — consumers must read inside the same frame
  // (matches the iter-241 advances lifetime contract).
  arena?: FrameArena,
): MlVerticalLayout {
  const LH = lineHeightPx
  const n = lineCount
  const off = (SHAPING_DEFAULT_OFFSET * sizePx) / ONE_EM
  const shiftY = -vAlign * n * LH + 0.5 * LH
  let baselineY: ArrayLike<number>
  if (arena !== undefined) {
    bumpAlloc('text-stage.mlVerticalLayout.baselineY.FrameArena')
    const view = arena.allocF32(n)
    for (let li = 0; li < n; li++) view[li] = li * LH + off + shiftY
    baselineY = view
  } else {
    bumpAlloc('text-stage.mlVerticalLayout.baselineY.Array')
    const arr: number[] = new Array(n)
    for (let li = 0; li < n; li++) arr[li] = li * LH + off + shiftY
    baselineY = arr
  }
  const blockTop = -vAlign * n * LH
  return { baselineY, blockTop, blockBottom: blockTop + n * LH }
}

/** Test seam for `mlVerticalLayout`. */
export function verticalLayoutForTesting(
  vAlign: 0 | 0.5 | 1, lineCount: number,
  lineHeightPx: number, sizePx: number,
): MlVerticalLayout {
  return mlVerticalLayout(vAlign, lineCount, lineHeightPx, sizePx)
}

/** Compose the rasterizer-visible font key for one label.
 *
 *  Format when weight/style are unset: plain CSS family-list string
 *  ("Foo, Bar, sans-serif"). When the LabelDef carries a fontWeight
 *  or fontStyle, the helper prepends a sentinel-delimited prefix:
 *
 *      \x01<style>\x01<weight>\x01<family-list>
 *
 *  glyph-rasterizer.ts detects the sentinel and unpacks the three
 *  fields into a properly-ordered CSS font shorthand
 *  ("italic 700 24px Foo, sans-serif"). Without this, the only way
 *  to carry weight info through ctx.font is to embed it in the
 *  family name itself, which CSS parses literally and the browser
 *  silently falls back to its default font — the root cause of "all
 *  Mapbox labels look the same Regular weight".
 *
 *  CJK_FALLBACK_CHAIN is appended after any user-supplied family
 *  list so Mapbox styles that only declare "Noto Sans Regular"
 *  still pick up a Korean / Japanese / Chinese font from the host
 *  OS for glyphs the primary family lacks. */
/** Resolve per-font typography overrides for the given fontKey against
 *  a typography table. The primary family is the first entry of the
 *  comma-separated CSS list inside the (possibly sentinel-encoded)
 *  fontKey. Returns identity values (0 / 1) when no override is
 *  registered, so callers always get a usable result. Pure helper —
 *  exported for unit testing. */
export function resolveTypography(
  fontKey: string,
  table: Map<string, { letterSpacingEm: number; lineHeightScale: number }> | null | undefined,
): { letterSpacingEm: number; lineHeightScale: number } {
  if (!table) return { letterSpacingEm: 0, lineHeightScale: 1 }
  // Skip the sentinel prefix if present; the family list is the last
  // segment. composeFontKey appends the CJK fallback chain, so the
  // primary family is whatever comes before the first comma.
  const familyList = fontKey.startsWith(FONT_KEY_SENTINEL)
    ? (fontKey.split(FONT_KEY_SENTINEL)[3] ?? '')
    : fontKey
  const primary = familyList.split(',')[0]!.trim().replace(/^["']|["']$/g, '')
  return table.get(primary) ?? { letterSpacingEm: 0, lineHeightScale: 1 }
}

export function composeFontKey(def: LabelDef, defaultFamily: string): string {
  const family = def.font && def.font.length > 0
    ? def.font.map(f => f.includes(' ') ? `"${f}"` : f).join(',')
      + ',' + CJK_FALLBACK_CHAIN
    : defaultFamily
  if (def.fontStyle === undefined && def.fontWeight === undefined) {
    return family
  }
  const style = def.fontStyle ?? 'normal'
  const weight = def.fontWeight ?? 400
  return `${FONT_KEY_SENTINEL}${style}${FONT_KEY_SENTINEL}${weight}${FONT_KEY_SENTINEL}${family}`
}

export interface TextStageOptions {
  /** Atlas slot side length in pixels. Each glyph rasterises into
   *  one slot; slot must be larger than (rasterFontSize + 2*sdfRadius). */
  slotSize?: number
  /** Atlas page side length in pixels. Multiple of slotSize. */
  pageSize?: number
  /** Pixel size each glyph is rasterised at. Display sizes scale
   *  via the SDF threshold smoothing in the shader. Picking ~24px
   *  gives good fidelity from 12px up to 64px display. */
  rasterFontSize?: number
  /** SDF falloff radius in pixels. Determines edge smoothness +
   *  halo headroom. */
  sdfRadius?: number
  /** Device-pixel-ratio the atlas rasterises for. `rasterFontSize`
   *  is multiplied by this (capped so rasterFontSize + 2*sdfRadius
   *  still fits slotSize) so locally Canvas2D-rasterised glyphs
   *  (Hangul/Han — not served by the PBF glyph endpoint) are baked
   *  near their physical-pixel display size instead of being
   *  GPU-upscaled ~dpr× from a 24-px raster (visible as low-res
   *  CJK labels on hidpi phones). Fixed at construction — the atlas
   *  is built once; matches the existing single-build lifecycle.
   *  Defaults to 1 (no scaling). */
  dpr?: number
  /** Default font key when LabelDef doesn't specify a font stack. */
  defaultFont?: string
  /** Optional rasterizer override (e.g. a worker-backed implementation
   *  injected by the integration layer). When omitted, picks the best
   *  available for the current environment via createRasterizer(). */
  rasterizer?: GlyphRasterizer
  /** Style-spec `glyphs` URL template (`{fontstack}` + `{range}`).
   *  When provided AND no explicit `rasterizer` is supplied, the stage
   *  wraps the Canvas2D rasterizer with one that fetches MapLibre SDF
   *  PBF glyphs in the background. Failed fetches (offline / 404 / CORS)
   *  stay on Canvas2D for the session. Combined with `inlineGlyphs` /
   *  `glyphProviders`, the URL provider sits at the END of the chain
   *  so cheap inline / IDB sources shadow network requests. */
  glyphsUrl?: string
  /** Pre-loaded PBF range data keyed by `{ fontstack: { rangeStart:
   *  Uint8Array } }`. Used for closed-network / military / air-gapped
   *  deployments where the host application bundles its own PBF
   *  bytes. Stacks at the TOP of the provider chain — inline data
   *  shadows network requests for any range the host pre-bundled. */
  inlineGlyphs?: { [fontstack: string]: InlineGlyphSource }
  /** Raw provider chain — escape hatch for custom backends (IndexedDB,
   *  S3, IPFS). Appended AFTER `inlineGlyphs` and BEFORE the URL-based
   *  HTTP provider. Implement the `GlyphProvider` interface to plug in. */
  glyphProviders?: GlyphProvider[]
  /** Per-font typography overrides — `{ family → { letterSpacingEm,
   *  lineHeightScale } }`. The letter-spacing offset is ADDED to the
   *  layer-level `text-letter-spacing` (in em-units), and the line-
   *  height scale multiplies the layer-level `text-line-height`. Lets
   *  callers tune multi-font bundles where the bundled families have
   *  different intrinsic tracking / leading without forking the style
   *  spec. Missing-family lookups are no-ops (identity 0 / 1). */
  fontTypography?: Map<string, { letterSpacingEm: number; lineHeightScale: number }>
}

// Slot must fit (rasterFontSize + 2*sdfRadius). PBF arrives at 24 px
// native (MapLibre's ONE_EM). Setting rasterFontSize to match means
// PBF→atlas is a 1:1 byte copy with no bilinear resample — every
// PBF-sourced glyph keeps the upstream tile server's sub-pixel SDF
// precision exactly. The byte rescale in pbf-to-slot.ts becomes a
// no-op at scale=1 (`192 + (b-192) * 1.0 == b`), eliminating the
// resampling blur that softened OFM Bright country labels relative
// to MapLibre.
//
// Canvas2D fallback still works at 24 px raster — it's the cold-
// frame fallback that disappears after the first PBF range lands,
// so its slightly lower stroke fidelity is invisible in steady
// state. (Earlier code raised this to 32 px specifically for the
// Hangul/Han Canvas2D path, but the user-visible labels go through
// PBF on every supported style; the trade-off swung the wrong way.)
//
// pageSize 2304 = 36 slots/side at slotSize 64 → 1296 slots per
// page. Multi-page atlases handle CJK-heavy maps via the renderer's
// per-page bind groups; no change to that path.
//
// defaultFont chains common CJK fallbacks AFTER sans-serif so an
// engine-level label without a Mapbox font stack still reads
// Hangul/Han correctly on every host OS we ship on (macOS / Win /
// Linux). Per-label font stacks coming from Mapbox styles get the
// same fallback chain appended in addLabel/addCurvedLineLabel.
const CJK_FALLBACK_CHAIN = '"Noto Sans CJK KR","Apple SD Gothic Neo","Malgun Gothic","Microsoft YaHei","Noto Sans CJK JP","Hiragino Sans","Yu Gothic",sans-serif'
const DEFAULTS: Required<Omit<TextStageOptions, 'rasterizer' | 'glyphsUrl' | 'inlineGlyphs' | 'glyphProviders' | 'fontTypography' | 'dpr'>> = {
  slotSize: 64,
  // iter-272 — bump atlas slots 1296 → 4096 (~3.2× headroom).
  // User-reported bilingual label corruption on OFM Bright dense
  // scenes (Seoul z=11) where atlas overflow cycles within the
  // iter-268 preloadString pass, breaking the "all admissions
  // complete before shape work" invariant. Dense bilingual scenes
  // (Latin + Hangul ~300 syllables + CJK + numbers + punctuation ×
  // multiple font weights) exceed 1296. 4096² R8 = 16 MB (was 5.3 MB).
  pageSize: 4096,
  rasterFontSize: 24,
  sdfRadius: 8,
  defaultFont: CJK_FALLBACK_CHAIN,
}

interface PendingLabel {
  text: string
  anchorX: number
  anchorY: number
  def: LabelDef
  fontKey: string
  /** Iter 112 paired-symbol collision: identifier shared with the
   *  matching icon dispatched at the SAME line-walk anchor. After
   *  collision, the stage exposes droppedPairKeys so IconStage can
   *  drop the paired icon — implements MapLibre's "text+icon as one
   *  symbol" invariant without a full paired-symbol collision queue. */
  pairKey?: string
}

interface PendingLineLabel {
  text: string
  /** Polyline already projected to screen pixels by the caller. */
  polylineX: Float32Array
  polylineY: Float32Array
  /** Distance along the polyline (px) where the label centre sits. */
  centerOffsetPx: number
  def: LabelDef
  fontKey: string
}

export class TextStage {
  readonly host: GlyphAtlasHost
  readonly gpu: GlyphAtlasGPU
  readonly renderer: TextRenderer
  readonly opts: Required<Omit<TextStageOptions, 'rasterizer' | 'glyphsUrl' | 'inlineGlyphs' | 'glyphProviders' | 'fontTypography' | 'dpr'>>
  /** The PBF rasterizer when this stage was built with PBF/inline/
   *  custom-provider config; null when no PBF chain is active.
   *  Exposed so `addGlyphProvider` can extend the chain after the
   *  stage is up. */
  private readonly pbfRasterizer: PbfRasterizer | null
  /** Per-font typography table — see TextStageOptions.fontTypography.
   *  Null when no overrides were configured (default identity behaviour). */
  private readonly fontTypography: TextStageOptions['fontTypography'] | null
  private readonly pending: PendingLabel[] = []
  private readonly pendingLine: PendingLineLabel[] = []
  /** iter-241 (Plan AAA B.2) — per-frame scratch arena for typed-array
   *  allocations that today fire per-label-per-frame inside `prepare()`.
   *  iter-240 interactive profile pinned `advances.Array` at 12,573
   *  allocations in a 3 s zoom+pan window — 54 % of the profiled
   *  total. Migrating to FrameArena turns those into watermark
   *  bumps in a single ArrayBuffer; allocation rate stabilises at
   *  the per-session peak.
   *
   *  Sub-views must NOT outlive the next `beginFrame()` call —
   *  watermark reset invalidates them. Confined to the
   *  prepare()-then-render-once pass, which completes within one
   *  synchronous frame. */
  // iter-251 — initial 64 KB overflowed on dense scene (text-stage
  // advances + baselineY + glyphOffsets point + curved sums past
  // 65 KB on Bright z=10 zoom transitions). Bumped initial to
  // 256 KB; auto-grow handles further peaks via the GROW_TRIGGER
  // logic in FrameArena.beginFrame.
  private readonly _frameArena = new FrameArena(256 * 1024)
  /** iter-241 — call at the start of each frame (map.ts renderFrame).
   *  Resets the arena watermark; capacity grows automatically. */
  beginFrame(): void {
    this._frameArena.beginFrame()
  }
  /** Diagnostic: cumulative set of resolved label-text strings the
   *  stage has SUBMITTED (post addLabel / addCurvedLineLabel) since
   *  last clear. Mirror of IconStage.getDispatchedIconNames() — answers
   *  "did the text reach the stage" (vs "evaluated to empty and
   *  dropped before submit"). Used by e2e diagnostics to isolate
   *  text-expr eval failures from downstream collision suppression.
   *  Iter 108. */
  private readonly dispatchedLabelTexts: Set<string> = new Set()
  /** iter 152 diagnostic — per-label halo normalisation capture for
   *  the z0-halo-too-large probe (user report #1). One entry per
   *  shaped label this prepare(): resolved fontSize (= def.size·dpr),
   *  the fixed atlas rasterFontSize, the resolved halo width (phys
   *  px), and haloWidthNorm = the value packUniforms feeds the
   *  shader (halo.width·3/fontSize). Lets an E2E read what the LIVE
   *  pipeline actually resolves at z0 vs deeper zoom — the unknown a
   *  unit probe of packUniforms can't reach. Capped to keep the
   *  array bounded. (memory project_z0_halo_too_large_2026_05_19) */
  private readonly haloDebug: Array<{
    text: string; fontSize: number; rasterFontSize: number
    haloWidth: number; haloWidthNorm: number
  }> = []
  /** Iter 112: pair-keys of labels REJECTED by the collision pass.
   *  IconStage reads this set in its own prepare() to drop matching
   *  icons — MapLibre-style "text+icon as one symbol" sync without a
   *  full paired-symbol collision queue. Cleared every prepare(). */
  private readonly droppedPairKeys: Set<string> = new Set()
  /** iter 167 — across-frame glyph-string cache (#10 Phase A first
   *  slice). `host.ensureString` per-character atlas-slot lookup
   *  dominates drag CPU (iter-161 profile: ensure 21.5% +
   *  ensureString 7.1% = 28.6%). For the SAME (fontKey, text) the
   *  result is camera-independent; cache it across frames. Cap at
   *  4096 entries (well above any label-dense scene; OFM Bright
   *  Korea z=5 has ~5k addLabel calls but most share a tiny set of
   *  unique texts). Invalidated wholesale on atlas eviction (rare).
   *
   *  Key: FNV-1a hash of (fontKey, text codepoints) — same shape as
   *  pretextCacheKey. Value: GlyphInfo[] (one per codepoint, same
   *  array shape host.ensureString would return). */
  private readonly _glyphsByTextCache = new Map<number, import('./sdf/glyph-atlas-host').GlyphInfo[]>()
  private static readonly GLYPHS_CACHE_MAX = 4096
  /** iter 168 — Phase A slice 2: across-frame layout cache.
   *  Caches the per-anchor camera-independent layout output (dx, dy,
   *  glyphOffsets, totalAdvance, blockTop, blockBottom, haloGeom,
   *  letterSpacingPx, rotateRad) for the SINGLE-ANCHOR-STATIC case
   *  (no variable anchors / no radialOffset / single candidate / no
   *  rotate). Variable-mode labels skip the cache (their layout
   *  depends on anchor-specific offset evaluation that is more
   *  intricate to fingerprint safely). Per frame on hit:
   *  drawX/Y = p.anchorX/Y + cached.dx/dy, bbox = drawX/Y +
   *  cached.bbox-offsets, color = per-frame p.def.color, halo color
   *  = per-frame p.def.halo.color (only halo GEOMETRY is cached). */
  private readonly _layoutCache = new Map<number, {
    dx: number; dy: number; totalAdvance: number
    blockTop: number; blockBottom: number; padding: number
    glyphOffsets: Float32Array
    glyphs: import('./sdf/glyph-atlas-host').GlyphInfo[]
    /** iter-190 — atlas generation at cache write. On read, compare
     *  with host.getGeneration(); mismatch → glyphs[] slot references
     *  may point at reassigned codepoints (iter-175 corruption root),
     *  so treat as cache miss. */
    generation: number
    haloGeom?: { width: number; blur?: number }
    sizePx: number; letterSpacingPx: number; rotateRad?: number
  }>()
  private static readonly LAYOUT_CACHE_MAX = 4096
  // iter-266 — layout cache hit-rate counter. The iter-261 L.1.1
  // probe at the OUTER label-dispatch loop (map.ts sig cache)
  // recorded 4.9 % hit-rate on zoom+pan, but the inner layout
  // cache here is keyed on content alone (textKeyFor + sizePx +
  // maxWidthPx + ... — no camera term), so its hit-rate should be
  // dramatically higher and reveal where the real Phase L.1 fix
  // is. Read via TextStage.getLayoutCacheStats() — wired into
  // map.ts global probe in the same iter for harness access.
  private _layoutCacheHits = 0
  private _layoutCacheMisses = 0
  getLayoutCacheStats(): { hits: number; misses: number; hitRate: number; entries: number } {
    const total = this._layoutCacheHits + this._layoutCacheMisses
    return {
      hits: this._layoutCacheHits,
      misses: this._layoutCacheMisses,
      hitRate: total > 0 ? this._layoutCacheHits / total : 0,
      entries: this._layoutCache.size,
    }
  }
  /** DPR applied to LabelDef.size (and offset/halo/maxWidth) at
   *  prepare() time. Anchors arrive already in physical pixels
   *  (map.ts projects against canvas.width/height) but `size` etc.
   *  come from xgis source in CSS-px convention — multiplying by
   *  DPR keeps text the right visual size on hidpi displays. */
  private dpr: number = 1

  constructor(
    device: GPUDevice,
    presentationFormat: GPUTextureFormat,
    options: TextStageOptions = {},
    sampleCount: number = 1,
  ) {
    this.opts = { ...DEFAULTS, ...options } as Required<Omit<TextStageOptions, 'rasterizer' | 'glyphsUrl' | 'inlineGlyphs' | 'glyphProviders' | 'fontTypography' | 'dpr'>>
    // Iter 116: rasterFontSize + sdfRadius are now DPR-invariant —
    // they match MapLibre's TinySDF defaults (fontSize=24, radius=8,
    // textureScale=1) and the PBF glyph server's native 24-px raster.
    // Display-size scaling happens at draw time via the shader's
    // sizePx / rasterFontSize factor, so glyph fidelity does NOT
    // depend on the host DPR.
    //
    // Pre-iter-116 multiplied both knobs by dpr (capped at 1.6 to fit
    // the slot). Justification was "fewer GPU upscales on hidpi", but
    // the trade-off conflicted with iter 114 / iter 115 SDF-encoding
    // parity work: a DPR-scaled local raster produced byte SDFs at a
    // DIFFERENT pixel-per-unit ratio than the PBF 24-px reference,
    // forcing the halo math to compensate per-source. With both
    // sources locked to the MapLibre TinySDF defaults, the shader's
    // 2.52/font_size_px AA half-width and haloK=3 are exact across
    // PBF and Canvas2D paths.
    //
    // Side effect: Canvas2D-rasterised glyphs (Hangul / icons / any
    // font absent from the PBF server) cost ~dpr² fewer GPU bytes
    // per slot, slightly reducing atlas memory on hidpi displays.
    // Rasterizer selection:
    //   1. explicit `rasterizer` override     → use as-is
    //   2. ANY of {glyphsUrl, inlineGlyphs,
    //      glyphProviders} supplied           → wrap Canvas2D with a
    //                                           PbfRasterizer chain
    //   3. neither                            → plain Canvas2D / Mock
    //                                           (existing path, byte-
    //                                           identical to pre-PBF)
    //
    // Chain order (cheapest-source-first):
    //   [InlineGlyphProvider, ...glyphProviders, GlyphPbfCache]
    //
    // The PbfRasterizer's `onLanded` forward-references `this.pbfRas`
    // via the constructor closure — only invoked async, after the
    // host is assigned a few lines below, so the temporal coupling
    // is sound.
    let rasterizer: GlyphRasterizer
    let pbfRas: PbfRasterizer | null = null
    if (options.rasterizer) {
      rasterizer = options.rasterizer
    } else if (options.glyphsUrl || options.inlineGlyphs || options.glyphProviders) {
      // PBF environment: glyphs arrive async from the network in
      // 50-200 ms typical. The sync fallback fires PER GLYPH on cold
      // frames (rapid pan / zoom in-out) — the full Canvas2D path
      // (fillText + getImageData + computeSDF) burns ~8 ms / glyph,
      // accumulating to 100+ ms freezes on dense label scenes.
      // Substitute a metrics-only fast path: measureText keeps the
      // layout correct, SDF is zero (glyph invisible) for the brief
      // window before the PBF range arrives and atlas.invalidate
      // triggers an upgrade to the real SDF on the next frame. The
      // full Canvas2D path is wired as the last-resort fallback for
      // codepoints PBF can't deliver (returns zero advance from
      // measureText → upgrade to full).
      const fullFallback = createRasterizer()
      const fallback = createMetricsRasterizer(fullFallback)
      const providers: GlyphProvider[] = []
      if (options.inlineGlyphs) providers.push(new InlineGlyphProvider(options.inlineGlyphs))
      if (options.glyphProviders) providers.push(...options.glyphProviders)
      if (options.glyphsUrl) providers.push(new GlyphPbfCache({ glyphsUrl: options.glyphsUrl }))
      pbfRas = new PbfRasterizer({
        fallback, providers,
        onLanded: (fontKey, codepoint) => this.host.invalidate(fontKey, codepoint),
      })
      rasterizer = pbfRas
    } else {
      rasterizer = createRasterizer()
    }
    this.pbfRasterizer = pbfRas
    this.fontTypography = options.fontTypography ?? null
    const hostOpts: GlyphAtlasHostOptions = {
      fontSize: this.opts.rasterFontSize,
      sdfRadius: this.opts.sdfRadius,
    }
    this.host = new GlyphAtlasHost(
      { slotSize: this.opts.slotSize, pageSize: this.opts.pageSize },
      rasterizer,
      hostOpts,
    )
    this.gpu = new GlyphAtlasGPU(device, this.host, { pageSize: this.opts.pageSize })
    this.renderer = new TextRenderer(device, this.gpu, presentationFormat, sampleCount)
  }

  /** Pre-warm the atlas with a glyph set. Run once at engine init
   *  to bake digits + punctuation + Latin alphabet so the first
   *  frame doesn't pay rasterisation cost on cold paths. */
  prewarm(codepoints: Iterable<number>, fontKey?: string): void {
    this.host.prewarm(fontKey ?? this.opts.defaultFont, codepoints)
  }

  /** Append a glyph provider to the PBF chain. No-op when this stage
   *  was built without any PBF/inline/custom-provider config (no
   *  PbfRasterizer to extend). The provider is consulted from the
   *  next `ensure()` onward — already-cached atlas slots keep their
   *  current bytes until invalidated. Used by `XGISMap.addGlyph
   *  Provider` for runtime composition. */
  addGlyphProvider(provider: GlyphProvider): void {
    this.pbfRasterizer?.addProvider(provider)
  }

  /** Set the device pixel ratio for the current frame. Call before
   *  prepare(). Sizes/offsets in LabelDef are CSS-px convention;
   *  multiplying by DPR matches the physical-pixel anchor space. */
  setDpr(dpr: number): void {
    this.dpr = dpr > 0 ? dpr : 1
  }

  /** Resolve per-font typography overrides for the given fontKey. */
  private typographyFor(fontKey: string): { letterSpacingEm: number; lineHeightScale: number } {
    return resolveTypography(fontKey, this.fontTypography)
  }

  /** Camera zoom for zoom-dependent text-field expressions (Mapbox
   *  `text-field: ["step", ["zoom"], …]` / legacy stops shape).
   *  Forwarded into the evaluator's props bag under the
   *  CAMERA_ZOOM_KEY sigil so `step(zoom, …)` evaluates correctly.
   *  Call once per frame BEFORE addLabel / addCurvedLineLabel
   *  submissions. */
  setCameraZoom(zoom: number): void {
    this.cameraZoom = zoom
  }
  private cameraZoom: number | undefined

  /** Optional render-trace recorder. When non-null, every addLabel /
   *  addCurvedLineLabel call pushes a rich `TraceLabel` (text, colour,
   *  halo, font, placement, anchor) for downstream invariant tests.
   *  Distinct from the older `_debugHook`, which only carries the
   *  (text, x, y, kind) tuple — kept for back-compat with the
   *  `#labels-debug` URL flag. Both can be active simultaneously. */
  setTraceRecorder(recorder: import('../../diagnostics/render-trace').RenderTraceRecorder | null): void {
    this._traceRecorder = recorder
  }
  private _traceRecorder: import('../../diagnostics/render-trace').RenderTraceRecorder | null = null

  /** Optional per-call hook fired once per addLabel /
   *  addCurvedLineLabel submission BEFORE collision. The hook receives
   *  the final-rendered text string + the screen-pixel anchor + the
   *  kind ('point' vs 'curve'). Used by the playground's
   *  `#labels-debug` URL flag to attach a DOM overlay on mobile where
   *  console debugging isn't available. Hook is called once per
   *  submission — collision-dropped labels still trigger it (so the
   *  user can SEE which submissions are being made even if collision
   *  hides them visually). */
  setLabelDebugHook(hook: ((text: string, ax: number, ay: number, kind: 'point' | 'curve') => void) | undefined): void {
    this._debugHook = hook
  }
  private _debugHook?: (text: string, ax: number, ay: number, kind: 'point' | 'curve') => void

  /** Default prewarm set: '0'..'9', '.,:;-+°\'\"NSEW '. Covers
   *  cursor coord readouts, timestamps, distance/bearing labels. */
  prewarmGISDefaults(fontKey?: string): void {
    const set: number[] = []
    for (let c = 0x20; c <= 0x7E; c++) set.push(c)  // basic Latin
    set.push(0xB0)  // °
    this.prewarm(set, fontKey)
  }

  /** Queue a curved label that follows a screen-projected polyline.
   *  Each glyph is placed at a different sample point along the
   *  polyline with rotation matching the local tangent — the
   *  Mapbox `symbol-placement: line` look. Caller supplies the
   *  polyline in physical-pixel coordinates plus a centre offset
   *  (distance along the polyline where the label centres). When
   *  the resolved text is wider than the available polyline length,
   *  the label is silently skipped. */
  addCurvedLineLabel(
    value: TextValue,
    props: FeatureProps,
    polylineX: Float32Array,
    polylineY: Float32Array,
    centerOffsetPx: number,
    def: LabelDef,
    fontKey?: string,
    layerName?: string,
  ): void {
    const text = resolveText(value, props, this.cameraZoom)
    if (text.length === 0) return
    // stripCurveLineExtraScripts drops everything from the first LF
    // onwards — Mapbox bilingual labels render only the primary
    // script along curves (Latin\nNonLatin would otherwise lay both
    // scripts head-to-tail along the road).
    const transformed = stripCurveLineExtraScripts(applyTextTransform(text, def.transform))
    if (transformed.length === 0) return
    if (this.dispatchedLabelTexts.size < 256) this.dispatchedLabelTexts.add(transformed)
    if (this._debugHook && polylineX.length > 0) {
      // Approximate the curve's anchor as its first vertex — enough
      // for the debug overlay to pin down a screen position. Mid-
      // point would require walking centerOffsetPx, which isn't
      // worth the cost for a debug-only path.
      this._debugHook(transformed, polylineX[0]!, polylineY[0]!, 'curve')
    }
    if (this._traceRecorder !== null && polylineX.length > 0) {
      this._traceRecorder.recordLabel({
        layerName: layerName ?? '',
        text: transformed,
        color: (def.color ?? [0, 0, 0, 1]) as readonly [number, number, number, number],
        halo: def.halo ? {
          color: def.halo.color as readonly [number, number, number, number],
          width: def.halo.width,
          blur: def.halo.blur ?? 0,
        } : undefined,
        fontFamily: (def.font && def.font[0]) ?? 'sans-serif',
        fontWeight: def.fontWeight ?? 400,
        fontStyle: def.fontStyle ?? 'normal',
        sizePx: def.size,
        placement: 'curve',
        state: 'placed',
        anchorScreenX: polylineX[0]!,
        anchorScreenY: polylineY[0]!,
      })
    }
    this.pendingLine.push({
      text: transformed,
      polylineX, polylineY, centerOffsetPx,
      def,
      fontKey: fontKey ?? composeFontKey(def, this.opts.defaultFont),
    })
  }

  /** Queue one label for the current frame. Resolve text from a
   *  TextValue + feature props inline; caller already knows the
   *  feature's screen anchor (after projection). Empty resolved
   *  text is silently skipped. */
  /** Diagnostic: every resolved text string the stage has submitted
   *  since last clear (mirror of IconStage.getDispatchedIconNames).
   *  Iter 108 — added to localize the OFM Bright Texas highway-shield
   *  text-overlay no-render bug. */
  getDispatchedLabelTexts(): string[] { return [...this.dispatchedLabelTexts].sort() }
  clearDispatchedLabelTexts(): void { this.dispatchedLabelTexts.clear() }
  /** iter 152 — drain the z0-halo probe capture (see haloDebug). */
  getHaloDebug(): ReadonlyArray<{
    text: string; fontSize: number; rasterFontSize: number
    haloWidth: number; haloWidthNorm: number
  }> { return this.haloDebug.slice() }
  clearHaloDebug(): void { this.haloDebug.length = 0 }

  /** Iter 112: pair-keys of text labels REJECTED by the most recent
   *  prepare() collision pass. IconStage.prepare reads this to drop
   *  paired icons whose text was dropped. Set is cleared at the
   *  START of each prepare() so call order matters: IconStage must
   *  run AFTER TextStage. */
  getDroppedPairKeys(): ReadonlySet<string> { return this.droppedPairKeys }

  addLabel(
    value: TextValue,
    props: FeatureProps,
    anchorScreenX: number,
    anchorScreenY: number,
    def: LabelDef,
    fontKey?: string,
    layerName?: string,
    pairKey?: string,
  ): void {
    const text = resolveText(value, props, this.cameraZoom)
    if (text.length === 0) return
    const transformed = applyTextTransform(text, def.transform)
    // Iter 108 dispatch diagnostic — record post-resolve text BEFORE
    // collision. Mirror of IconStage.dispatchedIconNames. Cap at 256
    // entries so unbounded label corpora (Bright Korea ~5000 unique)
    // don't blow up the set.
    if (this.dispatchedLabelTexts.size < 256) this.dispatchedLabelTexts.add(transformed)
    if (this._debugHook) {
      this._debugHook(transformed, anchorScreenX, anchorScreenY, 'point')
    }
    if (this._traceRecorder !== null) {
      this._traceRecorder.recordLabel({
        layerName: layerName ?? '',
        text: transformed,
        color: (def.color ?? [0, 0, 0, 1]) as readonly [number, number, number, number],
        halo: def.halo ? {
          color: def.halo.color as readonly [number, number, number, number],
          width: def.halo.width,
          blur: def.halo.blur ?? 0,
        } : undefined,
        fontFamily: (def.font && def.font[0]) ?? 'sans-serif',
        fontWeight: def.fontWeight ?? 400,
        fontStyle: def.fontStyle ?? 'normal',
        sizePx: def.size,
        placement: 'point',
        state: 'placed',  // collision result not known yet at submit time
        anchorScreenX,
        anchorScreenY,
      })
    }
    this.pending.push({
      text: transformed,
      anchorX: anchorScreenX,
      anchorY: anchorScreenY,
      def,
      fontKey: fontKey ?? composeFontKey(def, this.opts.defaultFont),
      pairKey,
    })
  }

  /** Realize queued labels into atlas + GPU + draw list. Caller
   *  invokes this once per frame after all addLabel() calls and
   *  before encoding the render pass; render() then encodes the
   *  draws onto the supplied pass. */
  prepare(): void {
    if (this.pending.length === 0 && this.pendingLine.length === 0) {
      this.renderer.setDraws([])
      return
    }
    // Phase 1: shape every label, compute its screen-space bbox, and
    // resolve the post-anchor draw position. Bbox is needed for the
    // greedy collision pass below.
    interface ShapedLabel {
      // One layout per candidate anchor. layouts[0] is the primary
      // (used by single-anchor labels); fallbacks come after for
      // text-variable-anchor.
      layouts: Array<{
        draw: TextDraw
        bbox: { minX: number; minY: number; maxX: number; maxY: number }
      }>
      allowOverlap: boolean
      ignorePlacement: boolean
      /** Mapbox `symbol-sort-key` — lower wins collisions. When
       *  undefined falls back to layer-order priority via the
       *  reverse iteration trick below. */
      sortKey?: number
    }
    const shaped: ShapedLabel[] = []
    const dpr = this.dpr
    // iter-167 Phase A first slice — across-frame glyph-string cache.
    // Atlas evictions invalidate cached GlyphInfo[] (the slot the
    // entry references is reused for a different codepoint), so on
    // ANY eviction this frame, drop the whole cache before lookups.
    // host.consumeEvictions() has no other consumer in the current
    // codebase (grep verified iter-167), so draining here is safe;
    // the GPU upload wrapper observes consumeDirty separately.
    if (this.host.consumeEvictions().length > 0) {
      this._glyphsByTextCache.clear()
      // iter-168: layout cache entries reference GlyphInfo[] whose
      // slot.pxX/pxY would point to the wrong glyph after eviction.
      this._layoutCache.clear()
    }

    // iter-268 — atlas slot aliasing fix. PRE-LOAD every codepoint
    // needed by every pending label BEFORE any shaping loop builds a
    // GlyphInfo[] array that downstream code holds in `shaped[]`.
    //
    // Bug class (user-reported 2026-05-21 OFM Bright z=5 Korea):
    // "Pyongyang" rendering as "Pyongy시ng"; "South Korea" as
    // "South 민국ea". The exact same iter-175 corruption that motivated
    // the iter-167/168 cache revert AND the iter-190 generation
    // guard — but those fixes only catch the CROSS-FRAME and
    // CACHE-RE-LOOKUP cases. They do not catch the within-frame
    // path: label A calls ensureString → builds A_glyphs holding
    // slot refs → label B calls ensureString → B's ensure() evicts
    // one of A_glyphs' slots and reuses pxX/pxY for B's codepoint →
    // A_glyphs is still alive in `shaped[]`, the renderer reads
    // its (now stale) slot reference, and the wrong SDF is drawn.
    //
    // Fix: collect all admissions into the atlas in a dedicated
    // phase BEFORE any shaped[] entry exists. Any evictions trigger
    // BEFORE any live GlyphInfo[] reference is held. After this
    // loop, the atlas is stable for the rest of the frame; the
    // subsequent ensureString calls in the shape loops below find
    // every codepoint already in metrics + infoCache and do not
    // trigger further evictions.
    //
    // Assumes the atlas fits all unique codepoints in one frame
    // (true for OFM-class styles: ~50-300 labels × ~10 chars
    // ≪ atlas slot capacity). If the atlas is too small, eviction
    // cycles during preload would still leave some labels mis-
    // rendered — that's a separate "atlas size budget" issue and
    // doesn't apply at the user-reported zoom levels.
    for (let i = 0; i < this.pending.length; i++) {
      const p = this.pending[i]!
      this.host.preloadString(p.fontKey, p.text)
    }
    for (let i = 0; i < this.pendingLine.length; i++) {
      const p = this.pendingLine[i]!
      this.host.preloadString(p.fontKey, p.text)
    }

    // iter-265 — sub-phase drill. Point-label shaping loop covers
    // ensureString + advances FrameArena fill + Knuth-Plass wrap +
    // per-anchor candidates' vertical layout + per-glyph offsets +
    // bbox compute + cache hit/miss store. The single biggest chunk
    // of prepare() time when point labels dominate (countries, POI).
    perfMarkStart('stage-prepare.point-loop')
    for (const p of this.pending) {
      // iter-175 REVERT: the iter-167 glyphsByTextCache + iter-168
      // layoutCache caused intermittent label corruption (user
      // report 2026-05-20 OFM positron #7.54/36.227/128.513 —
      // 한글 라벨이 깨져서 보여, e.g. "대전광역시" rendering as
      // "광역" with missing/wrong chars). Root: cached GlyphInfo[]
      // entries reference atlas-slot OBJECTS which the atlas-state
      // reuses for different codepoints over the session. Even with
      // a per-iteration eviction drain (iter-175 attempt), the
      // shared-slot aliasing produced wrong glyphs across labels.
      // Phase A label cache shipped iter-167/168 disabled here
      // pending redesign (likely needs slot-generation indices on
      // GlyphInfo or a cache value that copies pxX/pxY rather than
      // referencing the live slot). #10 drag p95 -36% (slice 1) +
      // -4% (slice 2) gains lost; correctness > perf.
      const glyphs = this.host.ensureString(p.fontKey, p.text)
      // CSS-px → physical-px. The atlas is in physical px (anchors
      // arrive projected to canvas.width/height) so every length
      // sourced from the LabelDef has to scale by DPR.
      const sizePx = p.def.size * dpr
      // letter-spacing in em units (Mapbox convention) — multiplies
      // the display font size to produce extra px between adjacent
      // glyphs. Per-font override (from fontTypography table) is ADDED
      // to the layer-level value so multi-font bundles can rebalance
      // intrinsic tracking differences without forking the style.
      const typo = this.typographyFor(p.fontKey)
      const letterSpacingPx = ((p.def.letterSpacing ?? 0) + typo.letterSpacingEm) * sizePx
      // Multiline layout: greedy word-break at maxWidth (em-units →
      // px). When unset, treat as Infinity = single line.
      const maxWidthPx = p.def.maxWidth !== undefined
        ? p.def.maxWidth * sizePx : Infinity
      const lineHeightEm = (p.def.lineHeight ?? 1.2) * typo.lineHeightScale
      const lineHeightPx = lineHeightEm * sizePx
      const justify = p.def.justify ?? 'center'

      // Per-glyph display advances (slot→px). Vertical placement does
      // NOT use ink metrics anymore — it follows MapLibre's constant
      // lineHeight-box model via `mlVerticalLayout` per candidate
      // anchor below.
      // iter-241 (Plan AAA B.2) — FrameArena-backed scratch instead
      // of `new Array(glyphs.length)`. iter-240 profile pinned this
      // site at 12,573 / 3 s on the interactive harness (top
      // allocator, 54 %). Sub-view valid through the synchronous
      // prepare() → render flow; the watermark resets next frame
      // (TextStage.beginFrame), invalidating this view but only
      // after the consumer (wrapWithKnuthPlass + downstream draw)
      // is done. Float32 precision matches the ~0.1 px tolerance of
      // PBF advance buckets — no observable rounding regression.
      bumpAlloc('text-stage.prepare.advances.FrameArena')
      const advances = this._frameArena.allocF32(glyphs.length)
      for (let gi = 0; gi < glyphs.length; gi++) {
        const g = glyphs[gi]!
        // Per-glyph slot→display scale: PBF runs are baked at 24 px,
        // local Hangul at the DPR-scaled raster — one bilingual label
        // mixes both, so the factor can't be label-wide.
        const scale = sizePx / (g.rasterFontSize ?? this.opts.rasterFontSize)
        advances[gi] = g.advanceWidth * scale
      }

      // Pretext handles the line-break decisions — Intl.Segmenter for
      // grapheme clusters (proper emoji ZWJ + combining marks),
      // streaming line-break with locale-aware break opportunities
      // around CJK/Hangul, soft hyphen support. We back-map its line
      // text to OUR glyph indices and recompute widths from our
      // SDF-rasterised advances so the renderer's per-glyph pen
      // positions stay consistent (the alternative — using pretext's
      // canvas-measured widths — would diverge from advanceWidth and
      // smear the bbox math).
      const lines = wrapWithKnuthPlass(
        glyphs, advances, p.fontKey, sizePx,
        letterSpacingPx, maxWidthPx,
      )
      // Total bounding box width = max line width.
      let totalAdvance = 0
      for (const ln of lines) if (ln.width > totalAdvance) totalAdvance = ln.width
      // Variable anchor (Mapbox `text-variable-anchor`): runtime
      // tries each candidate during collision and picks the first
      // non-overlapping one. Single-anchor labels always have one
      // candidate. The full draw + bbox is computed per candidate
      // here; the post-collision phase below picks the chosen one.
      // Mapbox variable placement. `text-variable-anchor-offset`
      // carries its own ordered anchor list (so it doubles as the
      // candidate set); otherwise `anchorCandidates` (text-variable-
      // anchor) drives it, falling back to the single static anchor.
      const vao = p.def.variableAnchorOffset
      const candidates: readonly LabelAnchor[] = vao
        ? vao.map(pair => pair[0])
        : (p.def.anchorCandidates && p.def.anchorCandidates.length > 0
            ? p.def.anchorCandidates
            : [p.def.anchor ?? 'center'])
      // MapLibre routes text-offset / text-radial-offset through the
      // per-anchor sign/axis rules ONLY for variable-placement labels.
      // A static single text-anchor keeps the plain offset add (no
      // baseline shift) — matching MapLibre's non-variable path.
      const variableMode = vao !== undefined
        || p.def.radialOffset !== undefined
        || (p.def.anchorCandidates !== undefined && p.def.anchorCandidates.length > 1)
      const padding = (p.def.padding ?? 2) * dpr
      const haloOut = p.def.halo
        ? {
            color: p.def.halo.color,
            width: p.def.halo.width * dpr,
            ...(p.def.halo.blur !== undefined ? { blur: p.def.halo.blur * dpr } : {}),
          }
        : undefined

      // iter-168 Phase A slice 2 — layout cache (single-anchor static).
      // Variable-anchor / radialOffset / multi-candidate / rotated
      // labels skip the cache (their per-anchor offset evaluation
      // needs intricate fingerprinting; not worth the risk for the
      // small share of labels they cover in OFM-class styles).
      // iter-190 RE-ENABLE — iter-175 reverted iter-167/168 because
      // the cached `GlyphInfo[]` references aliased atlas slots that
      // got reassigned mid-frame (one label's ensure() displacing a
      // cached glyph still indirected by a later label). Fix: keyed
      // by atlas generation. Cache entries store the generation at
      // write; on read, if `host.getGeneration()` differs, drop the
      // entry and recompute. Atlas eviction bumps generation, so any
      // stale slot pointer triggers a miss. Steady-state Paris z=18
      // pitch=70 idle frame budget was 78ms with no caching (probe
      // 2026-05-20) — label layout dominated. Re-enabling restores
      // the iter-167 / iter-168 perf gains correctly.
      const _isCacheable = !variableMode
        && candidates.length === 1
        && p.def.rotate === undefined
      let _layoutKey: number | undefined
      if (_isCacheable) {
        const anchorStr = String(candidates[0])
        const cacheKey = textKeyFor(p.fontKey, p.text)
        _layoutKey = layoutCacheKey(
          cacheKey, sizePx, letterSpacingPx,
          maxWidthPx === Infinity ? Infinity : maxWidthPx,
          lineHeightPx,
          justify, anchorStr,
          p.def.offset ? p.def.offset[0] : 0, p.def.offset ? p.def.offset[1] : 0,
          p.def.translate ? p.def.translate[0] : 0,
          p.def.translate ? p.def.translate[1] : 0,
          padding,
          haloOut ? haloOut.width : 0,
          haloOut?.blur ?? 0,
        )
        const hit = this._layoutCache.get(_layoutKey)
        // iter-190 generation guard. hit.glyphs[] references atlas
        // slots whose pxX / pxY change when the slot is reassigned.
        // If the host bumped its generation since this entry was
        // written, the references may now point at unrelated
        // codepoints → drop the entry and fall through to recompute.
        if (hit !== undefined && hit.generation === this.host.getGeneration()) {
          // iter-266 — count hit (after generation guard, so this
          // is a "real" hit that skipped the candidates loop).
          this._layoutCacheHits++
          // LRU touch.
          this._layoutCache.delete(_layoutKey)
          this._layoutCache.set(_layoutKey, hit)
          const drawX = p.anchorX + hit.dx
          const drawY = p.anchorY + hit.dy
          const haloLive = hit.haloGeom && p.def.halo
            ? {
                color: p.def.halo.color,
                width: hit.haloGeom.width,
                ...(hit.haloGeom.blur !== undefined ? { blur: hit.haloGeom.blur } : {}),
              }
            : undefined
          shaped.push({
            layouts: [{
              draw: {
                anchorX: drawX, anchorY: drawY,
                glyphs: hit.glyphs,
                fontSize: hit.sizePx,
                rasterFontSize: this.opts.rasterFontSize,
                color: p.def.color ?? [0, 0, 0, 1],
                halo: haloLive,
                letterSpacingPx: hit.letterSpacingPx,
                rotateRad: hit.rotateRad,
                glyphOffsets: hit.glyphOffsets,
                sdfRadius: this.opts.sdfRadius,
              },
              bbox: {
                minX: drawX - hit.padding,
                minY: drawY + hit.blockTop - hit.padding,
                maxX: drawX + hit.totalAdvance + hit.padding,
                maxY: drawY + hit.blockBottom + hit.padding,
              },
            }],
            allowOverlap: p.def.allowOverlap === true,
            ignorePlacement: p.def.ignorePlacement === true,
            sortKey: p.def.sortKey,
          })
          continue
        }
        // iter-266 — fell through: either no hit, or generation
        // mismatched. Both count as a miss for the harness probe.
        this._layoutCacheMisses++
      }

      const layouts: Array<{ draw: TextDraw; bbox: typeof shaped[number]['layouts'][number]['bbox'] }> = []
      for (const anchor of candidates) {
        let dx = 0, dy = 0
        if (anchor === 'left' || anchor.endsWith('-left')) dx = 0
        else if (anchor === 'right' || anchor.endsWith('-right')) dx = -totalAdvance
        else dx = -totalAdvance / 2
        // Vertical placement follows MapLibre `shapeLines`+`align()`:
        // a constant lineHeight box per line + a fixed
        // SHAPING_DEFAULT_OFFSET baseline, aligned by getAnchorAlignment
        // (top→0, bottom→1, else 0.5). `dy` no longer carries an
        // ink-metric anchor term — it's purely text-offset / translate
        // / variable below; the per-line baseline comes from `vlay`.
        const vAlign: 0 | 0.5 | 1 =
          (anchor === 'top' || anchor.startsWith('top-')) ? 0
          : (anchor === 'bottom' || anchor.startsWith('bottom-')) ? 1
          : 0.5
        // iter-242 (Plan AAA B.2) — pass arena so baselineY scratches
        // from FrameArena instead of allocating a fresh `new Array`.
        const vlay = mlVerticalLayout(vAlign, lines.length, lineHeightPx, sizePx, this._frameArena)
        if (variableMode) {
          // Per-anchor variable offset (MapLibre evaluateVariableOffset
          // / variable-anchor-offset), in em → scale by sizePx like
          // text-offset. Supersedes the plain text-offset add: MapLibre
          // folds text-offset INTO the variable offset and drops it
          // when text-radial-offset is also present.
          let vx = 0, vy = 0
          if (vao) {
            const pair = vao.find(pr => pr[0] === anchor)
            const off = pair ? pair[1] : [0, 0] as [number, number]
            ;[vx, vy] = variableAnchorOffsetEm(anchor, off)
          } else if (p.def.radialOffset !== undefined) {
            ;[vx, vy] = evaluateVariableOffsetEm(anchor, [p.def.radialOffset, 0], true)
          } else {
            ;[vx, vy] = evaluateVariableOffsetEm(
              anchor, p.def.offset ?? [0, 0], false)
          }
          dx += vx * sizePx
          dy += vy * sizePx
        } else if (p.def.offset) {
          dx += p.def.offset[0] * sizePx
          dy += p.def.offset[1] * sizePx
        }
        if (p.def.translate) {
          // text-translate is in pixels (Mapbox paint property), not
          // em-units, so it scales by DPR alone — independent of the
          // current font size. Stacks on top of text-offset.
          dx += p.def.translate[0] * dpr
          dy += p.def.translate[1] * dpr
        }
        const drawX = p.anchorX + dx
        const drawY = p.anchorY + dy
        // Per-glyph offsets for multi-line layout. Each line gets
        // justified within the bbox according to `justify`; lines
        // stack vertically by lineHeightPx.
        // Per-glyph offsets (x = within-line justified pen,
        // y = MapLibre per-line baseline). Emitted for EVERY label
        // (not just multi-line) so single- and multi-line take the
        // identical renderer path — the old split anchored them
        // differently and was the source of the #140 double-count.
        // Offsets are pure deltas from the draw anchor (drawX/drawY);
        // the renderer does base = d.anchor + offset.
        // iter-245 (Plan AAA B.3 prototype) — copy-on-cache pattern.
        // Allocate from arena (frame-scope) for the immediate render
        // path. If this layout is cacheable (see store site below),
        // a permanent `Float32Array(view)` copy is allocated at
        // cache-store time. Cache HITs return the permanent copy
        // (line ~1303), so the arena view is only valid within
        // THIS frame's prepare→render sequence.
        bumpAlloc('text-stage.prepare.glyphOffsets.point.FrameArena')
        const glyphOffsets = this._frameArena.allocF32(glyphs.length * 2)
        {
          // text-justify: auto resolves per anchor — left-anchors →
          // left, right-anchors → right, else center.
          const isLeftAnchor = anchor === 'left' || anchor.endsWith('-left')
          const isRightAnchor = anchor === 'right' || anchor.endsWith('-right')
          const effectiveJustify = justify === 'auto'
            ? (isLeftAnchor ? 'left' : isRightAnchor ? 'right' : 'center')
            : justify
          for (let li = 0; li < lines.length; li++) {
            const ln = lines[li]!
            let lineX = 0
            if (effectiveJustify === 'right') lineX = totalAdvance - ln.width
            else if (effectiveJustify === 'left') lineX = 0
            else lineX = (totalAdvance - ln.width) * 0.5
            const lineY = vlay.baselineY[li]!
            let pen = lineX
            for (let gi = ln.start; gi < ln.end; gi++) {
              glyphOffsets[gi * 2] = pen
              glyphOffsets[gi * 2 + 1] = lineY
              pen += advances[gi]!
              if (gi < ln.end - 1) pen += letterSpacingPx
            }
          }
        }
        const bbox = {
          minX: drawX - padding,
          minY: drawY + vlay.blockTop - padding,
          maxX: drawX + totalAdvance + padding,
          maxY: drawY + vlay.blockBottom + padding,
        }
        layouts.push({
          draw: {
            anchorX: drawX,
            anchorY: drawY,
            glyphs,
            fontSize: sizePx,
            rasterFontSize: this.opts.rasterFontSize,
            color: p.def.color ?? [0, 0, 0, 1],
            halo: haloOut,
            letterSpacingPx,
            rotateRad: p.def.rotate ? p.def.rotate * Math.PI / 180 : undefined,
            glyphOffsets,
            sdfRadius: this.opts.sdfRadius,
          },
          bbox,
        })
        // iter-168 cache store (cold-path single-iter cacheable case).
        if (_isCacheable && _layoutKey !== undefined) {
          if (this._layoutCache.size >= TextStage.LAYOUT_CACHE_MAX) {
            const oldest = this._layoutCache.keys().next().value
            if (oldest !== undefined) this._layoutCache.delete(oldest)
          }
          // iter-245 (Plan AAA B.3) — copy arena view to a permanent
          // heap-backed Float32Array for cache storage. The arena
          // view is only valid until next beginFrame; the cache
          // outlives many frames, so it must hold its own bytes.
          // `new Float32Array(view)` copies the underlying data.
          const cachedGlyphOffsets = new Float32Array(glyphOffsets)
          this._layoutCache.set(_layoutKey, {
            dx, dy,
            totalAdvance, padding,
            blockTop: vlay.blockTop,
            blockBottom: vlay.blockBottom,
            glyphOffsets: cachedGlyphOffsets, glyphs,
            generation: this.host.getGeneration(),
            haloGeom: haloOut
              ? {
                  width: haloOut.width,
                  ...(haloOut.blur !== undefined ? { blur: haloOut.blur } : {}),
                }
              : undefined,
            sizePx, letterSpacingPx,
            rotateRad: p.def.rotate ? p.def.rotate * Math.PI / 180 : undefined,
          })
        }
      }
      // iter 152: z0-halo probe capture. haloK=3 mirrors
      // packUniforms' pxToSdf (text-renderer.ts:602-609) exactly so
      // haloWidthNorm here == the buf[12] the shader receives.
      if (this.haloDebug.length < 512) {
        const hw = haloOut ? haloOut.width : 0
        this.haloDebug.push({
          text: p.text,
          fontSize: sizePx,
          rasterFontSize: this.opts.rasterFontSize,
          haloWidth: hw,
          haloWidthNorm: sizePx > 0 ? (hw * 3) / sizePx : 0,
        })
      }
      shaped.push({
        layouts,
        allowOverlap: p.def.allowOverlap === true,
        ignorePlacement: p.def.ignorePlacement === true,
        sortKey: p.def.sortKey,
      })
    }
    perfMarkEnd('stage-prepare.point-loop')

    // Phase 1b: shape curved line labels. Each glyph rides a
    // different point on the polyline with the local tangent rotation.
    // The static bbox used for collision is the AABB of all glyph
    // centres (rough but cheap; precise oriented bboxes are overkill
    // for label-vs-label dedupe at typical zoom).
    //
    // Shared per-phase scratches. Sized once across the curved-label
    // loop so we don't allocate `advances` / `cumLen` arrays per
    // label. The per-label sample loop also targets a shared
    // 3-element tuple instead of returning a fresh `{ x, y, angle }`
    // closure result per glyph — that was the dominant GC source
    // when many road labels project onto the same frame.
    let _advanceScratch = new Float32Array(0)
    let _cumLenScratch = new Float32Array(0)
    const _sampleOut: [number, number, number] = [0, 0, 0]
    // iter-265 — sub-phase drill. Curved-label loop covers ensure
    // String + per-glyph advance fill + cumulative length + keep
    // upright check + per-glyph sample (atan2 / Math.sin / Math.cos)
    // + glyphOffsets/Rotations arena fill. Dominates prepare() on
    // road/transportation heavy fixtures (Liberty highways at z>=12).
    perfMarkStart('stage-prepare.line-loop')
    for (const p of this.pendingLine) {
      const glyphs = this.host.ensureString(p.fontKey, p.text)
      if (glyphs.length === 0) continue
      const sizePx = p.def.size * dpr
      // Same per-font override path as the point-label branch above —
      // see the comment there for rationale. Curve labels reuse the
      // same letter-spacing semantics (extra em between adjacent
      // glyphs along the polyline arc).
      const typo = this.typographyFor(p.fontKey)
      const letterSpacingPx = ((p.def.letterSpacing ?? 0) + typo.letterSpacingEm) * sizePx
      // Total label width along the polyline (sum of advances + spacing).
      if (_advanceScratch.length < glyphs.length) {
        _advanceScratch = new Float32Array(glyphs.length * 2)
      }
      const advances = _advanceScratch
      let totalAdvancePx = 0
      for (let gi = 0; gi < glyphs.length; gi++) {
        const gg = glyphs[gi]!
        const adv = gg.advanceWidth
          * (sizePx / (gg.rasterFontSize ?? this.opts.rasterFontSize))
        advances[gi] = adv
        totalAdvancePx += adv
      }
      totalAdvancePx += letterSpacingPx * Math.max(0, glyphs.length - 1)
      // Cumulative polyline length + per-vertex distance for fast
      // distance-to-position lookup.
      const px = p.polylineX, py = p.polylineY
      const n = px.length
      if (n < 2) continue
      if (_cumLenScratch.length < n) {
        _cumLenScratch = new Float32Array(n * 2)
      }
      const cumLen = _cumLenScratch
      cumLen[0] = 0
      for (let i = 1; i < n; i++) {
        const dx = px[i]! - px[i - 1]!
        const dy = py[i]! - py[i - 1]!
        cumLen[i] = cumLen[i - 1]! + Math.sqrt(dx * dx + dy * dy)
      }
      const totalLineLen = cumLen[n - 1]!
      // Skip when label can't fit — Mapbox drops it rather than truncate.
      if (totalAdvancePx > totalLineLen) continue
      let startS = p.centerOffsetPx - totalAdvancePx * 0.5
      // Skip when the requested centre + label extends past the polyline.
      if (startS < 0 || startS + totalAdvancePx > totalLineLen + 0.5) continue

      // Mapbox `text-keep-upright` (default true): when the label's
      // overall direction would render text upside-down, flip the
      // entire run by walking the polyline in reverse. Per-glyph
      // flipping at the threshold caused adjacent glyphs across a
      // 90°-tangent boundary to face opposite ways — visibly broken
      // on roads with mild curves. Decide ONCE based on the tangent
      // sampled at the label's centre; reverse the polyline walk
      // direction if needed so all glyphs rotate coherently.
      const keepUpright = p.def.keepUpright !== false
      let walkReversed = false
      if (keepUpright) {
        // Sample tangent at label centre to gauge overall direction.
        let cIdx = 0
        const cs = p.centerOffsetPx
        while (cIdx < n - 2 && cumLen[cIdx + 1]! < cs) cIdx++
        const dxMid = px[cIdx + 1]! - px[cIdx]!
        const dyMid = py[cIdx + 1]! - py[cIdx]!
        const midAngle = Math.atan2(dyMid, dxMid)
        if (midAngle > Math.PI / 2 || midAngle < -Math.PI / 2) {
          walkReversed = true
          // Mirror startS so glyph 0 still ends up at the same screen
          // position the user expects — but now travelling toward the
          // polyline's start instead of its end.
          startS = totalLineLen - p.centerOffsetPx - totalAdvancePx * 0.5
        }
      }

      // Sample point at distance `s` along the polyline — writes to
      // `_sampleOut` shared tuple [x, y, angle] (no per-call object
      // alloc). When walkReversed, distances are measured from the
      // polyline END; the angle is flipped 180°.
      let segIdx = 0
      const sampleAt = (s: number): void => {
        const sFwd = walkReversed ? totalLineLen - s : s
        while (segIdx < n - 2 && cumLen[segIdx + 1]! < sFwd) segIdx++
        while (segIdx > 0 && cumLen[segIdx]! > sFwd) segIdx--
        const segLen = cumLen[segIdx + 1]! - cumLen[segIdx]!
        const t = segLen > 0 ? (sFwd - cumLen[segIdx]!) / segLen : 0
        const ax = px[segIdx]!, ay = py[segIdx]!
        const bx = px[segIdx + 1]!, by = py[segIdx + 1]!
        _sampleOut[0] = ax + (bx - ax) * t
        _sampleOut[1] = ay + (by - ay) * t
        let angle = Math.atan2(by - ay, bx - ax)
        if (walkReversed) angle += Math.PI
        _sampleOut[2] = angle
      }
      // iter-246 (Plan AAA B.2) — curved label per-glyph arrays via
      // FrameArena. Curved labels are NOT stored in _layoutCache
      // (only point labels are — see line ~1455 cache store branch),
      // so the arena view's lifetime is purely prepare() → render
      // within the same frame. Watermark resets at next beginFrame.
      bumpAlloc('text-stage.curved.glyphOffsets.FrameArena')
      const glyphOffsets = this._frameArena.allocF32(glyphs.length * 2)
      bumpAlloc('text-stage.curved.glyphRotations.FrameArena')
      const glyphRotations = this._frameArena.allocF32(glyphs.length)
      // Per-glyph centre = startS + sum(prev advances) + currentAdvance/2.
      // Vertical alignment: sample.y is the polyline anchor; the text
      // renderer treats it as the glyph BASELINE (glyphs grow upward
      // from there via bearingY). For along-path labels we want the
      // VISUAL CENTRE of the glyph row sitting on the line — meaning
      // the line passes through the cap-height midpoint, not under
      // the descender. Shift each anchor PERPENDICULAR to the local
      // tangent (so the offset still tracks curving roads / lat
      // lines) by ~0.35 * sizePx, which puts the cap-height midpoint
      // on the polyline for a typical Latin face. Earlier code used
      // sample.y as-is and the glyph rendered ABOVE the line —
      // visible on demotiles Tropic of Cancer / Equator labels and
      // on OFM road labels that fall inside the road carriageway.
      const verticalOffsetPx = sizePx * 0.4
      let cursor = startS
      let gminX = Infinity, gmaxX = -Infinity, gminY = Infinity, gmaxY = -Infinity
      for (let gi = 0; gi < glyphs.length; gi++) {
        const adv = advances[gi]!
        // Sample at the LEFT edge of the advance box, NOT its centre.
        // The text-renderer's bearing application places the visible
        // glyph's LEFT edge at `baseX + bearingX*scale`, so passing
        // the polyline position at advance-box-left here yields the
        // correct per-glyph anchor — `Tropic of Cancer` reads with
        // even spacing.
        // Sampling at the box centre (the pre-fix code) was off by
        // `bearingX + glyphWidth/2` per glyph; since glyph widths
        // vary, gap distance varied too — visible as "Tr o pi c of
        // Cancer" with wide / narrow alternations.
        sampleAt(cursor)
        const sx = _sampleOut[0], sy = _sampleOut[1], sAngle = _sampleOut[2]
        // Perpendicular shift: rotate (0, verticalOffsetPx) by the
        // sample's tangent angle. cos/sin of (angle + 90°) =
        // (-sin angle, cos angle). Multiply by the desired offset.
        const perpX = -Math.sin(sAngle) * verticalOffsetPx
        const perpY = Math.cos(sAngle) * verticalOffsetPx
        glyphOffsets[gi * 2] = sx + perpX
        glyphOffsets[gi * 2 + 1] = sy + perpY
        glyphRotations[gi] = sAngle
        if (sx < gminX) gminX = sx
        if (sx > gmaxX) gmaxX = sx
        if (sy < gminY) gminY = sy
        if (sy > gmaxY) gmaxY = sy
        cursor += adv + (gi < glyphs.length - 1 ? letterSpacingPx : 0)
      }
      // Line labels reference the polyline directly — anchor is at
      // origin (0,0); per-glyph offsets are absolute screen coords
      // already (the renderer computes baseX = anchorX + offset[0]
      // so we set anchor=0 and glyphOffsets[i] = sample.x).
      const haloOut = p.def.halo
        ? {
            color: p.def.halo.color,
            width: p.def.halo.width * dpr,
            ...(p.def.halo.blur !== undefined ? { blur: p.def.halo.blur * dpr } : {}),
          }
        : undefined
      const padding = (p.def.padding ?? 2) * dpr
      const halfH = sizePx * 0.5
      const draw: TextDraw = {
        anchorX: 0,
        anchorY: 0,
        glyphs,
        fontSize: sizePx,
        rasterFontSize: this.opts.rasterFontSize,
        color: p.def.color ?? [0, 0, 0, 1],
        halo: haloOut,
        letterSpacingPx,
        glyphOffsets,
        glyphRotations,
        sdfRadius: this.opts.sdfRadius,
      }
      shaped.push({
        layouts: [{
          draw,
          bbox: {
            minX: gminX - halfH - padding,
            minY: gminY - halfH - padding,
            maxX: gmaxX + halfH + padding,
            maxY: gmaxY + halfH + padding,
          },
        }],
        allowOverlap: p.def.allowOverlap === true,
        ignorePlacement: p.def.ignorePlacement === true,
        sortKey: p.def.sortKey,
      })
    }
    perfMarkEnd('stage-prepare.line-loop')

    // Phase 2: greedy bbox collision.
    //
    // Mapbox / MapLibre collision precedence:
    //   (1) Mapbox `symbol-sort-key` — lower keys win. This is the
    //       explicit author-controlled ordering and trumps the
    //       implicit layer-order rule.
    //   (2) Layer order — a label in a LATER layer beats an earlier
    //       layer's label. The mental model is "the layer you draw
    //       on top wins the screen real-estate contest" — countries
    //       (last in OFM Bright) beat water_name labels (first) at
    //       the antimeridian; POI labels (mid-stack) beat road
    //       shields when they collide.
    //
    // Our `pending` queue is populated in style order — water first,
    // country last — because map.ts iterates showCommands forward.
    // greedyPlaceBboxes is first-wins, so a naïve forward call lets
    // water labels claim the bbox real-estate and drops the country
    // ones. That's the wrong precedence and visibly so on low-zoom
    // mobile views (multiple sea names crowd out country labels
    // around the antimeridian).
    //
    // Strategy: when ANY shaped item carries sortKey, defer ordering
    // to greedyPlaceBboxes' stable sortKey-ascending pass. When no
    // sortKey is set, iterate the collision input in REVERSE so
    // later layers place first (legacy byte-identical path). Draw
    // order stays in original `shaped` order so
    // the layered rendering effect (country text on top of water
    // halo) is preserved — only the collision dedup priority flips.
    // iter-265 — sub-phase drill. Collision = CollisionItem.map +
    // greedyPlaceBboxes + per-shape place loop. greedy is O(N²) so
    // dense-label scenes (low-z world view) spend a chunk here.
    perfMarkStart('stage-prepare.collision')
    const collisionInput: CollisionItem[] = shaped.map(s => ({
      bboxes: s.layouts.map(l => l.bbox),
      allowOverlap: s.allowOverlap,
      ignorePlacement: s.ignorePlacement,
      sortKey: s.sortKey,
    }))
    // When ANY shaped item carries an explicit sortKey, greedy­Place­
    // Bboxes handles priority via stable sort by sortKey ascending —
    // we don't need (and shouldn't apply) the reverse-iteration
    // layer-order tie-break, because that would put high-sortKey
    // labels in front of low-sortKey ones. When no item sets sortKey,
    // keep the legacy reverse trick so "later layers win" behaviour
    // stays byte-identical for styles without symbol-sort-key.
    let placements
    let anySortKey = false
    for (const s of shaped) if (s.sortKey !== undefined) { anySortKey = true; break }
    if (anySortKey) {
      placements = greedyPlaceBboxes(collisionInput)
    } else {
      const reversed: CollisionItem[] = []
      for (let i = collisionInput.length - 1; i >= 0; i--) reversed.push(collisionInput[i]!)
      const placementsReversed = greedyPlaceBboxes(reversed)
      placements = new Array(shaped.length) as typeof placementsReversed
      for (let i = 0; i < placementsReversed.length; i++) {
        placements[shaped.length - 1 - i] = placementsReversed[i]!
      }
    }
    const draws: TextDraw[] = []
    // Iter 112 paired-symbol collision: stamp pairKeys of REJECTED
    // text labels so IconStage.prepare can drop the matching icon.
    // MapLibre treats text + icon as one symbol — both placed or both
    // dropped. Without this, every dispatched icon survived (no
    // IconStage collision) while text could be collision-rejected,
    // visible as "white shield boxes without road numbers" on
    // highway-shield-* layers.
    this.droppedPairKeys.clear()
    // shaped[i] is built 1:1 from this.pending in iteration order
    // above (line ~941). The collision-input may reorder but each
    // ShapedLabel still references its source PendingLabel by index.
    for (let i = 0; i < shaped.length; i++) {
      const placement = placements[i]!
      const src = this.pending[i]
      if (placement.placed) {
        draws.push(shaped[i]!.layouts[placement.chosen]!.draw)
      } else if (src?.pairKey !== undefined) {
        this.droppedPairKeys.add(src.pairKey)
      }
    }
    perfMarkEnd('stage-prepare.collision')

    // iter-265 — sub-phase drill. Emit = GPU flush (dirty SDF
    // uploads) + setDraws (uniform pack into FrameArena +
    // renderer state). Expected small but exposes GPU upload
    // pressure when glyph cache misses spike.
    perfMarkStart('stage-prepare.emit')
    // Flush dirty SDFs to GPU BEFORE setDraws — guarantees every
    // referenced glyph slot is resident when the renderer reads
    // page0.width to compute UVs.
    this.gpu.flush()
    this.renderer.setDraws(draws)
    perfMarkEnd('stage-prepare.emit')
  }

  /** Encode the prepared draws onto the pass. Safe to call without
   *  a prior prepare() — emits nothing in that case. */
  render(pass: GPURenderPassEncoder, viewport: { width: number; height: number }): void {
    this.renderer.draw(pass, viewport)
  }

  /** Reset the pending queue for the next frame. Call after render()
   *  (or immediately at frame start). */
  reset(): void {
    this.pending.length = 0
    this.pendingLine.length = 0
  }

  destroy(): void {
    this.renderer.destroy()
    this.gpu.destroy()
  }
}

