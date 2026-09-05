// hunt 2026-09-02: #2301 — a host data push must not destroy the REPLACEMENT tile's compute handle.
//
// `applyReplacedTiles` uploads the new data first and only then calls
// `releaseSupersededTile`, which fires the NAME-keyed `${key}:${slice}` release hook. But
// `buildPerTileFeatureData` re-uses the handle already registered under that name, so by the
// time the hook runs the key belongs to the replacement: destroying it frees the outBuffer the
// fresh featureBindGroup binds and drops the tile out of `dispatchComputePass` for good.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  installWebGPUStub,
  type StubInstallation,
} from '../../../rhi-webgpu/src/__test-support__/webgpu-stub'
import { initGPU } from '@xgis/rhi-webgpu'
import { VectorTileRenderer } from '@xgis/map'
import { FeatureDataBinder } from './feature-data-binder'
import {
  emitMatchComputeKernel,
  buildComputeVariantAddendum,
  mergeComputeAddendumIntoVariant,
  varRefVec4,
  tileKey,
  type ShaderVariant,
  type ComputePlanEntry,
} from '@xgis/compiler'
import type { TileData } from '@xgis/data'
import type { RhiCommandEncoder } from '@xgis/engine'

let stub: StubInstallation
beforeEach(() => {
  if (typeof HTMLCanvasElement === 'undefined') {
    ;(globalThis as { HTMLCanvasElement?: unknown }).HTMLCanvasElement = class {
      width = 800
      height = 600
      getContext(_t: string): unknown {
        return null
      }
    } as never
  }
  stub = installWebGPUStub()
})
afterEach(() => {
  stub.uninstall()
})

function legacyVariant(): ShaderVariant {
  return {
    key: 'L',
    preamble: {},
    fillExpr: varRefVec4('u.fill_color'),
    strokeExpr: varRefVec4('u.stroke_color'),
    opacityExpr: null,
    needsFeatureBuffer: true,
    featureFields: ['class'],
    uniformFields: [],
    categoryOrder: { class: ['a'] },
    paletteScalarGradients: [],
    opacityUsesPalette: false,
    fillIsDefault: true,
    strokeIsDefault: true,
    fillIsStage: false,
    strokeIsStage: false,
  }
}

function makeMatchEntry(field: string, renderNodeIndex: number): ComputePlanEntry {
  const kernel = emitMatchComputeKernel({
    fieldName: field,
    arms: [{ pattern: 'a', colorHex: '#ff0000' }],
    defaultColorHex: '#000000',
  })
  return {
    renderNodeIndex,
    paintAxis: 'fill',
    kernel,
    fieldOrder: kernel.fieldOrder,
    categoryOrder: kernel.categoryOrder ?? {},
  }
}

function tileData(): TileData {
  return {
    vertices: new Float32Array(24),
    dequantScale: 1,
    dequantHalf: 0,
    indices: new Uint32Array([0, 1, 2]),
    lineVertices: new Float32Array(0),
    lineIndices: new Uint32Array(0),
    tileWest: 0,
    tileSouth: 0,
    tileWidth: 1,
    tileHeight: 1,
    tileZoom: 2,
    featureProps: new Map<number, Record<string, unknown>>([[0, { class: 'a' }]]),
  } as unknown as TileData
}

const K = tileKey(2, 1, 1)
const S = 'continents'

describe('#2301 re-seed keeps the replacement tile’s compute handle', () => {
  it('after applyReplacedTiles the new tile still owns a live compute handle', async () => {
    const canvas = { width: 1024, height: 720 } as unknown as HTMLCanvasElement
    Object.setPrototypeOf(canvas, HTMLCanvasElement.prototype)
    const vtr = new VectorTileRenderer(await initGPU(canvas))
    const v = vtr as unknown as Record<string, any>

    // Arm the compute path exactly as map.ts does: variant with computeBindings + plan.
    const entry = makeMatchEntry('class', 0)
    const variant = mergeComputeAddendumIntoVariant(
      legacyVariant(),
      buildComputeVariantAddendum([entry], 0, 16),
    )
    vtr.setComputePlan([entry])
    vtr.buildFeatureDataBuffer(variant, {} as GPUBindGroupLayout, 0)
    // Palette + ring: stand in for the MapRenderer pushes (values only need to be truthy
    // for the stub device's createBindGroup).
    v.ringBufferNative = () => ({}) as GPUBuffer
    v._bindGroups.paletteResources = () => ({
      paletteColorAtlasView: {},
      paletteSampler: {},
      spriteAtlasView: {},
    })

    // Source stub: one replaced key, non-empty replacement data.
    let replacedOnce = false
    const src = {
      onTileLoaded: null as unknown,
      getPropertyTable: () => undefined,
      consumeReplacedKeys: () => {
        if (replacedOnce) return []
        replacedOnce = true
        return [K]
      },
      getTileData: () => tileData(),
      markReplaced: vi.fn(),
      refreshTiles: () => {},
      evictTiles: () => {},
    }
    vtr.setSource(src as never)

    const binder = v._featureBinder as FeatureDataBinder
    const handles = (binder as unknown as Record<string, any>).computeHandlesByTile as Map<
      string,
      { destroy: () => void; getBindGroupEntries: () => unknown }
    >

    // Frame N: tile K resident with a compute handle under 'K:S'.
    v._uploads.uploadSync(K, tileData(), S)
    const before = v._store.cache().get(S)?.get(K)
    expect(before, 'precondition: tile resident').toBeTruthy()
    expect(handles.has(`${K}:${S}`), 'precondition: compute handle minted').toBe(true)
    const handleBefore = handles.get(`${K}:${S}`)!
    const destroySpy = vi.spyOn(handleBefore, 'destroy')
    const entriesSpy = vi.spyOn(handleBefore, 'getBindGroupEntries')

    // Host data push → next beginFrame swaps the replacement in.
    vtr.beginFrame(1)

    const after = v._store.cache().get(S)?.get(K)
    expect(after, 'replacement tile is resident').toBeTruthy()
    expect(after, 'cache entry was swapped').not.toBe(before)
    expect(after.featureBindGroup, 'replacement has a feature bind group').toBeTruthy()
    // Non-vacuity: the replacement's bind group was assembled from THIS handle's entries.
    expect(entriesSpy, 'replacement bind group binds the pre-existing handle').toHaveBeenCalled()

    // That handle must therefore be alive and still dispatching.
    expect(
      destroySpy,
      'the handle the replacement re-used was NOT destroyed',
    ).not.toHaveBeenCalled()
    expect(handles.has(`${K}:${S}`), 'compute handle for K survives the re-seed').toBe(true)

    // Observable: dispatchComputePass still evaluates K's kernel.
    let dispatches = 0
    const enc = {
      nativeEncoder: {
        beginComputePass: () => ({
          setPipeline() {},
          setBindGroup() {},
          dispatchWorkgroups() {},
          end() {
            dispatches++
          },
        }),
      },
    } as unknown as RhiCommandEncoder
    vtr.dispatchComputePass(enc)
    expect(dispatches, "K's compute kernel still runs after the re-seed").toBe(1)
    vtr.destroy()
  })

  it('an evicted tile still releases its compute handle', async () => {
    const canvas = { width: 1024, height: 720 } as unknown as HTMLCanvasElement
    Object.setPrototypeOf(canvas, HTMLCanvasElement.prototype)
    const vtr = new VectorTileRenderer(await initGPU(canvas))
    const v = vtr as unknown as Record<string, any>

    const entry = makeMatchEntry('class', 0)
    const variant = mergeComputeAddendumIntoVariant(
      legacyVariant(),
      buildComputeVariantAddendum([entry], 0, 16),
    )
    vtr.setComputePlan([entry])
    vtr.buildFeatureDataBuffer(variant, {} as GPUBindGroupLayout, 0)
    v.ringBufferNative = () => ({}) as GPUBuffer
    v._bindGroups.paletteResources = () => ({
      paletteColorAtlasView: {},
      paletteSampler: {},
      spriteAtlasView: {},
    })

    const handles = (v._featureBinder as unknown as Record<string, any>)
      .computeHandlesByTile as Map<string, { destroy: () => void }>

    v._uploads.uploadSync(K, tileData(), S)
    expect(handles.has(`${K}:${S}`), 'precondition: compute handle minted').toBe(true)
    const handle = handles.get(`${K}:${S}`)!
    const destroySpy = vi.spyOn(handle, 'destroy')

    // The key IS vacated here, so the name-keyed release must still fire.
    v._store.dropTile(S, K, v._releaseTileHook)

    expect(destroySpy, 'dropping the tile destroys its handle').toHaveBeenCalled()
    expect(handles.has(`${K}:${S}`), 'dropped key leaves the handle map').toBe(false)
    vtr.destroy()
  })
})
