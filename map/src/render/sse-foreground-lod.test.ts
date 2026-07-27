// ═══ SSE selector: the foreground keeps native LOD at every pitch (#1374) ═══
//
// Reported symptom: lowering the map's pitch made the load far worse, and tiles
// that should be visible were not rendered.
//
// The SSE target used to be raised for the WHOLE frame whenever the camera was
// pitched past 60°. Measured on the real selector (Paris, 1280×800), that did
// not merely coarsen the horizon as its comment claimed — it coarsened
// everything:
//
//     zoom=16   pitch  0   20   40   60   70   80
//     tiles at native z16   9   11   12   20    0    0
//
// At pitch ≥ 70 not one selected tile was at the camera's own zoom: the
// foreground was drawn from z8-z14 ancestors. That is the cliff behind the
// report — crossing 60° downward, 12 coarse tiles became 20 native ones, and
// because buildings only exist at z ≥ 14 the pitched view carried almost no
// buildings at all until the pitch came down, at which point every tile grew a
// full building layer at once.
//
// The fix grades the target by DISTANCE (in camera altitudes) instead of by
// pitch. This gate pins both halves of that: low pitch is unchanged, and the
// foreground is never starved of native LOD however steep the pitch gets.
//
// Lives under map/src because it drives the REAL `Camera` (data/ cannot import
// it), which is the whole point — a hand-built matrix would not exercise pitch.

import { describe, it, expect } from 'vitest'
import { Camera } from '../camera'
import { visibleTilesSSE } from '@xgis/data'
import { mercator } from '@xgis/geo'

const W = 1280
const H = 800
const LON = 2.33194
const LAT = 48.84778

function selectAt(zoom: number, pitch: number): { total: number; atMaxZ: number } {
  const cam = new Camera(LON, LAT, zoom)
  cam.pitch = pitch
  cam.projType = 0
  const maxZ = Math.floor(zoom)
  const primaries = visibleTilesSSE(cam, mercator, maxZ, W, H, 0, 1).filter((t) => !t.fallbackOnly)
  return { total: primaries.length, atMaxZ: primaries.filter((t) => t.z === maxZ).length }
}

describe('SSE foreground LOD — never starved by pitch', () => {
  for (const zoom of [14, 16]) {
    it(`z${zoom}: every pitch keeps native-zoom tiles in the foreground`, () => {
      for (const pitch of [0, 20, 40, 60, 70, 80]) {
        const { atMaxZ } = selectAt(zoom, pitch)
        // The regression this gate exists for produced EXACTLY zero here at
        // pitch 70 and 80.
        expect(atMaxZ, `pitch=${pitch} emitted no native-zoom tile`).toBeGreaterThan(0)
      }
    })
  }

  it('an unpitched view is untouched by the distance grading', () => {
    // With a 45° FOV the whole unpitched frame — corner included — lies within
    // ~1.3 camera altitudes, i.e. inside FAR_RAMP_NEAR, so `farness` is 0 and the
    // target is exactly the base. Pinning the counts keeps that a property of the
    // design rather than a coincidence of the constants.
    expect(selectAt(16, 0)).toEqual({ total: 9, atMaxZ: 9 })
    expect(selectAt(14, 0)).toEqual({ total: 8, atMaxZ: 8 })
  })

  it('pitching DOWN never makes the native-LOD tile set appear from nothing', () => {
    // The user-visible shape of the bug: the count of full-detail tiles jumped
    // from 0 to 20 as the pitch came down through 60°. Now it varies smoothly and
    // is non-zero throughout, so no pitch change detonates the building layer.
    const steps = [80, 70, 60, 40, 20, 0].map((p) => selectAt(16, p).atMaxZ)
    for (const n of steps) expect(n).toBeGreaterThan(0)
  })

  it('the horizon is still coarsened at high pitch — the relief was kept', () => {
    // The grading must not simply disable the far-field ceiling: a steeply
    // pitched view should still emit ancestors well above the camera's zoom for
    // the distant ground, or the horizon explodes (the 154 ms case the original
    // pitch ramp was added for).
    const cam = new Camera(LON, LAT, 16)
    cam.pitch = 80
    cam.projType = 0
    const tiles = visibleTilesSSE(cam, mercator, 16, W, H, 0, 1).filter((t) => !t.fallbackOnly)
    const coarse = tiles.filter((t) => t.z <= 12)
    expect(coarse.length).toBeGreaterThan(0)
  })
})
