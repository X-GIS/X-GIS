// Geometry of a PAIRED symbol — a text run that shares one anchor with an icon
// (a route shield: the `ref` inside a `road_2` badge). Two concerns, both split
// out of text-stage.ts so each has room to carry its own rationale:
//
//  - `pairedTextCentreShift`: where the glyph band sits relative to the anchor.
//  - `PairedBadgeBoxes` + `unionBadgeBox`: how big the symbol collides.

/** The glyph metrics `pairedTextCentreShift` needs (a `ShapedGlyph` subset). */
export interface PairedGlyphMetric {
  height: number
  bearingY: number
  rasterFontSize?: number
}

/** Vertical offset applied to a paired label's glyph band, in physical px.
 *
 *  A STANDALONE place label hangs below its anchor by MapLibre's shaping offset
 *  — a glyph-metric-dependent amount (all-caps vs mixed-case vs CJK differ), not
 *  a constant. Paired text must NOT hang: the badge is drawn symmetrically about
 *  the shared anchor, so a hung band reads low / off-centre inside the box. For
 *  centre-anchored paired text, pin the band CENTROID instead by shifting on
 *  (maxAscender − maxDescender) / 2 — one shared per-block shift.
 *
 *  `paired` false, or a vertical alignment other than centre, keeps the hang.
 *
 *  MOVED HERE from the text-stage call site (#2144), where it sat above this
 *  call and cost the file lines it no longer had; the rationale belongs with
 *  the arithmetic it explains:
 *
 *  #608 — vertical-placement parity with MapLibre. MapLibre's
 *  `SHAPING_DEFAULT_OFFSET = -17` baseline term exists to convert
 *  from its glyph-metric origin (MapLibre `metrics.top` is
 *  ASCENDER-relative — `glyphTop - topAdjustment`, negative for a
 *  normal cap) down to the alphabetic baseline. X-GIS's `bearingY`
 *  is ALREADY a true baseline ascent (the pbf-rasterizer recovers a
 *  positive ascent from the ascender-relative PBF `top`), so the
 *  renderer's `y0 = baseline - bearingY*sc` places ink correctly
 *  relative to the baseline on its own. Re-applying the -17 SHAPING
 *  term in the baseline DOUBLE-COUNTS the origin shift, lifting the
 *  ink ~17/24-em ABOVE where MapLibre puts it (measured: Houston z12
 *  ink ~19px too HIGH; confirmed for center + bottom anchors). Cancel
 *  the SHAPING term (`-shapingBaselineOff`) so the per-line baseline
 *  is just MapLibre's `align` shiftY (li·LH spacing preserved); the
 *  ink then hangs from that baseline by the glyph's own
 *  metrics (-bearingY + height/2), exactly as MapLibre — a
 *  GLYPH-METRIC-DEPENDENT offset (all-caps vs mixed-case vs CJK
 *  differ), NOT a constant. This is the STANDALONE place-label hang; the
 *  #608-scope EXCEPTION for icon-paired / shield text is the `paired` branch
 *  below. */
export function pairedTextCentreShift(
  glyphs: readonly PairedGlyphMetric[],
  sizePx: number,
  defaultRasterFontSize: number,
  shapingBaselineOff: number,
  paired: boolean,
  vAlign: number,
): number {
  if (!paired || vAlign !== 0.5) return -shapingBaselineOff
  let maxAsc = 0
  let maxDesc = 0
  for (let gi = 0; gi < glyphs.length; gi++) {
    const g = glyphs[gi]!
    if (g.height <= 0) continue // skip blanks (junk metrics)
    const sc = sizePx / (g.rasterFontSize ?? defaultRasterFontSize)
    const asc = g.bearingY * sc
    const desc = (g.height - g.bearingY) * sc
    if (asc > maxAsc) maxAsc = asc
    if (desc > maxDesc) maxDesc = desc
  }
  return -shapingBaselineOff + (maxAsc - maxDesc) / 2
}

/** Half-extents of a paired icon's quad about the shared anchor, physical px. */
export interface BadgeHalfExtents {
  hw: number
  hh: number
}

/** Per-pairKey badge extents for the frame, and the box union that uses them.
 *
 *  A paired symbol collides as ONE symbol in MapLibre, and its box is the BADGE
 *  — the sprite quad plus `icon-padding`, or the `icon-text-fit` box — which is
 *  materially wider than the ref glyphs inside it. X-GIS collided on the glyph
 *  run alone, so a shield squeezed in where MapLibre drops it: on OFM Positron
 *  at z16 near 37.79/126.79, MapLibre's own collision debug shows the second
 *  route-14 shield REJECTED against the "Wijeon-ri" place label, while X-GIS
 *  rendered both with the badge crowding the place name.
 *
 *  The map fills this each frame from `IconStage.pairedIconHalfExtents()`,
 *  BEFORE the collision pass. Empty (no icon stage, or a label with no paired
 *  icon) ⇒ `union` is a no-op and the glyph-only box stands.
 *
 *  Note the direction: text box → icon (`_pairFitBox`, #777 I-A icon-text-fit)
 *  is the OPPOSITE handoff. The two cannot form a cycle because a fitted icon is
 *  excluded on the icon side — its quad is derived from the text box, and never
 *  extends past it by more than its authored padding. */
export class PairedBadgeBoxes {
  private extents: ReadonlyMap<string, BadgeHalfExtents> = new Map()

  set(extents: ReadonlyMap<string, BadgeHalfExtents>): void {
    this.extents = extents
  }

  /** Grow `bbox` (mutated in place) to cover this label's badge, centred on the
   *  shared anchor. No-op when the label is unpaired or its icon is unresolved. */
  union(
    pairKey: string | undefined,
    anchorX: number,
    anchorY: number,
    bbox: { minX: number; minY: number; maxX: number; maxY: number },
  ): void {
    if (pairKey === undefined) return
    const half = this.extents.get(pairKey)
    if (half === undefined) return
    if (anchorX - half.hw < bbox.minX) bbox.minX = anchorX - half.hw
    if (anchorX + half.hw > bbox.maxX) bbox.maxX = anchorX + half.hw
    if (anchorY - half.hh < bbox.minY) bbox.minY = anchorY - half.hh
    if (anchorY + half.hh > bbox.maxY) bbox.maxY = anchorY + half.hh
  }
}
