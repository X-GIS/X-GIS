// #1983 (ADR-0012 Phase B2) — a source-level `maxzoom` DECLARED in an `.xgis` source
// block must reach the same runtime consumers the field was built for.
//
// The plumbing existed end to end EXCEPT for two hops, and each one silently swallowed
// the value:
//
//   1. `SourceManager._attachOneSource` builds the `rawDatasets` markers
//      (`{ _tileUrl, tileSize }` for raster, `{ _tileUrl, _dem, … }` for raster-dem)
//      and neither carried `maxzoom` — so `map.ts`'s `'maxzoom' in data` guard, which
//      exists precisely to call `RasterRenderer.setSourceMaxzoom`, could never fire
//      from the declarative path.
//   2. `HillshadeRenderer.setParams` rebuilds its param object key by key and simply
//      had no `maxzoom` key — so `armHillshadeSource`, which DOES pass
//      `maxzoom: dem.maxzoom`, had its value dropped by the merge one line later.
//
// Without the clamp the cover zoom outruns the dataset and every tile 404s past its
// deepest real level (the terrarium z15 bucket vs a 256-px source's +1 bias — the
// failure `rasterCoverZoom`'s `sourceMaxzoom` argument was added for).
//
// Source-level `minzoom` is deliberately NOT wired: `rasterCoverZoom` clamps on maxzoom
// only, and a minzoom consumer is a tile-SELECTION gate ("below this the tile does not
// exist, draw nothing"), not a clamp mirror. It stays emit-only, reaching the compiler
// LoadCommand and stopping there — see the converter's own warning.

import { describe, it, expect } from 'vitest'
import { SourceManager } from './source-manager'
import { InputStore } from './render/input-store'
import { HillshadeRenderer, armHillshadeSource } from './render/hillshade-renderer'
import { rasterCoverZoom } from './render/raster-renderer'
import type { RawDataset } from './map-types'
import type { SceneCommands } from './interpreter'
import type { GeoJSONFeatureCollection, CapPoles } from '@xgis/data'

/** SourceManager with every collaborator stubbed — the raster / raster-dem arms of
 *  `_attachOneSource` touch nothing but `rawDatasets` (no fetch, no GPU). */
function makeManager() {
  const rawDatasets = new Map<string, RawDataset>()
  const mgr = new SourceManager({
    rawDatasets,
    inputs: new InputStore(),
    registerVtSource: () => {},
    sourceCRS: new Map<string, string>(),
    geojsonCapPoles: new Map<string, CapPoles>(),
    heatmapPointData: new Map<string, GeoJSONFeatureCollection>(),
    camera: {} as never,
    getCanvas: () => ({ width: 800 }) as never,
    getCtx: () => ({}) as never,
    getRenderer: () => ({}) as never,
    getLineRenderer: () => null,
    invalidate: () => {},
    fitZoomToLonSpan: () => 0,
    runBoundsFitGate: () => false,
    rebuildLayers: () => {},
    teardownSource: () => {},
    fireError: () => {},
    getVtSource: () => null,
    hasVariantSources: () => false,
    deleteFeatureIndex: () => {},
    beginCoverageLoad: () => Promise.resolve(),
  })
  return { mgr, rawDatasets }
}

const load = (over: Partial<SceneCommands['loads'][0]>): SceneCommands['loads'][0] => ({
  name: 'src',
  url: 'https://x/{z}/{x}/{y}.png',
  ...over,
})

const attach = async (l: SceneCommands['loads'][0]) => {
  const { mgr, rawDatasets } = makeManager()
  await mgr._attachOneSource(l, '', {} as never, { fit: false })
  return rawDatasets.get(l.name)
}

describe('#1983 hop 1 — the source-manager markers carry the declared maxzoom', () => {
  it('raster: the `{ _tileUrl }` marker carries maxzoom alongside tileSize', async () => {
    const marker = await attach(load({ type: 'raster', tileSize: 256, maxzoom: 6 }))
    expect(marker).toMatchObject({
      _tileUrl: 'https://x/{z}/{x}/{y}.png',
      tileSize: 256,
      maxzoom: 6,
    })
  })

  it('raster-dem: the `_dem` marker carries maxzoom alongside the DEM decode', async () => {
    const marker = await attach(
      load({ name: 'dem', type: 'raster-dem', encoding: 'terrarium', tileSize: 256, maxzoom: 15 }),
    )
    expect(marker).toMatchObject({
      _dem: true,
      encoding: 'terrarium',
      tileSize: 256,
      maxzoom: 15,
    })
  })

  it('a source that declares no maxzoom leaves it undefined — unbounded, as before', async () => {
    const marker = (await attach(load({ type: 'raster' }))) as { maxzoom?: number }
    expect(marker.maxzoom).toBeUndefined()
  })
})

describe('#1983 hop 2 — HillshadeRenderer.setParams keeps maxzoom through the merge', () => {
  const renderer = () => new HillshadeRenderer({ rhi: {}, format: 'bgra8unorm' } as never)
  /** `setParams` is a merge over the private `_params`; read it back the same way the
   *  render path does. */
  const paramsOf = (r: HillshadeRenderer) =>
    (r as unknown as { _params: { maxzoom?: number } })._params

  it('armHillshadeSource → setParams: the DEM marker maxzoom survives', () => {
    const r = renderer()
    armHillshadeSource(r, { _tileUrl: 'https://dem/{z}/{x}/{y}.png', tileSize: 256, maxzoom: 15 })
    expect(paramsOf(r).maxzoom).toBe(15)
  })

  it('a later PAINT-only merge does not clobber the armed maxzoom', () => {
    // The arm (source) and the per-frame paint (HillshadePass) merge into the SAME
    // object; a paint merge omits every source key, so the merge must carry them.
    const r = renderer()
    armHillshadeSource(r, { _tileUrl: 'https://dem/{z}/{x}/{y}.png', maxzoom: 12 })
    r.setParams({ direction: 300, altitude: 30 })
    expect(paramsOf(r).maxzoom).toBe(12)
  })

  it('an un-declaring source leaves maxzoom undefined (unbounded)', () => {
    const r = renderer()
    armHillshadeSource(r, { _tileUrl: 'https://dem/{z}/{x}/{y}.png' })
    expect(paramsOf(r).maxzoom).toBeUndefined()
  })
})

describe('#1983 hop 3 — the clamp actually changes the requested zoom', () => {
  // Guards against the wiring being "present but inert": a maxzoom that never reaches
  // rasterCoverZoom leaves the cover zoom identical, which is exactly how this gap hid.
  it('a 256-px source at camera z16 asks for z15 when maxzoom says 15, z17 without', () => {
    expect(rasterCoverZoom(16, 256, undefined)).toBe(17)
    expect(rasterCoverZoom(16, 256, 15)).toBe(15)
  })
})

describe('#1983 — minzoom is deliberately emit-only', () => {
  it('the RUNTIME LoadCommand carries no minzoom — it stops at the compiler', () => {
    // A tripwire tsc checks, not vitest: `@ts-expect-error` becomes an ERROR the day the
    // field is added, which is exactly when this file, the marker types, and the
    // converter's "no source-minzoom consumer yet" warning all need revisiting together.
    // (maxzoom is present on the same type — the two are asserted apart on purpose.)
    // @ts-expect-error — minzoom reaches the COMPILER LoadCommand and stops there.
    const withMinzoom: SceneCommands['loads'][0] = { name: 's', url: 'u', minzoom: 3 }
    const withMaxzoom: SceneCommands['loads'][0] = { name: 's', url: 'u', maxzoom: 3 }
    expect([withMinzoom.name, withMaxzoom.maxzoom]).toEqual(['s', 3])
  })
})
