// ═══ The flush prefers the in-place point patch over a re-seed (#1375) ═══
//
// FAIL-BEFORE (the red-before witness). On pre-fix code `flushPendingUpdates`
// ends the virtual-tiled branch with an UNCONDITIONAL
//
//     if (touched) this.host.reseedSource?.(sourceId, { ...seeded, features })
//
// (feature-update-queue.ts:205 at 5e10c49d) and `FeatureUpdateQueueHost` has no
// `patchFeaturesInPlace` member at all. So for the patchable case below the
// pre-fix run calls `reseedSource` exactly once and never calls the patch hook:
// the first two assertions of the first test fail, and they fail naming the
// re-seed. There is no arrangement of the fixture that greens them without the
// preference actually existing — which is the property #1444 says an assertion
// needs to carry information.
//
// The whole point of the preference is that `reseedSource` is `setSourceData`,
// which rebuilds the source's geojsonvt index, re-requests every drawn key and
// re-decodes + re-compiles each one. #1375 measured that chain at 5-7 frames
// per update, structurally — every arrow in it is a frame boundary.

import { describe, it, expect, vi } from 'vitest'
import { FeatureUpdateQueue, type FeatureUpdateQueueHost } from './feature-update-queue'
import type { GeoJSONFeature, GeoJSONFeatureCollection, PointFeatureMove } from '@xgis/data'
import type { RawDataset } from './map-types'

const SRC = 'vessels'

function pointFeature(id: number, lon: number, lat: number): GeoJSONFeature {
  return {
    type: 'Feature',
    id,
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: {},
  }
}

interface HarnessOptions {
  features?: GeoJSONFeature[]
  /** What the host reports back from the patch hook (default: serviced). */
  patchOk?: boolean
  /** false = a historical host that predates the hook entirely. */
  withHook?: boolean
}

function harness(opts: HarnessOptions = {}) {
  const seeded: GeoJSONFeatureCollection = {
    type: 'FeatureCollection',
    features: opts.features ?? [pointFeature(77, 10, 10), pointFeature(78, 20, 20)],
  }
  const teardownSource = vi.fn()
  const reseedSource = vi.fn()
  // Typed with the real signature so `mock.calls[0]` is the (id, fc, moves)
  // tuple rather than an empty one.
  const patchFeaturesInPlace = vi.fn(
    (_id: string, _fc: GeoJSONFeatureCollection, _moves: readonly PointFeatureMove[]) =>
      opts.patchOk !== false,
  )
  const host: FeatureUpdateQueueHost = {
    // A virtual-tiled geojson source: rawDatasets holds only the marker, so the
    // seeded FC is the host-side authority — the #1235 gap-2 shape.
    rawDatasets: new Map<string, RawDataset>([[SRC, { _vectorTile: true }]]),
    isDestroyed: () => false,
    teardownSource,
    rebuildLayers: vi.fn(),
    invalidate: vi.fn(),
    getSeededFC: (id) => (id === SRC ? seeded : null),
    reseedSource,
    patchFeaturesInPlace: opts.withHook === false ? undefined : patchFeaturesInPlace,
  }
  const queue = new FeatureUpdateQueue(host)
  return {
    queue,
    teardownSource,
    reseedSource,
    patchFeaturesInPlace,
    seeded,
    // Driven directly rather than through the coalescing rAF: the scheduling is
    // untouched by #1375 and a timer would only add flake.
    flush: () => (queue as unknown as { flushPendingUpdates(): void }).flushPendingUpdates(),
  }
}

describe('FeatureUpdateQueue — in-place point patch preference (#1375)', () => {
  it('a same-tile point move goes to the patch hook, NOT to reseed/teardown', () => {
    const h = harness()
    h.queue.updateFeature(SRC, 77, { geometry: { type: 'Point', coordinates: [11, 12] } })
    h.flush()

    // CAUSE first, EFFECT second (#1444): a severed preference and a
    // `collectPointMoves` that wrongly rejects both leave `reseedSource` called
    // once, so the "did the patch hook get reached at all" assertion is the one
    // that must report. Which HALF broke is separated by the dedicated
    // rejection tests below and by point-feature-patch.test.ts.
    expect(h.patchFeaturesInPlace, 'the flush must reach the in-place patch').toHaveBeenCalledTimes(
      1,
    )
    expect(h.reseedSource, 'a moved point must not re-tile the source').not.toHaveBeenCalled()
    expect(h.teardownSource, 'a moved point must not tear the source down').not.toHaveBeenCalled()

    const [sourceId, fc, moves] = h.patchFeaturesInPlace.mock.calls[0]
    expect(sourceId).toBe(SRC)
    expect(moves).toEqual([{ featureId: 77, lon: 11, lat: 12 }])
    // The patched FC is handed over so the host can adopt it as the new seeded
    // collection — the pre-image the NEXT flush patches against.
    expect(fc.features[0].geometry).toEqual({ type: 'Point', coordinates: [11, 12] })
    expect(fc.features[1], 'untouched features keep their identity').toBe(h.seeded.features[1])
  })

  it('coalesces several moved points into ONE patch call', () => {
    const h = harness()
    h.queue.updateFeature(SRC, 77, { geometry: { type: 'Point', coordinates: [11, 12] } })
    h.queue.updateFeature(SRC, 78, { geometry: { type: 'Point', coordinates: [21, 22] } })
    h.flush()
    expect(h.patchFeaturesInPlace).toHaveBeenCalledTimes(1)
    expect(h.patchFeaturesInPlace.mock.calls[0][2]).toEqual([
      { featureId: 77, lon: 11, lat: 12 },
      { featureId: 78, lon: 21, lat: 22 },
    ])
    expect(h.reseedSource).not.toHaveBeenCalled()
  })

  it('FALLS BACK to reseed when the host reports the patch unserviceable', () => {
    const h = harness({ patchOk: false })
    h.queue.updateFeature(SRC, 77, { geometry: { type: 'Point', coordinates: [11, 12] } })
    h.flush()
    expect(h.patchFeaturesInPlace).toHaveBeenCalledTimes(1)
    expect(h.reseedSource, 'a refused patch must still land the update').toHaveBeenCalledTimes(1)
  })

  // A properties change can re-bake per-feature width / colour / extrude, move
  // the feature across a show's `filter:`, or change a `label-` string — all of
  // them in buffers a position patch never touches.
  it('FALLS BACK to reseed for a PROPERTIES change', () => {
    const h = harness()
    h.queue.updateFeature(SRC, 77, {
      geometry: { type: 'Point', coordinates: [11, 12] },
      properties: { status: 'moored' },
    })
    h.flush()
    expect(h.patchFeaturesInPlace).not.toHaveBeenCalled()
    expect(h.reseedSource).toHaveBeenCalledTimes(1)
  })

  it('FALLS BACK to reseed for a non-Point geometry on either side of the edit', () => {
    // New geometry is a LineString: the fill / line / segment buffers change
    // vertex COUNT, which no in-place record rewrite can express.
    const a = harness()
    a.queue.updateFeature(SRC, 77, {
      geometry: {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      },
    })
    a.flush()
    expect(a.patchFeaturesInPlace).not.toHaveBeenCalled()
    expect(a.reseedSource).toHaveBeenCalledTimes(1)

    // Previous geometry is a LineString being replaced by a Point — same
    // reason, mirrored.
    const b = harness({
      features: [
        {
          type: 'Feature',
          id: 77,
          geometry: {
            type: 'LineString',
            coordinates: [
              [0, 0],
              [1, 1],
            ],
          },
          properties: {},
        },
      ],
    })
    b.queue.updateFeature(SRC, 77, { geometry: { type: 'Point', coordinates: [5, 5] } })
    b.flush()
    expect(b.patchFeaturesInPlace).not.toHaveBeenCalled()
    expect(b.reseedSource).toHaveBeenCalledTimes(1)
  })

  it('ONE ineligible patch sends the WHOLE flush to reseed — no half-patched source', () => {
    const h = harness()
    h.queue.updateFeature(SRC, 77, { geometry: { type: 'Point', coordinates: [11, 12] } })
    h.queue.updateFeature(SRC, 78, { properties: { status: 'moored' } })
    h.flush()
    expect(h.patchFeaturesInPlace).not.toHaveBeenCalled()
    expect(h.reseedSource).toHaveBeenCalledTimes(1)
  })

  it('a host WITHOUT the hook keeps the pre-#1375 behaviour (re-seed)', () => {
    const h = harness({ withHook: false })
    h.queue.updateFeature(SRC, 77, { geometry: { type: 'Point', coordinates: [11, 12] } })
    h.flush()
    expect(h.reseedSource).toHaveBeenCalledTimes(1)
  })
})
