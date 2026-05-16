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
import { InlineGlyphProvider, type InlineGlyphSource } from './sdf/pbf/inline-glyph-provider'
import type { GlyphProvider } from './sdf/pbf/glyph-provider'
import { PbfRasterizer } from './sdf/pbf-rasterizer'
import { TextRenderer, type TextDraw } from './text-renderer'
import { greedyPlaceBboxes, type CollisionItem } from './text-collision'
import { FONT_KEY_SENTINEL } from './sdf/glyph-rasterizer'
import type { GlyphInfo } from './sdf/glyph-atlas-host'
import { applyTextTransform, stripCurveLineExtraScripts } from './text-stage-helpers'

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
const _pretextCache = new Map<string, WrappedLineRange[]>()
function pretextCacheKey(
  glyphs: readonly GlyphInfo[],
  advances: readonly number[],
  fontKey: string, fontSizePx: number,
  letterSpacingPx: number, maxWidthPx: number,
): string {
  // Sub-pixel font sizes round to 0.1 px and letter-spacing similarly
  // — collapses near-duplicate camera-zoom variations onto one cache
  // entry without visible drift.
  const sz = fontSizePx.toFixed(1)
  const ls = letterSpacingPx.toFixed(2)
  const mw = maxWidthPx === Infinity ? 'inf' : maxWidthPx.toFixed(1)
  // Codepoint sequence (no String.fromCodePoint allocation — pack as
  // raw separator-joined ints; same uniqueness as the text itself).
  //
  // Advance signature: rounded to 0.1 px and joined into the key so the
  // cache invalidates the moment PBF glyphs land and shift metrics from
  // Canvas2D-fallback advance to PBF-native advance. Pre-fix bug: first
  // frame computed wrap with wide Canvas2D advances, cached the lines;
  // PBF italic landed → atlas advances narrowed → host.ensureString
  // returned fresh advances → BUT wrap cache keyed by codepoints-only
  // still returned the OLD (wider, more-breaks) lines. Result: bbox +
  // anchor math kept thinking the label was wider than it actually
  // rendered, glyphs looked "small inside an oversized bbox". User-
  // reported on OFM Bright water_name labels 2026-05-16.
  let cps = ''
  for (const g of glyphs) cps += g.codepoint.toString(36) + ','
  let advs = ''
  for (const a of advances) advs += a.toFixed(1) + ','
  return `${fontKey}|${sz}|${ls}|${mw}|${cps}|${advs}`
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
): WrappedLineRange[] {
  const n = segEnd - segStart
  if (n <= 0) return [{ start: segStart, end: segEnd, width: 0 }]
  if (maxWidthPx === Infinity) {
    return [{
      start: segStart, end: segEnd,
      width: rangeWidth(advances, segStart, segEnd, letterSpacingPx),
    }]
  }
  // 1. totalWidth = sum of (advance + spacing) for NON-WHITESPACE chars.
  //    Matches MapLibre's `if (!charIsWhitespace(cp)) currentX += ...`.
  let totalWidth = 0
  for (let i = segStart; i < segEnd; i++) {
    const cp = glyphs[i]!.codepoint
    if (!_charIsWhitespace(cp)) totalWidth += advances[i]! + letterSpacingPx
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
      const penalty = _kpPenalty(cp, nextCp, ideoBreak)
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
  advances: readonly number[],
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

  const lines: WrappedLineRange[] = []
  for (const seg of segments) {
    if (seg.start === seg.end) {
      lines.push({ start: seg.start, end: seg.end, width: 0 })
      continue
    }
    const segLines = _kpWrapSegment(glyphs, advances, letterSpacingPx, maxWidthPx, seg.start, seg.end)
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

// Slot must fit (rasterFontSize + 2*sdfRadius) — ascenders/descenders
// of a 32-px raster font extend ~38-40 px, plus 8 px SDF radius on
// each side ⇒ 54-56 px needed. Round to 64 for some headroom on
// CJK/diacritics. The previous 24-px raster lost too much stroke
// detail on Hangul / Han and visibly softened any label drawn above
// ~32 px display size (POI labels at high zoom).
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
const DEFAULTS: Required<Omit<TextStageOptions, 'rasterizer' | 'glyphsUrl' | 'inlineGlyphs' | 'glyphProviders' | 'fontTypography'>> = {
  slotSize: 64,
  pageSize: 2304,
  rasterFontSize: 32,
  sdfRadius: 8,
  defaultFont: CJK_FALLBACK_CHAIN,
}

interface PendingLabel {
  text: string
  anchorX: number
  anchorY: number
  def: LabelDef
  fontKey: string
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
  readonly opts: Required<Omit<TextStageOptions, 'rasterizer' | 'glyphsUrl' | 'inlineGlyphs' | 'glyphProviders' | 'fontTypography'>>
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
    this.opts = { ...DEFAULTS, ...options } as Required<Omit<TextStageOptions, 'rasterizer' | 'glyphsUrl' | 'inlineGlyphs' | 'glyphProviders' | 'fontTypography'>>
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
  addLabel(
    value: TextValue,
    props: FeatureProps,
    anchorScreenX: number,
    anchorScreenY: number,
    def: LabelDef,
    fontKey?: string,
    layerName?: string,
  ): void {
    const text = resolveText(value, props, this.cameraZoom)
    if (text.length === 0) return
    const transformed = applyTextTransform(text, def.transform)
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
    }
    const shaped: ShapedLabel[] = []
    const dpr = this.dpr
    for (const p of this.pending) {
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
      const scale = sizePx / this.opts.rasterFontSize
      // Multiline layout: greedy word-break at maxWidth (em-units →
      // px). When unset, treat as Infinity = single line.
      const maxWidthPx = p.def.maxWidth !== undefined
        ? p.def.maxWidth * sizePx : Infinity
      const lineHeightEm = (p.def.lineHeight ?? 1.2) * typo.lineHeightScale
      const lineHeightPx = lineHeightEm * sizePx
      const justify = p.def.justify ?? 'center'

      // Compute per-line glyph ranges + line widths. We track maxAscent
      // (= max bearingY) and maxDescent (= max(height-bearingY)) so the
      // anchor math below can place the BBOX BOTTOM (incl. descenders)
      // at the anchor for text-anchor='bottom' — matches Mapbox /
      // MapLibre semantics. Earlier code used `maxHeight` alone and put
      // the BASELINE at the anchor, leaving descenders dangling
      // ~descent_px below the authored position. User saw this on
      // OFM Liberty Korea z=4.96 with bearing/pitch: Pyongyang's
      // text-anchor='bottom' label drifted into the country label's
      // wrap zone "조선민주주의인민공화국" because city's baseline (and
      // therefore visible glyphs) sat ~descent px lower than ML.
      const advances: number[] = new Array(glyphs.length)
      let maxAscent = 0
      let maxDescent = 0
      for (let gi = 0; gi < glyphs.length; gi++) {
        const g = glyphs[gi]!
        advances[gi] = g.advanceWidth * scale
        const ascent = g.bearingY * scale
        const descent = (g.height - g.bearingY) * scale
        if (ascent > maxAscent) maxAscent = ascent
        if (descent > maxDescent) maxDescent = descent
      }
      const maxHeight = maxAscent + maxDescent

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
      const totalHeight = maxHeight + (lines.length - 1) * lineHeightPx
      // Variable anchor (Mapbox `text-variable-anchor`): runtime
      // tries each candidate during collision and picks the first
      // non-overlapping one. Single-anchor labels always have one
      // candidate. The full draw + bbox is computed per candidate
      // here; the post-collision phase below picks the chosen one.
      const candidates = p.def.anchorCandidates && p.def.anchorCandidates.length > 0
        ? p.def.anchorCandidates
        : [p.def.anchor ?? 'center']
      const padding = (p.def.padding ?? 2) * dpr
      const haloOut = p.def.halo
        ? {
            color: p.def.halo.color,
            width: p.def.halo.width * dpr,
            ...(p.def.halo.blur !== undefined ? { blur: p.def.halo.blur * dpr } : {}),
          }
        : undefined
      const layouts: Array<{ draw: TextDraw; bbox: typeof shaped[number]['layouts'][number]['bbox'] }> = []
      for (const anchor of candidates) {
        let dx = 0, dy = 0
        if (anchor === 'left' || anchor.endsWith('-left')) dx = 0
        else if (anchor === 'right' || anchor.endsWith('-right')) dx = -totalAdvance
        else dx = -totalAdvance / 2
        // drawY (set below) lands on the LAST-line baseline. For each
        // anchor mode we solve "where should baseline_last sit so that
        // bbox_{top|center|bottom} aligns with anchorY?" The
        // `-maxDescent` term shifts the baseline UP by the descender
        // height so descenders end up AT bbox bottom (i.e. AT the
        // anchor for bottom-anchored labels) instead of dangling BELOW
        // it. `B = totalHeight - maxDescent` is the distance from
        // bbox_top to baseline_last.
        if (anchor === 'top' || anchor.startsWith('top-')) dy = totalHeight - maxDescent
        else if (anchor === 'bottom' || anchor.startsWith('bottom-')) dy = -maxDescent
        else dy = totalHeight / 2 - maxDescent
        if (p.def.offset) {
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
        const glyphOffsets = lines.length > 1 ? new Float32Array(glyphs.length * 2) : undefined
        if (glyphOffsets) {
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
            const lineY = -totalHeight + maxHeight + li * lineHeightPx
            let pen = lineX
            for (let gi = ln.start; gi < ln.end; gi++) {
              glyphOffsets[gi * 2] = drawX - p.anchorX + pen
              glyphOffsets[gi * 2 + 1] = drawY - p.anchorY + lineY
              pen += advances[gi]!
              if (gi < ln.end - 1) pen += letterSpacingPx
            }
          }
        }
        const bbox = {
          minX: drawX - padding,
          minY: drawY - totalHeight - padding,
          maxX: drawX + totalAdvance + padding,
          maxY: drawY + padding,
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
      }
      shaped.push({
        layouts,
        allowOverlap: p.def.allowOverlap === true,
        ignorePlacement: p.def.ignorePlacement === true,
      })
    }

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
    for (const p of this.pendingLine) {
      const glyphs = this.host.ensureString(p.fontKey, p.text)
      if (glyphs.length === 0) continue
      const sizePx = p.def.size * dpr
      const scale = sizePx / this.opts.rasterFontSize
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
        const adv = glyphs[gi]!.advanceWidth * scale
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
      const glyphOffsets = new Float32Array(glyphs.length * 2)
      const glyphRotations = new Float32Array(glyphs.length)
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
      })
    }

    // Phase 2: greedy bbox collision.
    //
    // Mapbox / MapLibre collision semantic: a label belonging to a
    // LATER layer in the style takes precedence over an earlier
    // layer's label when their bboxes overlap. The mental model is
    // "the layer you draw on top wins the screen real-estate
    // contest" — countries (last in OFM Bright) beat water_name
    // labels (first) at the antimeridian; POI labels (mid-stack)
    // beat road shields when they collide.
    //
    // Our `pending` queue is populated in style order — water first,
    // country last — because map.ts iterates showCommands forward.
    // greedyPlaceBboxes is first-wins, so a naïve forward call lets
    // water labels claim the bbox real-estate and drops the country
    // ones. That's the wrong precedence and visibly so on low-zoom
    // mobile views (multiple sea names crowd out country labels
    // around the antimeridian).
    //
    // Fix: iterate the collision input in REVERSE so later layers
    // place first. Draw order stays in original `shaped` order so
    // the layered rendering effect (country text on top of water
    // halo) is preserved — only the collision dedup priority flips.
    const collisionInput: CollisionItem[] = shaped.map(s => ({
      bboxes: s.layouts.map(l => l.bbox),
      allowOverlap: s.allowOverlap,
      ignorePlacement: s.ignorePlacement,
    }))
    const reversed: CollisionItem[] = []
    for (let i = collisionInput.length - 1; i >= 0; i--) reversed.push(collisionInput[i]!)
    const placementsReversed = greedyPlaceBboxes(reversed)
    // Map back to original index space so the draw loop below reads
    // the right placement per shaped[i].
    const placements: typeof placementsReversed = new Array(shaped.length)
    for (let i = 0; i < placementsReversed.length; i++) {
      placements[shaped.length - 1 - i] = placementsReversed[i]!
    }
    const draws: TextDraw[] = []
    for (let i = 0; i < shaped.length; i++) {
      const placement = placements[i]!
      if (placement.placed) draws.push(shaped[i]!.layouts[placement.chosen]!.draw)
    }

    // Flush dirty SDFs to GPU BEFORE setDraws — guarantees every
    // referenced glyph slot is resident when the renderer reads
    // page0.width to compute UVs.
    this.gpu.flush()
    this.renderer.setDraws(draws)
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

