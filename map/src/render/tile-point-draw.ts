// #1581 leg B — the tile-point uniform-refresh + draw tail, extracted
// (point-renderer.ts sits at its LOC ceiling). Shared by `flushTilePointsRhi`
// (full repack) and `redrawTilePointsCached` (buffers reused, only the
// translate/frame uniform is refreshed) so the two never drift.

import type { RhiBuffer, RhiDevice, UniformBlockOf } from '@xgis/engine'
import type { pointU as POINT_U } from '../shaders/dsl/point'
import type { PointDraper } from './material/point-material'
import { resolveNumberShape } from './paint-shape-resolve'
import { writePointFrameUniform } from './point-renderer'
import type { TilePointFrameArgs } from './tile-point-pack-key'

/** Resources `refreshTilePointUniformAndDraw` needs off `PointRenderer` —
 *  resolved by the caller (shapeBuf/segBuf/pointDraper are already fallback-
 *  applied) so this function touches no PointRenderer internals directly. */
export interface TilePointDrawDeps {
  frameBlock: UniformBlockOf<typeof POINT_U>
  rhi: RhiDevice
  uniformBuffer: RhiBuffer
  pointDraper: PointDraper
  shapeBuf: RhiBuffer
  segBuf: RhiBuffer
  featBuffer: RhiBuffer
  vertexBuffer: RhiBuffer
  indexBuffer: RhiBuffer
}

export function refreshTilePointUniformAndDraw(
  deps: TilePointDrawDeps,
  args: TilePointFrameArgs,
  totalN: number,
  variant: 0 | 1,
): void {
  const {
    pass,
    camera,
    projType,
    projCenterLon,
    projCenterLat,
    canvasWidth,
    canvasHeight,
    show,
    dpr,
  } = args
  const tileTranslateX = show.circleTranslateXShape
    ? resolveNumberShape(show.circleTranslateXShape, camera.zoom, 0).value
    : (show.circleTranslateX ?? 0)
  const tileTranslateY = show.circleTranslateYShape
    ? resolveNumberShape(show.circleTranslateYShape, camera.zoom, 0).value
    : (show.circleTranslateY ?? 0)
  const frame = camera.getViewForProjection(projType, canvasWidth, canvasHeight, dpr)
  writePointFrameUniform(
    deps.frameBlock,
    frame,
    camera,
    projType,
    projCenterLon,
    projCenterLat,
    canvasWidth,
    canvasHeight,
    dpr,
    tileTranslateX,
    tileTranslateY,
    show.circleBlur ?? 0,
    show.circlePitchScaleMap ?? false,
  )
  deps.rhi.writeBuffer(deps.uniformBuffer, 0, deps.frameBlock.buffer)
  deps.pointDraper.draw(pass, {
    uniform: deps.uniformBuffer,
    feat: deps.featBuffer,
    shape: deps.shapeBuf,
    seg: deps.segBuf,
    vertex: deps.vertexBuffer,
    index: deps.indexBuffer,
    indexCount: totalN * 6,
    variant,
  })
}
