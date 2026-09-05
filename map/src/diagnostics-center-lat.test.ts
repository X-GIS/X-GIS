// #2526 — the diagnostics snapshot / inspection latitude and the replay
// restore must follow the frame's centre authority (centerLatDeg for the
// sphere family, which reaches the pole), not the ±85.051129°-saturated
// Mercator mirror. Fail-before: a globe camera at lat 89 inspected as 85.05,
// and a lat-89 snapshot replayed to 85.05 (the mirror, re-synced).
import { describe, it, expect } from 'vitest'
import { XGISMap } from './map'
import { replayMapSnapshot } from './diagnostics'
import { mercatorYToLat } from '@xgis/geo'

function mockCanvas(width = 1200, height = 800): HTMLCanvasElement {
  return { width, height } as unknown as HTMLCanvasElement
}

const MERC_LIMIT = 85.051129

describe('diagnostics centre latitude — one authority (#2526)', () => {
  it('inspectPipeline reports the true pole-ward centre of a globe camera', () => {
    const map = new XGISMap(mockCanvas())
    const cam = map.camera
    cam.projType = 7
    cam.globeMode = true
    // setCenter's dual write: saturated mirror + true latitude.
    cam.centerLatDeg = 89
    cam.centerY = 6378137 * Math.log(Math.tan(Math.PI / 4 + (MERC_LIMIT * Math.PI) / 360))
    expect(mercatorYToLat(cam.centerY)).toBeCloseTo(MERC_LIMIT, 3)
    expect(map.inspectPipeline().camera.lat).toBeCloseTo(89, 6)
  })

  it('inspectPipeline is byte-identical for a cylindrical camera (mirror == authority)', () => {
    const map = new XGISMap(mockCanvas())
    const before = map.inspectPipeline().camera.lat
    expect(before).toBeCloseTo(20, 6) // the default Camera(0, 20, 2)
    expect(before).toBe(mercatorYToLat(map.camera.centerY))
  })

  it('replayMapSnapshot restores a lat-89 globe snapshot at lat 89 (saturated mirror)', async () => {
    const map = new XGISMap(mockCanvas())
    map.camera.projType = 7
    map.camera.globeMode = true
    const res = await replayMapSnapshot(
      map,
      {
        schemaVersion: 1,
        camera: { lon: 10, lat: 89, zoom: 4, bearing: 0, pitch: 0 },
        sources: {},
      },
      { timeoutMs: 1_000 },
    )
    expect(res.matched).toBe(true)
    expect(map.camera.centerLatDeg).toBeCloseTo(89, 6)
    expect(mercatorYToLat(map.camera.centerY)).toBeCloseTo(MERC_LIMIT, 3)
    expect(map.camera.zoom).toBe(4)
  })

  it('replayMapSnapshot keeps the Mercator clamp for a cylindrical camera', async () => {
    const map = new XGISMap(mockCanvas())
    map.camera.projType = 0
    await replayMapSnapshot(
      map,
      { schemaVersion: 1, camera: { lon: 0, lat: 89, zoom: 2, bearing: 0, pitch: 0 }, sources: {} },
      { timeoutMs: 1_000 },
    )
    expect(map.camera.centerLatDeg).toBeCloseTo(MERC_LIMIT, 3)
    expect(mercatorYToLat(map.camera.centerY)).toBeCloseTo(MERC_LIMIT, 3)
  })
})
