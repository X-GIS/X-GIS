// ═══ Retained-text packer (static-text primitive) ═══
//
// Sibling of retained-icon-packer.ts. Turns a TextDrawSpec into the two GPU-bound typed arrays the
// retained-text shader reads: the `feat` buffer (per-GLYPH geo anchor DSFUN + screen-space offset +
// quad size + atlas UV + page, TEXT_RETAINED_FEAT layout) and the `tint` buffer (fill rgba per
// glyph). Every accessor runs EXACTLY ONCE here — this is called from add()/update(), NEVER from the
// render path — and every STRING is SHAPED EXACTLY ONCE, so a camera move does zero per-instance CPU
// work (the N-independence thesis). Position packing reuses the SAME ECEF/Mercator DSFUN math as the
// point/icon/circle packers, so the shader's shared geo→clip ladder applies unchanged.
//
// Glyph shaping is READ-ONLY reuse of the existing SDF glyph atlas: the packer depends only on the
// minimal `GlyphShaper` seam (adapts `GlyphAtlasHost.ensureString` — pure CPU, no device), never on
// TextStage internals, and never forks glyph layout. The per-glyph pen-walk + quad + UV arithmetic
// mirrors TextRenderer.setDraws (the single-line, no-per-glyph-offset branch) read-only.

import { worldCopyMercX } from '../render/point-feature-packer'
import { parseHexColor } from '../feature-helpers'
import { EARTH, lonLatToECEF } from '@xgis/shared'
import {
  TEXT_RETAINED_FEAT,
  TEXT_RETAINED_TINT_STRIDE,
} from '../shaders/dsl/text-retained-feat-layout'
import type { TextDrawSpec, IconColor, IconAnchor, Position, Packed } from './graphics-types'

const F = TEXT_RETAINED_FEAT.slot
const STRIDE = TEXT_RETAINED_FEAT.stride
const DEG2RAD = Math.PI / 180
const MERC_LAT_LIMIT = 85.051129
const R_MERC = EARTH.sphereR // web-Mercator sphere radius (matches the point/icon/circle packers)
const DEFAULT_FONT_SIZE = 16 // px, when getSize is absent
const DEFAULT_RASTER = 24 // ONE_EM — the fallback when a glyph omits rasterFontSize (mirrors the renderer)
const NEWLINE = 10 // codepoint skipped (no instance) — single-line pack (matches TextRenderer)

/** The minimal atlas SLOT a shaped glyph resolves its UV rect + page through. Mirrors the read-only
 *  subset of the atlas `AtlasSlot` (glyph-atlas-host). */
export interface ShapedGlyphSlot {
  readonly pxX: number
  readonly pxY: number
  readonly size: number
  readonly page: number
}

/** One shaped glyph's layout metrics + atlas slot — the read-only subset of the atlas `GlyphInfo`
 *  (glyph-atlas-host) the packer consumes. All lengths are px at `rasterFontSize`. */
export interface ShapedGlyph {
  readonly codepoint: number
  /** Pen advance after drawing (px). */
  readonly advanceWidth: number
  /** Pen → glyph-bbox left edge (px). */
  readonly bearingX: number
  /** Baseline → glyph-bbox top edge (px, positive up). */
  readonly bearingY: number
  readonly width: number
  readonly height: number
  /** Px size this glyph's SDF + metrics were baked at (falls back to ONE_EM = 24 when absent). */
  readonly rasterFontSize?: number
  readonly slot: ShapedGlyphSlot
}

/** The glyph-shaping SEAM the packer depends on — a READ-ONLY view of the existing SDF glyph atlas.
 *  The real implementation adapts `TextStage.host.ensureString` (pure CPU, no GPU device) +
 *  `TextStage.gpu.pageSizePx`; tests inject a stub with known metrics. */
export interface GlyphShaper {
  /** Shape a string into positioned-metric glyphs (atlas admit + metrics lookup). No device. */
  shape(fontKey: string, text: string): readonly ShapedGlyph[]
  /** Atlas page size in px — the UV-rect divisor (`GlyphAtlasGPU.pageSizePx`). */
  readonly pageSize: number
}

/** Horizontal block alignment: fraction of the line width to shift the pen origin left. */
const HFACTOR: Record<IconAnchor, number> = {
  left: 0,
  'top-left': 0,
  'bottom-left': 0,
  center: 0.5,
  top: 0.5,
  bottom: 0.5,
  right: 1,
  'top-right': 1,
  'bottom-right': 1,
}

/** Vertical block alignment: baseline offset BELOW the anchor, in ems of the font size. A Phase-2b
 *  single-line approximation (exact ascent/descent metrics + multi-line layout are a later phase). */
const VFACTOR: Record<IconAnchor, number> = {
  bottom: 0,
  'bottom-left': 0,
  'bottom-right': 0,
  center: 0.5,
  left: 0.5,
  right: 0.5,
  top: 1,
  'top-left': 1,
  'top-right': 1,
}

/** Resolve a `Packed<T,D>` accessor for item `i` — a function runs ONCE, a constant is returned
 *  as-is. Never invoked per frame. */
function resolve<T, D>(acc: Packed<T, D> | undefined, d: D, i: number): T | undefined {
  return typeof acc === 'function' ? (acc as (d: D, i: number) => T)(d, i) : acc
}

/** Normalise an IconColor to an rgba tuple in 0..1 (default white = opaque fill). */
function normColor(c: IconColor | undefined): [number, number, number, number] {
  if (c === undefined) return [1, 1, 1, 1]
  if (typeof c === 'string') {
    const parsed = parseHexColor(c)
    return parsed ? [parsed[0], parsed[1], parsed[2], parsed[3]] : [1, 1, 1, 1]
  }
  return [c[0], c[1], c[2], c[3] ?? 1]
}

/** Write the 12-slot ECEF/abs/Mercator DSFUN anchor block at feat offset `o` (identical to the
 *  point/icon/circle packers — the shader's shared geo→clip ladder reads it verbatim). */
function writeAnchorDsfun(feat: Float32Array, o: number, lon: number, lat: number): void {
  const ecef = lonLatToECEF(lon, lat)
  const exH = Math.fround(ecef[0])
  const eyH = Math.fround(ecef[1])
  const ezH = Math.fround(ecef[2])
  feat[o + F.ecef_x_h] = exH
  feat[o + F.ecef_y_h] = eyH
  feat[o + F.ecef_z_h] = ezH
  feat[o + F.ecef_x_l] = ecef[0] - exH
  feat[o + F.ecef_y_l] = ecef[1] - eyH
  feat[o + F.ecef_z_l] = ecef[2] - ezH
  feat[o + F.abs_lon] = lon
  feat[o + F.abs_lat] = lat
  const mx = worldCopyMercX(lon, 0)
  const latC = Math.max(-MERC_LAT_LIMIT, Math.min(MERC_LAT_LIMIT, lat))
  const my = Math.log(Math.tan(Math.PI / 4 + (latC * DEG2RAD) / 2)) * R_MERC
  const mxH = Math.fround(mx)
  const myH = Math.fround(my)
  feat[o + F.merc_x_h] = mxH
  feat[o + F.merc_x_l] = Math.fround(mx - mxH)
  feat[o + F.merc_y_h] = myH
  feat[o + F.merc_y_l] = Math.fround(my - myH)
}

/** A datum shaped once in the first pass — cached so the second (fill) pass never re-runs accessors
 *  or re-shapes (the accessor-runs-once + shape-once contract). */
interface ShapedDatum {
  lon: number
  lat: number
  fontSize: number
  anchor: IconAnchor
  glyphs: readonly ShapedGlyph[]
  /** Non-newline glyph count = this datum's GPU instance count. */
  count: number
}

/** Run the accessors ONCE per datum and shape each string ONCE. Shared by the feat + tint packers so
 *  neither re-runs accessors nor re-shapes. Returns the shaped data + the total glyph-instance count
 *  + the per-datum instance counts (the tint packer replicates the datum colour across them). */
function shapeAll<D>(
  spec: TextDrawSpec<D>,
  shaper: GlyphShaper,
): { shaped: ShapedDatum[]; total: number; glyphCounts: Uint32Array } {
  const data = spec.data
  const n = data.length
  const fontKey = spec.font ?? ''
  const anchor = spec.anchor ?? 'center'
  const shaped: ShapedDatum[] = new Array(n)
  const glyphCounts = new Uint32Array(n)
  let total = 0
  for (let i = 0; i < n; i++) {
    const d = data[i]!
    const pos = resolve<Position, D>(spec.getPosition, d, i)
    const text = resolve<string, D>(spec.getText, d, i) ?? ''
    const fontSize = resolve<number, D>(spec.getSize, d, i) ?? DEFAULT_FONT_SIZE
    const glyphs = shaper.shape(fontKey, text)
    let count = 0
    for (let g = 0; g < glyphs.length; g++) if (glyphs[g]!.codepoint !== NEWLINE) count++
    glyphCounts[i] = count
    total += count
    shaped[i] = {
      lon: pos ? pos[0] : 0,
      lat: pos ? pos[1] : 0,
      fontSize,
      anchor,
      glyphs,
      count,
    }
  }
  return { shaped, total, glyphCounts }
}

/** Pack the per-GLYPH `feat` buffer (anchor DSFUN + baked screen-space offset + quad size + UV +
 *  page). Runs getPosition / getText / getSize once per datum and shapes once; `dpr` scales the
 *  px offsets + sizes to physical px (same convention as the icon path). Returns the buffer plus the
 *  per-datum glyph-instance counts, so the tint packer replicates colour WITHOUT re-shaping. */
export function packRetainedTextFeat<D>(
  spec: TextDrawSpec<D>,
  shaper: GlyphShaper,
  dpr: number,
): { feat: Float32Array; glyphCounts: Uint32Array } {
  const { shaped, total, glyphCounts } = shapeAll(spec, shaper)
  const feat = new Float32Array(total * STRIDE)
  const pageSize = shaper.pageSize
  let o = 0
  for (let i = 0; i < shaped.length; i++) {
    const s = shaped[i]!
    if (s.count === 0) continue
    const { fontSize } = s
    const hFactor = HFACTOR[s.anchor]
    const vFactor = VFACTOR[s.anchor]

    // Line width (display px) for horizontal alignment — sum of scaled advances (skip newlines).
    let lineW = 0
    for (let g = 0; g < s.glyphs.length; g++) {
      const gl = s.glyphs[g]!
      if (gl.codepoint === NEWLINE) continue
      lineW += gl.advanceWidth * (fontSize / (gl.rasterFontSize ?? DEFAULT_RASTER))
    }
    const baseX = -hFactor * lineW
    const baseY = vFactor * fontSize // baseline offset below the anchor (screen px, y-down)

    let pen = 0
    for (let g = 0; g < s.glyphs.length; g++) {
      const gl = s.glyphs[g]!
      if (gl.codepoint === NEWLINE) continue
      const sc = fontSize / (gl.rasterFontSize ?? DEFAULT_RASTER)
      const drawW = gl.slot.size * sc
      const drawH = gl.slot.size * sc
      // Quad top-left relative to the anchor, in screen px (y-down) — the TextRenderer recipe.
      const gx = baseX + pen + gl.bearingX * sc - (drawW - gl.width * sc) * 0.5
      const gy = baseY - gl.bearingY * sc - (drawH - gl.height * sc) * 0.5

      writeAnchorDsfun(feat, o, s.lon, s.lat)
      feat[o + F.off_x] = gx * dpr
      feat[o + F.off_y] = gy * dpr
      feat[o + F.size_w] = drawW * dpr
      feat[o + F.size_h] = drawH * dpr
      feat[o + F.u0] = gl.slot.pxX / pageSize
      feat[o + F.v0] = gl.slot.pxY / pageSize
      feat[o + F.u1] = (gl.slot.pxX + gl.slot.size) / pageSize
      feat[o + F.v1] = (gl.slot.pxY + gl.slot.size) / pageSize
      feat[o + F.page] = gl.slot.page
      o += STRIDE

      pen += gl.advanceWidth * sc
    }
  }
  return { feat, glyphCounts }
}

/** Pack the per-GLYPH `tint` buffer (fill rgba). Runs getColor ONCE per datum and replicates the
 *  datum's colour across its glyphs using the `glyphCounts` from `packRetainedTextFeat` — so a
 *  color-only update re-uploads ONLY the tint attribute WITHOUT re-shaping. */
export function packRetainedTextTint<D>(
  spec: TextDrawSpec<D>,
  glyphCounts: Uint32Array,
): Float32Array {
  const data = spec.data
  const n = Math.min(data.length, glyphCounts.length)
  let total = 0
  for (let i = 0; i < n; i++) total += glyphCounts[i]!
  const tint = new Float32Array(total * TEXT_RETAINED_TINT_STRIDE)
  let o = 0
  for (let i = 0; i < n; i++) {
    const count = glyphCounts[i]!
    if (count === 0) continue
    const [r, g, b, a] = normColor(resolve(spec.getColor, data[i]!, i))
    for (let k = 0; k < count; k++) {
      tint[o] = r
      tint[o + 1] = g
      tint[o + 2] = b
      tint[o + 3] = a
      o += TEXT_RETAINED_TINT_STRIDE
    }
  }
  return tint
}
