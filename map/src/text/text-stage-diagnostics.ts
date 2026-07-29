// ═══════════════════════════════════════════════════════════════════
// Text Stage diagnostics (bounded observability)
// ═══════════════════════════════════════════════════════════════════
//
// SRP: bounded capture of label-pipeline observability — dispatch
// texts, the z0-halo norm probe, the glyph-placement dump, the
// submitted/drawn counters, and the render-trace records. ZERO
// influence on draws: every method here is a side-channel; a defect
// shows up in a probe, never in pixels.
//
// FrameDrawStats precedent (VTR PR #222): this state used to be smeared
// across the addLabel / addCurvedLineLabel / prepare() methods of
// TextStage. It is consolidated into one owner; the VERBS stay at the
// TextStage call sites (one-line `this._diag.recordDispatch(text)` etc.)
// so the pipeline logic does not move. This collaborator holds NO
// back-reference to TextStage — every method takes what it needs as
// arguments (the trace recorder, the draw-local glyph data).

import type { LabelDef } from '@xgis/compiler'
import type { RenderTraceRecorder } from '../diagnostics/render-trace'
import type { TextDraw } from './text-renderer-types'

/** One captured halo-norm probe entry (see captureHalo). */
export interface HaloDebugEntry {
  text: string
  fontSize: number
  rasterFontSize: number
  haloWidth: number
  haloWidthNorm: number
}

/** One captured glyph-placement dump entry (see captureDump). */
export interface DumpedLabel {
  text: string
  anchorX: number
  anchorY: number
  fontSize: number
  slotSize: number
  curved: boolean
  glyphs: Array<{ cp: number; x: number; y: number; bearingY: number; height: number; rfs: number }>
}

export class TextStageDiagnostics {
  /** Diagnostic: cumulative set of resolved label-text strings the
   *  stage has SUBMITTED (post addLabel / addCurvedLineLabel) since
   *  last clear. Mirror of IconStage.getDispatchedIconNames() — answers
   *  "did the text reach the stage" (vs "evaluated to empty and
   *  dropped before submit"). Used by e2e diagnostics to isolate
   *  text-expr eval failures from downstream collision suppression.
   *  Iter 108. Cap at 256 entries so unbounded label corpora (Bright
   *  Korea ~5000 unique) don't blow up the set. */
  private readonly dispatchedLabelTexts: Set<string> = new Set()
  /** iter-285 — per-frame counters disambiguating collision-suppressed
   *  vs render-but-invisible. Filled by prepare(): submitted is the
   *  raw addLabel/addCurvedLineLabel count at frame start, drawn is the
   *  count of TextDraws actually pushed to renderer.setDraws (post-
   *  collision). User-reported OFM Bright Texas highway shields:
   *  text numbers dispatchedLabelTexts include "10"/"45"/"288" but no
   *  visible glyphs on screen — these counters localise whether
   *  collision dropped them or render-but-invisible. */
  private _lastSubmittedLabelCount = 0
  private _lastDrawnLabelCount = 0
  /** iter 152 diagnostic — per-label halo normalisation capture for
   *  the z0-halo-too-large probe (user report #1). One entry per
   *  shaped label this prepare(): resolved fontSize (= def.size·dpr),
   *  the fixed atlas rasterFontSize, the resolved halo width (phys
   *  px), and haloWidthNorm = the value packUniforms feeds the
   *  shader (halo.width·3/fontSize). Lets an E2E read what the LIVE
   *  pipeline actually resolves at z0 vs deeper zoom — the unknown a
   *  unit probe of packUniforms can't reach. Capped to keep the
   *  array bounded. (memory project_z0_halo_too_large_2026_05_19) */
  private readonly haloDebug: HaloDebugEntry[] = []
  // iter-327 — live glyph-placement dump. When `_dumpFilter` is set,
  // prepare() records the actual per-glyph (x,y) offsets of every drawn
  // label whose text CONTAINS the filter substring. Lets a live session
  // read the REAL composition output for a user-reported scatter (e.g.
  // "서울특별시") and decide whether the corruption is in prepare (CPU)
  // or downstream in the GPU shader. Off by default (zero cost).
  private _dumpFilter: string | null = null
  private _dumpedLabels: DumpedLabel[] = []

  /** Record a resolved+transformed label text the stage just submitted.
   *  Bounded to 256 entries. Called once per addLabel /
   *  addCurvedLineLabel. */
  recordDispatch(text: string): void {
    if (this.dispatchedLabelTexts.size < 256) this.dispatchedLabelTexts.add(text)
  }

  /** Push a RenderTrace label record for one submission. The twin
   *  curved/point blocks in addCurvedLineLabel / addLabel were
   *  near-identical; consolidated here. The recorder is forwarded from
   *  the call site (the collaborator holds no TextStage back-ref). No-op
   *  when the recorder is null. `placement` is the only field that
   *  differed between the two original blocks ('curve' vs 'point'). */
  recordTrace(
    recorder: RenderTraceRecorder | null,
    placement: 'point' | 'curve',
    def: LabelDef,
    text: string,
    anchorScreenX: number,
    anchorScreenY: number,
    layerName: string | undefined,
  ): void {
    if (recorder === null) return
    recorder.recordLabel({
      layerName: layerName ?? '',
      text,
      color: (def.color ?? [0, 0, 0, 1]) as readonly [number, number, number, number],
      halo: def.halo
        ? {
            color: def.halo.color as readonly [number, number, number, number],
            width: def.halo.width,
            blur: def.halo.blur ?? 0,
          }
        : undefined,
      fontFamily: (def.font && def.font[0]) ?? 'sans-serif',
      fontWeight: def.fontWeight ?? 400,
      fontStyle: def.fontStyle ?? 'normal',
      sizePx: def.size,
      placement,
      state: 'placed', // collision result not known yet at submit time
      anchorScreenX,
      anchorScreenY,
    })
  }

  /** Record the per-frame submitted (raw addLabel) count. Called at the
   *  top of prepare(). */
  setSubmittedCount(n: number): void {
    this._lastSubmittedLabelCount = n
  }
  /** Record the per-frame drawn (post-collision) count. Called at the
   *  end of prepare() (and on the empty early-out). */
  setDrawnCount(n: number): void {
    this._lastDrawnLabelCount = n
  }

  /** iter 152 z0-halo probe capture. Bounded to 512 entries. Called
   *  once per shaped point label inside the point-loop. haloK=3 mirrors
   *  packUniforms' pxToSdf so haloWidthNorm == the buf[12] the shader
   *  receives. */
  captureHalo(text: string, sizePx: number, rasterFontSize: number, haloWidth: number): void {
    if (this.haloDebug.length < 512) {
      this.haloDebug.push({
        text,
        fontSize: sizePx,
        rasterFontSize,
        haloWidth,
        haloWidthNorm: sizePx > 0 ? (haloWidth * 3) / sizePx : 0,
      })
    }
  }

  /** Re-capture the glyph-placement dump from the post-collision draw
   *  list. No-op when no filter is set. Clears + refills each call
   *  (once per prepare()). slotSize is forwarded since it is a
   *  TextStage option, not draw-local. */
  captureDump(draws: ReadonlyArray<TextDraw>, slotSize: number, fallbackRfs: number): void {
    if (this._dumpFilter === null) return
    const filt = this._dumpFilter
    this._dumpedLabels = []
    for (const d of draws) {
      const text = String.fromCodePoint(...d.glyphs.map((g) => g.codepoint))
      if (!text.includes(filt)) continue
      const off = d.glyphOffsets
      const glyphs = d.glyphs.map((g, gi) => ({
        cp: g.codepoint,
        x: off ? off[gi * 2]! : NaN,
        y: off ? off[gi * 2 + 1]! : NaN,
        // setDraws inputs: the final vertex top y =
        //   anchorY + y - bearingY*(fontSize/rfs) - (slotH - height*scale)/2.
        // A CJK glyph with anomalous bearingY/height rises into the
        // line above even though its baseline y is correct.
        bearingY: g.bearingY,
        height: g.height,
        rfs: g.rasterFontSize ?? fallbackRfs,
      }))
      this._dumpedLabels.push({
        text,
        anchorX: d.anchorX,
        anchorY: d.anchorY,
        fontSize: d.fontSize,
        slotSize,
        // Line-following labels (roads/rivers, symbol-placement=line)
        // carry per-glyph rotations and place glyphs ALONG a curve —
        // the stacked-line render-y analysis does NOT apply to them.
        curved: d.glyphRotations !== undefined,
        glyphs,
      })
    }
  }

  // ── Accessors (drained by TextStage's thin public forwarders) ──────

  getDispatchedLabelTexts(): string[] {
    return [...this.dispatchedLabelTexts].sort()
  }
  clearDispatchedLabelTexts(): void {
    this.dispatchedLabelTexts.clear()
  }

  getLastSubmittedLabelCount(): number {
    return this._lastSubmittedLabelCount
  }
  getLastDrawnLabelCount(): number {
    return this._lastDrawnLabelCount
  }

  getHaloDebug(): ReadonlyArray<HaloDebugEntry> {
    return this.haloDebug.slice()
  }
  clearHaloDebug(): void {
    this.haloDebug.length = 0
  }

  setLabelDumpFilter(substr: string | null): void {
    this._dumpFilter = substr
  }
  getDumpedLabels(): ReadonlyArray<DumpedLabel> {
    return this._dumpedLabels
  }
}
