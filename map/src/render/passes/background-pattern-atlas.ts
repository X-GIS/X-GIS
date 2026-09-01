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
 *  fill-patterns to otherwise trip the lazy IconStage in execute().
 *
 *  `onLanded` calls BOTH, for two different reasons (#2128 corrected the note
 *  that used to stand here, which said `markLabelDirty()` cannot re-arm an idle
 *  loop — it can: `map.ts:979-982` sets `_needsRender` as well as tagging, and
 *  `shouldRenderThisFrame()`'s first term reads `_needsRender`):
 *    - `markLabelDirty()` — tags LABEL, the glyph-parity convention for an
 *      async atlas arrival, so the next frame re-preps labels.
 *    - `invalidate()` — tags the REST. What landed here is the SPRITE atlas,
 *      and its consumer is `_resolveFillPatterns` filling the synthetic show's
 *      fillPatternUV/RepeatM — a STYLE/SOURCE consumer, not a label one. LABEL
 *      alone would under-tag it the moment a second `_dirty.consume` caller
 *      lands (the S16 build-out `map.ts:971-976` anticipates).
 *
 *  Kept a free exported function (mirroring backgroundClearValue) so the gate +
 *  hook are behaviour-gated by a GPU-free test with a mocked IconStage. */
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
        // Label re-prep (glyph-parity convention) + the non-label domains the
        // landed sprite actually feeds — see the note above (#2128).
        host.markLabelDirty()
        host.invalidate()
      },
    },
    sampleCount,
  )
}
