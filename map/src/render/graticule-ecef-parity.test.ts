import { describe, it, expect } from 'vitest'
import { generateGraticule } from '@xgis/map'

// Pins the graticule ECEF-kernel unification (PR-A target #2): the
// hand-rolled `lonLatToEcefDSFUN` (own GRAT_EARTH_A / GRAT_F / GRAT_E2 +
// inline DSFUN hi/lo split) was routed onto the shared
// `lonLatToECEF` + `dsfunSplitECEF`. The swap MUST be byte-identical for the
// produced (Float32Array-stored) geometry.
//
// Subtle point this test guards: the OLD kernel fround-ed the lo residual
// (`Math.fround(ex - exH)`) while shared `dsfunSplitECEF` stores the raw f64
// residual (`rel - hi`). Those differ in f64, but BOTH collapse to the same
// f32 once the graticule's `new Float32Array(vertices)` rounds on storage.
// The assertion is therefore against the f32 output, exactly what the GPU
// consumes.

// Old inline kernel, reproduced verbatim (pre-PR-A), pushing stride-9
// ECEF-DSFUN floats — the byte-for-byte ground truth.
const OLD_EARTH_A = 6378137
const OLD_F = 1 / 298.257223563
const OLD_E2 = OLD_F * (2 - OLD_F)
const OLD_DEG2RAD = Math.PI / 180
const OLD_LAT_LIMIT = 85.051129

function oldKernel(lon: number, lat: number, featId: number, out: number[]): void {
  const clampedLat = Math.max(-OLD_LAT_LIMIT, Math.min(OLD_LAT_LIMIT, lat))
  const lonRad = lon * OLD_DEG2RAD
  const latRad = clampedLat * OLD_DEG2RAD
  const sinLat = Math.sin(latRad)
  const cosLat = Math.cos(latRad)
  const N = OLD_EARTH_A / Math.sqrt(1 - OLD_E2 * sinLat * sinLat)
  const ex = N * cosLat * Math.cos(lonRad)
  const ey = N * cosLat * Math.sin(lonRad)
  const ez = N * (1 - OLD_E2) * sinLat
  const exH = Math.fround(ex)
  const eyH = Math.fround(ey)
  const ezH = Math.fround(ez)
  const exL = Math.fround(ex - exH)
  const eyL = Math.fround(ey - eyH)
  const ezL = Math.fround(ez - ezH)
  out.push(exH, eyH, ezH, exL, eyL, ezL, featId, lon, clampedLat)
}

// Reproduce the grid `generateGraticule` walks per zoom bucket so the
// independent ground-truth array lines up element-for-element with the
// production geometry.
function oldGraticuleVertices(zoom: number): Float32Array {
  const stepsForZoom = (z: number): { major: number; minor: number | null } => {
    if (z < 3) return { major: 30, minor: null }
    if (z < 5) return { major: 15, minor: null }
    if (z < 7) return { major: 10, minor: 5 }
    if (z < 9) return { major: 5, minor: 1 }
    return { major: 1, minor: 0.5 }
  }
  const { major, minor } = stepsForZoom(zoom)
  const vertices: number[] = []
  const segmentStep = 2
  const addMeridians = (step: number, featId: number, skipStep?: number) => {
    for (let lon = -180; lon < 180; lon += step) {
      if (skipStep && lon % skipStep === 0) continue
      for (let lat = -90; lat < 90; lat += segmentStep) {
        oldKernel(lon, lat, featId, vertices)
        oldKernel(lon, Math.min(lat + segmentStep, 90), featId, vertices)
      }
    }
  }
  const addParallels = (step: number, featId: number, skipStep?: number) => {
    for (let lat = -90 + step; lat < 90; lat += step) {
      if (skipStep && (lat + 90) % skipStep === 0) continue
      for (let lon = -180; lon < 180; lon += segmentStep) {
        oldKernel(lon, lat, featId, vertices)
        oldKernel(Math.min(lon + segmentStep, 180), lat, featId, vertices)
      }
    }
  }
  addMeridians(major, 1)
  addParallels(major, 1)
  if (minor) {
    addMeridians(minor, 0, major)
    addParallels(minor, 0, major)
  }
  return new Float32Array(vertices)
}

describe('graticule ECEF kernel — shared vs old inline byte-equality', () => {
  // One zoom per distinct bucket (30 / 15 / 5+1 / 1+0.5) so every
  // major/minor combination of the kernel is exercised.
  for (const zoom of [2, 4, 6, 8, 10]) {
    it(`generateGraticule(${zoom}) is byte-identical to the old inline kernel`, () => {
      const produced = generateGraticule(zoom).vertices
      const expected = oldGraticuleVertices(zoom)
      expect(produced.length).toBe(expected.length)
      // Float32Array bit-for-bit comparison via the underlying byte view.
      const a = new Uint8Array(produced.buffer, produced.byteOffset, produced.byteLength)
      const b = new Uint8Array(expected.buffer, expected.byteOffset, expected.byteLength)
      let firstDiff = -1
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
          firstDiff = i
          break
        }
      }
      expect(firstDiff).toBe(-1)
    })
  }
})
