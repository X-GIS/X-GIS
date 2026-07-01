// Audit ⑩ B1 (pick visibility) + B2 (DPR pick-coord rounding). Device-free:
// `cssToDevicePixel` is pure, and `resolvePick` only reads the layerId
// registry + the XGISLayer visibility flag (no GPU readback), so both are
// unit-testable with stub deps.

import { describe, it, expect } from 'vitest'
import {
  InteractionController,
  cssToDevicePixel,
  type InteractionControllerDeps,
} from './interaction-controller'
import type { LayerIdRegistry, XGISLayer } from './layer'

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

  it('returns -1 for NaN / degenerate rect', () => {
    expect(cssToDevicePixel(NaN, 100, 200)).toBe(-1)
    expect(cssToDevicePixel(5, 0, 200)).toBe(-1)
  })
})

// ── B1: invisible⇒unclickable, enforced at the readback boundary ──
function makeController(layers: Record<number, { name: string; visible: boolean }>): InteractionController {
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
