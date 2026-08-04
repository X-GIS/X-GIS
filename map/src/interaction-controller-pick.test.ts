// Audit ⑩ B1 (pick visibility) + B2 (DPR pick-coord rounding). Device-free:
// `cssToDevicePixel` is pure, and `resolvePick` only reads the layerId
// registry + the XGISLayer visibility flag (no GPU readback), so both are
// unit-testable with stub deps.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  InteractionController,
  cssToDevicePixel,
  type InteractionControllerDeps,
} from './interaction-controller'
import type { LayerIdRegistry, XGISLayer } from './layer'
import type { RawDataset } from './map-types'

// ── B2: center-rounded CSS→device pixel mapping ──
describe('cssToDevicePixel (Audit ⑩ B2 — DPR pick-coord rounding)', () => {
  it('DPR1: samples the same pixel index (no regression)', () => {
    expect(cssToDevicePixel(0, 100, 100)).toBe(0)
    expect(cssToDevicePixel(50, 100, 100)).toBe(50)
    expect(cssToDevicePixel(99, 100, 100)).toBe(99)
  })

  it('DPR2: samples the CSS-pixel CENTRE, not the group top-left', () => {
    // CSS px 50 spans device [100,102); the old `floor(50*2)=100` biased to
    // the top-left, the centre-sample lands on 101.
    expect(cssToDevicePixel(50, 100, 200)).toBe(101)
    expect(cssToDevicePixel(0, 100, 200)).toBe(1) // floor(0.5*2)=1, centre of px0
  })

  it('clamps the high edge into [0, canvasSpan-1] (never overflows)', () => {
    expect(cssToDevicePixel(99.9, 100, 200)).toBe(199)
  })

  it('returns -1 (miss) for out-of-element coords', () => {
    expect(cssToDevicePixel(-0.1, 100, 200)).toBe(-1)
    expect(cssToDevicePixel(100, 100, 200)).toBe(-1) // == rectSpan → outside
    expect(cssToDevicePixel(150, 100, 200)).toBe(-1)
  })

  // #1429 INC-2 — the adaptive ladder can hold the pick RT (a scene-pass
  // attachment) BELOW the canvas. The conversion's span comes from the pick
  // TEXTURE itself, so a scaled texture maps proportionally: the same CSS
  // point must land on the scene texel, not the canvas texel.
  it('scaled pick RT (scene < canvas): maps into the TEXTURE span, byte-identical at scale 1', () => {
    // 800-CSS rect, 576-px scene texture (scale 0.72): centre CSS px 400
    // lands at floor(400.5 × 576/800) = floor(288.36) = 288 — the scene
    // texel. Converting against the 800-px canvas would give 400: reading
    // texel 400 of a 576-wide texture is the off-by-a-fraction the design
    // names (§4) — silent wrong-feature picks on exactly the slow hosts
    // the ladder serves.
    expect(cssToDevicePixel(400, 800, 576)).toBe(288)
    expect(cssToDevicePixel(400, 800, 800)).toBe(400) // scale 1: unchanged
    // High edge stays inside the scaled texture.
    expect(cssToDevicePixel(799.9, 800, 576)).toBe(575)
  })

  it('pickAt derives its span from the pick TEXTURE, not the canvas (#1429 wiring pin)', () => {
    // Source-text pin (the label-pass-replay precedent): the call sites must
    // read the pick texture's own size — surfaced by its owner as
    // `getPickTextureSize` since the RhiTexture retype (#1046 F4 Inc-D; the
    // opaque handle has no `.width`). A revert to canvas.width would compile
    // and pass every math case above — this anchor is what fails it.
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'interaction-controller.ts'),
      'utf8',
    )
    expect(src).toContain('cssToDevicePixel(clientX - rect.left, rect.width, pickSize.width)')
    expect(src).toContain('cssToDevicePixel(clientY - rect.top, rect.height, pickSize.height)')
    // The ONE canvas-span conversion that remains is the forced-WebGL2 arm,
    // whose on-demand offscreen pick RT IS canvas-sized (the twin scales its
    // canvas — scene === canvas there, so canvas.width is that RT's span).
    // It must sit INSIDE the webgl2 branch, above the WebGPU path's
    // texture-span pair; a second canvas-span conversion — a WebGPU-arm
    // revert — fails here.
    const canvasSpanUses =
      src.split('cssToDevicePixel(clientX - rect.left, rect.width, canvas.width)').length - 1
    expect(canvasSpanUses).toBe(1)
    // The sync-readback arm — asked as the CAPABILITY minted for that decision
    // since #1046 Inc-F, not the backend's identity.
    const twinArm = src.indexOf("ctx.rhi?.caps.pickReadback === 'sync'")
    const canvasConv = src.indexOf(
      'cssToDevicePixel(clientX - rect.left, rect.width, canvas.width)',
    )
    const textureConv = src.indexOf(
      'cssToDevicePixel(clientX - rect.left, rect.width, pickSize.width)',
    )
    expect(twinArm).toBeGreaterThan(-1)
    expect(canvasConv).toBeGreaterThan(twinArm)
    expect(textureConv).toBeGreaterThan(canvasConv)
  })

  it('returns -1 for NaN / degenerate rect', () => {
    expect(cssToDevicePixel(NaN, 100, 200)).toBe(-1)
    expect(cssToDevicePixel(5, 0, 200)).toBe(-1)
  })
})

// ── B1: invisible⇒unclickable, enforced at the readback boundary ──
function makeController(
  layers: Record<number, { name: string; visible: boolean }>,
): InteractionController {
  const idToName = new Map<number, string>()
  const xgisLayers = new Map<string, XGISLayer>()
  for (const [idStr, { name, visible }] of Object.entries(layers)) {
    idToName.set(Number(idStr), name)
    xgisLayers.set(name, { visible } as XGISLayer)
  }
  const layerIds = {
    getName: (id: number) => idToName.get(id) ?? null,
  } as unknown as LayerIdRegistry

  const deps = {
    camera: {} as never,
    layerIds,
    xgisLayers,
    rawDatasets: new Map(),
    featureIndex: new Map(),
    getCtx: () => null,
    getPickTexture: () => null,
    getProjectionName: () => 'mercator',
    getVectorTileShows: () => [],
  } as unknown as InteractionControllerDeps
  return new InteractionController(deps)
}

describe('InteractionController.resolvePick (Audit ⑩ B1 — pick visibility)', () => {
  const ctrl = makeController({
    1: { name: 'roads', visible: true },
    2: { name: 'hidden_pois', visible: false },
  })

  it('returns the hit for a VISIBLE layer', () => {
    expect(ctrl.resolvePick(7, 1, 0)).toEqual({ featureId: 7, layerId: 1, instanceId: 0 })
  })

  it('suppresses a hit on a HIDDEN layer (invisible ⇒ unclickable)', () => {
    expect(ctrl.resolvePick(7, 2, 0)).toBeNull()
  })

  it('treats featureId=0 and layerId=0 as miss sentinels', () => {
    expect(ctrl.resolvePick(0, 1, 0)).toBeNull()
    expect(ctrl.resolvePick(7, 0, 0)).toBeNull()
  })

  it('does NOT suppress a hit on an unregistered layerId (cannot prove hidden)', () => {
    expect(ctrl.resolvePick(7, 99, 0)).toEqual({ featureId: 7, layerId: 99, instanceId: 0 })
  })
})

// ── Tile-backed marker sources must NOT crash the property lookup ──
// VirtualPMTilesBackend is the DEFAULT route for URL GeoJSON, so such a
// source's `rawDatasets` entry is the `{ _vectorTile: true }` marker (the real
// FeatureCollection lives in hostSeededFC), NOT a FeatureCollection. The old
// bare `!data` guard let the truthy marker through to `data.features.length`,
// which threw "Cannot read properties of undefined (reading 'length')" on every
// hover — the reported picking-demo crash storm. The lookup's contract is to
// return null for non-GeoJSON sources; buildFeatureForEvent then degrades to an
// ID-only feature (properties: {}).
function makePropsController(opts: {
  rawDatasets: Map<string, RawDataset>
  layers?: Record<number, string> // layerId → layerName
  shows?: { layerName?: string; targetName: string }[]
}): InteractionController {
  const idToName = new Map<number, string>(
    Object.entries(opts.layers ?? {}).map(([id, name]) => [Number(id), name]),
  )
  const xgisLayers = new Map<string, XGISLayer>()
  for (const name of idToName.values()) xgisLayers.set(name, { visible: true } as XGISLayer)
  const deps = {
    camera: {} as never,
    layerIds: { getName: (id: number) => idToName.get(id) ?? null } as unknown as LayerIdRegistry,
    xgisLayers,
    rawDatasets: opts.rawDatasets,
    featureIndex: new Map(),
    getCtx: () => null,
    getPickTexture: () => null,
    getPickTextureDevice: () => null,
    getProjectionName: () => 'mercator',
    getVectorTileShows: () =>
      (opts.shows ?? []).map((show) => ({
        sourceName: show.targetName,
        show,
        pipelines: null,
        layout: null,
      })),
  } as unknown as InteractionControllerDeps
  return new InteractionController(deps)
}

describe('InteractionController.lookupFeatureProperties (tile-backed markers)', () => {
  const markers: Array<[string, RawDataset]> = [
    ['vector-tile / tiled-geojson', { _vectorTile: true }],
    ['raster', { _tileUrl: 'https://t/{z}/{x}/{y}.png' }],
    ['coverage', { _coverage: {} as never }],
  ]
  for (const [label, marker] of markers) {
    it(`returns null (no throw) for a ${label} marker source`, () => {
      const ctrl = makePropsController({ rawDatasets: new Map([['world', marker]]) })
      expect(() => ctrl.lookupFeatureProperties('world', 42)).not.toThrow()
      expect(ctrl.lookupFeatureProperties('world', 42)).toBeNull()
    })
  }

  it('still resolves properties for a real FeatureCollection source', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', id: 7, properties: { name: 'Korea' }, geometry: null }],
    } as unknown as RawDataset
    const ctrl = makePropsController({ rawDatasets: new Map([['world', fc]]) })
    expect(ctrl.lookupFeatureProperties('world', 7)).toEqual({ name: 'Korea' })
  })

  it('returns null for an unknown source (miss)', () => {
    const ctrl = makePropsController({ rawDatasets: new Map() })
    expect(ctrl.lookupFeatureProperties('nope', 1)).toBeNull()
  })
})

describe('InteractionController.buildFeatureForEvent (tile-backed source → ID-only feature)', () => {
  it('builds an ID-only feature (no crash) when the picked source is a tile marker', () => {
    const ctrl = makePropsController({
      rawDatasets: new Map<string, RawDataset>([['world', { _vectorTile: true }]]),
      layers: { 3: 'fill' },
      shows: [{ layerName: 'fill', targetName: 'world' }],
    })
    expect(ctrl.buildFeatureForEvent(3, 42)).toEqual({
      id: 42,
      source: 'world',
      layer: 'fill',
      properties: {},
    })
  })
})
