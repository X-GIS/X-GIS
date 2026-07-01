// Pure (WebGPU-free) text-stage helpers. text-stage.ts imports from
// here for production use; tests can import without pulling in
// TextRenderer's WGSL pipeline + GPU types.

import type { LabelDef } from '@xgis/compiler'
import { FONT_KEY_SENTINEL } from '@xgis/map'
import { bumpAlloc } from '@xgis/map'
import { FrameArena } from '@xgis/engine'
import type { MlVerticalLayout } from './text-stage-types'

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

/** Mapbox `text-transform` — uppercase / lowercase / none.
 *  Note for CJK: case mapping is undefined for ideographs and
 *  hangul — Unicode default-cased mappings pass them through. */
export function applyTextTransform(
  s: string,
  t?: 'none' | 'uppercase' | 'lowercase',
): string {
  if (t === 'uppercase') return s.toUpperCase()
  if (t === 'lowercase') return s.toLowerCase()
  return s
}

export type LabelAnchor =
  | 'center' | 'top' | 'bottom' | 'left' | 'right'
  | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

// MapLibre's `baselineOffset`: the radial offset is to the EDGE of the
// text box, but vertically glyphs "start" at the baseline, not the box
// top. MapLibre assumes ONE_EM - 17 = 7 layout-px (ONE_EM = 24); in
// X-GIS we keep offsets in em (multiplied by sizePx at draw time), so
// 7 layout-px = 7/24 em. Replicated verbatim so variable-anchor labels
// land where MapLibre puts them (user opted for MapLibre-latest parity).
// ONE_EM is the single MapLibre em-space unit shared by both the
// variable-anchor baseline math here and mlVerticalLayout below; it is
// exported for the point-loop centreShift in text-stage.ts.
export const ONE_EM = 24
const BASELINE_OFFSET_EM = 7 / ONE_EM

/** Port of MapLibre `evaluateVariableOffset` (variable_text_anchor.ts)
 *  in em units. For variable-placement labels (`text-variable-anchor`)
 *  MapLibre nudges the text away from the anchor point per candidate:
 *  a radial push (`text-radial-offset`) or an absolute `text-offset`,
 *  both routed through anchor-specific sign/axis rules plus the
 *  baseline correction. `isRadial` selects `fromRadialOffset` (offset =
 *  [radius, _]) vs `fromTextOffset` (offset = [dx, dy]). Returns the
 *  em-space [dx, dy] to ADD on top of X-GIS's box-anchor alignment. */
export function evaluateVariableOffsetEm(
  anchor: LabelAnchor,
  offset: [number, number],
  isRadial: boolean,
): [number, number] {
  let x = 0, y = 0
  if (isRadial) {
    let r = offset[0]
    if (r < 0) r = 0 // Mapbox ignores a negative radial offset.
    const hyp = r / Math.SQRT2 // solve r^2 + r^2 = radialOffset^2
    switch (anchor) {
      case 'top-right':
      case 'top-left': y = hyp - BASELINE_OFFSET_EM; break
      case 'bottom-right':
      case 'bottom-left': y = -hyp + BASELINE_OFFSET_EM; break
      case 'bottom': y = -r + BASELINE_OFFSET_EM; break
      case 'top': y = r - BASELINE_OFFSET_EM; break
    }
    switch (anchor) {
      case 'top-right':
      case 'bottom-right': x = -hyp; break
      case 'top-left':
      case 'bottom-left': x = hyp; break
      case 'left': x = r; break
      case 'right': x = -r; break
    }
    return [x, y]
  }
  // fromTextOffset — absolute values, anchor picks the sign/axis.
  const ox = Math.abs(offset[0])
  const oy = Math.abs(offset[1])
  switch (anchor) {
    case 'top-right':
    case 'top-left':
    case 'top': y = oy - BASELINE_OFFSET_EM; break
    case 'bottom-right':
    case 'bottom-left':
    case 'bottom': y = -oy + BASELINE_OFFSET_EM; break
  }
  switch (anchor) {
    case 'top-right':
    case 'bottom-right':
    case 'right': x = -ox; break
    case 'top-left':
    case 'bottom-left':
    case 'left': x = ox; break
  }
  return [x, y]
}

/** Port of MapLibre's `text-variable-anchor-offset` branch: the raw
 *  per-anchor em offset is used as-authored (NOT run through the
 *  sign/axis rules) but still gets the top/bottom baseline shift. */
export function variableAnchorOffsetEm(
  anchor: LabelAnchor,
  offset: [number, number],
): [number, number] {
  let y = offset[1]
  if (anchor.startsWith('top')) y -= BASELINE_OFFSET_EM
  else if (anchor.startsWith('bottom')) y += BASELINE_OFFSET_EM
  return [offset[0], y]
}

/** Mapbox bilingual `text-field: concat(name:latin, "\n",
 *  name:nonlatin)` stacks two scripts on point labels as two lines.
 *  Along a CURVED road, however, Mapbox's reference rendering shows
 *  only the primary (Latin) script — laying both head-to-tail along
 *  the path is the visible artefact. Strip everything from the first
 *  LF onwards before the curve sampler walks the glyph sequence. */
export function stripCurveLineExtraScripts(text: string): string {
  const lf = text.indexOf('\n')
  return lf >= 0 ? text.slice(0, lf) : text
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
export function layoutCacheKey(
  glyphsKey: number,
  sizePx: number, letterSpacingPx: number, maxWidthPx: number,
  lineHeightPx: number,
  justify: string, anchor: string,
  offsetX: number, offsetY: number,
  translateX: number, translateY: number,
  padding: number,
  haloWidth: number, haloBlur: number,
  // #608-scope — whether the label is icon-paired (a shield). Paired center-
  // anchored text recentres its ink BAND onto the anchor (box-centred); a
  // standalone label hangs the ink below. Same font/text/size/anchor but
  // different glyphOffsets, so the two must NOT share a cache entry.
  paired: boolean,
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
  h = Math.imul(h ^ (paired ? 1 : 0), 0x01000193)
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
export function textKeyFor(fontKey: string, text: string): number {
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

/** Audit ④ B1 — layout-cache hit validity. The numeric `_layoutKey`
 *  (32-bit FNV-1a over font/size/width/…) CAN collide; the generation
 *  guard only catches eviction-staleness, so on a collision the cache
 *  would serve label-A's glyphs+offsets for label-B (the "일부만" scatter,
 *  iter-327). Validate the EXACT source identity (`srcKey` = fontKey+text)
 *  on hit — a string compare is collision-proof. A hit is valid only when
 *  BOTH the atlas generation matches (slots unchanged) AND the source text
 *  matches (no hash collision). Exported for direct unit testing. */
export function layoutCacheEntryValid(
  entry: { generation: number; srcKey: string },
  srcKey: string,
  generation: number,
): boolean {
  return entry.generation === generation && entry.srcKey === srcKey
}

/** SHAPING_DEFAULT_OFFSET — MapLibre `shaping.ts` constant. MapLibre
 *  lays text in a 24-unit em space (ONE_EM, declared above); the
 *  baseline of every line sits a FIXED −17/24 em below the line-box
 *  top, independent of the glyphs' own ink metrics. We work in display
 *  px, so the em→px factor is sizePx/ONE_EM. */
export const SHAPING_DEFAULT_OFFSET = -17

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

// Slot must fit (rasterFontSize + 2*sdfRadius). PBF arrives at 24 px
// native (MapLibre's ONE_EM). Setting rasterFontSize to match means
// PBF→atlas is a 1:1 byte copy with no bilinear resample — every
// PBF-sourced glyph keeps the upstream tile server's sub-pixel SDF
// precision exactly.
//
// CJK_FALLBACK_CHAIN chains common CJK fallbacks AFTER sans-serif so an
// engine-level label without a Mapbox font stack still reads
// Hangul/Han correctly on every host OS we ship on (macOS / Win /
// Linux). Per-label font stacks coming from Mapbox styles get the
// same fallback chain appended in composeFontKey.
export const CJK_FALLBACK_CHAIN = '"Noto Sans CJK KR","Apple SD Gothic Neo","Malgun Gothic","Microsoft YaHei","Noto Sans CJK JP","Hiragino Sans","Yu Gothic",sans-serif'

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
