// Regression test for slot 44 (Uniforms.zoom, byte offset 176) in the
// per-tile polygon uniform packed by VectorTileRenderer.renderTileKeys.
//
// Slot 44 feeds OFM Liberty/Bright zoom-interpolated fill colours and
// palette-gradient sampling (the variant shader maps
// clamp((u.zoom - zMin)/span, 0, 1) into the gradient atlas). It MUST
// be the CONTINUOUS camera zoom — every fractional camera zoom in
// [N, N+1) must produce a distinct u.zoom. Previously slot 44 was
// packed with `this.lastZoom`, the INTEGER tile-selection zoom (floor +
// hysteresis), so fills/gradients snapped at integer boundaries instead
// of interpolating. The fix caches `this.currentCameraZoom = camera.zoom`
// in render() and packs that into slot 44, keeping lastZoom (integer)
// for tile-selection/LOD only.
//
// VTR's constructor needs WebGPU init we can't run in vitest, so we build
// an instance via Object.create + manual field injection (same escape
// hatch as vtr-held-keys / vtr-pump-prefetch). We drive the REAL private
// renderTileKeys with one geometry-less cached tile so the loop reaches
// the slot-44 write but emits no GPU draws, then read the staged uniform.

import { describe, expect, it } from 'vitest'
import { tileKey } from '@xgis/compiler'
import { VectorTileRenderer } from './vector-tile-renderer'
import { polygonUniformBytes } from './polygon-uniform-slots'
import type { GPUTile } from './vector-tile-renderer-types'

// Scratch uniform buffer size — DERIVED from reflect(buildPolygonModule()) (the
// SAME source the production VTR sizes uniformDataBuf from), not a hardcoded byte
// count. A hardcoded 256 silently truncated the #600 globe_eye slot (f32 64-67)
// when the struct grew to 272; deriving it means a future field reflows the test
// automatically instead of drifting (the std140-drift class #581 retired). Read
// lazily inside makeVtr (post-setup configureProjections), never at module scope.

// A cached tile with NO geometry: indexCount/segment counts all 0 so the
// fill draw (`cached.indexCount > 0`) and stroke push are both skipped,
// but the per-tile uniform pack (incl. slot 44) still runs.
function emptyTile(): GPUTile {
  return {
    indexCount: 0,
    lineIndexCount: 0,
    outlineIndexCount: 0,
    outlineSegmentCount: 0,
    lineSegmentCount: 0,
    extruded: false,
    tileWest: 0,
    tileSouth: 0,
    tileZoom: 5,
    dequantScale: 0,
    dequantHalf: 0,
    lastUsedFrame: 0,
    featureBindGroup: null,
  } as unknown as GPUTile
}

// A bind-group layout sentinel that === the value baseLayout() returns,
// so the FILL path resolves to a truthy baseGroup() and passes the guard.
function makeVtr(lastZoom: number, cameraZoom: number) {
  const vtr = Object.create(VectorTileRenderer.prototype) as VectorTileRenderer
  const buf = new ArrayBuffer(polygonUniformBytes())
  const f32 = new Float32Array(buf)
  const u32 = new Uint32Array(buf)
  const layout = {} as GPUBindGroupLayout
  const group = {} as GPUBindGroup

  const set = (k: string, v: unknown) => { (vtr as unknown as Record<string, unknown>)[k] = v }

  set('uniformDataBuf', buf)
  set('uniformF32', f32)
  set('uniformU32', u32)
  set('lastZoom', lastZoom)
  set('currentCameraZoom', cameraZoom)
  set('frameCount', 0)
  set('cachedFillColor', [0, 0, 0, 0])
  set('cachedStrokeColor', [0, 0, 0, 0])
  set('currentOpacity', 1.0)
  set('logDepthFc', 1.0)
  set('currentPickId', 0)
  set('currentExtrudeHeight', 0)
  set('currentExtrudeMode', 'none')
  set('_skipFillDraw', false)
  set('_skipStrokeDrawForBundle', false)
  // WS-9 — the per-tile uniform packer reads these light fields (the
  // packer destructures _lightPosition). Object.create skips the class
  // field initializers, so set them to the MapLibre defaults here.
  set('_lightPosition', [1.15, 210, 30])
  set('_lightIntensity', 0.5)
  set('_lightColor', [1, 1, 1])
  set('lineRenderer', null)
  set('_linePatternActiveForShow', false)
  set('_drawStats', { hasDrawn: () => false, markDrawn: () => {} })
  set('_bindGroups', { baseLayout: () => layout, baseGroup: () => group, featureGroup: () => group })
  set('uniformRing', { buffer: {}, allocSlot: () => 0, stageSlot: () => {}, flush: () => {} })

  return { vtr, f32, layout }
}

// Call the private renderTileKeys with the minimal positional args.
function callRenderTileKeys(vtr: VectorTileRenderer, layout: GPUBindGroupLayout, key: number) {
  const cache = new Map<number, GPUTile>([[key, emptyTile()]])
  const pipe = {} as GPURenderPipeline
  const pass = {} as GPURenderPassEncoder
  ;(vtr as unknown as {
    renderTileKeys(
      keys: number[], pass: unknown, fillPipeline: unknown, linePipeline: unknown,
      projCenterLon: number, projCenterLat: number, worldOffsets: number[] | undefined,
      lineLayerOffset: number, lineLayerOffsetGap: number, phase: string,
      layerCache: Map<number, GPUTile>, fillPipelineExtruded: unknown,
      fillBindGroupLayout: unknown,
    ): void
  }).renderTileKeys(
    [key], pass, pipe, pipe,
    0, 0, undefined,
    0, -1, 'fills',
    cache, null,
    layout,
  )
}

describe('VectorTileRenderer — slot 44 (u.zoom) carries continuous camera zoom', () => {
  it('packs the fractional camera.zoom (5.7), not the integer tile-selection zoom (5)', () => {
    // camera.zoom = 5.7 while the tile-selection zoom (lastZoom) sits at 5.
    const { vtr, f32, layout } = makeVtr(/* lastZoom */ 5, /* cameraZoom */ 5.7)
    callRenderTileKeys(vtr, layout, tileKey(5, 16, 11))

    // Slot 44 = byte offset 176. Must reflect the continuous zoom.
    // Float32 round-trip of 5.7 — compare with a small tolerance.
    expect(f32[44]).toBeCloseTo(5.7, 5)
    // And it must NOT be the integer tile-selection zoom (the bug).
    expect(f32[44]).not.toBe(5)
  })

  it('interpolates across a fractional zoom range within one integer level', () => {
    // Two camera zooms inside [5, 6) that share the SAME integer
    // tile-selection zoom (5) must yield DISTINCT u.zoom values.
    const a = makeVtr(5, 5.2)
    callRenderTileKeys(a.vtr, a.layout, tileKey(5, 16, 11))
    const b = makeVtr(5, 5.8)
    callRenderTileKeys(b.vtr, b.layout, tileKey(5, 16, 11))

    expect(a.f32[44]).toBeCloseTo(5.2, 5)
    expect(b.f32[44]).toBeCloseTo(5.8, 5)
    expect(a.f32[44]).not.toBeCloseTo(b.f32[44], 5)
  })
})
