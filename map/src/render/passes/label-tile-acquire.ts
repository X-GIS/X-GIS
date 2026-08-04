// ═══ Tile acquisition for label-bearing VT shows (#834 M5 s3 → #1046 Inc-F2b) ═══
//
// A label-ONLY show never enters the fills/lines acquisition — both bail on
// missing paint — but the label dispatch reads that selection's frameTileCache
// and the source's CPU payloads. Without this, such a show draws NOTHING: no
// text, no icons, no error, nothing a pixel gate distinguishes from an empty
// style.
//
// It lived inside the forced-WebGL2 twin frame only, which is exactly how the
// unified chain lost it. Measured on `fixture_symbol_icon_textfit`: the twin
// reported `getDispatchedIconNames() == ["shield"]` and painted the shields;
// the chain reported `[]` and painted an empty map, with zero console errors.
// Calling it from the label PASS — which both frame shapes run, beside the
// labelShows that determine what needs acquiring — makes it one authority and
// outlives the twin's deletion.
//
// Extracted from label-pass.ts per the LOC ratchet's own instruction ("extract,
// don't grow"). The missing count is folded into each renderer's FrameDrawStats
// by `ensureLabelTilesRhi` itself, which is the counter the chain's keep-warm
// gate reads; the twin keeps its own accumulator and its own pre-pass call
// until it is deleted.

import type { Camera } from '../../camera'
import type { FrameContext } from '../frame-context'
import type { ShowCommand } from '../renderer-types'
import type { VectorTileRenderer } from '../vector-tile-renderer'
import { unwrapProjection } from '../projection-token'

/** The slice of the label-pass host this needs: where the tiles live and what
 *  the selection projects through. */
export interface LabelTileAcquireHost {
  vtSources: ReadonlyMap<string, { renderer: VectorTileRenderer }>
  camera: Camera
}

/** Acquire the tiles every label-bearing show needs, before the dispatch reads
 *  them. No-op when nothing carries a label this frame. */
export function acquireLabelTiles(
  labelShows: readonly ShowCommand[],
  host: LabelTileAcquireHost,
  projection: FrameContext['projection'],
  w: number,
  h: number,
  dpr: number,
): void {
  if (labelShows.length === 0) return
  const { projType, centerLon, centerLat } = unwrapProjection(projection)
  for (const show of labelShows) {
    const vt = host.vtSources.get(show.targetName)
    if (!vt) continue
    vt.renderer.ensureLabelTilesRhi(host.camera, projType, centerLon, centerLat, w, h, dpr, show)
  }
}
