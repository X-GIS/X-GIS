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
import { uniformBlock } from '@xgis/engine'
import { VectorTileRenderer } from './vector-tile-renderer'
import { polygonUniformSlots } from './polygon-uniform-slots'
import { polygonU } from '../shaders/dsl/polygon'
import type { GPUTile } from './vector-tile-renderer-types'

// #733 REWRITE: the packer surface this pins moved from the hand-indexed
// `uniformF32` scratch (uf[44]) to the typed UniformBlock — the harness now
// injects a real `uniformBlock(polygonU)` as `frameBlock` (Object.create skips
// the class-field initializer) and reads the zoom lane back off the block's own
// buffer at the reflect-derived slot (polygonUniformSlots().slot.zoom), so a
// future struct reflow moves the assertion automatically instead of drifting.
// Block construction happens lazily inside makeVtr (post-setup
// configureProjections — reflect() is injection-deferred), never at module scope.

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
  // The REAL typed block the production packer writes through (#733). Its
  // backing buffer is what stageUniformSlot copies into the ring — reading it
  // directly is the same staged ground truth the old uniformF32 scratch was.
  const block = uniformBlock(polygonU)
  const f32 = new Float32Array(block.buffer)
  const layout = {} as GPUBindGroupLayout
  const group = {} as GPUBindGroup

  const set = (k: string, v: unknown) => {
    ;(vtr as unknown as Record<string, unknown>)[k] = v
  }

  set('frameBlock', block)
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
  set('_bindGroups', {
    baseLayout: () => layout,
    baseGroup: () => group,
    featureGroup: () => group,
  })
  set('uniformRing', { rhiBuffer: {}, allocSlot: () => 0, stageSlot: () => {}, flush: () => {} })

  return { vtr, f32, layout }
}

// Call the private renderTileKeys with the minimal positional args.
function callRenderTileKeys(vtr: VectorTileRenderer, layout: GPUBindGroupLayout, key: number) {
  const cache = new Map<number, GPUTile>([[key, emptyTile()]])
  const pipe = {} as GPURenderPipeline
  const pass = {} as GPURenderPassEncoder
  ;(
    vtr as unknown as {
      renderTileKeys(
        keys: number[],
        pass: unknown,
        fillPipeline: unknown,
        linePipeline: unknown,
        projCenterLon: number,
        projCenterLat: number,
        worldOffsets: number[] | undefined,
        lineLayerOffset: number,
        lineLayerOffsetGap: number,
        phase: string,
        layerCache: Map<number, GPUTile>,
        fillPipelineExtruded: unknown,
        fillBindGroupLayout: unknown,
      ): void
    }
  ).renderTileKeys([key], pass, pipe, pipe, 0, 0, undefined, 0, -1, 'fills', cache, null, layout)
}

describe('VectorTileRenderer — u.zoom lane carries continuous camera zoom', () => {
  it('packs the fractional camera.zoom (5.7), not the integer tile-selection zoom (5)', () => {
    // camera.zoom = 5.7 while the tile-selection zoom (lastZoom) sits at 5.
    const { vtr, f32, layout } = makeVtr(/* lastZoom */ 5, /* cameraZoom */ 5.7)
    callRenderTileKeys(vtr, layout, tileKey(5, 16, 11))

    // The zoom lane at its reflect-derived f32 slot must carry the continuous
    // zoom. Float32 round-trip of 5.7 — compare with a small tolerance.
    const zoomSlot = (polygonUniformSlots().slot as Record<string, number>).zoom!
    expect(f32[zoomSlot]).toBeCloseTo(5.7, 5)
    // And it must NOT be the integer tile-selection zoom (the bug).
    expect(f32[zoomSlot]).not.toBe(5)
  })

  it('interpolates across a fractional zoom range within one integer level', () => {
    // Two camera zooms inside [5, 6) that share the SAME integer
    // tile-selection zoom (5) must yield DISTINCT u.zoom values.
    const zoomSlot = (polygonUniformSlots().slot as Record<string, number>).zoom!
    const a = makeVtr(5, 5.2)
    callRenderTileKeys(a.vtr, a.layout, tileKey(5, 16, 11))
    const b = makeVtr(5, 5.8)
    callRenderTileKeys(b.vtr, b.layout, tileKey(5, 16, 11))

    expect(a.f32[zoomSlot]).toBeCloseTo(5.2, 5)
    expect(b.f32[zoomSlot]).toBeCloseTo(5.8, 5)
    expect(a.f32[zoomSlot]).not.toBeCloseTo(b.f32[zoomSlot], 5)
  })
})
