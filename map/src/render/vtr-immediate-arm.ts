// ═══ VTR immediate-execution arm — the chain's WebGL2 terminal (#1046 Inc-E2) ═══
//
// On a device whose frames execute as they record (`caps.executionModel ===
// 'immediate'`, the WebGL2 truth), VTR.render's native tile body cannot run:
// its pipelines and bind groups are WebGPU objects, and the boundary unwrap
// fails loud (arch F3). This arm routes the draw through the *Rhi entry
// family — the SAME immediate-mode body the twin frame drives — with the
// phase mapping mirroring the twin's per-show sequencing: fills → tile
// points (single authority: the points read the keys the fills just
// selected), then strokes; the translucent bucket's offscreen pass takes the
// MAX-blend material. VTR keys the routing on the DEVICE capability (never
// backend identity) and keeps 'oit-fill' native-only (P6): reaching it on an
// immediate device trips the named fail-loud unwrap. Extracted from
// VTR.render's top per the LOC ratchet's own instruction ("extract, don't
// grow"); dies with the twin↔chain unification (P6).

import type { Camera } from '../camera'
import type { RhiRenderPass } from '@xgis/engine'
import type { ShowCommand } from './renderer-types'
import type { PointRenderer } from './point-renderer'
import type { VectorTileRenderer } from './vector-tile-renderer'
import type { LayerDrawPhase } from './vector-tile-renderer-types'
import type { ResolvedShow } from './resolved-show'

export interface ImmediateArmArgs {
  rhiPass: RhiRenderPass
  camera: Camera
  projType: number
  projCenterLon: number
  projCenterLat: number
  canvasWidth: number
  canvasHeight: number
  dpr: number
  show: ShowCommand
  resolvedShow: ResolvedShow
  phase: LayerDrawPhase
  translucentBucket: boolean
  pointRenderer: PointRenderer | null | undefined
}

/** Draw one show through the immediate-mode entries. The caller (VTR.render)
 *  has already gated on `caps.executionModel === 'immediate'` and excluded
 *  'oit-fill'. */
export function renderImmediateArm(vtr: VectorTileRenderer, a: ImmediateArmArgs): void {
  const { rhiPass, camera, projType, projCenterLon, projCenterLat } = a
  const { canvasWidth, canvasHeight, dpr, show, resolvedShow } = a
  if (a.phase === 'all' || a.phase === 'fills') {
    vtr.renderFillsRhi(
      rhiPass,
      camera,
      projType,
      projCenterLon,
      projCenterLat,
      canvasWidth,
      canvasHeight,
      dpr,
      show,
      resolvedShow,
      'color',
    )
    // Twin sequencing: the tile points read the keys the fills just selected.
    vtr.emitTilePointsRhi(
      rhiPass,
      camera,
      projType,
      projCenterLon,
      projCenterLat,
      canvasWidth,
      canvasHeight,
      dpr,
      show,
      a.pointRenderer,
    )
  }
  if (a.phase === 'all' || a.phase === 'strokes') {
    vtr.renderLinesRhi(
      rhiPass,
      camera,
      projType,
      projCenterLon,
      projCenterLat,
      canvasWidth,
      canvasHeight,
      dpr,
      show,
      resolvedShow,
      a.translucentBucket ? 'max' : 'opaque',
    )
  }
}
