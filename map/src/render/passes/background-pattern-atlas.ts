// ═══ Background-pattern sprite atlas gate (#777 I-E) ═══
//
// Extracted from label-pass.ts, which is a baselined god-file at its LOC ceiling: the ratchet's
// instruction is "extract, don't grow", and this was already the file's most separable piece —
// a free exported function with one call site and its own GPU-free behaviour gate
// (background-pattern-wiring.test.ts). No logic changed in the move.

import { IconStage } from '../../sprite/icon-stage'
import type { LabelPassHost } from './pass'

/** #777 I-E — a `background-pattern` style needs the sprite atlas loaded so
 *  the synthetic earth-surface show's fill-pattern (the pattern's carrier)
 *  can resolve its UV + repeat, even when the style has NO labels / icons /
 *  fill-patterns to otherwise trip the lazy IconStage in execute(). The
 *  `onLanded` hook must GUARANTEE a frame: `markLabelDirty()` alone re-preps
 *  labels but never re-arms a label-less idle loop, so the async atlas landed
 *  on a frozen canvas (the I-E probe's root cause B) — `invalidate()` sets
 *  `_needsRender` so the pattern paints once the sprite arrives. Kept a free
 *  exported function (mirroring backgroundClearValue) so the gate + hook are
 *  behaviour-gated by a GPU-free test with a mocked IconStage. */
export function ensureBackgroundPatternAtlas(
  host: Pick<
    LabelPassHost,
    'iconStage' | 'spriteUrl' | '_backgroundPattern' | 'ctx' | 'markLabelDirty' | 'invalidate'
  >,
  dpr: number,
  sampleCount: number,
): void {
  if (host.iconStage !== null || host.spriteUrl === null || host._backgroundPattern === null) return
  host.iconStage = new IconStage(
    host.ctx.device,
    host.ctx.rhi,
    host.ctx.format,
    {
      spriteUrl: host.spriteUrl,
      dpr,
      onLanded: () => {
        // Label re-prep (glyph-parity convention) + a guaranteed frame.
        host.markLabelDirty()
        host.invalidate()
      },
    },
    sampleCount,
  )
}
